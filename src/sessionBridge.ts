import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateSchema,
  observationSchema,
  sessionContextSchema,
  type AgentKind,
  type Candidate,
  type LocalRouteDescriptor,
  type Observation,
  type RegisteredRoute,
  type SessionContext,
} from './observerTypes.js';
import { parseResult } from './predictor.js';
import { SessionPredictor } from './sessionPredictor.js';
import type { ProxySessionEvent } from './proxy.js';

const MAX_LINE_BYTES = 2 * 1024 * 1024 + 4096;
const MAX_CANDIDATES_PER_EVENT = 3;
const MAX_CANDIDATE_AGE_MS = 1_000;
const MAX_REPLAY_IDS = 4_096;
const MAX_SOURCE_EVENTS = 4_096;
const REPLAY_RETENTION_MS = 120_000;
const MAX_PENDING_OBSERVATIONS = 256;
const MAX_PENDING_OBSERVATION_BYTES = 8 * 1024 * 1024;
const MAX_CONVERSATIONS = 256;
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;
const MAX_UNAUTHENTICATED_SOCKETS = 32;
const HANDSHAKE_TIMEOUT_MS = 1_000;

export interface SessionBridgeCoordinates {
  socketPath: string;
  capability: string;
  launchId: string;
}

interface OwnerState {
  ownerId: string;
  socket: Socket;
  hostClient: AgentKind;
  hostServerAlias: string;
  generation: number;
  routes: RegisteredRoute[];
}

interface ClientMessage {
  type: 'hello' | 'register' | 'invalidate' | 'observation' | 'completed';
  requestId?: number;
  capability?: string;
  launchId?: string;
  hostClient?: AgentKind;
  hostServerAlias?: string;
  routes?: LocalRouteDescriptor[];
  upstreamServer?: string;
  reason?: string;
  observation?: Observation;
  completion?: ProxySessionEvent;
}

type ServerMessage =
  | { type: 'response'; requestId: number; ok: true; value?: unknown }
  | { type: 'response'; requestId: number; ok: false; error: string }
  | { type: 'candidates'; candidates: Candidate[] };

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(socket: Socket, value: ServerMessage | ClientMessage): boolean {
  if (socket.destroyed || !socket.writable) return false;
  const payload = `${JSON.stringify(value)}\n`;
  if (socket.writableLength + Buffer.byteLength(payload, 'utf8') > MAX_SOCKET_BUFFER_BYTES) return false;
  socket.write(payload);
  return true;
}

function readLines(socket: Socket, onLine: (value: unknown) => void, onError: (error: Error) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered, 'utf8') > MAX_LINE_BYTES) {
      onError(new Error('bridge message exceeds limit'));
      socket.destroy();
      return;
    }
    for (;;) {
      const at = buffered.indexOf('\n');
      if (at < 0) break;
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line) as unknown);
      } catch {
        onError(new Error('invalid bridge message'));
      }
    }
  });
}

function localAddress(): { socketPath: string; directory: string | null } {
  if (process.platform === 'win32') {
    return { socketPath: `\\\\.\\pipe\\speculate-${randomUUID()}`, directory: null };
  }
  const directory = mkdtempSync(join(tmpdir(), 'speculate-session-'));
  chmodSync(directory, 0o700);
  return { socketPath: join(directory, 'bridge.sock'), directory };
}

export class SessionBridge {
  readonly coordinates: SessionBridgeCoordinates;
  private readonly owners = new Map<string, OwnerState>();
  private readonly sockets = new Set<Socket>();
  private readonly conversations = new Set<string>();
  private readonly listeners = new Set<(observation: Observation) => void>();
  private readonly replay = new Map<string, number>();
  private readonly eventCounts = new Map<string, { count: number; at: number }>();
  private readonly observationQueue: Array<{ observation: Observation; bytes: number }> = [];
  private readonly sessionPredictor: SessionPredictor;
  private readonly lastCompletionByConversation = new Map<string, { startedAt: number; completedAt: number }>();
  private observationQueueBytes = 0;
  private observationScheduled = false;
  private invalidationSequence = 0;
  private closed = false;

  private constructor(
    private readonly context: SessionContext,
    private readonly server: Server,
    private readonly directory: string | null,
    private readonly now: () => number,
    private readonly correlateCompletion: CompletionCorrelator | null,
    coordinates: SessionBridgeCoordinates,
  ) {
    this.coordinates = coordinates;
    this.conversations.add(context.conversationId);
    this.sessionPredictor = new SessionPredictor({ routes: () => this.listRoutes(), now });
  }

  static async start(
    context: SessionContext,
    opts: { now?: () => number; correlateCompletion?: CompletionCorrelator } = {},
  ): Promise<SessionBridge> {
    const parsedContext = sessionContextSchema.parse(context);
    const address = localAddress();
    const capability = randomBytes(32).toString('base64url');
    const server = createServer();
    const bridge = new SessionBridge(
      parsedContext,
      server,
      address.directory,
      opts.now ?? Date.now,
      opts.correlateCompletion ?? null,
      {
      socketPath: address.socketPath,
      capability,
      launchId: context.launchId,
      },
    );
    server.on('connection', (socket) => bridge.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(address.socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    if (process.platform !== 'win32') chmodSync(address.socketPath, 0o600);
    return bridge;
  }

  listRoutes(): readonly RegisteredRoute[] {
    return [...this.owners.values()].flatMap((owner) => owner.routes.map((route) => structuredClone(route)));
  }

  resolveObservedTool(hostServerAlias: string, exposedTool: string): RegisteredRoute | 'unknown' | 'ambiguous' {
    const matches = this.listRoutes().filter(
      (route) => route.hostServerAlias === hostServerAlias && route.exposedTool === exposedTool,
    );
    if (matches.length === 0) return 'unknown';
    if (matches.length > 1) return 'ambiguous';
    return matches[0]!;
  }

  registerConversation(context: SessionContext): boolean {
    if (this.closed) return false;
    const parsed = sessionContextSchema.safeParse(context);
    if (!parsed.success) return false;
    context = parsed.data;
    if (
      context.launchId !== this.context.launchId ||
      context.agent !== this.context.agent ||
      context.cwd !== this.context.cwd
    ) return false;
    if (this.conversations.has(context.conversationId)) return true;
    if (this.conversations.size >= MAX_CONVERSATIONS) return false;
    this.conversations.add(context.conversationId);
    return true;
  }

  subscribe(listener: (observation: Observation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishObservation(input: unknown): boolean {
    if (this.closed) return false;
    const parsed = observationSchema.safeParse(input);
    if (!parsed.success || !this.acceptsContext(parsed.data.context)) return false;
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
    if (parsed.data.kind === 'invalidate') {
      while (
        this.observationQueue.length >= MAX_PENDING_OBSERVATIONS ||
        this.observationQueueBytes + bytes > MAX_PENDING_OBSERVATION_BYTES
      ) {
        let at = -1;
        for (let index = this.observationQueue.length - 1; index >= 0; index--) {
          if (this.observationQueue[index]!.observation.kind !== 'invalidate') {
            at = index;
            break;
          }
        }
        if (at < 0) return false;
        this.observationQueueBytes -= this.observationQueue.splice(at, 1)[0]!.bytes;
      }
      const at = this.observationQueue.findIndex(({ observation }) => observation.kind !== 'invalidate');
      this.observationQueue.splice(at < 0 ? this.observationQueue.length : at, 0, { observation: parsed.data, bytes });
    } else {
      if (
        this.observationQueue.length >= MAX_PENDING_OBSERVATIONS ||
        this.observationQueueBytes + bytes > MAX_PENDING_OBSERVATION_BYTES
      ) return false;
      this.observationQueue.push({ observation: parsed.data, bytes });
    }
    this.observationQueueBytes += bytes;
    if (!this.observationScheduled) {
      this.observationScheduled = true;
      setImmediate(() => this.drainObservations());
    }
    return true;
  }

  submit(input: unknown): boolean {
    if (this.closed) return false;
    const parsed = candidateSchema.safeParse(input);
    if (!parsed.success) return false;
    const candidate = parsed.data;
    if (candidate.launchId !== this.context.launchId || !this.conversations.has(candidate.conversationId)) return false;
    const now = this.now();
    if (candidate.createdAt > now || now - candidate.createdAt > MAX_CANDIDATE_AGE_MS) return false;
    this.pruneReplay(now);
    const replayKey = `${candidate.conversationId}\0${candidate.candidateId}`;
    if (this.replay.has(replayKey)) return false;
    const eventKey = `${candidate.conversationId}\0${candidate.sourceEventId}`;
    const count = this.eventCounts.get(eventKey)?.count ?? 0;
    if (count >= MAX_CANDIDATES_PER_EVENT) return false;
    const owner = [...this.owners.values()].find((item) => item.routes.some(
      (route) => route.routeId === candidate.routeId && route.generation === candidate.generation,
    ));
    if (!owner) return false;
    this.replay.set(replayKey, now);
    this.eventCounts.set(eventKey, { count: count + 1, at: now });
    while (this.replay.size > MAX_REPLAY_IDS) this.replay.delete(this.replay.keys().next().value!);
    while (this.eventCounts.size > MAX_SOURCE_EVENTS) this.eventCounts.delete(this.eventCounts.keys().next().value!);
    const delivered = send(owner.socket, { type: 'candidates', candidates: [candidate] });
    if (!delivered) owner.socket.destroy();
    return delivered;
  }

  async register(owner: SessionBridgeOwner, routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    if (!(owner instanceof SessionBridgeOwner) || !this.owners.has(owner.ownerId)) throw new Error('owner is not authenticated by this bridge');
    return owner.register(routes);
  }

  async invalidate(owner: SessionBridgeOwner, upstreamServer?: string): Promise<void> {
    if (!(owner instanceof SessionBridgeOwner) || !this.owners.has(owner.ownerId)) throw new Error('owner is not authenticated by this bridge');
    await owner.invalidate(upstreamServer);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sessionPredictor.invalidate([]);
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.owners.clear();
    this.listeners.clear();
    this.observationQueue.length = 0;
    this.observationQueueBytes = 0;
    this.lastCompletionByConversation.clear();
  }

  private acceptsContext(context: SessionContext): boolean {
    return context.launchId === this.context.launchId &&
      context.agent === this.context.agent &&
      context.cwd === this.context.cwd &&
      this.conversations.has(context.conversationId);
  }

  private pruneReplay(now: number): void {
    for (const [key, at] of this.replay) {
      if (now - at > REPLAY_RETENTION_MS) this.replay.delete(key);
    }
    for (const [key, value] of this.eventCounts) {
      if (now - value.at > REPLAY_RETENTION_MS) this.eventCounts.delete(key);
    }
  }

  private drainObservations(): void {
    this.observationScheduled = false;
    const queued = this.observationQueue.splice(0);
    this.observationQueueBytes = 0;
    for (const { observation } of queued) {
      for (const candidate of this.sessionPredictor.observe(observation)) this.submit(candidate);
      for (const listener of this.listeners) {
        try { listener(observation); } catch {}
      }
    }
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= MAX_UNAUTHENTICATED_SOCKETS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let owner: OwnerState | null = null;
    const handshakeTimer = setTimeout(() => {
      if (!owner) socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.sockets.delete(socket);
      if (owner) {
        const routeIds = owner.routes.map((route) => route.routeId);
        this.owners.delete(owner.ownerId);
        if (!this.closed && routeIds.length > 0) this.publishRouteInvalidation(owner, routeIds, 'disconnect');
      }
    });
    readLines(socket, (raw) => {
      if (raw === null || typeof raw !== 'object') return socket.destroy();
      const message = raw as ClientMessage;
      if (!owner) {
        if (
          message.type !== 'hello' ||
          typeof message.requestId !== 'number' ||
          typeof message.capability !== 'string' ||
          message.launchId !== this.context.launchId ||
          !secureEqual(message.capability, this.coordinates.capability) ||
          (message.hostClient !== 'claude' && message.hostClient !== 'codex') ||
          typeof message.hostServerAlias !== 'string' ||
          message.hostServerAlias.length === 0 ||
          message.hostServerAlias.length > 512
        ) {
          if (typeof message.requestId === 'number') send(socket, { type: 'response', requestId: message.requestId, ok: false, error: 'authentication failed' });
          return socket.end();
        }
        owner = {
          ownerId: randomUUID(),
          socket,
          hostClient: message.hostClient,
          hostServerAlias: message.hostServerAlias,
          generation: 0,
          routes: [],
        };
        this.owners.set(owner.ownerId, owner);
        clearTimeout(handshakeTimer);
        if (!send(socket, { type: 'response', requestId: message.requestId, ok: true, value: owner.ownerId })) socket.destroy();
        return;
      }
      this.handleOwnerMessage(owner, message);
    }, () => socket.destroy());
  }

  private handleOwnerMessage(owner: OwnerState, message: ClientMessage): void {
    const requestId = message.requestId;
    if (typeof requestId !== 'number') return;
    if (message.type === 'register' && Array.isArray(message.routes)) {
      if (message.routes.length > 512 || !message.routes.every(validLocalRoute)) {
        this.respond(owner, { type: 'response', requestId, ok: false, error: 'invalid route registration' });
        return;
      }
      const replacedRouteIds = owner.routes.map((route) => route.routeId);
      owner.routes = [];
      owner.generation++;
      owner.routes = message.routes.map((route) => ({
        ...route,
        routeId: randomUUID(),
        generation: owner.generation,
        instanceId: owner.ownerId,
        hostClient: owner.hostClient,
        hostServerAlias: owner.hostServerAlias,
      }));
      if (replacedRouteIds.length > 0) this.publishRouteInvalidation(owner, replacedRouteIds, 'routes-replaced');
      this.respond(owner, { type: 'response', requestId, ok: true, value: owner.routes });
      return;
    }
    if (message.type === 'invalidate') {
      const removedRouteIds = owner.routes
        .filter((route) => typeof message.upstreamServer !== 'string' || route.upstreamServer === message.upstreamServer)
        .map((route) => route.routeId);
      owner.routes = typeof message.upstreamServer === 'string'
        ? owner.routes.filter((route) => route.upstreamServer !== message.upstreamServer)
        : [];
      owner.generation++;
      this.publishRouteInvalidation(
        owner,
        removedRouteIds,
        typeof message.reason === 'string' && message.reason.length > 0 && message.reason.length <= 512
          ? message.reason
          : 'route-invalidated',
      );
      this.respond(owner, { type: 'response', requestId, ok: true });
      return;
    }
    if (message.type === 'observation') {
      const accepted = message.observation?.kind !== 'tool-complete' &&
        this.publishObservation(message.observation);
      this.respond(owner, { type: 'response', requestId, ok: true, value: accepted });
      return;
    }
    if (message.type === 'completed') {
      const accepted = this.publishCompleted(owner, message.completion);
      this.respond(owner, { type: 'response', requestId, ok: true, value: accepted });
      return;
    }
    this.respond(owner, { type: 'response', requestId, ok: false, error: 'unsupported bridge message' });
  }

  private respond(owner: OwnerState, message: ServerMessage): void {
    if (!send(owner.socket, message)) owner.socket.destroy();
  }

  private publishRouteInvalidation(owner: OwnerState, routeIds: string[], reason: string): void {
    this.publishObservation({
      context: this.context,
      kind: 'invalidate',
      eventId: `invalidate:${owner.ownerId}:${++this.invalidationSequence}`,
      observedAt: this.now(),
      routeIds,
      reason,
    });
  }

  private publishCompleted(owner: OwnerState, input: unknown): boolean {
    if (!this.correlateCompletion || !validCompletion(input)) return false;
    const event = input;
    const route = owner.routes.find((candidate) =>
      candidate.routeId === event.routeId &&
      candidate.generation === event.generation &&
      candidate.exposedTool === event.exposedTool &&
      candidate.upstreamServer === event.upstreamServer &&
      candidate.upstreamTool === event.upstreamTool,
    );
    if (
      !route ||
      event.launchId !== this.context.launchId ||
      event.hostClient !== owner.hostClient ||
      event.hostServerAlias !== owner.hostServerAlias
    ) return false;
    let correlation: CompletionCorrelation | null = null;
    try { correlation = this.correlateCompletion(event); } catch {}
    if (!correlation || !validId(correlation.conversationId) || !this.conversations.has(correlation.conversationId)) {
      return false;
    }
    const eventId = correlation.eventId ?? event.eventId;
    if (!validId(eventId)) return false;
    const previous = this.lastCompletionByConversation.get(correlation.conversationId);
    const ordered = correlation.ordered !== false && (
      previous === undefined ||
      (event.startedAt >= previous.completedAt && event.completedAt >= previous.completedAt)
    );
    if (previous === undefined || event.completedAt >= previous.completedAt) {
      this.lastCompletionByConversation.set(correlation.conversationId, {
        startedAt: event.startedAt,
        completedAt: event.completedAt,
      });
    }
    const accepted = this.publishObservation({
      context: { ...this.context, conversationId: correlation.conversationId },
      kind: 'tool-complete',
      eventId,
      observedAt: event.completedAt,
      routeId: route.routeId,
      args: event.args,
      parsed: parseResult(event.result),
      latencyMs: event.completedAt - event.startedAt,
      ordered,
    });
    if (!accepted) this.sessionPredictor.invalidate([]);
    return accepted;
  }
}

export interface CompletionCorrelation {
  conversationId: string;
  eventId?: string;
  ordered?: boolean;
}

export type CompletionCorrelator = (event: Readonly<ProxySessionEvent>) => CompletionCorrelation | null;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validCompletion(value: unknown): value is ProxySessionEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<ProxySessionEvent>;
  return event.kind === 'tool-complete' &&
    validId(event.launchId) &&
    (event.hostClient === 'claude' || event.hostClient === 'codex') &&
    validId(event.hostServerAlias) &&
    (event.conversationId === null || validId(event.conversationId)) &&
    validId(event.eventId) &&
    validId(event.routeId) &&
    typeof event.generation === 'number' && Number.isInteger(event.generation) && event.generation > 0 &&
    validId(event.exposedTool) &&
    validId(event.upstreamServer) &&
    validId(event.upstreamTool) &&
    event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args) &&
    event.result !== null && typeof event.result === 'object' && !Array.isArray(event.result) &&
    typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 &&
    typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0 &&
    typeof event.completedAt === 'number' && Number.isFinite(event.completedAt) &&
    event.completedAt >= event.startedAt;
}

function validLocalRoute(value: unknown): value is LocalRouteDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return Object.keys(route).every((key) => ['exposedTool', 'upstreamServer', 'upstreamTool', 'inputSchema'].includes(key)) &&
    ['exposedTool', 'upstreamServer', 'upstreamTool'].every((key) => typeof route[key] === 'string' && (route[key] as string).length > 0 && (route[key] as string).length <= 512) &&
    route.inputSchema !== null && typeof route.inputSchema === 'object' && !Array.isArray(route.inputSchema);
}

export interface SessionBridgeOwnerOptions {
  hostClient: AgentKind;
  hostServerAlias: string;
  onCandidates(candidates: Candidate[]): void;
}

export class SessionBridgeOwner {
  readonly coordinates: SessionBridgeCoordinates;
  readonly ownerId: string;
  private requestId = 1;
  private closed = false;
  private disconnectHandler: (() => void) | null = null;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(
    coordinates: SessionBridgeCoordinates,
    ownerId: string,
    private readonly socket: Socket,
    private onCandidates: (candidates: Candidate[]) => void,
  ) {
    this.coordinates = coordinates;
    this.ownerId = ownerId;
  }

  static async connect(coordinates: SessionBridgeCoordinates, options: SessionBridgeOwnerOptions): Promise<SessionBridgeOwner> {
    const socket = createConnection(coordinates.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let instance: SessionBridgeOwner | null = null;
    let helloResolve!: (value: string) => void;
    let helloReject!: (error: Error) => void;
    const hello = new Promise<string>((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
    readLines(socket, (raw) => {
      if (raw === null || typeof raw !== 'object') return;
      const message = raw as ServerMessage;
      if (message.type === 'candidates') {
        try { instance?.onCandidates(message.candidates); } catch {}
        return;
      }
      if (message.type !== 'response') return;
      if (!instance && message.requestId === 0) {
        if (message.ok && typeof message.value === 'string') helloResolve(message.value);
        else helloReject(new Error(message.ok ? 'authentication failed' : message.error));
        return;
      }
      const request = instance?.pending.get(message.requestId);
      if (!request) return;
      instance!.pending.delete(message.requestId);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error));
    }, (error) => {
      helloReject(error);
      instance?.failPending(error);
    });
    socket.on('close', () => {
      const error = new Error('session bridge connection closed');
      helloReject(error);
      instance?.failPending(error);
      if (instance && !instance.closed) {
        try { instance.disconnectHandler?.(); } catch {}
      }
    });
    send(socket, {
      type: 'hello',
      requestId: 0,
      capability: coordinates.capability,
      launchId: coordinates.launchId,
      hostClient: options.hostClient,
      hostServerAlias: options.hostServerAlias,
    });
    const ownerId = await hello;
    instance = new SessionBridgeOwner(coordinates, ownerId, socket, options.onCandidates);
    return instance;
  }

  async register(routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    return await this.request({ type: 'register', routes: [...routes] }) as RegisteredRoute[];
  }

  replaceRoutes(routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    return this.register(routes);
  }

  setCandidateHandler(handler: (candidates: unknown) => void): void {
    this.onCandidates = handler;
  }

  setDisconnectHandler(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  async invalidate(upstreamServer?: string, reason?: string): Promise<void> {
    await this.request({ type: 'invalidate', upstreamServer, reason });
  }

  invalidateServer(upstreamServer?: string, reason?: string): Promise<void> {
    return this.invalidate(upstreamServer, reason);
  }

  async publishObservation(observation: Observation): Promise<boolean> {
    return await this.request({ type: 'observation', observation }) as boolean;
  }

  async publishCompleted(event: ProxySessionEvent): Promise<boolean> {
    return await this.request({ type: 'completed', completion: event }) as boolean;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }

  private request(message: ClientMessage): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('session bridge owner is closed'));
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      if (!send(this.socket, { ...message, requestId })) {
        this.pending.delete(requestId);
        reject(new Error('session bridge connection is unavailable'));
      }
    });
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export function connectSessionBridgeOwner(
  coordinates: SessionBridgeCoordinates,
  options: SessionBridgeOwnerOptions,
): Promise<SessionBridgeOwner> {
  return SessionBridgeOwner.connect(coordinates, options);
}
