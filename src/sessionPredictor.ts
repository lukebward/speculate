import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { TransitionLearner } from './learner.js';
import { candidateSchema, type Candidate, type Observation, type RegisteredRoute } from './observerTypes.js';
import type { ObservedCall } from './types.js';

const MAX_CONVERSATIONS = 256;
const MAX_REPLAY_IDS = 4_096;
const REPLAY_RETENTION_MS = 120_000;
const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const LEARNER_RETAINED_COPY_FACTOR = 4;
const OBSERVATION_STATE_OVERHEAD_BYTES = 512;

export interface SessionPredictorOptions {
  routes(): readonly RegisteredRoute[];
  now?: () => number;
}

interface ConversationState {
  learner: TransitionLearner;
  routeIds: Set<string>;
  retainedBytes: number;
  lastUsed: number;
}

export class SessionPredictor {
  private readonly now: () => number;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly replay = new Map<string, number>();
  private candidateSequence = 0;
  private stateSequence = 0;
  private retainedBytes = 0;

  constructor(private readonly options: SessionPredictorOptions) {
    this.now = options.now ?? Date.now;
  }

  observe(event: Observation): Candidate[] {
    if (event.kind === 'invalidate') {
      this.invalidate(event.routeIds);
      return [];
    }
    const now = this.now();
    this.pruneReplay(now);
    const routes = this.options.routes();
    if (event.kind === 'prompt') return this.intentCandidates(event, routes, now);
    if (event.kind === 'stream-call') return this.streamCandidate(event, routes, now);
    if (event.kind !== 'tool-complete') return [];

    if (!this.claimReplay(`${event.context.conversationId}\0${event.routeId}\0${event.eventId}`, now)) return [];
    const source = routes.find((route) => route.routeId === event.routeId);
    if (!source) return [];

    let state = this.conversations.get(event.context.conversationId);
    if (!state) {
      if (this.conversations.size >= MAX_CONVERSATIONS) this.dropOldestConversation();
      state = this.newConversation();
      this.conversations.set(event.context.conversationId, state);
    }
    if (!event.ordered) {
      this.resetConversation(event.context.conversationId);
      return [];
    }

    const args = copyJsonRecord(event.args);
    const parsed = copyJson(event.parsed);
    if (!args.ok || !parsed.ok) return [];
    const retainedBytes = OBSERVATION_STATE_OVERHEAD_BYTES +
      LEARNER_RETAINED_COPY_FACTOR * (args.bytes + parsed.bytes);
    if (retainedBytes > MAX_CONVERSATION_BYTES) {
      this.dropConversation(event.context.conversationId);
      return [];
    }
    if (state.retainedBytes + retainedBytes > MAX_CONVERSATION_BYTES) {
      state = this.resetConversation(event.context.conversationId);
    }
    state.retainedBytes += retainedBytes;
    state.lastUsed = ++this.stateSequence;
    this.retainedBytes += retainedBytes;
    this.enforceSessionBytes(event.context.conversationId);
    const server = conversationToken(event.context.conversationId);
    const tool = routeToken(source);
    const observed: ObservedCall = {
      server,
      tool,
      args: args.value,
      result: { content: [] },
      parsed: parsed.value,
      timestamp: event.observedAt,
      latencyMs: event.latencyMs,
    };
    state.routeIds.add(source.routeId);
    state.learner.observe(observed);

    const byToken = new Map(routes.map((route) => [routeToken(route), route]));
    return state.learner.predict(observed).flatMap((prediction) => {
      const destination = byToken.get(prediction.tool);
      if (!destination) return [];
      state!.routeIds.add(destination.routeId);
      const candidate = candidateSchema.safeParse({
        version: 1 as const,
        launchId: event.context.launchId,
        conversationId: event.context.conversationId,
        candidateId: `transition:${++this.candidateSequence}`,
        routeId: destination.routeId,
        generation: destination.generation,
        sourceEventId: event.eventId,
        source: 'transition' as const,
        args: prediction.args,
        confidence: prediction.confidence,
        createdAt: now,
      });
      return candidate.success ? [candidate.data] : [];
    }).slice(0, 3);
  }

  private intentCandidates(
    event: Extract<Observation, { kind: 'prompt' }>,
    routes: readonly RegisteredRoute[],
    now: number,
  ): Candidate[] {
    const sourceEventId = event.occurrenceId ?? event.eventId;
    const mapped = explicitIntent(event.text, event.context.cwd, routes.filter((route) =>
      route.hostClient === event.context.agent));
    if (!mapped) return [];
    const replayKey = `${event.context.conversationId}\0${mapped.route.routeId}\0${sourceEventId}`;
    if (!this.claimReplay(replayKey, now)) return [];
    return this.candidate(event, mapped.route, sourceEventId, 'intent', mapped.args, 0.95, now);
  }

  private streamCandidate(
    event: Extract<Observation, { kind: 'stream-call' }>,
    routes: readonly RegisteredRoute[],
    now: number,
  ): Candidate[] {
    const matches = routes.filter((route) =>
      route.routeId === event.routeId && route.hostClient === event.context.agent);
    if (matches.length !== 1 || !validArgs(matches[0]!, event.args)) return [];
    const replayKey = `${event.context.conversationId}\0${event.routeId}\0${event.callId}`;
    if (!this.claimReplay(replayKey, now)) return [];
    return this.candidate(event, matches[0]!, event.callId, 'stream', event.args, 1, now);
  }

  private candidate(
    event: Exclude<Observation, { kind: 'invalidate' | 'tool-complete' }>,
    route: RegisteredRoute,
    sourceEventId: string,
    source: 'intent' | 'stream',
    args: Record<string, unknown>,
    confidence: number,
    now: number,
  ): Candidate[] {
    const copied = copyJsonRecord(args);
    if (!copied.ok) return [];
    const parsed = candidateSchema.safeParse({
      version: 1 as const,
      launchId: event.context.launchId,
      conversationId: event.context.conversationId,
      candidateId: `${source}:${++this.candidateSequence}`,
      routeId: route.routeId,
      generation: route.generation,
      sourceEventId,
      source,
      args: copied.value,
      confidence,
      createdAt: now,
    });
    return parsed.success ? [parsed.data] : [];
  }

  private claimReplay(key: string, now: number): boolean {
    if (this.replay.has(key)) return false;
    this.replay.set(key, now);
    while (this.replay.size > MAX_REPLAY_IDS) this.replay.delete(this.replay.keys().next().value!);
    return true;
  }

  invalidate(routeIds: string[]): void {
    if (routeIds.length === 0) {
      this.conversations.clear();
      this.replay.clear();
      this.retainedBytes = 0;
      return;
    }
    const removed = new Set(routeIds);
    for (const [conversationId, state] of this.conversations) {
      if ([...state.routeIds].some((routeId) => removed.has(routeId))) {
        this.dropConversation(conversationId);
      }
    }
  }

  private newConversation(): ConversationState {
    return {
      learner: new TransitionLearner({
        now: this.now,
        maxTransitions: 500,
        maxPredictionsPerTrigger: 3,
      }),
      routeIds: new Set(),
      retainedBytes: 0,
      lastUsed: ++this.stateSequence,
    };
  }

  private resetConversation(conversationId: string): ConversationState {
    this.dropConversation(conversationId);
    const state = this.newConversation();
    this.conversations.set(conversationId, state);
    return state;
  }

  private dropConversation(conversationId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) return;
    this.retainedBytes -= state.retainedBytes;
    this.conversations.delete(conversationId);
  }

  private enforceSessionBytes(protectedConversationId: string): void {
    while (this.retainedBytes > MAX_SESSION_BYTES) {
      if (!this.dropOldestConversation(protectedConversationId)) return;
    }
  }

  private dropOldestConversation(excludedConversationId?: string): boolean {
    let oldest: { conversationId: string; lastUsed: number } | null = null;
    for (const [conversationId, state] of this.conversations) {
      if (conversationId === excludedConversationId) continue;
      if (!oldest || state.lastUsed < oldest.lastUsed) oldest = { conversationId, lastUsed: state.lastUsed };
    }
    if (!oldest) return false;
    this.dropConversation(oldest.conversationId);
    return true;
  }

  private pruneReplay(now: number): void {
    for (const [key, at] of this.replay) {
      if (now - at > REPLAY_RETENTION_MS) this.replay.delete(key);
    }
  }
}

function explicitIntent(
  text: string,
  cwd: string,
  routes: readonly RegisteredRoute[],
): { route: RegisteredRoute; args: Record<string, unknown> } | null {
  const input = text.trim();
  const pull = /^(?:please\s+)?(?:review|inspect|read|open|check)\s+(?:the\s+)?(?:(?:pull request|pr)\s+(?:at\s+)?)?https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\.?$/i.exec(input);
  if (pull) {
    const pullNumber = Number(pull[3]);
    if (!Number.isSafeInteger(pullNumber)) return null;
    return uniqueMappedRoute(routes, [
      { tool: 'get_pull_request', args: { owner: pull[1]!, repo: pull[2]!, pull_number: pullNumber } },
      { tool: 'pull_request_read', args: { owner: pull[1]!, repo: pull[2]!, pullNumber, method: 'get' } },
    ]);
  }

  const workspace = /^(?:please\s+)?(?:list|show)(?:\s+me)?\s+(?:(?:the\s+)?(?:contents|files|entries)\s+(?:in|of)\s+)?(?:the\s+)?(?:workspace|current|working)(?:\s+directory)?\.?$/i.exec(input);
  if (workspace) return uniqueMappedRoute(routes, [{ tool: 'list_directory', args: { path: cwd } }]);

  const absolute = /^(?:please\s+)?(?:list|show)(?:\s+me)?\s+(?:(?:the\s+)?(?:contents|files|entries)\s+(?:in|of)\s+)?(\/[^\s"'`]+?)\.?$/i.exec(input);
  if (absolute) return uniqueMappedRoute(routes, [{ tool: 'list_directory', args: { path: absolute[1]! } }]);
  return null;
}

function uniqueMappedRoute(
  routes: readonly RegisteredRoute[],
  mappings: readonly { tool: string; args: Record<string, unknown> }[],
): { route: RegisteredRoute; args: Record<string, unknown> } | null {
  const matches = mappings.flatMap((mapping) => routes
    .filter((route) => route.exposedTool === mapping.tool &&
      compatibleMapping(route.inputSchema, mapping.args) && validArgs(route, mapping.args))
    .map((route) => ({ route, args: mapping.args })));
  return matches.length === 1 ? matches[0]! : null;
}

function compatibleMapping(schema: Record<string, unknown>, args: Record<string, unknown>): boolean {
  if (schema.type !== 'object' || schema.properties === null || typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties) || !Array.isArray(schema.required)) return false;
  const properties = schema.properties as Record<string, unknown>;
  const required = new Set(schema.required.filter((item): item is string => typeof item === 'string'));
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!required.has(key) || property === null || typeof property !== 'object' || Array.isArray(property)) return false;
    const shape = property as Record<string, unknown>;
    if (typeof value === 'string' && shape.type !== 'string') return false;
    if (typeof value === 'number' && shape.type !== 'number' && shape.type !== 'integer') return false;
    if (key === 'method' && shape.const !== value &&
      (!Array.isArray(shape.enum) || !shape.enum.includes(value))) return false;
  }
  return true;
}

function validArgs(route: RegisteredRoute, args: Record<string, unknown>): boolean {
  try {
    return new AjvJsonSchemaValidator()
      .getValidator<Record<string, unknown>>(route.inputSchema as never)(args).valid;
  } catch {
    return false;
  }
}

function conversationToken(conversationId: string): string {
  return `session:${digest(conversationId)}`;
}

function routeToken(route: Pick<RegisteredRoute, 'routeId' | 'generation'>): string {
  return `route:${digest(`${route.routeId}\0${route.generation}`)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function copyJson(value: unknown): { ok: true; value: unknown; bytes: number } | { ok: false } {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return { ok: false };
    return {
      ok: true,
      value: JSON.parse(serialized) as unknown,
      bytes: Buffer.byteLength(serialized, 'utf8'),
    };
  } catch {
    return { ok: false };
  }
}

function copyJsonRecord(value: Record<string, unknown>):
  { ok: true; value: Record<string, unknown>; bytes: number } | { ok: false } {
  const copied = copyJson(value);
  if (!copied.ok || copied.value === null || typeof copied.value !== 'object' || Array.isArray(copied.value)) {
    return { ok: false };
  }
  return { ok: true, value: copied.value as Record<string, unknown>, bytes: copied.bytes };
}
