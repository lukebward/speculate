import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { PromptOccurrenceCorrelator, promptNativeId } from './promptOccurrence.js';
import { HookBoundaryTracker } from '../hookBoundaries.js';
import type { ObservationBudget } from '../observationBudget.js';
import { codexSubcommand, resolveCodexBin, type CodexConfigRead } from '../codexClient.js';
import { isStdioEntry, wrapLaunchEntry, type McpServerEntry } from '../hostConfig.js';
import { sessionObserverHookPath } from '../packageResources.js';
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
  type AgentAdapterWebSocketObserver,
  type Observation,
  type RegisteredRoute,
  type SessionContext,
  type WebSocketMessage,
  type AgentLaunchContext,
  type LaunchPlan,
} from '../observerTypes.js';

const MAX_STREAM_ARGUMENT_BYTES = 64 * 1024;
const MAX_REQUEST_TOOLS = 512;
const MAX_ACTIVE_RESPONSES = 64;
const MAX_COMPLETED_RESPONSES = 64;
const MAX_RESPONSE_CALLS = 256;
const MAX_CONNECTION_ANALYSIS_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_NAME_BYTES = 512;
const RETAINED_ENTRY_BYTES = 192;
const RETAINED_TRACKER_BYTES = 512;
const GLOBAL_ADAPTER_ANALYSIS_BYTES = 8 * 1024 * 1024;

interface ResponseContext {
  complete: boolean;
  routesByName: Map<string, RegisteredRoute>;
}

interface ActiveCall {
  callId: string;
  name: string;
  arguments: string;
  retainedBytes: number;
}

interface CompletedResponse {
  context: ResponseContext;
  retainedBytes: number;
}

class RetainedBudget {
  private used = 0;

  constructor(private readonly shared?: ObservationBudget) {}

  reserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CONNECTION_ANALYSIS_BYTES - this.used) return false;
    if (bytes > 0 && this.shared && !this.shared.reserve(bytes)) return false;
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    const released = Math.min(this.used, Math.max(0, bytes));
    this.used -= released;
    this.shared?.release(released);
  }
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

function requestPath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path.split('?', 1)[0] ?? null;
}

function responsesPath(path: string): boolean {
  return path === '/responses' || path === '/v1/responses';
}

function modelToolName(route: RegisteredRoute): string {
  return `mcp__${route.hostServerAlias}__${route.exposedTool}`;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && Buffer.byteLength(value, 'utf8') <= 512;
}

function boundedToolName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_NAME_BYTES &&
    Buffer.byteLength(value, 'utf8') <= MAX_TOOL_NAME_BYTES;
}

function retainedStringBytes(value: string): number {
  return RETAINED_ENTRY_BYTES + value.length * 2;
}

function retainedRouteBytes(name: string, route: RegisteredRoute): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(route);
  } catch {
    return MAX_CONNECTION_ANALYSIS_BYTES + 1;
  }
  return RETAINED_ENTRY_BYTES + retainedStringBytes(name) + retainedStringBytes(serialized);
}

function retainedContextBytes(responseId: string, context: ResponseContext): number {
  let bytes = RETAINED_ENTRY_BYTES + retainedStringBytes(responseId);
  for (const [name, route] of context.routesByName) bytes += retainedRouteBytes(name, route);
  return bytes;
}

function terminalState(event: Record<string, unknown>): 'completed' | 'failed' | null {
  if (event.type === 'response.completed') {
    return object(event.response) && event.response.status !== undefined && event.response.status !== 'completed'
      ? 'failed'
      : 'completed';
  }
  if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'response.cancelled' ||
    event.type === 'response.canceled' || event.type === 'response.error' || event.type === 'response.aborted') return 'failed';
  if (event.type === 'error' && (boundedId(event.response_id) || boundedId(event.stream_id) ||
    (object(event.response) && boundedId(event.response.id)))) return 'failed';
  return null;
}

function inputText(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (!Array.isArray(value)) return null;
  for (let index = value.length - 1; index >= 0; index--) {
    const item = value[index];
    if (!object(item)) return null;
    if (item.type === 'function_call_output') continue;
    if (item.role === 'user') {
      if (typeof item.content === 'string') return item.content || null;
      if (!Array.isArray(item.content)) return null;
      const text = item.content.flatMap((part) =>
        object(part) && (part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string'
          ? [part.text]
          : []
      ).join('\n');
      return text || null;
    }
    if (item.type === 'input_text' && typeof item.text === 'string') return item.text || null;
    return null;
  }
  return null;
}

class CodexConnection implements AgentAdapterConnection {
  private readonly requests = new Set<CodexRequestObserver>();
  private readonly sockets = new Set<CodexWebSocketObserver>();
  private readonly completed = new Map<string, CompletedResponse>();
  private readonly retainedBudget: RetainedBudget;
  private closed = false;

  constructor(
    private readonly environment: AgentAdapterEnvironment,
    private readonly promptOccurrences: PromptOccurrenceCorrelator,
    initiallyClosed = false,
  ) {
    this.retainedBudget = new RetainedBudget(environment.analysisBudget);
    if (initiallyClosed) this.closed = true;
  }

  startRequest(request: AgentAdapterRequest): AgentAdapterRequestObserver | null {
    if (this.closed || request.transport !== 'http' || request.method.toUpperCase() !== 'POST' ||
      !responsesPath(requestPath(request.path) ?? '')) return null;
    const context = this.context(request.headers);
    if (!context) return null;
    let observer!: CodexRequestObserver;
    observer = new CodexRequestObserver(
      context,
      request,
      this.environment,
      this.promptOccurrences,
      this.retainedBudget,
      (responseId, responseContext) => this.remember(responseId, responseContext),
      (responseId) => this.completed.get(responseId)?.context ?? null,
      () => this.requests.delete(observer),
    );
    this.requests.add(observer);
    return observer;
  }

  startWebSocket(request: AgentAdapterRequest): AgentAdapterWebSocketObserver | null {
    if (this.closed || request.transport !== 'websocket' || request.method.toUpperCase() !== 'GET' ||
      !responsesPath(requestPath(request.path) ?? '')) return null;
    const context = this.context(request.headers);
    if (!context) return null;
    let observer!: CodexWebSocketObserver;
    observer = new CodexWebSocketObserver(
      context,
      this.environment,
      this.promptOccurrences,
      this.retainedBudget,
      (responseId, responseContext) => this.remember(responseId, responseContext),
      (responseId) => this.completed.get(responseId)?.context ?? null,
      () => this.sockets.delete(observer),
    );
    this.sockets.add(observer);
    return observer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.abort();
    for (const socket of this.sockets) socket.abort();
    this.requests.clear();
    this.sockets.clear();
    for (const entry of this.completed.values()) this.retainedBudget.release(entry.retainedBytes);
    this.completed.clear();
  }

  private context(headers: Readonly<Record<string, string | string[] | undefined>>): SessionContext | null {
    const conversationId = header(headers, 'thread-id') ?? header(headers, 'session-id');
    if (!boundedId(conversationId)) return null;
    try {
      const parsed = sessionContextSchema.safeParse(this.environment.contextForConversation(conversationId));
      return parsed.success && parsed.data.agent === 'codex' && parsed.data.conversationId === conversationId
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  }

  private remember(responseId: string, responseContext: ResponseContext): void {
    if (this.closed || !boundedId(responseId) || !responseContext.complete) return;
    const retainedBytes = retainedContextBytes(responseId, responseContext);
    const existing = this.completed.get(responseId);
    if (existing) {
      this.completed.delete(responseId);
      this.retainedBudget.release(existing.retainedBytes);
    }
    while (this.completed.size >= MAX_COMPLETED_RESPONSES) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = this.completed.get(oldest);
      this.completed.delete(oldest);
      if (entry) this.retainedBudget.release(entry.retainedBytes);
    }
    let reserved = this.retainedBudget.reserve(retainedBytes);
    while (!reserved && this.completed.size > 0) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = this.completed.get(oldest);
      this.completed.delete(oldest);
      if (entry) this.retainedBudget.release(entry.retainedBytes);
      reserved = this.retainedBudget.reserve(retainedBytes);
    }
    if (!reserved) return;
    this.completed.set(responseId, {
      context: {
        complete: true,
        routesByName: new Map(responseContext.routesByName),
      },
      retainedBytes,
    });
  }
}

class ResponseTracker {
  readonly responseContext: ResponseContext = { complete: false, routesByName: new Map() };
  responseId: string | null = null;
  private readonly calls = new Map<string, ActiveCall>();
  private readonly emitted = new Set<string>();
  private retainedBytes = 0;
  private stopped = false;
  private boundaryAt: number | null = null;
  private opaqueExec = false;

  constructor(
    private readonly context: SessionContext,
    private readonly environment: AgentAdapterEnvironment,
    private readonly promptOccurrences: PromptOccurrenceCorrelator,
    private readonly retainedBudget: RetainedBudget,
    private readonly remember: (responseId: string, responseContext: ResponseContext) => void,
    private readonly previous: (responseId: string) => ResponseContext | null,
  ) {
    if (!this.retain(RETAINED_TRACKER_BYTES)) this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  retainLane(lane: string): boolean {
    return this.retain(RETAINED_ENTRY_BYTES + retainedStringBytes(lane));
  }

  readRequest(value: Record<string, unknown>, bytes: Uint8Array, observedAt?: number): Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (this.stopped) return [];
    const hasTools = Object.prototype.hasOwnProperty.call(value, 'tools');
    if (hasTools) {
      this.responseContext.complete = true;
      this.captureRoutes(value.tools);
    } else if (boundedId(value.previous_response_id)) {
      try {
        this.environment.onExecutionWindow?.({
          source: 'model', phase: 'closed', context: this.context,
          windowId: value.previous_response_id, observedAt: this.boundaryAt,
        });
      } catch {}
      const prior = this.previous(value.previous_response_id);
      if (prior?.complete) {
        this.responseContext.complete = true;
        this.captureContext(prior);
      }
    } else {
      this.responseContext.complete = true;
    }
    if (this.stopped || !this.responseContext.complete) return [];
    const text = inputText(value.input);
    if (text === null) return [];
    const stableId = createHash('sha256').update(this.context.conversationId).update('\0').update(Buffer.from(bytes)).digest('base64url');
    const nativeId = promptNativeId({ previousResponseId: value.previous_response_id ?? null, input: value.input });
    return this.observation({
      kind: 'prompt',
      context: this.context,
      eventId: this.eventId('prompt', stableId),
      observedAt: this.boundaryAt,
      occurrenceId: this.promptOccurrences.identify(this.context.conversationId, text, 'proxy', nativeId),
      text,
    });
  }

  readEvent(event: Record<string, unknown>, observedAt?: number): Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (this.stopped) return [];
    if (terminalState(event) === 'failed') {
      try { this.environment.onTrackingLoss?.(this.boundaryAt); } catch {}
      this.abort();
      return [];
    }
    if (event.type === 'response.created' && object(event.response) && boundedId(event.response.id)) {
      this.setResponseId(event.response.id);
      return [];
    }
    if (event.type === 'response.output_item.added' && object(event.item)) {
      this.captureCall(event.item);
      return [];
    }
    if (event.type === 'response.function_call_arguments.delta' && boundedId(event.item_id) && typeof event.delta === 'string') {
      const call = this.calls.get(event.item_id);
      if (call) {
        if (Buffer.byteLength(call.arguments, 'utf8') + Buffer.byteLength(event.delta, 'utf8') > MAX_STREAM_ARGUMENT_BYTES) {
          this.dropCall(event.item_id, call);
        } else {
          const retainedBytes = event.delta.length * 2;
          if (!this.retain(retainedBytes)) this.abort();
          else {
            call.arguments += event.delta;
            call.retainedBytes += retainedBytes;
          }
        }
      }
      return [];
    }
    if (event.type === 'response.function_call_arguments.done' && boundedId(event.item_id) && typeof event.arguments === 'string') {
      const call = this.calls.get(event.item_id);
      if (call) {
        if (Buffer.byteLength(event.arguments, 'utf8') > MAX_STREAM_ARGUMENT_BYTES) this.dropCall(event.item_id, call);
        else this.replaceArguments(call, event.arguments);
      }
      return [];
    }
    if (event.type === 'response.output_item.done' && object(event.item)) {
      const observations = this.completedItem(event.item);
      if (boundedId(event.item.id)) {
        const call = this.calls.get(event.item.id);
        if (call) this.dropCall(event.item.id, call);
      }
      return observations;
    }
    if (event.type === 'response.completed' && object(event.response)) {
      if (boundedId(event.response.id)) this.setResponseId(event.response.id);
      const observations = Array.isArray(event.response.output)
        ? event.response.output.flatMap((item) => object(item) ? this.completedItem(item) : [])
        : [];
      this.openOpaqueWindow();
      this.complete();
      return observations;
    }
    return [];
  }

  readJsonResponse(value: unknown, observedAt?: number): Observation[] {
    this.boundaryAt = observedAt ?? this.now();
    if (!object(value)) return [];
    if (boundedId(value.id)) this.setResponseId(value.id);
    if (value.status !== 'completed') {
      this.abort();
      return [];
    }
    const observations = Array.isArray(value.output)
      ? value.output.flatMap((item) => object(item) ? this.completedItem(item) : [])
      : [];
    this.openOpaqueWindow();
    this.complete();
    return observations;
  }

  complete(): void {
    if (!this.stopped && this.responseId) this.remember(this.responseId, this.responseContext);
  }

  abort(): void {
    if (this.stopped && this.retainedBytes === 0) return;
    this.stopped = true;
    this.calls.clear();
    this.emitted.clear();
    this.responseContext.routesByName.clear();
    this.responseId = null;
    this.retainedBudget.release(this.retainedBytes);
    this.retainedBytes = 0;
  }

  private captureRoutes(value: unknown): void {
    if (!Array.isArray(value) || value.length > MAX_REQUEST_TOOLS) return;
    const definitions = new Map<string, Record<string, unknown>[]>();
    for (const item of value) {
      if (!object(item) || item.type !== 'function' || !boundedToolName(item.name) ||
        !object(item.parameters) || item.defer_loading === true) continue;
      const list = definitions.get(item.name) ?? [];
      list.push(item.parameters);
      definitions.set(item.name, list);
    }
    for (const [name, schemas] of definitions) {
      if (schemas.length !== 1) continue;
      const matches = this.environment.routes().filter((route) =>
        route.hostClient === 'codex' && modelToolName(route) === name && isDeepStrictEqual(route.inputSchema, schemas[0])
      );
      if (matches.length === 1) {
        const route = matches[0]!;
        if (!this.retain(retainedRouteBytes(name, route))) {
          this.abort();
          return;
        }
        this.responseContext.routesByName.set(name, route);
      }
    }
  }

  private captureContext(context: ResponseContext): void {
    for (const [name, route] of context.routesByName) {
      if (!this.retain(retainedRouteBytes(name, route))) {
        this.abort();
        return;
      }
      this.responseContext.routesByName.set(name, route);
    }
  }

  private captureCall(item: Record<string, unknown>): void {
    if (item.type !== 'function_call' || !boundedId(item.id) || !boundedId(item.call_id) || !boundedToolName(item.name)) return;
    if (this.calls.has(item.id)) return;
    if (!this.calls.has(item.id) && this.calls.size >= MAX_RESPONSE_CALLS) return;
    const args = typeof item.arguments === 'string' ? item.arguments : '';
    if (Buffer.byteLength(args, 'utf8') > MAX_STREAM_ARGUMENT_BYTES) return;
    const retainedBytes = RETAINED_ENTRY_BYTES + retainedStringBytes(item.id) + retainedStringBytes(item.call_id) +
      retainedStringBytes(item.name) + retainedStringBytes(args);
    if (!this.retain(retainedBytes)) {
      this.abort();
      return;
    }
    this.calls.set(item.id, {
      callId: item.call_id,
      name: item.name,
      arguments: args,
      retainedBytes,
    });
  }

  private completedItem(item: Record<string, unknown>): Observation[] {
    if (item.type === 'custom_tool_call' && item.name === 'exec' &&
      (boundedId(item.call_id) || boundedId(item.id))) {
      this.opaqueExec = true;
      return [];
    }
    if (item.type !== 'function_call') return [];
    const active = boundedId(item.id) ? this.calls.get(item.id) : undefined;
    const callId = boundedId(item.call_id) ? item.call_id : active?.callId;
    const name = typeof item.name === 'string' ? item.name : active?.name;
    const argsText = typeof item.arguments === 'string' ? item.arguments : active?.arguments;
    if (!boundedId(callId) || !boundedToolName(name) || typeof argsText !== 'string' ||
      Buffer.byteLength(argsText, 'utf8') > MAX_STREAM_ARGUMENT_BYTES || this.emitted.has(callId) ||
      this.emitted.size >= MAX_RESPONSE_CALLS) return [];
    let args: unknown;
    try {
      args = JSON.parse(argsText) as unknown;
    } catch {
      return [];
    }
    if (!object(args)) return [];
    const route = this.responseContext.routesByName.get(name);
    if (!route) return [];
    if (!this.retain(RETAINED_ENTRY_BYTES + retainedStringBytes(callId))) {
      this.abort();
      return [];
    }
    this.emitted.add(callId);
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

  private replaceArguments(call: ActiveCall, value: string): void {
    const difference = value.length * 2 - call.arguments.length * 2;
    if (difference > 0 && !this.retain(difference)) {
      this.abort();
      return;
    }
    if (difference < 0) this.releaseRetained(-difference);
    call.arguments = value;
    call.retainedBytes += difference;
  }

  private dropCall(itemId: string, call: ActiveCall): void {
    this.calls.delete(itemId);
    this.releaseRetained(call.retainedBytes);
  }

  private setResponseId(responseId: string): void {
    if (this.responseId === responseId) return;
    const priorBytes = this.responseId === null ? 0 : RETAINED_ENTRY_BYTES + retainedStringBytes(this.responseId);
    if (priorBytes > 0) this.releaseRetained(priorBytes);
    const nextBytes = RETAINED_ENTRY_BYTES + retainedStringBytes(responseId);
    if (!this.retain(nextBytes)) {
      this.abort();
      return;
    }
    this.responseId = responseId;
  }

  private retain(bytes: number): boolean {
    if (this.stopped || !this.retainedBudget.reserve(bytes)) return false;
    this.retainedBytes += bytes;
    return true;
  }

  private releaseRetained(bytes: number): void {
    const released = Math.min(bytes, this.retainedBytes);
    this.retainedBytes -= released;
    this.retainedBudget.release(released);
  }

  private observation(value: unknown): Observation[] {
    const parsed = observationSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }

  private now(): number {
    return this.environment.now?.() ?? Date.now();
  }

  private eventId(kind: Observation['kind'], stableId: string): string {
    return this.environment.eventId?.(kind, stableId) ?? `codex:${kind}:${stableId || randomUUID()}`;
  }

  private openOpaqueWindow(): void {
    if (!this.opaqueExec || !this.responseId) return;
    try {
      this.environment.onExecutionWindow?.({
        source: 'model', phase: 'opened', context: this.context,
        windowId: this.responseId, observedAt: this.boundaryAt ?? this.now(),
      });
    } catch {}
  }
}

class CodexRequestObserver implements AgentAdapterRequestObserver {
  private readonly decoder = new StringDecoder('utf8');
  private readonly tracker: ResponseTracker;
  private responseMode: 'sse' | 'json' | 'none' = 'none';
  private responseText = '';
  private responseBytes = 0;
  private requestReady = false;
  private stopped = false;
  private released = false;
  private retainedResponseBytes = 0;

  constructor(
    context: SessionContext,
    private readonly request: AgentAdapterRequest,
    environment: AgentAdapterEnvironment,
    promptOccurrences: PromptOccurrenceCorrelator,
    private readonly retainedBudget: RetainedBudget,
    remember: (responseId: string, responseContext: ResponseContext) => void,
    previous: (responseId: string) => ResponseContext | null,
    private readonly release: () => void,
  ) {
    this.tracker = new ResponseTracker(context, environment, promptOccurrences, retainedBudget, remember, previous);
  }

  observeRequestBody(body: Uint8Array, observedAt?: number): readonly Observation[] {
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
    this.requestReady = true;
    const observations = this.tracker.readRequest(parsed, body, observedAt);
    if (this.tracker.isStopped) this.abort();
    return observations;
  }

  observeResponseStart(response: AgentAdapterResponse, _observedAt?: number): readonly Observation[] {
    if (this.stopped || !this.requestReady || response.status < 200 || response.status >= 300 || !inspectableEncoding(response.headers)) {
      this.abort();
      return [];
    }
    const contentType = header(response.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType === 'text/event-stream') this.responseMode = 'sse';
    else if (contentType === 'application/json') this.responseMode = 'json';
    else this.abort();
    if (this.responseMode !== 'none' && !this.replaceResponseText('')) this.abort();
    return [];
  }

  observeResponseChunk(chunk: Uint8Array, observedAt?: number): readonly Observation[] {
    if (this.stopped || this.responseMode === 'none') return [];
    this.responseBytes += chunk.byteLength;
    if (this.responseBytes > MAX_OBSERVATION_BYTES) {
      this.abort();
      return [];
    }
    if (!this.replaceResponseText(this.responseText + this.decoder.write(Buffer.from(chunk)))) {
      this.abort();
      return [];
    }
    const observations = this.responseMode === 'sse' ? this.readSse(false, observedAt) : [];
    if (this.tracker.isStopped) this.abort();
    return observations;
  }

  observeResponseEnd(observedAt?: number): readonly Observation[] {
    if (this.stopped || this.responseMode === 'none') return [];
    if (!this.replaceResponseText(this.responseText + this.decoder.end())) {
      this.abort();
      return [];
    }
    let observations: Observation[];
    if (this.responseMode === 'sse') observations = this.readSse(true, observedAt);
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.responseText) as unknown;
      } catch {
        parsed = null;
      }
      observations = this.tracker.readJsonResponse(parsed, observedAt);
    }
    this.finish();
    return observations;
  }

  abort(): void {
    if (this.stopped) return;
    this.tracker.abort();
    this.finish();
  }

  private readSse(ended: boolean, observedAt?: number): Observation[] {
    const out: Observation[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.responseText);
      if (!match) break;
      const block = this.responseText.slice(0, match.index);
      this.replaceResponseText(this.responseText.slice(match.index + match[0].length));
      out.push(...this.readSseBlock(block, observedAt));
    }
    if (ended && this.responseText.trim()) out.push(...this.readSseBlock(this.responseText, observedAt));
    if (ended) this.replaceResponseText('');
    return out;
  }

  private readSseBlock(block: string, observedAt?: number): Observation[] {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return [];
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
    return object(event) ? this.tracker.readEvent(event, observedAt) : [];
  }

  private finish(): void {
    if (this.stopped) return;
    this.tracker.abort();
    this.stopped = true;
    this.responseMode = 'none';
    this.responseText = '';
    this.retainedBudget.release(this.retainedResponseBytes);
    this.retainedResponseBytes = 0;
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }

  private replaceResponseText(value: string): boolean {
    const nextBytes = 256 + value.length * 4;
    if (nextBytes > this.retainedResponseBytes && !this.retainedBudget.reserve(nextBytes - this.retainedResponseBytes)) {
      return false;
    }
    if (nextBytes < this.retainedResponseBytes) this.retainedBudget.release(this.retainedResponseBytes - nextBytes);
    this.retainedResponseBytes = nextBytes;
    this.responseText = value;
    return true;
  }
}

interface WebSocketResponse {
  lane: string;
  tracker: ResponseTracker;
}

class CodexWebSocketObserver implements AgentAdapterWebSocketObserver {
  private readonly pendingByLane = new Map<string, ResponseTracker[]>();
  private readonly activeByResponse = new Map<string, WebSocketResponse>();
  private readonly activeByLane = new Map<string, WebSocketResponse>();
  private readonly trackers = new Set<ResponseTracker>();
  private ready = false;
  private stopped = false;

  constructor(
    private readonly context: SessionContext,
    private readonly environment: AgentAdapterEnvironment,
    private readonly promptOccurrences: PromptOccurrenceCorrelator,
    private readonly retainedBudget: RetainedBudget,
    private readonly remember: (responseId: string, responseContext: ResponseContext) => void,
    private readonly previous: (responseId: string) => ResponseContext | null,
    private readonly release: () => void,
  ) {}

  observeResponseStart(response: AgentAdapterResponse, _observedAt?: number): readonly Observation[] {
    if (this.stopped || response.status !== 101) {
      this.abort();
      return [];
    }
    this.ready = true;
    return [];
  }

  observeClientMessage(message: WebSocketMessage, observedAt?: number): readonly Observation[] {
    if (!this.ready || this.stopped || message.binary || message.data.byteLength > MAX_OBSERVATION_BYTES) return [];
    const parsed = this.parse(message.data);
    if (!parsed || parsed.type !== 'response.create' || this.trackers.size >= MAX_ACTIVE_RESPONSES) return [];
    const tracker = new ResponseTracker(
      this.context,
      this.environment,
      this.promptOccurrences,
      this.retainedBudget,
      this.remember,
      this.previous,
    );
    const lane = boundedId(parsed.stream_id) ? parsed.stream_id : '';
    if (tracker.isStopped || !tracker.retainLane(lane)) {
      tracker.abort();
      return [];
    }
    this.trackers.add(tracker);
    const pending = this.pendingByLane.get(lane) ?? [];
    pending.push(tracker);
    this.pendingByLane.set(lane, pending);
    const observations = tracker.readRequest(parsed, message.data, observedAt);
    if (tracker.isStopped) this.releaseTracker(tracker);
    return observations;
  }

  observeServerMessage(message: WebSocketMessage, observedAt?: number): readonly Observation[] {
    if (!this.ready || this.stopped || message.binary || message.data.byteLength > MAX_OBSERVATION_BYTES) return [];
    const event = this.parse(message.data);
    if (!event) return [];
    if (event.type === 'response.created') {
      const responseId = object(event.response) && boundedId(event.response.id) ? event.response.id : null;
      if (!responseId) return [];
      const lane = boundedId(event.stream_id) ? event.stream_id : null;
      const tracker = this.takePending(lane);
      if (!tracker) return [];
      tracker.readEvent(event, observedAt);
      if (tracker.isStopped) {
        this.releaseTracker(tracker);
        return [];
      }
      const response = { lane: lane ?? '', tracker };
      if (this.activeByResponse.has(responseId)) {
        this.releaseTracker(tracker);
        return [];
      }
      this.activeByResponse.set(responseId, response);
      this.activeByLane.set(response.lane, response);
      return [];
    }
    const terminal = terminalState(event);
    const response = this.responseFor(event);
    if (!response) {
      if (terminal !== null) {
        const lane = boundedId(event.stream_id) ? event.stream_id : null;
        const pending = this.takePending(lane);
        if (pending) this.releaseTracker(pending);
      }
      return [];
    }
    if (terminal === 'failed') {
      try { this.environment.onTrackingLoss?.(observedAt ?? Date.now()); } catch {}
    }
    const observations = terminal === 'failed' ? [] : response.tracker.readEvent(event, observedAt);
    if (terminal !== null || response.tracker.isStopped) this.releaseResponse(response);
    return observations;
  }

  abort(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const tracker of this.trackers) tracker.abort();
    this.trackers.clear();
    this.pendingByLane.clear();
    this.activeByResponse.clear();
    this.activeByLane.clear();
    this.release();
  }

  private parse(data: Uint8Array): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(data).toString('utf8')) as unknown;
    } catch {
      return null;
    }
    return object(parsed) ? parsed : null;
  }

  private takePending(lane: string | null): ResponseTracker | null {
    if (lane !== null) {
      const pending = this.pendingByLane.get(lane);
      const tracker = pending?.shift() ?? null;
      if (pending?.length === 0) this.pendingByLane.delete(lane);
      return tracker;
    }
    const entries = [...this.pendingByLane].filter(([, items]) => items.length > 0);
    if (entries.length !== 1) return null;
    const [key, pending] = entries[0]!;
    const tracker = pending.shift() ?? null;
    if (pending.length === 0) this.pendingByLane.delete(key);
    return tracker;
  }

  private responseFor(event: Record<string, unknown>): WebSocketResponse | null {
    const responseId = boundedId(event.response_id)
      ? event.response_id
      : object(event.response) && boundedId(event.response.id) ? event.response.id : null;
    if (responseId) return this.activeByResponse.get(responseId) ?? null;
    const lane = boundedId(event.stream_id) ? event.stream_id : null;
    if (lane !== null) return this.activeByLane.get(lane) ?? null;
    return this.activeByResponse.size === 1 ? this.activeByResponse.values().next().value ?? null : null;
  }

  private releaseResponse(response: WebSocketResponse): void {
    this.releaseTracker(response.tracker);
  }

  private releaseTracker(tracker: ResponseTracker): void {
    for (const [lane, pending] of this.pendingByLane) {
      const remaining = pending.filter((item) => item !== tracker);
      if (remaining.length === 0) this.pendingByLane.delete(lane);
      else if (remaining.length !== pending.length) this.pendingByLane.set(lane, remaining);
    }
    for (const [responseId, response] of this.activeByResponse) {
      if (response.tracker === tracker) this.activeByResponse.delete(responseId);
    }
    for (const [lane, response] of this.activeByLane) {
      if (response.tracker === tracker) this.activeByLane.delete(lane);
    }
    this.trackers.delete(tracker);
    tracker.abort();
  }
}

export function codexAdapter(environment: AgentAdapterEnvironment): AgentAdapter {
  const promptOccurrences = new PromptOccurrenceCorrelator(() => environment.now?.() ?? Date.now());
  const hookBoundaries = new HookBoundaryTracker();
  const retainedGlobalAnalysis = environment.analysisBudget?.reserve(GLOBAL_ADAPTER_ANALYSIS_BYTES)
    ? GLOBAL_ADAPTER_ANALYSIS_BYTES
    : environment.analysisBudget ? 0 : GLOBAL_ADAPTER_ANALYSIS_BYTES;
  let closed = retainedGlobalAnalysis === 0;
  return {
    agent: 'codex',
    createConnection: () => new CodexConnection(environment, promptOccurrences, closed),
    normalizeHook(payload: unknown, boundaryAt?: number): readonly Observation[] {
      if (closed) return [];
      if (!record(payload)) return [];
      const conversationId = boundedId(payload.thread_id)
        ? payload.thread_id
        : boundedId(payload.session_id) ? payload.session_id : null;
      if (!conversationId) return [];
      let context: SessionContext | null = null;
      try {
        const parsed = sessionContextSchema.safeParse(environment.contextForConversation(
          conversationId,
          typeof payload.cwd === 'string' ? payload.cwd : undefined,
        ));
        if (parsed.success && parsed.data.agent === 'codex' && parsed.data.conversationId === conversationId) context = parsed.data;
      } catch {}
      if (!context) return [];
      const event = typeof payload.type === 'string'
        ? payload.type
        : typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
      const observedAt = boundaryAt ?? environment.now?.() ?? Date.now();
      if (event === 'session-end' || event === 'SessionEnd') {
        if (hookBoundaries.endSession(context)) {
          try { environment.onTrackingLoss?.(observedAt); } catch {}
        }
        return [];
      }
      const phase = event === 'before-tool-use' || event === 'PreToolUse'
        ? 'started'
        : event === 'after-tool-use' || event === 'tool-use-error' || event === 'PostToolUse' || event === 'PostToolUseFailure'
          ? 'settled'
          : null;
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
      const callId = boundedId(payload.tool_use_id) ? payload.tool_use_id : null;
      const args = record(payload.arguments) ? payload.arguments : record(payload.tool_input) ? payload.tool_input : null;
      if (phase && toolName && callId && args) {
        const routes = environment.routes().filter((route) => route.hostClient === 'codex' && modelToolName(route) === toolName);
        const startClassification = phase === 'started'
          ? routes.length === 1 && routes[0]!.readOnly === true
            ? { kind: 'read' as const, routeId: routes[0]!.routeId, generation: routes[0]!.generation }
            : { kind: 'mutation' as const }
          : undefined;
        const boundary = hookBoundaries.observeStatus({
          context,
          toolName,
          callId,
          ...(boundedId(payload.agent_id) ? { actorId: payload.agent_id } : {}),
          ...(boundedId(payload.turn_id) ? { turnId: payload.turn_id } : {}),
        }, phase, startClassification);
        if (boundary.gap) {
          try { environment.onTrackingLoss?.(observedAt); } catch {}
        }
        if (boundary.duplicate) return [];
        if (boundary.classification?.kind === 'read') {
          try {
            environment.onToolCallMarker?.({
              source: 'hook', phase, context, routeId: boundary.classification.routeId,
              generation: boundary.classification.generation, callId, args,
              observedAt,
              ...(boundedId(payload.agent_id) ? { actorId: payload.agent_id } : {}),
              ...(boundedId(payload.turn_id) ? { turnId: payload.turn_id } : {}),
            });
          } catch {}
          return [];
        }
        const parsed = observationSchema.safeParse({
          kind: 'invalidate', context,
          eventId: environment.eventId?.('invalidate', `hook:${callId}:${phase}`) ??
            `codex:invalidate:hook:${callId}:${phase}:${randomUUID()}`,
          observedAt, routeIds: [], reason: phase === 'started' ? 'native-mutation-start' : 'native-mutation-settle',
        });
        return parsed.success ? [parsed.data] : [];
      }
      if ((event !== 'user-prompt-submit' && event !== 'UserPromptSubmit') || typeof payload.prompt !== 'string' ||
        Buffer.byteLength(payload.prompt, 'utf8') > MAX_OBSERVATION_BYTES) return [];
      const stableId = createHash('sha256').update(conversationId).update('\0').update(payload.prompt).digest('base64url');
      return [{
        kind: 'prompt', context,
        eventId: environment.eventId?.('prompt', `hook:${stableId}`) ?? `codex:prompt:hook:${randomUUID()}`,
        observedAt,
        occurrenceId: promptOccurrences.identify(conversationId, payload.prompt, 'hook'),
        text: payload.prompt,
      }];
    },
    close() {
      if (closed) return;
      closed = true;
      environment.analysisBudget?.release(retainedGlobalAnalysis);
    },
  };
}

export interface CodexLaunchContext extends AgentLaunchContext {
  nativeConfig: CodexConfigRead;
  nativeUpstreamBaseUrl?: string | null;
  nativeGlobalArgs?: readonly string[];
}

export function codexObserverHookCommand(): string {
  const script = sessionObserverHookPath();
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `${quote(process.execPath)} ${quote(script)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (record(value)) {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`;
  }
  throw new Error('unsupported Codex launch override value');
}

function override(path: string, value: unknown): string[] {
  return ['-c', `${path}=${toml(value)}`];
}

function nativeKeySegment(value: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function codexHookConfig(existing: unknown): Record<string, unknown> | null {
  if (existing !== undefined && !record(existing)) return null;
  const hooks = structuredClone((existing as Record<string, unknown> | undefined) ?? {});
  const handler = { type: 'command', command: codexObserverHookCommand(), async: true, timeout: 1 };
  for (const event of [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
  ]) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) return null;
    hooks[event] = [...((current as unknown[] | undefined) ?? []), { hooks: [handler] }];
  }
  return hooks;
}

function configOverrideTouches(args: readonly string[], root: string): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = arg === '-c' || arg === '--config'
      ? args[++index]
      : arg.startsWith('--config=') ? arg.slice('--config='.length) : null;
    if (!value) continue;
    const equalsAt = value.indexOf('=');
    const key = value.slice(0, equalsAt < 0 ? value.length : equalsAt).trim();
    const quotedRoot = JSON.stringify(root);
    if (key === root || key.startsWith(`${root}.`) || key === quotedRoot || key.startsWith(`${quotedRoot}.`)) return true;
  }
  return false;
}

function configOverrideAffectsOwnedTransport(args: readonly string[], alias: string): boolean {
  const root = `mcp_servers.${alias}`;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = arg === '-c' || arg === '--config'
      ? args[++index]
      : arg.startsWith('--config=') ? arg.slice('--config='.length) : null;
    if (!value) continue;
    const equalsAt = value.indexOf('=');
    const key = value.slice(0, equalsAt < 0 ? value.length : equalsAt).trim();
    if (key === 'mcp_servers') return true;
    if (key !== root && !key.startsWith(`${root}.`)) continue;
    if (key === root) return true;
    const field = key.slice(root.length + 1).split('.', 1)[0]!.replace(/^"|"$/g, '');
    if (field === 'command' || field === 'args' || field === 'env' || field === 'cwd' || field === 'type' || field === 'url') {
      return true;
    }
  }
  return false;
}

function supportsFinalOverridePlacement(args: readonly string[]): boolean {
  return codexSubcommand(args) === 'exec';
}

function placeGeneratedOverrides(generated: readonly string[], clientArgs: readonly string[]): string[] {
  if (!supportsFinalOverridePlacement(clientArgs)) return [...generated, ...clientArgs];
  const sentinel = clientArgs.indexOf('--');
  if (sentinel < 0) return [...clientArgs, ...generated];
  return [...clientArgs.slice(0, sentinel), ...generated, ...clientArgs.slice(sentinel)];
}

export function codexProxyOverrideIsVerifiable(
  config: Record<string, unknown>,
  nativeGlobalArgs: readonly string[],
  clientArgs: readonly string[] = [],
): boolean {
  const provider = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
  if (provider !== 'openai' && nativeKeySegment(provider) === null) return false;
  if (supportsFinalOverridePlacement(clientArgs)) return true;
  return provider === 'openai'
    ? !configOverrideTouches(nativeGlobalArgs, 'openai_base_url')
    : !configOverrideTouches(nativeGlobalArgs, 'model_providers');
}

export async function buildLaunchPlan(context: CodexLaunchContext): Promise<LaunchPlan> {
  const effective = context.nativeConfig.config;
  const generated: string[] = [];
  const disabledCapabilities: string[] = [];
  const modelProvider = typeof effective.model_provider === 'string' ? effective.model_provider : 'openai';
  if (context.observe === 'proxy' && context.relayBaseUrl &&
    !codexProxyOverrideIsVerifiable(effective, context.nativeGlobalArgs ?? [], context.clientArgs)) {
    throw new Error('Codex provider override would bypass proxy observation');
  }
  let upstreamBaseUrl: string;
  if (modelProvider === 'openai') {
    upstreamBaseUrl = typeof effective.openai_base_url === 'string'
      ? effective.openai_base_url
      : context.nativeUpstreamBaseUrl ?? '';
    if (!upstreamBaseUrl && context.observe === 'proxy') {
      throw new Error('Codex account route could not be verified for proxy observation');
    }
    if (!upstreamBaseUrl) upstreamBaseUrl = 'https://invalid.invalid';
    if (context.observe === 'proxy' && context.relayBaseUrl) generated.push(...override('openai_base_url', context.relayBaseUrl));
  } else {
    const providers = effective.model_providers;
    const selected = record(providers) ? providers[modelProvider] : null;
    if (!record(selected) || typeof selected.base_url !== 'string') {
      if (context.observe === 'proxy') throw new Error('selected Codex provider endpoint could not be verified');
      upstreamBaseUrl = 'https://invalid.invalid';
    } else {
      upstreamBaseUrl = selected.base_url;
    }
    if (context.observe === 'proxy' && context.relayBaseUrl) {
      const providerSegment = nativeKeySegment(modelProvider);
      if (!providerSegment) throw new Error('selected Codex provider could not be redirected safely');
      generated.push(...override(`model_providers.${providerSegment}.base_url`, context.relayBaseUrl));
    }
  }
  const servers = record(effective.mcp_servers) ? effective.mcp_servers : {};
  const finalOverrides = supportsFinalOverridePlacement(context.clientArgs);
  for (const [alias, raw] of Object.entries(servers)) {
    if (!record(raw) || raw.enabled === false || !isStdioEntry(raw as McpServerEntry)) continue;
    const aliasSegment = nativeKeySegment(alias);
    if (!aliasSegment) {
      disabledCapabilities.push('owned-mcp:unsupported-alias');
      continue;
    }
    if (!finalOverrides && configOverrideAffectsOwnedTransport(context.nativeGlobalArgs ?? [], aliasSegment)) {
      disabledCapabilities.push('owned-mcp:config-override-precedence');
      continue;
    }
    const wrapped = wrapLaunchEntry(alias, raw as McpServerEntry, context.self, {
      hostClient: 'codex',
      socketPath: context.session.socketPath,
      capability: context.session.capability,
      launchId: context.session.launchId,
    });
    if (!('entry' in wrapped)) {
      disabledCapabilities.push(`owned-mcp:${wrapped.reason}`);
      continue;
    }
    const entryOverrides: string[] = [];
    try {
      for (const key of ['command', 'args', 'env', 'cwd'] as const) {
        const value = wrapped.entry[key];
        if (value !== undefined) entryOverrides.push(...override(`mcp_servers.${aliasSegment}.${key}`, value));
      }
    } catch {
      disabledCapabilities.push('owned-mcp:unsupported-entry');
      continue;
    }
    generated.push(...entryOverrides);
  }
  if (context.observe !== 'off') {
    const hooks = codexHookConfig(effective.hooks);
    const features = record(effective.features) ? effective.features : {};
    const hooksRemainNative = !finalOverrides && configOverrideTouches(context.nativeGlobalArgs ?? [], 'hooks');
    if (hooksRemainNative) {
      disabledCapabilities.push('hook-observation:config-override-precedence');
    } else if (hooks && features.hooks !== false && features.codex_hooks !== false && effective.allow_managed_hooks_only !== true) {
      try { generated.push(...override('hooks', hooks)); }
      catch { disabledCapabilities.push('hook-observation:unsupported-settings'); }
    } else {
      disabledCapabilities.push('hook-observation:settings-policy');
    }
  }
  const env: NodeJS.ProcessEnv = { ...context.env };
  if (context.observe !== 'off') {
    env.SPECULATE_OBSERVER_SOCKET = context.hook.socketPath;
    env.SPECULATE_OBSERVER_CAPABILITY = context.hook.capability;
    env.SPECULATE_OBSERVER_LAUNCH_ID = context.hook.launchId;
    env.SPECULATE_OBSERVER_CLIENT = 'codex';
  }
  return {
    command: context.clientBin ?? resolveCodexBin(context.env.SPECULATE_CODEX_BIN ?? 'codex', {
      env: context.env,
      cwd: context.cwd,
    }),
    args: placeGeneratedOverrides(generated, context.clientArgs),
    env,
    upstreamBaseUrl,
    transport: 'responses',
    disabledCapabilities,
    async cleanup() {},
  };
}
