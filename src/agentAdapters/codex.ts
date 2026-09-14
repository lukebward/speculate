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
  type AgentAdapterWebSocketObserver,
  type Observation,
  type RegisteredRoute,
  type SessionContext,
  type WebSocketMessage,
} from '../observerTypes.js';

const MAX_STREAM_ARGUMENT_BYTES = 64 * 1024;
const MAX_REQUEST_TOOLS = 512;
const MAX_ACTIVE_RESPONSES = 64;
const MAX_COMPLETED_RESPONSES = 64;
const MAX_RESPONSE_CALLS = 256;

interface ResponseContext {
  complete: boolean;
  routesByName: Map<string, RegisteredRoute>;
}

interface ActiveCall {
  callId: string;
  name: string;
  arguments: string;
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
  private readonly completed = new Map<string, ResponseContext>();
  private closed = false;

  constructor(private readonly environment: AgentAdapterEnvironment) {}

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
      (responseId, responseContext) => this.remember(responseId, responseContext),
      (responseId) => this.completed.get(responseId) ?? null,
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
      (responseId, responseContext) => this.remember(responseId, responseContext),
      (responseId) => this.completed.get(responseId) ?? null,
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
    this.completed.delete(responseId);
    this.completed.set(responseId, {
      complete: true,
      routesByName: new Map(responseContext.routesByName),
    });
    while (this.completed.size > MAX_COMPLETED_RESPONSES) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }
}

class ResponseTracker {
  readonly responseContext: ResponseContext = { complete: false, routesByName: new Map() };
  responseId: string | null = null;
  private readonly calls = new Map<string, ActiveCall>();
  private readonly emitted = new Set<string>();
  private stopped = false;

  constructor(
    private readonly context: SessionContext,
    private readonly environment: AgentAdapterEnvironment,
    private readonly remember: (responseId: string, responseContext: ResponseContext) => void,
    private readonly previous: (responseId: string) => ResponseContext | null,
  ) {}

  readRequest(value: Record<string, unknown>, bytes: Uint8Array): Observation[] {
    if (this.stopped) return [];
    const hasTools = Object.prototype.hasOwnProperty.call(value, 'tools');
    if (hasTools) {
      this.responseContext.complete = true;
      this.captureRoutes(value.tools);
    } else if (boundedId(value.previous_response_id)) {
      const prior = this.previous(value.previous_response_id);
      if (prior?.complete) {
        this.responseContext.complete = true;
        this.responseContext.routesByName = new Map(prior.routesByName);
      }
    } else {
      this.responseContext.complete = true;
    }
    if (!this.responseContext.complete) return [];
    const text = inputText(value.input);
    if (text === null) return [];
    const stableId = createHash('sha256').update(this.context.conversationId).update('\0').update(Buffer.from(bytes)).digest('base64url');
    return this.observation({
      kind: 'prompt',
      context: this.context,
      eventId: this.eventId('prompt', stableId),
      observedAt: this.now(),
      text,
    });
  }

  readEvent(event: Record<string, unknown>): Observation[] {
    if (this.stopped) return [];
    if (event.type === 'response.created' && object(event.response) && boundedId(event.response.id)) {
      this.responseId = event.response.id;
      return [];
    }
    if (event.type === 'response.output_item.added' && object(event.item)) {
      this.captureCall(event.item);
      return [];
    }
    if (event.type === 'response.function_call_arguments.delta' && boundedId(event.item_id) && typeof event.delta === 'string') {
      const call = this.calls.get(event.item_id);
      if (call && !call.oversized) {
        call.arguments += event.delta;
        if (Buffer.byteLength(call.arguments, 'utf8') > MAX_STREAM_ARGUMENT_BYTES) {
          call.arguments = '';
          call.oversized = true;
        }
      }
      return [];
    }
    if (event.type === 'response.function_call_arguments.done' && boundedId(event.item_id) && typeof event.arguments === 'string') {
      const call = this.calls.get(event.item_id);
      if (call) {
        call.arguments = Buffer.byteLength(event.arguments, 'utf8') <= MAX_STREAM_ARGUMENT_BYTES ? event.arguments : '';
        call.oversized = Buffer.byteLength(event.arguments, 'utf8') > MAX_STREAM_ARGUMENT_BYTES;
      }
      return [];
    }
    if (event.type === 'response.output_item.done' && object(event.item)) {
      const observations = this.completedItem(event.item);
      if (boundedId(event.item.id)) this.calls.delete(event.item.id);
      return observations;
    }
    if (event.type === 'response.completed' && object(event.response)) {
      if (boundedId(event.response.id)) this.responseId = event.response.id;
      const observations = Array.isArray(event.response.output)
        ? event.response.output.flatMap((item) => object(item) ? this.completedItem(item) : [])
        : [];
      this.complete();
      return observations;
    }
    return [];
  }

  readJsonResponse(value: unknown): Observation[] {
    if (!object(value)) return [];
    if (boundedId(value.id)) this.responseId = value.id;
    const observations = Array.isArray(value.output)
      ? value.output.flatMap((item) => object(item) ? this.completedItem(item) : [])
      : [];
    if (value.status === 'completed') this.complete();
    return observations;
  }

  complete(): void {
    if (!this.stopped && this.responseId) this.remember(this.responseId, this.responseContext);
  }

  abort(): void {
    this.stopped = true;
    this.calls.clear();
    this.emitted.clear();
    this.responseContext.routesByName.clear();
  }

  private captureRoutes(value: unknown): void {
    if (!Array.isArray(value) || value.length > MAX_REQUEST_TOOLS) return;
    const definitions = new Map<string, Record<string, unknown>[]>();
    for (const item of value) {
      if (!object(item) || item.type !== 'function' || typeof item.name !== 'string' ||
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
      if (matches.length === 1) this.responseContext.routesByName.set(name, matches[0]!);
    }
  }

  private captureCall(item: Record<string, unknown>): void {
    if (item.type !== 'function_call' || !boundedId(item.id) || !boundedId(item.call_id) || typeof item.name !== 'string') return;
    if (!this.calls.has(item.id) && this.calls.size >= MAX_RESPONSE_CALLS) return;
    const args = typeof item.arguments === 'string' ? item.arguments : '';
    const oversized = Buffer.byteLength(args, 'utf8') > MAX_STREAM_ARGUMENT_BYTES;
    this.calls.set(item.id, {
      callId: item.call_id,
      name: item.name,
      arguments: oversized ? '' : args,
      oversized,
    });
  }

  private completedItem(item: Record<string, unknown>): Observation[] {
    if (item.type !== 'function_call') return [];
    const active = boundedId(item.id) ? this.calls.get(item.id) : undefined;
    const callId = boundedId(item.call_id) ? item.call_id : active?.callId;
    const name = typeof item.name === 'string' ? item.name : active?.name;
    const argsText = typeof item.arguments === 'string' ? item.arguments : active?.arguments;
    if (!boundedId(callId) || typeof name !== 'string' || typeof argsText !== 'string' ||
      active?.oversized || Buffer.byteLength(argsText, 'utf8') > MAX_STREAM_ARGUMENT_BYTES || this.emitted.has(callId) ||
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
    this.emitted.add(callId);
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
    return this.environment.eventId?.(kind, stableId) ?? `codex:${kind}:${stableId || randomUUID()}`;
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

  constructor(
    context: SessionContext,
    private readonly request: AgentAdapterRequest,
    environment: AgentAdapterEnvironment,
    remember: (responseId: string, responseContext: ResponseContext) => void,
    previous: (responseId: string) => ResponseContext | null,
    private readonly release: () => void,
  ) {
    this.tracker = new ResponseTracker(context, environment, remember, previous);
  }

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
    this.requestReady = true;
    return this.tracker.readRequest(parsed, body);
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
    this.responseText += this.decoder.write(Buffer.from(chunk));
    return this.responseMode === 'sse' ? this.readSse(false) : [];
  }

  observeResponseEnd(): readonly Observation[] {
    if (this.stopped || this.responseMode === 'none') return [];
    this.responseText += this.decoder.end();
    let observations: Observation[];
    if (this.responseMode === 'sse') observations = this.readSse(true);
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.responseText) as unknown;
      } catch {
        parsed = null;
      }
      observations = this.tracker.readJsonResponse(parsed);
    }
    this.finish();
    return observations;
  }

  abort(): void {
    if (this.stopped) return;
    this.tracker.abort();
    this.finish();
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
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return [];
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
    return object(event) ? this.tracker.readEvent(event) : [];
  }

  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.responseMode = 'none';
    this.responseText = '';
    if (!this.released) {
      this.released = true;
      this.release();
    }
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
    private readonly remember: (responseId: string, responseContext: ResponseContext) => void,
    private readonly previous: (responseId: string) => ResponseContext | null,
    private readonly release: () => void,
  ) {}

  observeResponseStart(response: AgentAdapterResponse): readonly Observation[] {
    if (this.stopped || response.status !== 101) {
      this.abort();
      return [];
    }
    this.ready = true;
    return [];
  }

  observeClientMessage(message: WebSocketMessage): readonly Observation[] {
    if (!this.ready || this.stopped || message.binary || message.data.byteLength > MAX_OBSERVATION_BYTES) return [];
    const parsed = this.parse(message.data);
    if (!parsed || parsed.type !== 'response.create' || this.trackers.size >= MAX_ACTIVE_RESPONSES) return [];
    const tracker = new ResponseTracker(this.context, this.environment, this.remember, this.previous);
    this.trackers.add(tracker);
    const lane = boundedId(parsed.stream_id) ? parsed.stream_id : '';
    const pending = this.pendingByLane.get(lane) ?? [];
    pending.push(tracker);
    this.pendingByLane.set(lane, pending);
    return tracker.readRequest(parsed, message.data);
  }

  observeServerMessage(message: WebSocketMessage): readonly Observation[] {
    if (!this.ready || this.stopped || message.binary || message.data.byteLength > MAX_OBSERVATION_BYTES) return [];
    const event = this.parse(message.data);
    if (!event) return [];
    if (event.type === 'response.created') {
      const responseId = object(event.response) && boundedId(event.response.id) ? event.response.id : null;
      if (!responseId) return [];
      const lane = boundedId(event.stream_id) ? event.stream_id : null;
      const tracker = this.takePending(lane);
      if (!tracker) return [];
      tracker.readEvent(event);
      const response = { lane: lane ?? '', tracker };
      this.activeByResponse.set(responseId, response);
      this.activeByLane.set(response.lane, response);
      return [];
    }
    const response = this.responseFor(event);
    if (!response) return [];
    const observations = response.tracker.readEvent(event);
    if (event.type === 'response.completed') this.releaseResponse(response);
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
    const responseId = [...this.activeByResponse].find(([, value]) => value === response)?.[0];
    if (responseId !== undefined) this.activeByResponse.delete(responseId);
    if (this.activeByLane.get(response.lane) === response) this.activeByLane.delete(response.lane);
    this.trackers.delete(response.tracker);
  }
}

export function codexAdapter(environment: AgentAdapterEnvironment): AgentAdapter {
  return {
    agent: 'codex',
    createConnection: () => new CodexConnection(environment),
    normalizeHook: () => [],
  };
}
