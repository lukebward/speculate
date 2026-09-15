import { z } from 'zod';

export const MAX_CANDIDATE_BYTES = 64 * 1024;
export const MAX_OBSERVATION_BYTES = 2 * 1024 * 1024;

const id = z.string().min(1).max(512);
const jsonObject = z.record(z.string(), z.json());

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export const agentKindSchema = z.enum(['claude', 'codex']);
export const observerModeSchema = z.enum(['off', 'hooks', 'proxy']);
export const signalKindSchema = z.enum(['intent', 'transition', 'stream']);

export const sessionContextSchema = z.object({
  launchId: id,
  conversationId: id,
  agent: agentKindSchema,
  cwd: z.string().min(1).max(16_384),
}).strict();

export const candidateSchema = z.object({
  version: z.literal(1),
  launchId: id,
  conversationId: id,
  candidateId: id,
  routeId: id,
  generation: z.number().int().positive().finite(),
  sourceEventId: id,
  source: signalKindSchema,
  args: jsonObject,
  confidence: z.number().min(0).max(1).finite(),
  createdAt: z.number().nonnegative().finite(),
}).strict().refine((value) => serializedSize(value) <= MAX_CANDIDATE_BYTES, {
  message: `candidate exceeds ${MAX_CANDIDATE_BYTES} bytes`,
});

const observationBase = {
  context: sessionContextSchema,
  eventId: id,
  observedAt: z.number().nonnegative().finite(),
};

export const observationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...observationBase,
    kind: z.literal('prompt'),
    occurrenceId: id.optional(),
    text: z.string().max(MAX_OBSERVATION_BYTES),
  }).strict(),
  z.object({
    ...observationBase,
    kind: z.literal('tool-complete'),
    routeId: id,
    args: jsonObject,
    parsed: z.json(),
    latencyMs: z.number().nonnegative().finite(),
    ordered: z.boolean(),
  }).strict(),
  z.object({
    ...observationBase,
    kind: z.literal('stream-call'),
    routeId: id,
    callId: id,
    args: jsonObject,
  }).strict(),
  z.object({
    ...observationBase,
    kind: z.literal('invalidate'),
    routeIds: z.array(id).max(512),
    reason: z.string().min(1).max(512),
  }).strict(),
]).refine((value) => serializedSize(value) <= MAX_OBSERVATION_BYTES, {
  message: `observation exceeds ${MAX_OBSERVATION_BYTES} bytes`,
});

export type AgentKind = z.infer<typeof agentKindSchema>;
export type ObserverMode = z.infer<typeof observerModeSchema>;
export type SignalKind = z.infer<typeof signalKindSchema>;
export type SessionContext = z.infer<typeof sessionContextSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Observation = z.infer<typeof observationSchema>;

export interface AuthorizedCandidate {
  candidate: Candidate;
  permissionContext: string;
}

export interface LocalRouteDescriptor {
  exposedTool: string;
  upstreamServer: string;
  upstreamTool: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredRoute extends LocalRouteDescriptor {
  routeId: string;
  generation: number;
  instanceId: string;
  hostClient: AgentKind;
  hostServerAlias: string;
}

export type HostPermissionDecision = 'allowed' | 'denied' | 'approval-required' | 'unverifiable';

export interface HostPermissionGate {
  check(input: {
    hostClient: AgentKind;
    hostServerAlias: string;
    exposedTool: string;
    args: Readonly<Record<string, unknown>>;
    permissionContext: string;
  }): HostPermissionDecision;
}

export type LlmTransport = 'http' | 'websocket';

export type LlmHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface AgentAdapterRequest {
  transport: LlmTransport;
  method: string;
  path: string;
  headers: LlmHeaders;
}

export interface AgentAdapterResponse {
  status: number;
  headers: LlmHeaders;
}

export interface AgentAdapterRequestObserver {
  observeRequestBody(body: Uint8Array, observedAt?: number): readonly Observation[];
  observeResponseStart(response: AgentAdapterResponse, observedAt?: number): readonly Observation[];
  observeResponseChunk(chunk: Uint8Array, observedAt?: number): readonly Observation[];
  observeResponseEnd(observedAt?: number): readonly Observation[];
  abort(): void;
}

export interface WebSocketMessage {
  data: Uint8Array;
  binary: boolean;
}

export interface AgentAdapterWebSocketObserver {
  observeResponseStart(response: AgentAdapterResponse, observedAt?: number): readonly Observation[];
  observeClientMessage(message: WebSocketMessage, observedAt?: number): readonly Observation[];
  observeServerMessage(message: WebSocketMessage, observedAt?: number): readonly Observation[];
  abort(): void;
}

export interface AgentAdapterConnection {
  startRequest(request: AgentAdapterRequest): AgentAdapterRequestObserver | null;
  startWebSocket?(request: AgentAdapterRequest): AgentAdapterWebSocketObserver | null;
  close(): void;
}

export interface AgentAdapter {
  readonly agent: AgentKind;
  createConnection(): AgentAdapterConnection;
  normalizeHook(payload: unknown, observedAt?: number): readonly Observation[];
}

export interface AgentAdapterEnvironment {
  contextForConversation(conversationId: string, cwd?: string): SessionContext | null;
  routes(): readonly RegisteredRoute[];
  now?(): number;
  eventId?(kind: Observation['kind'], stableId: string): string;
  onToolCallMarker?(marker: ToolCallMarker): void;
  onExecutionWindow?(event: ExecutionWindowEvent): void;
  onTrackingLoss?(observedAt: number): void;
}

export interface ToolCallMarker {
  source: 'model' | 'hook';
  phase: 'selected' | 'started' | 'settled';
  context: SessionContext;
  routeId: string;
  generation: number;
  callId: string;
  args: Record<string, unknown>;
  observedAt: number;
  actorId?: string;
  turnId?: string;
}

export interface ExecutionWindowEvent {
  source: 'model' | 'hook';
  phase: 'opened' | 'closed';
  context: SessionContext;
  windowId: string;
  observedAt: number;
  actorId?: string;
  turnId?: string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  upstreamBaseUrl: string;
  transport: 'messages' | 'responses';
  disabledCapabilities?: string[];
  cleanup(): Promise<void>;
}

export interface SessionLaunchCoordinates {
  socketPath: string;
  capability: string;
  launchId: string;
}

export interface AgentLaunchContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientArgs: readonly string[];
  observe: ObserverMode;
  relayBaseUrl: string | null;
  session: SessionLaunchCoordinates;
  hook: SessionLaunchCoordinates;
  self: { command: string; args: string[] };
  clientBin?: string;
}
