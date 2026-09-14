import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
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
} from '../observerTypes.js';

const MAX_STREAM_ARGUMENT_BYTES = 64 * 1024;
const MAX_ACTIVE_BLOCKS = 256;
const MAX_REQUEST_TOOLS = 512;

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

function currentPrompt(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.messages)) return null;
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index];
    if (!object(message) || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content || null;
    if (!Array.isArray(message.content)) return null;
    const text = message.content.flatMap((block) =>
      object(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    ).join('\n');
    if (text) return text;
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

  constructor(
    private readonly context: SessionContext,
    private readonly request: AgentAdapterRequest,
    private readonly environment: AgentAdapterEnvironment,
    private readonly release: () => void,
  ) {}

  observeRequestBody(body: Uint8Array): readonly Observation[] {
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
    const text = currentPrompt(parsed);
    if (text === null) return [];
    const stableId = createHash('sha256').update(this.context.conversationId).update('\0').update(Buffer.from(body)).digest('base64url');
    return this.observation({
      kind: 'prompt',
      context: this.context,
      eventId: this.eventId('prompt', stableId),
      observedAt: this.now(),
      text,
    });
  }

  observeResponseStart(response: AgentAdapterResponse): readonly Observation[] {
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

  observeResponseChunk(chunk: Uint8Array): readonly Observation[] {
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

  observeResponseEnd(): readonly Observation[] {
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
    return this.observation({
      kind: 'stream-call',
      context: this.context,
      eventId: this.eventId('stream-call', callId),
      observedAt: this.now(),
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

  constructor(private readonly environment: AgentAdapterEnvironment) {}

  startRequest(request: AgentAdapterRequest): AgentAdapterRequestObserver | null {
    if (this.closed || request.transport !== 'http' || request.method.toUpperCase() !== 'POST' || requestPath(request.path) !== '/v1/messages') return null;
    const conversationId = header(request.headers, 'x-claude-code-session-id');
    if (!conversationId) return null;
    const context = this.context(conversationId);
    if (!context) return null;
    let observer!: ClaudeRequestObserver;
    observer = new ClaudeRequestObserver(context, request, this.environment, () => this.requests.delete(observer));
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
  return {
    agent: 'claude',
    createConnection: () => new ClaudeConnection(environment),
    normalizeHook(payload: unknown): readonly Observation[] {
      if (!object(payload) || payload.hook_event_name !== 'UserPromptSubmit' || typeof payload.session_id !== 'string' || typeof payload.prompt !== 'string') return [];
      if (payload.session_id.length === 0 || payload.session_id.length > 512 ||
        Buffer.byteLength(payload.session_id, 'utf8') > 512 || payload.prompt.length > MAX_OBSERVATION_BYTES ||
        Buffer.byteLength(payload.prompt, 'utf8') > MAX_OBSERVATION_BYTES) return [];
      let context: SessionContext | null = null;
      try {
        const parsed = sessionContextSchema.safeParse(environment.contextForConversation(payload.session_id));
        if (parsed.success && parsed.data.agent === 'claude' && parsed.data.conversationId === payload.session_id) context = parsed.data;
      } catch {
        return [];
      }
      if (!context) return [];
      const eventId = environment.eventId?.('prompt', `hook:${payload.session_id}:${createHash('sha256').update(payload.prompt).digest('base64url')}`) ??
        `claude:prompt:hook:${payload.session_id}:${randomUUID()}`;
      const parsed = observationSchema.safeParse({
        kind: 'prompt',
        context,
        eventId,
        observedAt: environment.now?.() ?? Date.now(),
        text: payload.prompt,
      });
      return parsed.success ? [parsed.data] : [];
    },
  };
}
