import { describe, expect, it } from 'vitest';
import {
  MULTITURN_PARAMETERS,
  materializeMultiturnWorkflow,
  nextPayload,
} from '../bench/observer-multiturn-workflows.js';
import {
  MULTITURN_ARM_DEFINITIONS,
  createMultiturnOrder,
  runMultiturnRecord,
  summarizeMultiturnRecords,
} from '../bench/observer-multiturn.js';
import { OBSERVER_ARMS } from '../bench/observer.js';

describe('multi-turn opportunity diagnostic', () => {
  it('keeps completed-stream dispatch lag shorter than the separately declared model opportunity', () => {
    expect(MULTITURN_ARM_DEFINITIONS).toBe(OBSERVER_ARMS);
    expect(MULTITURN_PARAMETERS.repetitions).toBe(3);
    expect(MULTITURN_PARAMETERS.trainingEpisodes).toBeGreaterThan(1);
    expect(MULTITURN_PARAMETERS.dispatchLagMs).toBeLessThan(MULTITURN_PARAMETERS.modelLatencyMs);
  });

  it('materializes independent entities with an actual result-to-next-argument chain across servers', () => {
    const training = materializeMultiturnWorkflow('derivable-cross-server', 'training', 11, 0);
    const holdout = materializeMultiturnWorkflow('derivable-cross-server', 'holdout', 29, 0);
    expect(training.steps.map((step) => step.alias)).toEqual(['workspace', 'registry', 'ci']);
    expect(new Set(training.steps.map((step) => step.alias)).size).toBe(3);
    expect(training.steps).not.toEqual(holdout.steps);
    expect(nextPayload(holdout.steps[0]!)).toMatchObject({ nextKey: holdout.steps[1]!.args.key });
    expect(nextPayload(holdout.steps[1]!)).toMatchObject({ nextKey: holdout.steps[2]!.args.key });
    const cold = materializeMultiturnWorkflow('unpredictable-cold', 'holdout', 29, 0);
    expect(cold.steps[0]!.args).not.toEqual(cold.steps[1]!.args);
  });

  it('uses a deterministic paired order with every arm represented once per block', () => {
    const first = createMultiturnOrder(3, 123);
    const second = createMultiturnOrder(3, 123);
    expect(first).toEqual(second);
    expect(first).toHaveLength(60);
    for (const client of ['claude', 'codex'] as const) {
      for (const workflow of ['derivable-cross-server', 'unpredictable-cold'] as const) {
        for (let repetition = 0; repetition < 3; repetition++) {
          const block = first.filter((run) => run.client === client && run.workflow === workflow && run.repetition === repetition);
          expect(new Set(block.map((run) => run.arm))).toEqual(new Set(Object.keys(OBSERVER_ARMS)));
        }
      }
    }
  });

  it('summarizes aggregate timing and source outcomes without retaining session material', () => {
    const summary = summarizeMultiturnRecords([{
      client: 'claude', arm: 'E', workflow: 'derivable-cross-server', repetition: 0,
      taskWallMs: 10, toolWaitMs: 4, modelWaitMs: 6, providerRequests: 3,
      demandedCalls: 3, physicalCalls: 3, hits: 1, joins: 1, misses: 1, issued: 2,
      settledWaste: 0, perSource: { transition: { issued: 1, hits: 1, joins: 0, waste: 0 } },
      resultDigest: 'digest', failures: [],
    }]);
    expect(summary).toEqual([expect.objectContaining({ client: 'claude', arm: 'E', records: 1, issued: 2 })]);
    expect(JSON.stringify(summary)).not.toContain('/workspace/');
  });

  it.each(['claude', 'codex'] as const)('runs the production %s adapter for every turn and consumes the derived chain', async (client) => {
    const control = await runMultiturnRecord({
      client,
      arm: 'A',
      workflow: 'derivable-cross-server',
      repetition: 0,
      orderIndex: 0,
    });
    const record = await runMultiturnRecord({
      client,
      arm: 'E',
      workflow: 'derivable-cross-server',
      repetition: 0,
      orderIndex: 0,
    });
    expect(record.providerRequests).toBe(3);
    expect(record.providerDigest).toBe(control.providerDigest);
    expect(record.resultDigest).toBe(control.resultDigest);
    expect(record.demandedCalls).toBe(3);
    expect(record.failures).toEqual([]);
    expect(record.perSource.intent?.issued).toBeGreaterThan(0);
    expect(record.perSource.transition?.issued).toBeGreaterThan(0);
    expect(record.hits + record.joins).toBeGreaterThan(0);
    expect(record.settledWaste).toBeLessThanOrEqual(record.issued);
  }, 15_000);
});
