import { createHash } from 'node:crypto';
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
    if (event.kind !== 'tool-complete') return [];

    const now = this.now();
    this.pruneReplay(now);
    const replayKey = `${event.context.conversationId}\0${event.routeId}\0${event.eventId}`;
    if (this.replay.has(replayKey)) return [];
    this.replay.set(replayKey, now);
    while (this.replay.size > MAX_REPLAY_IDS) this.replay.delete(this.replay.keys().next().value!);

    const routes = this.options.routes();
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
