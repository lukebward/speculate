import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateSchema,
  observationSchema,
  sessionContextSchema,
  type AgentKind,
  type AuthorizedCandidate,
  type Candidate,
  type HostPermissionDecision,
  type LocalRouteDescriptor,
  type Observation,
  type RegisteredRoute,
  type SessionContext,
} from './observerTypes.js';
import { parseResult } from './predictor.js';
import { SessionPredictor } from './sessionPredictor.js';
import type { ProxySessionEvent } from './proxy.js';
import type { ObserverLifecycleEvent } from './types.js';
import type {
  ProxyDemandEvent,
  PendingProxyDemandStart,
  SemanticRankingConfig,
  SemanticRankingReply,
  SemanticRankingRequest,
  VerifiedProxyDemandEvent,
} from './semanticTypes.js';

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
const MAX_PENDING_AUTHORIZATIONS = 256;
const MAX_PENDING_AUTHORIZATION_BYTES = 8 * 1024 * 1024;
const MAX_SEMANTIC_CORRELATIONS = 64;
const MAX_SEMANTIC_CORRELATION_BYTES = 1024 * 1024;
const SEMANTIC_CORRELATION_RETENTION_MS = 120_000;

export interface SessionBridgeCoordinates {
  socketPath: string;
  capability: string;
  launchId: string;
}

export interface CandidateAuthorizationInput {
  candidate: Candidate;
  context: SessionContext;
  route: RegisteredRoute;
}

export interface CandidateAuthorizationResult {
  decision: HostPermissionDecision;
  permissionContext: string | null;
  policyFingerprint?: string | null;
  reason?: string;
}

export type CandidateAuthorizer = (
  input: Readonly<CandidateAuthorizationInput>,
) => Promise<CandidateAuthorizationResult>;

interface OwnerState {
  ownerId: string;
  socket: Socket;
  hostClient: AgentKind;
  hostServerAlias: string;
  generation: number;
  routes: RegisteredRoute[];
}

interface ReservedCandidate {
  candidate: Candidate;
  context: SessionContext;
  owner: OwnerState;
  replayKey: string;
  reservedAt: number;
  authorizationBytes: number;
}

interface SemanticCorrelationRecord {
  active: boolean;
  sourceOwnerId: string;
  sourceEventId: string;
  bridgeSourceEventId: string;
  createdAt: number;
  expiresAt: number;
  retainedBytes: number;
  completionAccepted: boolean;
  correlationResolved: boolean;
  correlationResult: CompletionCorrelation | null;
  demandEvents: ProxyDemandEvent[];
  flushingDemands: boolean;
  resolve(correlation: CompletionCorrelation | null): void;
  correlation: Promise<CompletionCorrelation | null>;
}

export interface SessionSemanticService {
  observePrompt(input: {
    launchId: string;
    conversationId: string;
    task: string;
    workspace?: string;
    revision?: number;
  }): boolean;
  observeCall(conversationId: string, input: {
    server: string;
    tool: string;
    args: Readonly<Record<string, unknown>>;
    success: boolean;
    completedAt: number;
  }): boolean;
  judgeCandidates(request: SemanticRankingRequest): Promise<SemanticRankingReply | null>;
  publishDemand(event: VerifiedProxyDemandEvent): Promise<boolean>;
  notePendingDemand?(event: PendingProxyDemandStart): boolean;
  censorPendingDemand?(ownerInstanceId: string, requestId: string): boolean;
  invalidate?(conversationId: string): void;
  shutdown(): void;
}

interface ClientMessage {
  type: 'hello' | 'hook' | 'register' | 'invalidate' | 'observation' | 'completed' | 'lifecycle' | 'startup-policy' | 'semantic-judge' | 'semantic-demand';
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
  payload?: unknown;
  lifecycle?: ObserverLifecycleEvent;
  semanticRequest?: SemanticRankingRequest;
  demand?: ProxyDemandEvent;
}

type ServerMessage =
  | { type: 'response'; requestId: number; ok: true; value?: unknown }
  | { type: 'response'; requestId: number; ok: false; error: string }
  | { type: 'candidates'; candidates: Array<Candidate | AuthorizedCandidate> }
  | { type: 'permission-context'; conversationId: string; permissionContext: string | null }
  | { type: 'semantic-invalidate'; revision: number; reason: string }
  | { type: 'invalidate'; routeIds: string[]; reason: string };

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
  readonly hookCoordinates: SessionBridgeCoordinates;
  private readonly owners = new Map<string, OwnerState>();
  private readonly sockets = new Set<Socket>();
  private readonly conversations = new Map<string, SessionContext>();
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
  private pendingAuthorizationBytes = 0;
  private hookEvents = 0;
  private trackingLost = false;
  private readonly pendingAuthorizations = new Map<string, number>();
  private readonly semanticCorrelations = new Map<string, SemanticCorrelationRecord>();
  private readonly semanticCorrelationAliases = new Map<string, SemanticCorrelationRecord>();
  private semanticCorrelationBytes = 0;
  private semanticCorrelationInFlightBytes = 0;
  private semanticRevisionSequence = 0;
  private readonly semanticPolicyFingerprints = new Map<string, string>();

  private constructor(
    private readonly context: SessionContext,
    private readonly server: Server,
    private readonly directory: string | null,
    private readonly now: () => number,
    private readonly correlateCompletion: CompletionCorrelator | null,
    private readonly authorizeCandidate: CandidateAuthorizer | null,
    private readonly onHook: ((client: AgentKind, payload: unknown, observedAt: number) => void) | null,
    private readonly startupPolicy: ((hostClient: AgentKind, hostServerAlias: string) => Promise<unknown>) | null,
    private readonly onLifecycle: ((event: ObserverLifecycleEvent) => void | Promise<void>) | null,
    private readonly configuredSemanticRanking: SemanticRankingConfig | null,
    private readonly semanticService: SessionSemanticService | null,
    coordinates: SessionBridgeCoordinates,
    hookCoordinates: SessionBridgeCoordinates,
  ) {
    this.coordinates = coordinates;
    this.hookCoordinates = hookCoordinates;
    this.conversations.set(context.conversationId, context);
    this.sessionPredictor = new SessionPredictor({ routes: () => this.listRoutes(), now });
  }

  static async start(
    context: SessionContext,
    opts: {
      now?: () => number;
      correlateCompletion?: CompletionCorrelator;
      authorizeCandidate?: CandidateAuthorizer;
      onHook?: (client: AgentKind, payload: unknown, observedAt: number) => void;
      startupPolicy?: (hostClient: AgentKind, hostServerAlias: string) => Promise<unknown>;
      onLifecycle?: (event: ObserverLifecycleEvent) => void | Promise<void>;
      semanticConfig?: SemanticRankingConfig;
      semanticService?: SessionSemanticService;
    } = {},
  ): Promise<SessionBridge> {
    const parsedContext = sessionContextSchema.parse(context);
    const address = localAddress();
    const capability = randomBytes(32).toString('base64url');
    const hookCapability = randomBytes(32).toString('base64url');
    const server = createServer();
    const bridge = new SessionBridge(
      parsedContext,
      server,
      address.directory,
      opts.now ?? Date.now,
      opts.correlateCompletion ?? null,
      opts.authorizeCandidate ?? null,
      opts.onHook ?? null,
      opts.startupPolicy ?? null,
      opts.onLifecycle ?? null,
      opts.semanticConfig && opts.semanticConfig.mode !== 'off' && opts.semanticService
        ? structuredClone(opts.semanticConfig)
        : null,
      opts.semanticConfig && opts.semanticConfig.mode !== 'off' && opts.semanticService ? opts.semanticService : null,
      {
        socketPath: address.socketPath,
        capability,
        launchId: context.launchId,
      },
      { socketPath: address.socketPath, capability: hookCapability, launchId: context.launchId },
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

  conversationContext(conversationId: string): SessionContext | null {
    const context = this.conversations.get(conversationId);
    return context ? structuredClone(context) : null;
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
      context.agent !== this.context.agent
    ) return false;
    const existing = this.conversations.get(context.conversationId);
    if (existing) {
      if (existing.cwd === context.cwd) return true;
      this.semanticService?.invalidate?.(context.conversationId);
      this.invalidateSemantic('cwd-changed');
      this.conversations.set(context.conversationId, context);
      this.lastCompletionByConversation.delete(context.conversationId);
      for (const target of this.owners.values()) {
        if (!send(target.socket, { type: 'permission-context', conversationId: context.conversationId, permissionContext: null })) {
          target.socket.destroy();
        }
      }
      return true;
    }
    if (this.conversations.size >= MAX_CONVERSATIONS) return false;
    this.conversations.set(context.conversationId, context);
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
    if (parsed.data.kind === 'prompt') {
      this.invalidateSemantic('prompt-changed');
      this.semanticService?.observePrompt({
        launchId: parsed.data.context.launchId,
        conversationId: parsed.data.context.conversationId,
        task: parsed.data.text,
        workspace: parsed.data.context.cwd,
      });
    } else if (parsed.data.kind === 'invalidate') {
      this.invalidateSemantic(parsed.data.reason);
      for (const conversationId of this.conversations.keys()) this.semanticService?.invalidate?.(conversationId);
    }
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
    const reserved = this.reserveCandidate(input);
    if (!reserved) return false;
    if (this.authorizeCandidate) {
      void this.authorizeAndDeliverGroup([reserved]);
      return true;
    }
    const delivered = send(reserved.owner.socket, { type: 'candidates', candidates: [reserved.candidate] });
    if (!delivered) reserved.owner.socket.destroy();
    return delivered;
  }

  private submitGroup(inputs: readonly unknown[]): void {
    const groups = new Map<string, ReservedCandidate[]>();
    for (const input of inputs) {
      const reserved = this.reserveCandidate(input);
      if (!reserved) continue;
      const key = `${reserved.candidate.conversationId}\0${reserved.candidate.sourceEventId}\0${reserved.owner.ownerId}`;
      const group = groups.get(key) ?? [];
      group.push(reserved);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (this.authorizeCandidate) void this.authorizeAndDeliverGroup(group);
      else {
        const delivered = send(group[0]!.owner.socket, {
          type: 'candidates',
          candidates: group.map((item) => item.candidate),
        });
        if (!delivered) group[0]!.owner.socket.destroy();
      }
    }
  }

  private reserveCandidate(input: unknown): ReservedCandidate | null {
    if (this.closed) return null;
    const parsed = candidateSchema.safeParse(input);
    if (!parsed.success) return null;
    const candidate = parsed.data;
    const candidateContext = this.conversations.get(candidate.conversationId);
    if (candidate.launchId !== this.context.launchId || !candidateContext) return null;
    const now = this.now();
    if (candidate.createdAt > now || now - candidate.createdAt > MAX_CANDIDATE_AGE_MS) return null;
    this.pruneReplay(now);
    const replayKey = `${candidate.conversationId}\0${candidate.candidateId}`;
    if (this.replay.has(replayKey)) return null;
    const eventKey = `${candidate.conversationId}\0${candidate.sourceEventId}`;
    const count = this.eventCounts.get(eventKey)?.count ?? 0;
    if (count >= MAX_CANDIDATES_PER_EVENT) return null;
    const owner = [...this.owners.values()].find((item) => item.routes.some(
      (route) => route.routeId === candidate.routeId && route.generation === candidate.generation,
    ));
    if (!owner) return null;
    const authorizationBytes = this.authorizeCandidate
      ? Buffer.byteLength(JSON.stringify({ candidate, context: candidateContext, route: owner.routes.find((route) =>
        route.routeId === candidate.routeId && route.generation === candidate.generation) }), 'utf8')
      : 0;
    if (this.authorizeCandidate && (
      this.pendingAuthorizations.size >= MAX_PENDING_AUTHORIZATIONS ||
      this.pendingAuthorizationBytes + authorizationBytes > MAX_PENDING_AUTHORIZATION_BYTES
    )) return null;
    this.replay.set(replayKey, now);
    this.eventCounts.set(eventKey, { count: count + 1, at: now });
    while (this.replay.size > MAX_REPLAY_IDS) this.replay.delete(this.replay.keys().next().value!);
    while (this.eventCounts.size > MAX_SOURCE_EVENTS) this.eventCounts.delete(this.eventCounts.keys().next().value!);
    if (this.authorizeCandidate) {
      this.pendingAuthorizations.set(replayKey, authorizationBytes);
      this.pendingAuthorizationBytes += authorizationBytes;
    }
    return { candidate, context: candidateContext, owner, replayKey, reservedAt: now, authorizationBytes };
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
    this.pendingAuthorizations.clear();
    this.pendingAuthorizationBytes = 0;
    for (const record of [...this.semanticCorrelations.values()]) this.deleteSemanticCorrelation(record);
    this.semanticCorrelationBytes = 0;
    this.semanticPolicyFingerprints.clear();
    this.semanticService?.shutdown();
  }

  private acceptsContext(context: SessionContext): boolean {
    return context.launchId === this.context.launchId &&
      context.agent === this.context.agent &&
      this.conversations.get(context.conversationId)?.cwd === context.cwd;
  }

  private async authorizeAndDeliverGroup(group: readonly ReservedCandidate[]): Promise<void> {
    const results = await Promise.all(group.map(async (reserved) => {
      let result: CandidateAuthorizationResult = { decision: 'unverifiable', permissionContext: null };
      const route = reserved.owner.routes.find((item) =>
        item.routeId === reserved.candidate.routeId && item.generation === reserved.candidate.generation,
      );
      try {
        if (route) result = await this.authorizeCandidate!({
          candidate: reserved.candidate,
          context: reserved.context,
          route,
        });
      } catch {}
      const bytes = this.pendingAuthorizations.get(reserved.replayKey);
      if (bytes !== undefined) {
        this.pendingAuthorizations.delete(reserved.replayKey);
        this.pendingAuthorizationBytes -= bytes;
      }
      return { reserved, result };
    }));
    const now = this.now();
    const current = results.filter(({ reserved }) => {
      const currentOwner = this.owners.get(reserved.owner.ownerId);
      const currentContext = this.conversations.get(reserved.candidate.conversationId);
      const currentRoute = currentOwner?.routes.find((item) =>
        item.routeId === reserved.candidate.routeId && item.generation === reserved.candidate.generation,
      );
      return !this.closed && !!currentOwner && !!currentRoute && !!currentContext &&
        currentContext.cwd === reserved.context.cwd &&
        this.replay.get(reserved.replayKey) === reserved.reservedAt &&
        reserved.candidate.createdAt <= now && now - reserved.candidate.createdAt <= MAX_CANDIDATE_AGE_MS;
    });
    if (current.length === 0) return;
    const conversationId = current[0]!.reserved.candidate.conversationId;
    const previousPolicyFingerprint = this.semanticPolicyFingerprints.get(conversationId);
    const policyFingerprints = new Set(current.flatMap(({ result }) =>
      validId(result.policyFingerprint) ? [result.policyFingerprint] : [],
    ));
    const unverifiableTransition = current.some(({ result }) =>
      result.decision !== 'allowed' && !validId(result.policyFingerprint),
    );
    if (policyFingerprints.size > 1 || unverifiableTransition) {
      if (previousPolicyFingerprint !== undefined) {
        this.semanticService?.invalidate?.(conversationId);
        this.invalidateSemantic('permission-context-changed');
        this.semanticPolicyFingerprints.delete(conversationId);
      }
      if (policyFingerprints.size > 1) return;
    } else if (policyFingerprints.size === 1) {
      const policyFingerprint = policyFingerprints.values().next().value!;
      if (previousPolicyFingerprint !== undefined && previousPolicyFingerprint !== policyFingerprint) {
        this.semanticService?.invalidate?.(conversationId);
        this.invalidateSemantic('permission-context-changed');
      }
      this.semanticPolicyFingerprints.set(conversationId, policyFingerprint);
    }
    const accepted = current.filter(({ result }) =>
      result.decision === 'allowed' && validId(result.permissionContext),
    );
    if (accepted.length === 0) return;
    const permissionContext = accepted.length === 1
      ? accepted[0]!.result.permissionContext!
      : createHash('sha256').update(JSON.stringify(accepted.map(({ reserved, result }) => [
          reserved.candidate.candidateId,
          result.permissionContext,
        ]))).digest('base64url');
    for (const target of this.owners.values()) {
      if (!send(target.socket, { type: 'permission-context', conversationId, permissionContext })) {
        target.socket.destroy();
      }
    }
    const currentOwner = this.owners.get(accepted[0]!.reserved.owner.ownerId);
    if (!currentOwner) return;
    const candidates = accepted.map(({ reserved }) => ({ candidate: reserved.candidate, permissionContext }));
    if (!send(currentOwner.socket, { type: 'candidates', candidates })) {
      currentOwner.socket.destroy();
    }
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
      if (
        observation.kind === 'invalidate' &&
        observation.routeIds.length === 0 &&
        observation.reason === 'observer-tracking-gap'
      ) this.revokeOwnersForTrackingLoss(observation.reason);
      else if (
        observation.kind === 'invalidate' &&
        observation.routeIds.length === 0 &&
        (observation.reason === 'native-mutation-start' || observation.reason === 'native-mutation-settle')
      ) this.revokeOwnersForNativeMutation(observation.reason);
      this.submitGroup(this.sessionPredictor.observe(observation));
      for (const listener of this.listeners) {
        try { listener(observation); } catch {}
      }
    }
  }

  private revokeOwnersForTrackingLoss(reason: string): void {
    this.trackingLost = true;
    for (const owner of this.owners.values()) {
      owner.routes = [];
      owner.generation++;
      if (!send(owner.socket, { type: 'invalidate', routeIds: [], reason })) owner.socket.destroy();
    }
  }

  private revokeOwnersForNativeMutation(reason: string): void {
    if (this.trackingLost) return;
    for (const owner of this.owners.values()) {
      owner.routes = [];
      owner.generation++;
      if (!send(owner.socket, { type: 'invalidate', routeIds: [], reason })) owner.socket.destroy();
    }
  }

  private invalidateSemantic(reason: string): void {
    if (!this.semanticService) return;
    this.semanticRevisionSequence++;
    for (const record of [...this.semanticCorrelations.values()]) this.deleteSemanticCorrelation(record);
    for (const owner of this.owners.values()) {
      if (!send(owner.socket, {
        type: 'semantic-invalidate',
        revision: this.semanticRevisionSequence,
        reason,
      })) owner.socket.destroy();
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
        for (const record of this.semanticCorrelations.values()) {
          if (record.sourceOwnerId !== owner.ownerId) continue;
          this.deleteSemanticCorrelation(record);
        }
        if (!this.closed && routeIds.length > 0) this.publishRouteInvalidation(owner, routeIds, 'disconnect');
      }
    });
    readLines(socket, (raw) => {
      if (raw === null || typeof raw !== 'object') return socket.destroy();
      const message = raw as ClientMessage;
      if (!owner) {
        if (message.type === 'hook') {
          clearTimeout(handshakeTimer);
          if (
            typeof message.capability === 'string' &&
            message.launchId === this.context.launchId &&
            message.hostClient === this.context.agent &&
            secureEqual(message.capability, this.hookCoordinates.capability) &&
            this.hookEvents < MAX_SOURCE_EVENTS
          ) {
            this.hookEvents++;
            try { this.onHook?.(message.hostClient, message.payload, this.now()); } catch {}
          }
          socket.end();
          return;
        }
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
        if (!send(socket, {
          type: 'response',
          requestId: message.requestId,
          ok: true,
          value: {
            ownerId: owner.ownerId,
            semanticConfig: this.configuredSemanticRanking ? structuredClone(this.configuredSemanticRanking) : null,
            semanticRevision: this.semanticRevisionSequence,
          },
        })) socket.destroy();
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
      if (this.trackingLost) {
        owner.routes = [];
        owner.generation++;
        this.respond(owner, { type: 'response', requestId, ok: true, value: [] });
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
      const accepted = this.queueCompleted(owner, message.completion);
      this.respond(owner, { type: 'response', requestId, ok: true, value: accepted });
      return;
    }
    if (message.type === 'semantic-judge') {
      void this.judgeCandidates(owner, message.semanticRequest).then(
        (value) => this.respond(owner, { type: 'response', requestId, ok: true, value }),
        () => this.respond(owner, { type: 'response', requestId, ok: true, value: null }),
      );
      return;
    }
    if (message.type === 'semantic-demand') {
      void this.publishDemand(owner, message.demand).then(
        (value) => this.respond(owner, { type: 'response', requestId, ok: true, value }),
        () => this.respond(owner, { type: 'response', requestId, ok: true, value: false }),
      );
      return;
    }
    if (message.type === 'startup-policy' && this.startupPolicy) {
      void this.startupPolicy(owner.hostClient, owner.hostServerAlias).then(
        (value) => this.respond(owner, { type: 'response', requestId, ok: true, value }),
        () => this.respond(owner, { type: 'response', requestId, ok: true, value: null }),
      );
      return;
    }
    if (message.type === 'lifecycle' && validLifecycle(message.lifecycle)) {
      try {
        const pending = this.onLifecycle?.(message.lifecycle);
        void pending?.catch(() => {});
      } catch {}
      this.respond(owner, { type: 'response', requestId, ok: true, value: true });
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

  private async judgeCandidates(
    owner: OwnerState,
    input: unknown,
  ): Promise<SemanticRankingReply | null> {
    if (!this.semanticService || !this.configuredSemanticRanking || !validSemanticRequest(input)) return null;
    const request = input;
    if (
      request.ownerInstanceId !== owner.ownerId ||
      request.launchId !== this.context.launchId ||
      request.candidates.length === 0 ||
      request.candidates.length > this.configuredSemanticRanking.maxCandidates ||
      request.createdAt > this.now() ||
      request.deadlineAt <= this.now() ||
      !request.candidates.every((candidate) => this.ownerOwnsProjection(owner, candidate))
    ) return null;
    const semanticRevision = this.semanticRevisionSequence;
    const record = this.semanticCorrelationForRequest(owner.ownerId, request.sourceEventId, request.deadlineAt);
    if (!record) return null;
    const correlation = await this.awaitCorrelation(record, request.deadlineAt);
    if (!correlation || this.now() >= request.deadlineAt || !this.owners.has(owner.ownerId) ||
      this.semanticRevisionSequence !== semanticRevision) return null;
    const conversation = this.conversations.get(correlation.conversationId);
    if (!conversation || (correlation.cwd !== undefined && correlation.cwd !== conversation.cwd)) return null;
    if (request.conversationId !== undefined && request.conversationId !== conversation.conversationId) return null;
    const verifiedRequest: SemanticRankingRequest = {
      ...structuredClone(request),
      conversationId: conversation.conversationId,
    };
    let reply: SemanticRankingReply | null = null;
    try { reply = await this.semanticService.judgeCandidates(verifiedRequest); } catch {}
    if (
      !reply ||
      this.now() >= request.deadlineAt ||
      !this.owners.has(owner.ownerId) ||
      this.semanticRevisionSequence !== semanticRevision ||
      !validSemanticReply(reply, verifiedRequest, conversation.conversationId, this.configuredSemanticRanking.model)
    ) return null;
    return structuredClone(reply);
  }

  private async publishDemand(owner: OwnerState, input: unknown): Promise<boolean> {
    if (!this.semanticService || !validProxyDemand(input)) return false;
    const event = input;
    if (event.ownerInstanceId !== owner.ownerId || event.requestId !== event.sourceEventId) return false;
    const route = owner.routes.find((candidate) =>
      candidate.routeId === event.routeId && candidate.generation === event.generation,
    );
    if (!route) return false;
    if (event.phase === 'start' && (
      event.server !== route.upstreamServer ||
      event.tool !== route.upstreamTool
    )) return false;
    if (event.phase === 'start' && this.configuredSemanticRanking?.mode === 'rank') {
      this.invalidateSemantic('real-demand-start');
    }
    const record = this.semanticCorrelation(owner.ownerId, event.sourceEventId, true);
    if (!record) return false;
    if (record.demandEvents.some((item) => item.requestId === event.requestId && item.phase === event.phase)) return false;
    const retainedBytes = serializedSize(event);
    if (
      this.semanticCorrelationBytes + this.semanticCorrelationInFlightBytes + retainedBytes >
      MAX_SEMANTIC_CORRELATION_BYTES
    ) return false;
    record.demandEvents.push(structuredClone(event));
    record.retainedBytes += retainedBytes;
    this.semanticCorrelationBytes += retainedBytes;
    record.expiresAt = Math.max(record.expiresAt, this.now() + SEMANTIC_CORRELATION_RETENTION_MS);
    if (event.phase === 'start') this.semanticService.notePendingDemand?.(structuredClone(event));
    if (record.correlationResolved) void this.flushDemands(record);
    if (record.correlationResolved && !record.correlationResult && event.phase === 'start') {
      this.semanticService.censorPendingDemand?.(event.ownerInstanceId, event.requestId);
    }
    return true;
  }

  private async flushDemands(record: SemanticCorrelationRecord): Promise<void> {
    if (record.flushingDemands || !record.correlationResolved || !record.correlationResult) return;
    const conversation = this.conversations.get(record.correlationResult.conversationId);
    if (!conversation || (
      record.correlationResult.cwd !== undefined && record.correlationResult.cwd !== conversation.cwd
    )) return;
    record.flushingDemands = true;
    try {
      while (record.demandEvents.length > 0) {
        const event = record.demandEvents.shift()!;
        const bytes = serializedSize(event);
        record.retainedBytes -= bytes;
        this.semanticCorrelationBytes -= bytes;
        try {
          await this.semanticService!.publishDemand({
            ...event,
            conversationId: conversation.conversationId,
          });
        } catch {}
      }
    } finally {
      record.flushingDemands = false;
    }
  }

  private ownerOwnsProjection(
    owner: OwnerState,
    candidate: SemanticRankingRequest['candidates'][number],
  ): boolean {
    return owner.routes.some((route) =>
      route.routeId === candidate.routeId &&
      route.generation === candidate.generation &&
      route.upstreamServer === candidate.server &&
      route.upstreamTool === candidate.tool,
    );
  }

  private semanticCorrelationForRequest(
    ownerId: string,
    sourceEventId: string,
    deadlineAt: number,
  ): SemanticCorrelationRecord | null {
    const direct = this.semanticCorrelation(ownerId, sourceEventId, false);
    const aliased = this.semanticCorrelationAliases.get(sourceEventId);
    const record = direct ?? aliased ?? this.semanticCorrelation(ownerId, sourceEventId, true);
    if (!record) return null;
    record.expiresAt = Math.max(record.expiresAt, deadlineAt);
    return record;
  }

  private semanticCorrelation(
    ownerId: string,
    sourceEventId: string,
    create: boolean,
  ): SemanticCorrelationRecord | null {
    this.pruneSemanticCorrelations(this.now());
    const key = `${ownerId}\0${sourceEventId}`;
    const existing = this.semanticCorrelations.get(key);
    if (existing || !create) return existing ?? null;
    let resolveCorrelation!: (value: CompletionCorrelation | null) => void;
    const correlation = new Promise<CompletionCorrelation | null>((resolvePromise) => {
      resolveCorrelation = resolvePromise;
    });
    const bridgeSourceEventId = `semantic:${randomUUID()}`;
    const retainedBytes = serializedSize({ ownerId, sourceEventId, bridgeSourceEventId });
    if (
      this.semanticCorrelations.size >= MAX_SEMANTIC_CORRELATIONS ||
      this.semanticCorrelationBytes + this.semanticCorrelationInFlightBytes + retainedBytes > MAX_SEMANTIC_CORRELATION_BYTES
    ) return null;
    const record: SemanticCorrelationRecord = {
      active: true,
      sourceOwnerId: ownerId,
      sourceEventId,
      bridgeSourceEventId,
      createdAt: this.now(),
      expiresAt: this.now() + SEMANTIC_CORRELATION_RETENTION_MS,
      retainedBytes,
      completionAccepted: false,
      correlationResolved: false,
      correlationResult: null,
      demandEvents: [],
      flushingDemands: false,
      resolve: resolveCorrelation,
      correlation,
    };
    this.semanticCorrelations.set(key, record);
    this.semanticCorrelationAliases.set(bridgeSourceEventId, record);
    this.semanticCorrelationBytes += retainedBytes;
    this.pruneSemanticCorrelations(this.now());
    return this.semanticCorrelations.get(key) ?? null;
  }

  private awaitCorrelation(
    record: SemanticCorrelationRecord,
    deadlineAt: number,
  ): Promise<CompletionCorrelation | null> {
    const remaining = Math.max(0, deadlineAt - this.now());
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), remaining);
      timer.unref();
      void record.correlation.then((correlation) => {
        clearTimeout(timer);
        resolvePromise(correlation);
      });
    });
  }

  private pruneSemanticCorrelations(now: number): void {
    for (const record of this.semanticCorrelations.values()) {
      if (record.expiresAt > now) continue;
      this.deleteSemanticCorrelation(record);
    }
  }

  private deleteSemanticCorrelation(record: SemanticCorrelationRecord): void {
    const key = `${record.sourceOwnerId}\0${record.sourceEventId}`;
    if (!this.semanticCorrelations.delete(key)) return;
    record.active = false;
    this.semanticCorrelationAliases.delete(record.bridgeSourceEventId);
    this.semanticCorrelationBytes -= record.retainedBytes;
    for (const event of record.demandEvents) {
      if (event.phase === 'start') this.semanticService?.censorPendingDemand?.(event.ownerInstanceId, event.requestId);
    }
    record.resolve(null);
  }

  private queueCompleted(owner: OwnerState, input: unknown): boolean {
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
    if (!this.semanticService) {
      void this.publishCompleted(owner, route, event);
      return true;
    }
    const record = this.semanticCorrelation(owner.ownerId, event.eventId, true);
    if (!record) {
      void this.publishCompleted(owner, route, event);
      return true;
    }
    if (record.completionAccepted) return false;
    const eventBytes = serializedSize(event);
    if (
      this.semanticCorrelationBytes + this.semanticCorrelationInFlightBytes + eventBytes >
      MAX_SEMANTIC_CORRELATION_BYTES
    ) {
      this.deleteSemanticCorrelation(record);
      void this.publishCompleted(owner, route, event);
      return true;
    }
    record.completionAccepted = true;
    this.semanticCorrelationInFlightBytes += eventBytes;
    record.expiresAt = Math.max(record.expiresAt, event.completedAt + SEMANTIC_CORRELATION_RETENTION_MS);
    void this.correlateSemanticCompletion(record, owner, route, event).finally(() => {
      this.semanticCorrelationInFlightBytes -= eventBytes;
    });
    this.pruneSemanticCorrelations(this.now());
    return true;
  }

  private async correlateSemanticCompletion(
    record: SemanticCorrelationRecord,
    owner: OwnerState,
    route: RegisteredRoute,
    event: ProxySessionEvent,
  ): Promise<void> {
    let correlation: CompletionCorrelation | null = null;
    try { correlation = await this.correlateCompletion!(event); } catch {}
    if (correlation) {
      const conversation = this.conversations.get(correlation.conversationId);
      if (!conversation || (correlation.cwd !== undefined && correlation.cwd !== conversation.cwd)) {
        correlation = null;
      } else if (record.active) {
        this.semanticService?.observeCall(conversation.conversationId, {
          server: event.upstreamServer,
          tool: event.upstreamTool,
          args: event.args,
          success: event.success,
          completedAt: event.completedAt,
        });
      }
    }
    await this.publishCorrelatedCompletion(
      owner,
      route,
      event,
      correlation ? { ...correlation, eventId: record.bridgeSourceEventId } : null,
      record.bridgeSourceEventId,
    );
    if (!record.active) return;
    record.correlationResolved = true;
    record.correlationResult = correlation;
    record.resolve(correlation);
    if (correlation) await this.flushDemands(record);
    else {
      for (const pending of record.demandEvents) {
        if (pending.phase === 'start') {
          this.semanticService?.censorPendingDemand?.(pending.ownerInstanceId, pending.requestId);
        }
      }
      for (const conversationId of this.conversations.keys()) this.semanticService?.invalidate?.(conversationId);
    }
  }

  private async publishCompleted(owner: OwnerState, route: RegisteredRoute, event: ProxySessionEvent): Promise<void> {
    let correlation: CompletionCorrelation | null = null;
    try { correlation = await this.correlateCompletion!(event); } catch {}
    await this.publishCorrelatedCompletion(owner, route, event, correlation, correlation?.eventId ?? event.eventId);
  }

  private async publishCorrelatedCompletion(
    owner: OwnerState,
    route: RegisteredRoute,
    event: ProxySessionEvent,
    correlation: CompletionCorrelation | null,
    sourceEventId: string,
  ): Promise<void> {
    const currentOwner = this.owners.get(owner.ownerId);
    const currentRoute = currentOwner?.routes.find((candidate) =>
      candidate.routeId === event.routeId && candidate.generation === event.generation,
    );
    if (!currentRoute) return;
    const conversation = correlation && validId(correlation.conversationId)
      ? this.conversations.get(correlation.conversationId)
      : null;
    if (!correlation || !conversation || (correlation.cwd !== undefined && correlation.cwd !== conversation.cwd)) {
      return;
    }
    const eventId = correlation.eventId ?? sourceEventId;
    if (!validId(eventId)) return;
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
      context: conversation,
      kind: 'tool-complete',
      eventId,
      observedAt: event.completedAt,
      routeId: route.routeId,
      args: event.args,
      parsed: event.result ? parseResult(event.result) : null,
      latencyMs: event.completedAt - event.startedAt,
      ordered,
    });
    if (!accepted) this.sessionPredictor.invalidate([]);
  }
}

export interface CompletionCorrelation {
  conversationId: string;
  cwd?: string;
  eventId?: string;
  ordered?: boolean;
}

export type CompletionCorrelator = (
  event: Readonly<ProxySessionEvent>,
) => CompletionCorrelation | null | Promise<CompletionCorrelation | null>;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validSemanticHandshake(value: unknown): value is {
  ownerId: string;
  semanticConfig: SemanticRankingConfig | null;
  semanticRevision: number;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const handshake = value as Record<string, unknown>;
  return Object.keys(handshake).every((key) => ['ownerId', 'semanticConfig', 'semanticRevision'].includes(key)) &&
    validId(handshake.ownerId) &&
    finiteInteger(handshake.semanticRevision, 0) &&
    (handshake.semanticConfig === null || validSemanticConfig(handshake.semanticConfig));
}

function validSemanticConfig(value: unknown): value is SemanticRankingConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return Object.keys(config).every((key) => [
    'mode', 'model', 'timeoutMs', 'maxCandidates', 'horizonMs',
    'maxRequestsPerMinute', 'maxRequestsPerSession',
  ].includes(key)) &&
    (config.mode === 'off' || config.mode === 'shadow' || config.mode === 'rank') &&
    typeof config.model === 'string' && config.model.length > 0 && Buffer.byteLength(config.model, 'utf8') <= 128 &&
    finiteInteger(config.timeoutMs, 1) && config.timeoutMs <= 500 &&
    finiteInteger(config.maxCandidates, 1) && config.maxCandidates <= 16 &&
    finiteInteger(config.horizonMs, 1) && config.horizonMs <= 30_000 &&
    finiteInteger(config.maxRequestsPerMinute, 1) && config.maxRequestsPerMinute <= 60 &&
    finiteInteger(config.maxRequestsPerSession, 1) && config.maxRequestsPerSession <= 1_000;
}

function validSemanticRequest(value: unknown): value is SemanticRankingRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const allowed = new Set([
    'protocolVersion', 'requestId', 'batchId', 'sourceEventId', 'ownerInstanceId', 'launchId',
    'conversationId', 'createdAt', 'deadlineAt', 'batchDigest', 'candidates',
  ]);
  if (!Object.keys(request).every((key) => allowed.has(key)) || request.protocolVersion !== 1 ||
    !['requestId', 'batchId', 'sourceEventId', 'ownerInstanceId', 'launchId', 'batchDigest']
      .every((key) => validId(request[key])) ||
    (request.conversationId !== undefined && !validId(request.conversationId)) ||
    !finiteNumber(request.createdAt, 0) || !finiteNumber(request.deadlineAt, 0) ||
    !Array.isArray(request.candidates)) return false;
  return request.candidates.every(validSemanticCandidate);
}

function validSemanticCandidate(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).every((key) => [
    'id', 'routeId', 'generation', 'server', 'tool', 'toolDescription', 'args', 'baselineScore',
    'conservativeLatencyMs', 'effectiveTtlMs',
  ].includes(key)) &&
    ['id', 'routeId', 'server', 'tool'].every((key) => validId(candidate[key])) &&
    (candidate.toolDescription === undefined || (
      typeof candidate.toolDescription === 'string' &&
      Buffer.byteLength(candidate.toolDescription, 'utf8') <= 2 * 1024
    )) &&
    finiteInteger(candidate.generation, 1) &&
    jsonRecord(candidate.args) &&
    finiteNumber(candidate.baselineScore, 0) &&
    finiteNumber(candidate.conservativeLatencyMs, 0) &&
    finiteNumber(candidate.effectiveTtlMs, 0);
}

function validSemanticReply(
  reply: SemanticRankingReply,
  request: SemanticRankingRequest,
  conversationId: string,
  model: string,
): boolean {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return false;
  const value = reply as unknown as Record<string, unknown>;
  const allowed = new Set([
    'protocolVersion', 'requestId', 'batchId', 'sourceEventId', 'ownerInstanceId', 'launchId',
    'conversationId', 'batchDigest', 'contextRevision', 'model', 'questionVersion',
    'providerDurationMs', 'tokenUsage', 'scores',
  ]);
  if (!Object.keys(value).every((key) => allowed.has(key)) ||
    reply.protocolVersion !== 1 ||
    reply.requestId !== request.requestId ||
    reply.batchId !== request.batchId ||
    reply.sourceEventId !== request.sourceEventId ||
    reply.ownerInstanceId !== request.ownerInstanceId ||
    reply.launchId !== request.launchId ||
    reply.conversationId !== conversationId ||
    reply.batchDigest !== request.batchDigest ||
    reply.model !== model ||
    !finiteInteger(reply.contextRevision, 0) ||
    !validId(reply.questionVersion) ||
    !finiteNumber(reply.providerDurationMs, 0) ||
    !jsonRecord(reply.scores)) return false;
  const candidateIds = new Set(request.candidates.map((candidate) => candidate.id));
  if (!Object.entries(reply.scores).every(([id, score]) => candidateIds.has(id) && finiteNumber(score, 0, 1))) {
    return false;
  }
  if (reply.tokenUsage !== undefined && (
    Object.keys(reply.tokenUsage).some((key) => key !== 'input' && key !== 'output') ||
    !finiteInteger(reply.tokenUsage.input, 0) || !finiteInteger(reply.tokenUsage.output, 0)
  )) return false;
  return true;
}

function validProxyDemand(value: unknown): value is ProxyDemandEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const common = ['phase', 'requestId', 'sourceEventId', 'ownerInstanceId', 'routeId', 'generation'];
  if (!common.slice(1).every((key) => key === 'generation' || validId(event[key])) ||
    !finiteInteger(event.generation, 1)) return false;
  if (event.phase === 'start') {
    return Object.keys(event).every((key) => [...common, 'server', 'tool', 'args', 'startedAt'].includes(key)) &&
      validId(event.server) && validId(event.tool) && jsonRecord(event.args) && finiteNumber(event.startedAt, 0);
  }
  return event.phase === 'complete' &&
    Object.keys(event).every((key) => [...common, 'completedAt', 'success'].includes(key)) &&
    finiteNumber(event.completedAt, 0) && typeof event.success === 'boolean';
}

function finiteNumber(value: unknown, minimum: number, maximum = Number.POSITIVE_INFINITY): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function finiteInteger(value: unknown, minimum: number): value is number {
  return finiteNumber(value, minimum) && Number.isInteger(value);
}

function jsonRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return JSON.stringify(value) !== undefined; } catch { return false; }
}

function serializedSize(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return MAX_SEMANTIC_CORRELATION_BYTES; }
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
    typeof event.success === 'boolean' &&
    (event.result === undefined || (event.result !== null && typeof event.result === 'object' && !Array.isArray(event.result))) &&
    typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 &&
    typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0 &&
    typeof event.completedAt === 'number' && Number.isFinite(event.completedAt) &&
    event.completedAt >= event.startedAt;
}

function validLocalRoute(value: unknown): value is LocalRouteDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return Object.keys(route).every((key) => ['exposedTool', 'upstreamServer', 'upstreamTool', 'inputSchema', 'readOnly'].includes(key)) &&
    ['exposedTool', 'upstreamServer', 'upstreamTool'].every((key) => typeof route[key] === 'string' && (route[key] as string).length > 0 && (route[key] as string).length <= 512) &&
    (route.readOnly === undefined || typeof route.readOnly === 'boolean') &&
    route.inputSchema !== null && typeof route.inputSchema === 'object' && !Array.isArray(route.inputSchema);
}

function validLifecycle(value: unknown): value is ObserverLifecycleEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<ObserverLifecycleEvent>;
  return ['suppressed', 'speculated', 'hit', 'joined', 'expired', 'invalidated', 'abandoned', 'spec_error'].includes(event.type ?? '') &&
    typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) &&
    validId(event.ruleId) && event.observerAttribution !== undefined &&
    (event.observerAttribution.client === 'claude' || event.observerAttribution.client === 'codex') &&
    ['intent', 'transition', 'stream'].includes(event.observerAttribution.source) &&
    validId(event.observerAttribution.routeId) && Number.isInteger(event.observerAttribution.generation);
}

export interface SessionBridgeOwnerOptions {
  hostClient: AgentKind;
  hostServerAlias: string;
  onCandidates(candidates: Array<Candidate | AuthorizedCandidate>): void;
}

export class SessionBridgeOwner {
  readonly coordinates: SessionBridgeCoordinates;
  readonly ownerId: string;
  private requestId = 1;
  private closed = false;
  private disconnectHandler: (() => void) | null = null;
  private invalidationHandler: ((routeIds: readonly string[], reason: string) => void) | null = null;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly permissionContexts = new Map<string, string>();
  private semanticRevisionSequence: number;

  private constructor(
    coordinates: SessionBridgeCoordinates,
    ownerId: string,
    private readonly configuredSemanticRanking: SemanticRankingConfig | null,
    semanticRevision: number,
    private readonly socket: Socket,
    private onCandidates: (candidates: Array<Candidate | AuthorizedCandidate>) => void,
  ) {
    this.coordinates = coordinates;
    this.ownerId = ownerId;
    this.semanticRevisionSequence = semanticRevision;
  }

  static async connect(coordinates: SessionBridgeCoordinates, options: SessionBridgeOwnerOptions): Promise<SessionBridgeOwner> {
    const socket = createConnection(coordinates.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let instance: SessionBridgeOwner | null = null;
    let helloResolve!: (value: { ownerId: string; semanticConfig: SemanticRankingConfig | null; semanticRevision: number }) => void;
    let helloReject!: (error: Error) => void;
    const hello = new Promise<{ ownerId: string; semanticConfig: SemanticRankingConfig | null; semanticRevision: number }>((resolve, reject) => {
      helloResolve = resolve;
      helloReject = reject;
    });
    readLines(socket, (raw) => {
      if (raw === null || typeof raw !== 'object') return;
      const message = raw as ServerMessage;
      if (message.type === 'candidates') {
        try { instance?.onCandidates(message.candidates); } catch {}
        return;
      }
      if (message.type === 'permission-context') {
        if (message.permissionContext) instance?.permissionContexts.set(message.conversationId, message.permissionContext);
        else instance?.permissionContexts.delete(message.conversationId);
        return;
      }
      if (message.type === 'semantic-invalidate') {
        if (finiteInteger(message.revision, 0) && message.revision > (instance?.semanticRevisionSequence ?? -1)) {
          if (instance) instance.semanticRevisionSequence = message.revision;
        }
        return;
      }
      if (
        message.type === 'invalidate' &&
        Array.isArray(message.routeIds) &&
        message.routeIds.length <= 512 &&
        message.routeIds.every(validId) &&
        validId(message.reason)
      ) {
        try { instance?.invalidationHandler?.(message.routeIds, message.reason); } catch {}
        return;
      }
      if (message.type !== 'response') return;
      if (!instance && message.requestId === 0) {
        if (message.ok && validSemanticHandshake(message.value)) helloResolve(message.value);
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
    const handshake = await hello;
    instance = new SessionBridgeOwner(
      coordinates,
      handshake.ownerId,
      handshake.semanticConfig,
      handshake.semanticRevision,
      socket,
      options.onCandidates,
    );
    return instance;
  }

  async register(routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    return await this.request({ type: 'register', routes: [...routes] }) as RegisteredRoute[];
  }

  replaceRoutes(routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    return this.register(routes);
  }

  setCandidateHandler(handler: (candidates: unknown) => void): void {
    this.onCandidates = handler as (candidates: Array<Candidate | AuthorizedCandidate>) => void;
  }

  currentPermissionContext(conversationId: string): string | null {
    return this.permissionContexts.get(conversationId) ?? null;
  }

  async readStartupPolicy(): Promise<unknown> {
    return await this.request({ type: 'startup-policy' }, 1_000);
  }

  setDisconnectHandler(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  setInvalidationHandler(handler: (routeIds: readonly string[], reason: string) => void): void {
    this.invalidationHandler = handler;
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

  semanticConfig(): SemanticRankingConfig | undefined {
    return this.configuredSemanticRanking ? structuredClone(this.configuredSemanticRanking) : undefined;
  }

  semanticRevision(): number {
    return this.semanticRevisionSequence;
  }

  async judgeCandidates(request: SemanticRankingRequest): Promise<SemanticRankingReply | null> {
    return await this.request({ type: 'semantic-judge', semanticRequest: request }) as SemanticRankingReply | null;
  }

  async publishDemand(event: ProxyDemandEvent): Promise<boolean> {
    return await this.request({ type: 'semantic-demand', demand: event }) as boolean;
  }

  async publishLifecycle(event: ObserverLifecycleEvent): Promise<boolean> {
    return await this.request({ type: 'lifecycle', lifecycle: event }) as boolean;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.permissionContexts.clear();
    await new Promise<void>((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }

  private request(message: ClientMessage, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('session bridge owner is closed'));
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const settle = (callback: (value: unknown) => void) => (value: unknown) => {
        if (timer) clearTimeout(timer);
        callback(value);
      };
      this.pending.set(requestId, { resolve: settle(resolve), reject: settle(reject) as (error: Error) => void });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          reject(new Error('session bridge request timed out'));
        }, timeoutMs);
        timer.unref();
      }
      if (!send(this.socket, { ...message, requestId })) {
        this.pending.delete(requestId);
        if (timer) clearTimeout(timer);
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
