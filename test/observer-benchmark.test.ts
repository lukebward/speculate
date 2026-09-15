import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OBSERVER_ARMS,
  bootstrapPairedMedian,
  lifecycleTiming,
  percentile,
  randomizedBlocks,
  runObserverBenchmark,
  settleAccounting,
  validateArtifact,
  validatePair,
  type ObserverRunRecord,
} from '../bench/observer.js';
import {
  OBSERVER_WORKFLOW_IDS,
  materializeObserverWorkflow,
} from '../bench/observer-workflows.js';
import { SpeculationCache } from '../src/cache.js';
import { canonicalKey } from '../src/keys.js';

describe('observer benchmark statistics', () => {
  it('uses the declared timestamp boundaries without clamping negative lead', () => {
    expect(lifecycleTiming({
      candidateCreatedAt: 100,
      specDispatchAt: 107,
      realDemandAt: 103,
      argsCompleteChunkAt: 90,
      streamObservedAt: 94,
    })).toEqual({ candidateToDispatchMs: 7, demandLeadMs: -4, streamDetectionLagMs: 4 });
    expect(lifecycleTiming({ candidateCreatedAt: 2, specDispatchAt: 5 })).toEqual({
      candidateToDispatchMs: 3,
      demandLeadMs: null,
      streamDetectionLagMs: null,
    });
  });

  it('calculates nearest-rank-lower percentiles at every boundary', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([9, 1, 5], 0.5)).toBe(5);
    expect(percentile([8, 2, 6, 4], 0.5)).toBe(4);
    expect(percentile([100, 1, 3, 2, 4], 0.95)).toBe(4);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 1)).toBe(3);
    for (const fraction of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => percentile([1], fraction)).toThrow(/fraction/);
    }
    expect(() => percentile([1, Number.NaN], 0.5)).toThrow(/finite/);
  });

  it('bootstraps complete workflow clusters deterministically', () => {
    const pairs = [
      { workflow: 'alpha', repetition: 0, value: 0 },
      { workflow: 'alpha', repetition: 1, value: 2 },
      { workflow: 'beta', repetition: 0, value: 10 },
      { workflow: 'beta', repetition: 1, value: 12 },
    ];
    const first = bootstrapPairedMedian(pairs, { seed: 19, replicates: 64 });
    const second = bootstrapPairedMedian([...pairs].reverse(), { seed: 19, replicates: 64 });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ point: 2, clusterCount: 2, pairCount: 4, seed: 19, replicates: 64 });
    expect(first.lower).toBe(0);
    expect(first.upper).toBe(10);
  });
});

describe('observer benchmark design', () => {
  it('defines the five cumulative arms while keeping source switches independent', () => {
    expect(OBSERVER_ARMS).toEqual({
      A: { speculate: false, hooks: false, requestObserver: false, signals: { intent: false, transition: false, stream: false } },
      B: { speculate: true, hooks: false, requestObserver: false, signals: { intent: false, transition: false, stream: false } },
      C: { speculate: true, hooks: true, requestObserver: false, signals: { intent: true, transition: true, stream: false } },
      D: { speculate: true, hooks: true, requestObserver: true, signals: { intent: true, transition: true, stream: false } },
      E: { speculate: true, hooks: true, requestObserver: true, signals: { intent: true, transition: true, stream: true } },
    });
    expect(new Set(Object.values(OBSERVER_ARMS).map((arm) => JSON.stringify(arm.signals))).size).toBe(3);
    const enabled = { ...OBSERVER_ARMS.E.signals };
    expect({ ...enabled, intent: false }).toEqual({ intent: false, transition: true, stream: true });
    expect({ ...enabled, transition: false }).toEqual({ intent: true, transition: false, stream: true });
    expect({ ...enabled, stream: false }).toEqual({ intent: true, transition: true, stream: false });
  });

  it('materializes twenty held-out workflows without reusing the training entity pool', () => {
    expect(OBSERVER_WORKFLOW_IDS).toHaveLength(20);
    const holdout = materializeObserverWorkflow('pr-review-checks', 41, 2, 'holdout');
    const training = materializeObserverWorkflow('pr-review-checks', 41, 2, 'training');
    expect(holdout.steps).not.toEqual(training.steps);
    expect(JSON.stringify(holdout)).toContain('holdout-');
    expect(JSON.stringify(training)).toContain('training-');
    expect(materializeObserverWorkflow('expired-before-demand', 1, 0).steps[0]!.thinkMs).toBeGreaterThan(30_000);
  });

  it('randomizes complete paired blocks with balanced arm positions', () => {
    const order = randomizedBlocks({
      clients: ['claude', 'codex'],
      workflows: OBSERVER_WORKFLOW_IDS,
      repetitions: 5,
    }, 9173);
    expect(order).toHaveLength(1_000);
    expect(new Set(order.map((run) => run.orderIndex)).size).toBe(1_000);
    for (const client of ['claude', 'codex'] as const) {
      for (const workflow of OBSERVER_WORKFLOW_IDS) {
        for (const arm of ['A', 'B', 'C', 'D', 'E'] as const) {
          const positions = order.filter((run) => run.client === client && run.workflow === workflow && run.arm === arm)
            .map((run) => run.armPosition).sort((a, b) => a - b);
          expect(positions).toEqual([0, 1, 2, 3, 4]);
        }
      }
    }
  });
});

describe('observer accounting and validation', () => {
  it.each([
    [{ hits: 1, joins: 0, expired: 0, invalidated: 0, abandoned: 0, specErrors: 0, outstandingAtSnapshot: 0, queuedSuppressed: 0 }, { issued: 1, settledWaste: 0, settledWasteRate: 0 }],
    [{ hits: 0, joins: 0, expired: 0, invalidated: 0, abandoned: 0, specErrors: 0, outstandingAtSnapshot: 1, queuedSuppressed: 0 }, { issued: 1, settledWaste: 1, settledWasteRate: 1 }],
    [{ hits: 0, joins: 0, expired: 0, invalidated: 1, abandoned: 0, specErrors: 0, outstandingAtSnapshot: 0, queuedSuppressed: 0 }, { issued: 1, settledWaste: 1, settledWasteRate: 1 }],
    [{ hits: 0, joins: 0, expired: 0, invalidated: 0, abandoned: 0, specErrors: 1, outstandingAtSnapshot: 0, queuedSuppressed: 0 }, { issued: 1, settledWaste: 1, settledWasteRate: 1 }],
    [{ hits: 0, joins: 0, expired: 0, invalidated: 0, abandoned: 0, specErrors: 0, outstandingAtSnapshot: 0, queuedSuppressed: 1 }, { issued: 0, settledWaste: 0, settledWasteRate: null }],
  ] as const)('settles every issued call once and excludes queued suppressions', (input, expected) => {
    expect(settleAccounting(input)).toMatchObject(expected);
  });

  it('counts expired unused results as waste without creating a saved-time field', () => {
    const settled = settleAccounting({
      hits: 0, joins: 0, expired: 1, invalidated: 0, abandoned: 0,
      specErrors: 0, outstandingAtSnapshot: 0, queuedSuppressed: 0,
    });
    expect(settled).toMatchObject({ issued: 1, settledWaste: 1, settledWasteRate: 1 });
    expect(settled).not.toHaveProperty('savedTimeMs');
  });

  it('attributes an expired production cache entry as one miss and one settled waste', async () => {
    let now = 100;
    const expired: string[] = [];
    const cache = new SpeculationCache({ now: () => now, onEvent: (event) => expired.push(event.type) });
    const key = canonicalKey('fixture', 'read', { key: 'unused' });
    cache.putInFlight(key, { server: 'fixture', tool: 'read', ruleId: 'observer:claude:intent', issuedAt: now },
      Promise.resolve({ content: [{ type: 'text', text: 'fixture' }] }), 5);
    await Promise.resolve();
    now = 106;

    expect(cache.lookup(key)).toMatchObject({ outcome: 'miss' });
    expect(expired).toEqual(['expired']);
    expect(settleAccounting({
      hits: 0, joins: 0, expired: 1, invalidated: 0, abandoned: 0,
      specErrors: 0, outstandingAtSnapshot: 0, queuedSuppressed: 0,
    })).toMatchObject({ issued: 1, settledWaste: 1 });
  });

  it('rejects mismatched outputs, payloads, call counts, isolation, writes, consent, and extra model calls', () => {
    const control = record({ arm: 'A' });
    const candidate = record({ arm: 'E' });
    expect(() => validatePair([control, candidate])).not.toThrow();
    for (const patch of [
      { correctness: { ...candidate.correctness, outputDigest: 'wrong' } },
      { correctness: { ...candidate.correctness, providerPayloadIdentical: false } },
      { cache: { ...candidate.cache, requestedCalls: 2 } },
      { correctness: { ...candidate.correctness, wrongSessionResults: 1 } },
      { correctness: { ...candidate.correctness, unexpectedWrites: 1 } },
      { correctness: { ...candidate.correctness, consentBypasses: 1 } },
      { provider: { ...candidate.provider, modelRequests: 2 } },
    ]) {
      expect(() => validatePair([control, { ...candidate, ...patch } as ObserverRunRecord])).toThrow();
    }
  });

  it('rejects missing tags and raw session material anywhere in an artifact', () => {
    const valid = { schemaVersion: 1 as const, benchmark: 'observer' as const, records: [record()] };
    expect(() => validateArtifact(valid)).not.toThrow();
    expect(() => validateArtifact({ ...valid, records: [{ ...record(), model: '' }] })).toThrow(/model/);
    expect(() => validateArtifact({ ...valid, rawPrompt: 'secret' })).toThrow(/raw/i);
    expect(() => validateArtifact({ ...valid, records: [{ ...record(), headers: { authorization: 'secret' } }] })).toThrow(/raw/i);
  });
});

describe('observer real-path smoke', () => {
  it('runs all arms for both clients through bare MCP or the production wrapper path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'observer-checkpoint-test-'));
    const checkpointPath = join(directory, 'checkpoint.json');
    const progress: string[] = [];
    try {
      const artifact = await runObserverBenchmark({
        clients: ['claude', 'codex'],
        arms: ['A', 'B', 'C', 'D', 'E'],
        workflows: ['early-stream-call'],
        repetitions: 1,
        latencyMs: 1,
        trainingEpisodes: 0,
        experimentSeed: 7,
        orderSeed: 11,
        bootstrapReplicates: 64,
        verifyLauncher: true,
        checkpointPath,
        onProgress: (line) => progress.push(line),
      });
      expect(artifact.records).toHaveLength(10);
      expect(artifact.launcher).toEqual({ claude: true, codex: true });
      expect(artifact.records.every((item) => item.correctness.failures.length === 0)).toBe(true);
      expect(artifact.records.filter((item) => item.arm === 'A').every((item) => item.runtimePath === 'bare-mcp')).toBe(true);
      expect(artifact.records.filter((item) => item.arm !== 'A').every((item) => item.runtimePath === 'session-wrapper')).toBe(true);
      expect(artifact.records.filter((item) => item.arm === 'E').every((item) => item.cache.issued === 1)).toBe(true);
      expect(progress).toHaveLength(10);
      expect(progress[0]).toMatch(/^completed 1\/10 client=(claude|codex) arm=[A-E] workflow=early-stream-call elapsedMs=\d+$/);
      expect(existsSync(checkpointPath)).toBe(true);
      expect(JSON.parse(readFileSync(checkpointPath, 'utf8'))).toMatchObject({ status: 'complete', completed: 10, total: 10 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('gives one source ownership and a dedup suppression to overlapping intent and stream candidates', async () => {
    const artifact = await runObserverBenchmark({
      clients: ['claude'],
      arms: ['A', 'E'],
      workflows: ['retry-dedup'],
      repetitions: 1,
      latencyMs: 1,
      trainingEpisodes: 0,
      relayPairs: 1,
      relayWarmups: 0,
      verifyLauncher: false,
      bootstrapReplicates: 16,
    });
    const record = artifact.records.find((item) => item.arm === 'E')!;
    expect(record.cache.issued).toBe(1);
    expect(record.cache.suppressed.dedup).toBeGreaterThanOrEqual(1);
    expect(record.cache.perSource.intent?.issued).toBe(1);
    expect(record.cache.perSource.stream?.dedupSuppressions).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('cancels incomplete model arguments without issuing a partial stream candidate', async () => {
    const artifact = await runObserverBenchmark({
      clients: ['codex'],
      arms: ['A', 'E'],
      workflows: ['cancelled-mixed-task'],
      repetitions: 1,
      latencyMs: 1,
      trainingEpisodes: 0,
      relayPairs: 1,
      relayWarmups: 0,
      verifyLauncher: false,
      bootstrapReplicates: 16,
    });
    const observed = artifact.records.find((item) => item.arm === 'E')!;
    expect(observed.provider.streamCallsObserved).toBe(0);
    expect(observed.cache.issued).toBe(0);
  }, 30_000);
});

function record(overrides: Partial<ObserverRunRecord> = {}): ObserverRunRecord {
  return {
    schemaVersion: 1,
    phase: 'holdout',
    sourceCommit: 'fixture',
    client: 'claude',
    clientVersion: 'fixture-1',
    adapterFixtureVersion: '1',
    transport: 'messages-json',
    model: 'fixture-model',
    effort: null,
    arm: 'A',
    signals: { intent: false, transition: false, stream: false },
    observationPaths: [],
    thermalState: 'cold',
    workloadSet: 'mixed',
    workflow: 'early-stream-call',
    workflowVersion: 1,
    repetition: 0,
    trainingSeed: null,
    holdoutSeed: 1,
    orderIndex: 0,
    runtimePath: 'bare-mcp',
    timings: {
      taskWallMs: 10,
      toolWaitMs: 8,
      toolWaitSamplesMs: [8],
      modelTtfbMs: [],
      candidateToDispatchMs: [],
      demandLeadMs: [],
      streamDetectionLagMs: [],
    },
    cache: {
      requestedCalls: 1, hits: 0, joins: 0, misses: 1, issued: 0,
      expired: 0, invalidated: 0, abandoned: 0, specErrors: 0,
      outstandingAtSnapshot: 0, settledWaste: 0, suppressed: {}, perSource: {},
    },
    provider: {
      modelRequests: 1, inputTokens: null, outputTokens: null,
      usageSource: 'unavailable', requestsObserved: 0, streamCallsObserved: 0,
    },
    correctness: {
      outputDigest: 'same', expectedDigest: 'same', providerPayloadIdentical: true,
      toolResultDigestsIdenticalToA: true, unexpectedWrites: 0, consentBypasses: 0,
      wrongSessionResults: 0, failures: [],
    },
    ...overrides,
  };
}
