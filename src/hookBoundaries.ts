import { randomUUID } from 'node:crypto';
import {
  observationSchema,
  type AgentAdapterEnvironment,
  type Observation,
  type RegisteredRoute,
  type SessionContext,
} from './observerTypes.js';

const MAX_HOOK_BOUNDARIES = 1_024;
const MAX_HOOK_BOUNDARY_BYTES = 1024 * 1024;

interface HookBoundary {
  context: SessionContext;
  callId: string;
  toolName: string;
  actorId?: string;
  turnId?: string;
}

interface RetainedBoundary {
  conversationId: string;
  bytes: number;
  classification?: HookBoundaryClassification;
}

export type HookBoundaryClassification =
  | { kind: 'read'; routeId: string; generation: number }
  | { kind: 'mutation' };

export function modelToolName(route: RegisteredRoute): string {
  return `mcp__${route.hostServerAlias}__${route.exposedTool}`;
}

export function observeHookToolBoundary(
  tracker: HookBoundaryTracker,
  environment: AgentAdapterEnvironment,
  input: HookBoundary & {
    phase: 'started' | 'settled';
    args: Record<string, unknown>;
    observedAt: number;
  },
): readonly Observation[] {
  const routes = environment.routes().filter((route) =>
    route.hostClient === input.context.agent && modelToolName(route) === input.toolName
  );
  const startClassification = input.phase === 'started'
    ? routes.length === 1 && routes[0]!.readOnly === true
      ? { kind: 'read' as const, routeId: routes[0]!.routeId, generation: routes[0]!.generation }
      : { kind: 'mutation' as const }
    : undefined;
  const boundary = tracker.observeStatus(input, input.phase, startClassification);
  if (boundary.gap) {
    try { environment.onTrackingLoss?.(input.observedAt); } catch {}
  }
  if (boundary.duplicate) return [];
  if (boundary.classification?.kind === 'read') {
    try {
      environment.onToolCallMarker?.({
        source: 'hook',
        phase: input.phase,
        context: input.context,
        routeId: boundary.classification.routeId,
        generation: boundary.classification.generation,
        callId: input.callId,
        args: input.args,
        observedAt: input.observedAt,
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      });
    } catch {}
    return [];
  }
  const parsed = observationSchema.safeParse({
    kind: 'invalidate',
    context: input.context,
    eventId: environment.eventId?.('invalidate', `hook:${input.callId}:${input.phase}`) ??
      `${input.context.agent}:invalidate:hook:${input.callId}:${input.phase}:${randomUUID()}`,
    observedAt: input.observedAt,
    routeIds: [],
    reason: input.phase === 'started' ? 'native-mutation-start' : 'native-mutation-settle',
  });
  return parsed.success ? [parsed.data] : [];
}

export class HookBoundaryTracker {
  private readonly active = new Map<string, RetainedBoundary>();
  private readonly settled = new Map<string, RetainedBoundary>();
  private retainedBytes = 0;

  observe(boundary: HookBoundary, phase: 'started' | 'settled'): boolean {
    return this.observeStatus(boundary, phase).gap;
  }

  observeStatus(
    boundary: HookBoundary,
    phase: 'started' | 'settled',
    classification?: HookBoundaryClassification,
  ): { gap: boolean; duplicate: boolean; classification?: HookBoundaryClassification } {
    const key = this.key(boundary);
    if (phase === 'started') {
      const prior = this.active.get(key) ?? this.settled.get(key);
      if (prior) return { gap: false, duplicate: true, classification: prior.classification };
      return {
        gap: this.retain(this.active, key, boundary.context.conversationId, classification),
        duplicate: false,
        classification,
      };
    }
    const active = this.active.get(key);
    if (active) {
      this.active.delete(key);
      this.retainedBytes -= active.bytes;
      return {
        gap: this.retain(this.settled, key, boundary.context.conversationId, active.classification),
        duplicate: false,
        classification: active.classification,
      };
    }
    const settled = this.settled.get(key);
    if (settled) return { gap: false, duplicate: true, classification: settled.classification };
    this.retain(this.settled, key, boundary.context.conversationId, classification);
    return { gap: true, duplicate: false, classification };
  }

  endSession(context: SessionContext): boolean {
    let missing = false;
    for (const [key, value] of this.active) {
      if (value.conversationId !== context.conversationId) continue;
      this.active.delete(key);
      this.retainedBytes -= value.bytes;
      missing = true;
    }
    for (const [key, value] of this.settled) {
      if (value.conversationId !== context.conversationId) continue;
      this.settled.delete(key);
      this.retainedBytes -= value.bytes;
    }
    return missing;
  }

  private retain(
    target: Map<string, RetainedBoundary>,
    key: string,
    conversationId: string,
    classification?: HookBoundaryClassification,
  ): boolean {
    const bytes = Buffer.byteLength(key, 'utf8') +
      (classification?.kind === 'read' ? Buffer.byteLength(classification.routeId, 'utf8') : 0) + 128;
    if (this.active.size + this.settled.size >= MAX_HOOK_BOUNDARIES ||
      this.retainedBytes + bytes > MAX_HOOK_BOUNDARY_BYTES) {
      this.active.clear();
      this.settled.clear();
      this.retainedBytes = 0;
      return true;
    }
    target.set(key, { conversationId, bytes, classification });
    this.retainedBytes += bytes;
    return false;
  }

  private key(boundary: HookBoundary): string {
    return [
      boundary.context.launchId,
      boundary.context.conversationId,
      boundary.actorId ?? '',
      boundary.turnId ?? '',
      boundary.toolName,
      boundary.callId,
    ].join('\0');
  }
}
