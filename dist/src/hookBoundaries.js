import { randomUUID } from 'node:crypto';
import { observationSchema, } from './observerTypes.js';
const MAX_HOOK_BOUNDARIES = 1_024;
const MAX_HOOK_BOUNDARY_BYTES = 1024 * 1024;
export function modelToolName(route) {
    return `mcp__${route.hostServerAlias}__${route.exposedTool}`;
}
export function observeHookToolBoundary(tracker, environment, input) {
    const routes = environment.routes().filter((route) => route.hostClient === input.context.agent && modelToolName(route) === input.toolName);
    const startClassification = input.phase === 'started'
        ? routes.length === 1 && routes[0].readOnly === true
            ? { kind: 'read', routeId: routes[0].routeId, generation: routes[0].generation }
            : { kind: 'mutation' }
        : undefined;
    const boundary = tracker.observeStatus(input, input.phase, startClassification);
    if (boundary.gap) {
        try {
            environment.onTrackingLoss?.(input.observedAt);
        }
        catch { }
    }
    if (boundary.duplicate)
        return [];
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
        }
        catch { }
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
    active = new Map();
    settled = new Map();
    retainedBytes = 0;
    observe(boundary, phase) {
        return this.observeStatus(boundary, phase).gap;
    }
    observeStatus(boundary, phase, classification) {
        const key = this.key(boundary);
        if (phase === 'started') {
            const prior = this.active.get(key) ?? this.settled.get(key);
            if (prior)
                return { gap: false, duplicate: true, classification: prior.classification };
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
        if (settled)
            return { gap: false, duplicate: true, classification: settled.classification };
        this.retain(this.settled, key, boundary.context.conversationId, classification);
        return { gap: true, duplicate: false, classification };
    }
    endSession(context) {
        let missing = false;
        for (const [key, value] of this.active) {
            if (value.conversationId !== context.conversationId)
                continue;
            this.active.delete(key);
            this.retainedBytes -= value.bytes;
            missing = true;
        }
        for (const [key, value] of this.settled) {
            if (value.conversationId !== context.conversationId)
                continue;
            this.settled.delete(key);
            this.retainedBytes -= value.bytes;
        }
        return missing;
    }
    retain(target, key, conversationId, classification) {
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
    key(boundary) {
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
