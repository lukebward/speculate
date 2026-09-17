import { describe, expect, it } from 'vitest';
import { SemanticEvaluationTracker } from '../src/semanticEvaluation.js';
import type { SemanticCandidateProjection, VerifiedProxyDemandEvent } from '../src/semanticTypes.js';

function candidate(id: string, args: Record<string, unknown>, ttl = 1_000): SemanticCandidateProjection {
  return {
    id,
    routeId: 'route',
    generation: 2,
    server: 'workspace',
    tool: 'read_file',
    args,
    baselineScore: 10,
    conservativeLatencyMs: 100,
    effectiveTtlMs: ttl,
  };
}

function demand(overrides: Partial<VerifiedProxyDemandEvent> = {}): VerifiedProxyDemandEvent {
  return {
    phase: 'start',
    requestId: 'demand-1',
    sourceEventId: 'source-real',
    ownerInstanceId: 'owner',
    routeId: 'route',
    generation: 2,
    server: 'workspace',
    tool: 'read_file',
    args: { path: 'a' },
    startedAt: 1_500,
    conversationId: 'conversation',
    ...overrides,
  } as VerifiedProxyDemandEvent;
}

describe('SemanticEvaluationTracker', () => {
  it('labels exact demand within each candidate horizon independently of next-call order', () => {
    let now = 1_000;
    const tracker = new SemanticEvaluationTracker({ now: () => now, drainMs: 1_000 });
    tracker.register({
      batchId: 'batch', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [
        { candidate: candidate('a', { path: 'a' }), probability: 0.8, windowMs: 1_000 },
        { candidate: candidate('b', { path: 'b' }), probability: 0.3, windowMs: 2_000 },
      ],
    });

    expect(tracker.observeDemand(demand())).toBe(true);
    expect(tracker.observeDemand(demand())).toBe(false);
    expect(tracker.report()).toMatchObject({ judged: 2, positives: 1, negatives: 0, censored: 0 });

    now = 4_001;
    tracker.sweep();
    expect(tracker.report()).toMatchObject({ judged: 2, positives: 1, negatives: 1, censored: 0 });
  });

  it('retains bounded demand-start evidence that arrives before provider scores', () => {
    const tracker = new SemanticEvaluationTracker({ now: () => 1_500 });
    expect(tracker.observeDemand(demand())).toBe(true);
    expect(tracker.register({
      batchId: 'late-provider', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [{ candidate: candidate('a', { path: 'a' }), probability: 0.9, windowMs: 1_000 }],
    })).toBe(1);
    expect(tracker.report()).toMatchObject({ judged: 1, positives: 1, negatives: 0 });
  });

  it('censors an expired window while its demand start is still awaiting correlation', () => {
    let now = 1_000;
    const tracker = new SemanticEvaluationTracker({ now: () => now, drainMs: 1_000 });
    tracker.register({
      batchId: 'slow-call', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [{ candidate: candidate('a', { path: 'a' }), probability: 0.7, windowMs: 500 }],
    });
    expect(tracker.notePendingDemand({
      phase: 'start', requestId: 'slow', sourceEventId: 'slow', ownerInstanceId: 'owner',
      routeId: 'route', generation: 2, server: 'workspace', tool: 'read_file',
      args: { path: 'a' }, startedAt: 1_400,
    })).toBe(true);

    now = 2_501;
    tracker.sweep();
    expect(tracker.report()).toMatchObject({ judged: 1, positives: 0, negatives: 0, censored: 1 });
  });

  it('retains censorship when correlation fails before provider scores register', () => {
    const tracker = new SemanticEvaluationTracker({ now: () => 1_400 });
    tracker.notePendingDemand({
      phase: 'start', requestId: 'ambiguous', sourceEventId: 'ambiguous', ownerInstanceId: 'owner',
      routeId: 'route', generation: 2, server: 'workspace', tool: 'read_file',
      args: { path: 'a' }, startedAt: 1_300,
    });
    expect(tracker.censorPendingDemand('owner', 'ambiguous')).toBe(true);
    tracker.register({
      batchId: 'late-scores', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [{ candidate: candidate('a', { path: 'a' }), probability: 0.9, windowMs: 1_000 }],
    });
    expect(tracker.report()).toMatchObject({ judged: 1, positives: 0, negatives: 0, censored: 1 });
  });

  it('uses an open-left closed-right demand window and ignores completion success', () => {
    let now = 1_000;
    const tracker = new SemanticEvaluationTracker({ now: () => now, drainMs: 0 });
    tracker.register({
      batchId: 'at-snapshot', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [{ candidate: candidate('a', { path: 'a' }), probability: 0.6, windowMs: 500 }],
    });
    expect(tracker.observeDemand(demand({ requestId: 'old', startedAt: 1_000 }))).toBe(true);
    expect(tracker.report().positives).toBe(0);
    expect(tracker.observeDemand(demand({ requestId: 'failed', startedAt: 1_500 }))).toBe(true);
    expect(tracker.observeDemand({
      phase: 'complete', requestId: 'failed', sourceEventId: 'source-real', ownerInstanceId: 'owner',
      routeId: 'route', generation: 2, completedAt: 1_600, success: false,
      conversationId: 'conversation',
    })).toBe(true);
    expect(tracker.report().positives).toBe(1);
  });

  it('censors invalidated and evicted windows instead of creating negatives', () => {
    let now = 1_000;
    const tracker = new SemanticEvaluationTracker({
      now: () => now,
      drainMs: 0,
      limits: { maxPerConversation: 1, maxPerLaunch: 2, maxBytes: 10_000 },
    });
    const register = (batchId: string, conversationId: string) => tracker.register({
      batchId, conversationId, ownerInstanceId: 'owner', snapshotAt: now,
      candidates: [{ candidate: candidate(batchId, { path: batchId }), probability: 0.5, windowMs: 1_000 }],
    });
    register('first', 'conversation');
    register('second', 'conversation');
    expect(tracker.report()).toMatchObject({ judged: 2, censored: 1, evicted: 1 });
    tracker.invalidate('conversation');
    expect(tracker.report()).toMatchObject({ judged: 2, positives: 0, negatives: 0, censored: 2 });
    now = 10_000;
    tracker.sweep();
    expect(tracker.report().negatives).toBe(0);
  });

  it('reports aggregate Brier score and probability reliability without retaining identities', () => {
    let now = 1_000;
    const tracker = new SemanticEvaluationTracker({ now: () => now, drainMs: 0 });
    tracker.register({
      batchId: 'positive-batch', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [{ candidate: candidate('a', { path: 'a' }), probability: 0.8, windowMs: 1_000 }],
    });
    tracker.register({
      batchId: 'negative-batch', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 1_000,
      candidates: [{ candidate: candidate('b', { path: 'b' }), probability: 0.2, windowMs: 1_000 }],
    });
    tracker.observeDemand(demand());
    now = 2_001;
    tracker.sweep();
    const report = tracker.report();
    expect(report.brierScore).toBeCloseTo(0.04);
    expect(report.reliability.find((bin) => bin.count > 0)).toEqual(expect.objectContaining({
      meanProbability: expect.any(Number),
    }));
    expect(JSON.stringify(report)).not.toContain('conversation');
    expect(JSON.stringify(report)).not.toContain('path');
  });

  it('clears unresolved records as censored on shutdown', () => {
    const tracker = new SemanticEvaluationTracker({ now: () => 0 });
    tracker.register({
      batchId: 'batch', conversationId: 'conversation', ownerInstanceId: 'owner', snapshotAt: 0,
      candidates: [{ candidate: candidate('a', { path: 'a' }), probability: 0.5, windowMs: 1_000 }],
    });
    tracker.clear();
    expect(tracker.report()).toMatchObject({ judged: 1, censored: 1 });
  });
});
