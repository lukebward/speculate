import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptOccurrenceCorrelator, promptNativeId } from './promptOccurrence.js';
import { effectiveServers, readClaudeServers, selfCommand, wrapLaunchEntry, type McpServerEntry } from '../hostConfig.js';
import { resolveClaudeBin } from '../manage.js';
import {
  MAX_OBSERVATION_BYTES,
  observationSchema,
  sessionContextSchema,
  type AgentAdapter,
  type AgentAdapterConnection,
  type AgentAdapterEnvironment,
  type AgentAdapterRequest,
  type AgentAdapterRequestObserver,
  type AgentAdapterResponse,
  type Observation,
  type RegisteredRoute,
  type SessionContext,
  type AgentLaunchContext,
  type LaunchPlan,
} from '../observerTypes.js';

const MAX_STREAM_ARGUMENT_BYTES = 64 * 1024;
const MAX_ACTIVE_BLOCKS = 256;
const MAX_REQUEST_TOOLS = 512;
const MAX_LAUNCH_CONFIG_BYTES = 8 * 1024 * 1024;

interface ActiveBlock {
  callId: string;
  name: string;
  initialInput: Record<string, unknown> | null;
  partialJson: string;
  oversized: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function header(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | null {
  const value = headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name) ?? ''];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function inspectableEncoding(headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const encoding = header(headers, 'content-encoding');
  return encoding === null || encoding.trim().toLowerCase() === 'identity';
}

function currentPrompt(body: Record<string, unknown>): { text: string; nativeId: string } | null {
  if (!Array.isArray(body.messages)) return null;
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index];
    if (!object(message) || message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      return message.content ? { text: message.content, nativeId: promptNativeId(body.messages.slice(0, index + 1)) } : null;
    }
    if (!Array.isArray(message.content)) return null;
    const text = message.content.flatMap((block) =>
      object(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    ).join('\n');
    if (text) return { text, nativeId: promptNativeId(body.messages.slice(0, index + 1)) };
    if (message.content.every((block) => object(block) && block.type === 'tool_result')) continue;
    return null;
  }
  return null;
}

function requestPath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path.split('?', 1)[0] ?? null;
}

function modelToolName(route: RegisteredRoute): string {
  return `mcp__${route.hostServerAlias}__${route.exposedTool}`;
}

class ClaudeRequestObserver implements AgentAdapterRequestObserver {
  private readonly decoder = new StringDecoder('utf8');
  private readonly activeBlocks = new Map<number, ActiveBlock>();
  private readonly routesByName = new Map<string, RegisteredRoute>();
  private responseMode: 'sse' | 'json' | 'none' = 'none';
  private responseText = '';
  private responseBytes = 0;
  private requestReady = false;
  private stopped = false;
  private released = false;
  private boundaryAt: number | null = null;

  constructor(
    private readonly context: SessionContext,
    private readonly request: AgentAdapterRequest,
    private readonly environment: AgentAdapterEnvironment,
    private readonly promptOccurrences: PromptOccurrenceCorrelator,
    private readonly release: () => void,
  ) {}

  observeRequestBody(body: Uint8Array, observedAt?: number): readonly Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (this.stopped || body.byteLength > MAX_OBSERVATION_BYTES || !inspectableEncoding(this.request.headers)) {
      this.abort();
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    } catch {
      this.abort();
      return [];
    }
    if (!object(parsed)) {
      this.abort();
      return [];
    }
    this.captureRoutes(parsed.tools);
    this.requestReady = true;
    const current = currentPrompt(parsed);
    if (current === null) return [];
    const stableId = createHash('sha256').update(this.context.conversationId).update('\0').update(Buffer.from(body)).digest('base64url');
    return this.observation({
      kind: 'prompt',
      context: this.context,
      eventId: this.eventId('prompt', stableId),
      observedAt: this.boundaryAt,
      occurrenceId: this.promptOccurrences.identify(this.context.conversationId, current.text, 'proxy', current.nativeId),
      text: current.text,
    });
  }

  observeResponseStart(response: AgentAdapterResponse, observedAt?: number): readonly Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (this.stopped || !this.requestReady || response.status < 200 || response.status >= 300 || !inspectableEncoding(response.headers)) {
      this.abort();
      return [];
    }
    const contentType = header(response.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType === 'text/event-stream') this.responseMode = 'sse';
    else if (contentType === 'application/json') this.responseMode = 'json';
    else this.abort();
    return [];
  }

  observeResponseChunk(chunk: Uint8Array, observedAt?: number): readonly Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (this.stopped || this.responseMode === 'none') return [];
    this.responseBytes += chunk.byteLength;
    if (this.responseBytes > MAX_OBSERVATION_BYTES) {
      this.abort();
      return [];
    }
    if (this.responseMode === 'json') {
      this.responseText += this.decoder.write(Buffer.from(chunk));
      return [];
    }
    this.responseText += this.decoder.write(Buffer.from(chunk));
    return this.readSse(false);
  }

  observeResponseEnd(observedAt?: number): readonly Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (this.stopped || this.responseMode === 'none') return [];
    if (this.responseMode === 'json') {
      this.responseText += this.decoder.end();
      const observations = this.readJsonResponse();
      this.abort();
      return observations;
    }
    this.responseText += this.decoder.end();
    const observations = this.readSse(true);
    this.abort();
    return observations;
  }

  abort(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.responseMode = 'none';
    this.responseText = '';
    this.activeBlocks.clear();
    this.routesByName.clear();
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }

  private captureRoutes(value: unknown): void {
    if (!Array.isArray(value) || value.length > MAX_REQUEST_TOOLS) return;
    const definitions = new Map<string, Record<string, unknown>[]>();
    for (const item of value) {
      if (!object(item) || typeof item.name !== 'string' || !object(item.input_schema) || item.defer_loading === true) continue;
      const list = definitions.get(item.name) ?? [];
      list.push(item.input_schema);
      definitions.set(item.name, list);
    }
    for (const [name, schemas] of definitions) {
      if (schemas.length !== 1) continue;
      const matches = this.environment.routes().filter((route) =>
        route.hostClient === 'claude' && modelToolName(route) === name && isDeepStrictEqual(route.inputSchema, schemas[0])
      );
      if (matches.length === 1) this.routesByName.set(name, matches[0]!);
    }
  }

  private readSse(ended: boolean): Observation[] {
    const out: Observation[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.responseText);
      if (!match) break;
      const block = this.responseText.slice(0, match.index);
      this.responseText = this.responseText.slice(match.index + match[0].length);
      out.push(...this.readSseBlock(block));
    }
    if (ended && this.responseText.trim()) out.push(...this.readSseBlock(this.responseText));
    if (ended) this.responseText = '';
    return out;
  }

  private readSseBlock(block: string): Observation[] {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return [];
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
    if (!object(event) || !Number.isInteger(event.index)) return [];
    const index = event.index as number;
    if (event.type === 'content_block_start' && object(event.content_block) && event.content_block.type === 'tool_use' &&
      typeof event.content_block.id === 'string' && typeof event.content_block.name === 'string') {
      if (!this.activeBlocks.has(index) && this.activeBlocks.size >= MAX_ACTIVE_BLOCKS) {
        this.abort();
        return [];
      }
      this.activeBlocks.set(index, {
        callId: event.content_block.id,
        name: event.content_block.name,
        initialInput: object(event.content_block.input) ? event.content_block.input : null,
        partialJson: '',
        oversized: false,
      });
      return [];
    }
    const active = this.activeBlocks.get(index);
    if (!active) return [];
    if (event.type === 'content_block_delta' && object(event.delta) && event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
      if (!active.oversized) {
        active.partialJson += event.delta.partial_json;
        if (Buffer.byteLength(active.partialJson, 'utf8') > MAX_STREAM_ARGUMENT_BYTES) {
          active.partialJson = '';
          active.oversized = true;
        }
      }
      return [];
    }
    if (event.type !== 'content_block_stop') return [];
    this.activeBlocks.delete(index);
    if (active.oversized) return [];
    let args: unknown = active.initialInput;
    if (active.partialJson) {
      try {
        args = JSON.parse(active.partialJson) as unknown;
      } catch {
        return [];
      }
    }
    return this.toolObservation(active.name, active.callId, args);
  }

  private readJsonResponse(): Observation[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.responseText) as unknown;
    } catch {
      return [];
    }
    if (!object(parsed) || !Array.isArray(parsed.content)) return [];
    return parsed.content.flatMap((block) => {
      if (!object(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') return [];
      return this.toolObservation(block.name, block.id, block.input);
    });
  }

  private toolObservation(name: string, callId: string, args: unknown): Observation[] {
    const route = this.routesByName.get(name);
    if (!route || !object(args)) return [];
    const observedAt = this.boundaryAt ?? this.now();
    try {
      this.environment.onToolCallMarker?.({
        source: 'model', phase: 'selected', context: this.context,
        routeId: route.routeId, generation: route.generation, callId, args, observedAt,
      });
    } catch {}
    return this.observation({
      kind: 'stream-call',
      context: this.context,
      eventId: this.eventId('stream-call', callId),
      observedAt,
      routeId: route.routeId,
      callId,
      args,
    });
  }

  private observation(value: unknown): Observation[] {
    const parsed = observationSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }

  private now(): number {
    return this.environment.now?.() ?? Date.now();
  }

  private eventId(kind: Observation['kind'], stableId: string): string {
    return this.environment.eventId?.(kind, stableId) ?? `claude:${kind}:${stableId || randomUUID()}`;
  }
}

class ClaudeConnection implements AgentAdapterConnection {
  private readonly requests = new Set<ClaudeRequestObserver>();
  private closed = false;

  constructor(
    private readonly environment: AgentAdapterEnvironment,
    private readonly promptOccurrences: PromptOccurrenceCorrelator,
  ) {}

  startRequest(request: AgentAdapterRequest): AgentAdapterRequestObserver | null {
    if (this.closed || request.transport !== 'http' || request.method.toUpperCase() !== 'POST' || requestPath(request.path) !== '/v1/messages') return null;
    const conversationId = header(request.headers, 'x-claude-code-session-id');
    if (!conversationId) return null;
    const context = this.context(conversationId);
    if (!context) return null;
    let observer!: ClaudeRequestObserver;
    observer = new ClaudeRequestObserver(
      context,
      request,
      this.environment,
      this.promptOccurrences,
      () => this.requests.delete(observer),
    );
    this.requests.add(observer);
    return observer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }

  private context(conversationId: string): SessionContext | null {
    try {
      const parsed = sessionContextSchema.safeParse(this.environment.contextForConversation(conversationId));
      return parsed.success && parsed.data.agent === 'claude' && parsed.data.conversationId === conversationId ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

export function claudeAdapter(environment: AgentAdapterEnvironment): AgentAdapter {
  const promptOccurrences = new PromptOccurrenceCorrelator(() => environment.now?.() ?? Date.now());
  return {
    agent: 'claude',
    createConnection: () => new ClaudeConnection(environment, promptOccurrences),
    normalizeHook(payload: unknown, boundaryAt?: number): readonly Observation[] {
      if (!object(payload) || typeof payload.session_id !== 'string') return [];
      if (payload.session_id.length === 0 || payload.session_id.length > 512 ||
        Buffer.byteLength(payload.session_id, 'utf8') > 512) return [];
      const toolEvent = payload.hook_event_name === 'PreToolUse' || payload.hook_event_name === 'PostToolUse' ||
        payload.hook_event_name === 'PostToolUseFailure';
      if (payload.hook_event_name === 'UserPromptSubmit' && (typeof payload.prompt !== 'string' ||
        payload.prompt.length > MAX_OBSERVATION_BYTES || Buffer.byteLength(payload.prompt, 'utf8') > MAX_OBSERVATION_BYTES)) return [];
      if (toolEvent && (typeof payload.tool_name !== 'string' || payload.tool_name.length > 512 ||
        typeof payload.tool_use_id !== 'string' || payload.tool_use_id.length === 0 || payload.tool_use_id.length > 512 ||
        !object(payload.tool_input))) return [];
      let context: SessionContext | null = null;
      try {
        const parsed = sessionContextSchema.safeParse(environment.contextForConversation(
          payload.session_id,
          typeof payload.cwd === 'string' ? payload.cwd : undefined,
        ));
        if (parsed.success && parsed.data.agent === 'claude' && parsed.data.conversationId === payload.session_id) context = parsed.data;
      } catch {
        return [];
      }
      if (!context) return [];
      const phase = payload.hook_event_name === 'PreToolUse'
        ? 'started'
        : payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure'
          ? 'settled'
          : null;
      if (phase && typeof payload.tool_name === 'string' && typeof payload.tool_use_id === 'string' && object(payload.tool_input)) {
        const routes = environment.routes().filter((route) => route.hostClient === 'claude' && modelToolName(route) === payload.tool_name);
        if (routes.length === 1) {
          try {
            environment.onToolCallMarker?.({
              source: 'hook', phase, context, routeId: routes[0]!.routeId,
              generation: routes[0]!.generation, callId: payload.tool_use_id,
              args: payload.tool_input, observedAt: boundaryAt ?? environment.now?.() ?? Date.now(),
              ...(typeof payload.agent_id === 'string' ? { actorId: payload.agent_id } : {}),
              ...(typeof payload.turn_id === 'string' ? { turnId: payload.turn_id } : {}),
            });
          } catch {}
        }
        return [];
      }
      if (payload.hook_event_name !== 'UserPromptSubmit' || typeof payload.prompt !== 'string') return [];
      const eventId = environment.eventId?.('prompt', `hook:${payload.session_id}:${createHash('sha256').update(payload.prompt).digest('base64url')}`) ??
        `claude:prompt:hook:${payload.session_id}:${randomUUID()}`;
      const parsed = observationSchema.safeParse({
        kind: 'prompt',
        context,
        eventId,
        observedAt: boundaryAt ?? environment.now?.() ?? Date.now(),
        occurrenceId: promptOccurrences.identify(context.conversationId, payload.prompt, 'hook'),
        text: payload.prompt,
      });
      return parsed.success ? [parsed.data] : [];
    },
  };
}

export interface ClaudeLaunchContext extends AgentLaunchContext {
  home?: string;
}

export function claudeObserverHookCommand(): string {
  const script = fileURLToPath(new URL('../../plugin/hooks/session-observer.mjs', import.meta.url));
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `${quote(process.execPath)} ${quote(script)}`;
}

function hookSettings(existing: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (existing.disableAllHooks === true || existing.allowManagedHooksOnly === true) return null;
  const handler = { type: 'command', command: claudeObserverHookCommand(), timeout: 1 };
  const settings = structuredClone(existing);
  if (settings.hooks !== undefined && !object(settings.hooks)) return null;
  const hooks = object(settings.hooks) ? settings.hooks : {};
  for (const event of [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
  ]) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) return null;
    hooks[event] = [...((current as unknown[] | undefined) ?? []), { hooks: [handler] }];
  }
  settings.hooks = hooks;
  return settings;
}

function launchSettings(cwd: string, clientArgs: readonly string[]): {
  settings: Record<string, unknown> | null;
  clientArgs: string[];
  reason?: string;
} {
  const occurrences: Array<{ index: number; count: number; value: string }> = [];
  for (let index = 0; index < clientArgs.length; index++) {
    if (clientArgs[index] === '--') break;
    if (clientArgs[index] === '--settings') {
      const value = clientArgs[index + 1];
      if (!value) return { settings: null, clientArgs: [...clientArgs], reason: 'hook-observation:invalid-settings' };
      occurrences.push({ index, count: 2, value });
      index++;
    } else if (clientArgs[index]!.startsWith('--settings=')) {
      occurrences.push({ index, count: 1, value: clientArgs[index]!.slice('--settings='.length) });
    }
  }
  if (occurrences.length > 1) return { settings: null, clientArgs: [...clientArgs], reason: 'hook-observation:ambiguous-settings' };
  let existing: Record<string, unknown> = {};
  if (occurrences.length === 1) {
    const raw = occurrences[0]!.value;
    try {
      let parsed: unknown;
      if (raw.trim().startsWith('{')) parsed = JSON.parse(raw) as unknown;
      else {
        const path = resolve(cwd, raw);
        if (statSync(path).size > 8 * 1024 * 1024) throw new Error('oversized');
        parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      }
      if (!object(parsed)) throw new Error('invalid');
      existing = parsed;
    } catch {
      return { settings: null, clientArgs: [...clientArgs], reason: 'hook-observation:invalid-settings' };
    }
  }
  const settings = hookSettings(existing);
  if (!settings) return { settings: null, clientArgs: [...clientArgs], reason: 'hook-observation:settings-policy' };
  const forwarded = [...clientArgs];
  if (occurrences.length === 1) forwarded.splice(occurrences[0]!.index, occurrences[0]!.count);
  return { settings, clientArgs: forwarded };
}

function launchMcpSource(cwd: string, clientArgs: readonly string[]): {
  source: Record<string, unknown> | null;
  servers: Record<string, McpServerEntry>;
  clientArgs: string[];
  reason?: string;
} {
  const occurrences: Array<{ index: number; count: number; value: string }> = [];
  for (let index = 0; index < clientArgs.length; index++) {
    const arg = clientArgs[index]!;
    if (arg === '--') break;
    if (arg === '--mcp-config') {
      const value = clientArgs[index + 1];
      if (!value) return { source: null, servers: {}, clientArgs: [...clientArgs], reason: 'owned-mcp:unverifiable-config-source' };
      occurrences.push({ index, count: 2, value });
      index++;
    } else if (arg.startsWith('--mcp-config=')) {
      occurrences.push({ index, count: 1, value: arg.slice('--mcp-config='.length) });
    }
  }
  if (occurrences.length === 0) return { source: null, servers: {}, clientArgs: [...clientArgs] };
  if (occurrences.length !== 1 || !occurrences[0]!.value) {
    return { source: null, servers: {}, clientArgs: [...clientArgs], reason: 'owned-mcp:unverifiable-config-source' };
  }
  const occurrence = occurrences[0]!;
  try {
    let parsed: unknown;
    if (occurrence.value.trim().startsWith('{')) {
      if (Buffer.byteLength(occurrence.value, 'utf8') > MAX_LAUNCH_CONFIG_BYTES) throw new Error('oversized');
      parsed = JSON.parse(occurrence.value) as unknown;
    } else {
      const path = resolve(cwd, occurrence.value);
      if (statSync(path).size > MAX_LAUNCH_CONFIG_BYTES) throw new Error('oversized');
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    }
    if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers))) throw new Error('invalid');
    const servers: Record<string, McpServerEntry> = {};
    for (const [alias, entry] of Object.entries(object(parsed.mcpServers) ? parsed.mcpServers : {})) {
      if (!object(entry)) throw new Error('invalid');
      servers[alias] = entry as McpServerEntry;
    }
    const forwarded = [...clientArgs];
    forwarded.splice(occurrence.index, occurrence.count);
    return { source: parsed, servers, clientArgs: forwarded };
  } catch {
    return { source: null, servers: {}, clientArgs: [...clientArgs], reason: 'owned-mcp:unverifiable-config-source' };
  }
}

export async function buildLaunchPlan(context: ClaudeLaunchContext): Promise<LaunchPlan> {
  const home = context.home ?? homedir();
  const directory = mkdtempSync(join(tmpdir(), 'speculate-claude-run-'));
  chmodSync(directory, 0o700);
  const args: string[] = [];
  const disabledCapabilities: string[] = [];
  try {
    const view = readClaudeServers({ home, cwd: context.cwd });
    const perRun = launchMcpSource(context.cwd, context.clientArgs);
    const mcpServers: Record<string, unknown> = {};
    if (perRun.reason) disabledCapabilities.push(perRun.reason);
    const launchEntries = new Map<string, { entry: McpServerEntry; preserveIfUnowned: boolean }>();
    if (!perRun.reason) {
      for (const [alias, scoped] of effectiveServers(view.servers)) {
        if (scoped.scope === 'project' && !view.approvedProjectServers.has(alias)) continue;
        if (!Object.hasOwn(perRun.servers, alias)) launchEntries.set(alias, { entry: scoped.entry, preserveIfUnowned: false });
      }
      for (const [alias, entry] of Object.entries(perRun.servers)) {
        launchEntries.set(alias, { entry, preserveIfUnowned: true });
      }
    }
    for (const [alias, item] of launchEntries) {
      const wrapped = wrapLaunchEntry(alias, item.entry, context.self ?? selfCommand(), {
        hostClient: 'claude',
        socketPath: context.session.socketPath,
        capability: context.session.capability,
        launchId: context.session.launchId,
      });
      if ('entry' in wrapped) mcpServers[alias] = wrapped.entry;
      else if (item.preserveIfUnowned) mcpServers[alias] = item.entry;
    }
    if (perRun.source || Object.keys(mcpServers).length > 0) {
      const path = join(directory, 'mcp.json');
      writeFileSync(path, `${JSON.stringify({ ...(perRun.source ?? {}), mcpServers })}\n`, { mode: 0o600 });
      args.push(`--mcp-config=${path}`);
    }
    const forwardedMcpArgs = perRun.reason ? [...context.clientArgs] : perRun.clientArgs;
    if (context.observe !== 'off') {
      const temporary = launchSettings(context.cwd, forwardedMcpArgs);
      if (temporary.settings) {
        const path = join(directory, 'settings.json');
        writeFileSync(path, `${JSON.stringify(temporary.settings)}\n`, { mode: 0o600 });
        args.push('--settings', path);
      } else if (temporary.reason) disabledCapabilities.push(temporary.reason);
      args.push(...temporary.clientArgs);
    } else {
      args.push(...forwardedMcpArgs);
    }
    const env: NodeJS.ProcessEnv = { ...context.env };
    if (context.observe !== 'off') {
      env.SPECULATE_OBSERVER_SOCKET = context.hook.socketPath;
      env.SPECULATE_OBSERVER_CAPABILITY = context.hook.capability;
      env.SPECULATE_OBSERVER_LAUNCH_ID = context.hook.launchId;
      env.SPECULATE_OBSERVER_CLIENT = 'claude';
    }
    if (context.observe === 'proxy' && context.relayBaseUrl) env.ANTHROPIC_BASE_URL = context.relayBaseUrl;
    const upstreamBaseUrl = context.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    return {
      command: context.clientBin ?? resolveClaudeBin(context.env.SPECULATE_CLAUDE_BIN ?? 'claude', {
        pathEnv: context.env.PATH,
        home,
      }),
      args,
      env,
      upstreamBaseUrl,
      transport: 'messages',
      disabledCapabilities,
      async cleanup() { rmSync(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
