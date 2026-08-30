import { describe, expect, it } from 'vitest';
import {
  compareDailyRuns,
  percentile,
  validateDailyRunRecord,
  type DailyRunRecord,
} from '../bench/comparison.js';
import {
  DAILY_WORKFLOW_IDS,
  generateDailyWorkflow,
  seededRandom,
} from '../bench/dailyWorkflows.js';

function record(overrides: Partial<DailyRunRecord> = {}): DailyRunRecord {
  return {
    schemaVersion: 1,
    workflow: 'code-navigation',
    workflowVersion: 1,
    arm: 'candidate',
    seed: 1,
    session: 0,
    requestedCalls: 3,
    eligibleCalls: 3,
    hits: 1,
    joins: 1,
    misses: 1,
    speculativeCalls: 3,
    terminalWasted: 1,
    outstandingAtSnapshot: 0,
    predictorOpportunities: 2,
    predictorHitsAt1: 1,
    predictorHitsAt3: 2,
    toolWaitMs: 60,
    toolWaitSamplesMs: [10, 20, 30],
    estimatedSavedMs: 50,
    estimatedAddedWaitMs: 5,
    upstreamCalls: 4,
    ...overrides,
  };
}

describe('daily workflow generation', () => {
  it('has stable PRNG golden values', () => {
    const random = seededRandom(1);
    expect([random(), random(), random()]).toEqual([
      0.6270739405881613,
      0.002735721180215478,
      0.5274470399599522,
    ]);
  });

  it('repeats byte-identically for the same workflow, seed, and session', () => {
    for (const id of DAILY_WORKFLOW_IDS) {
      expect(generateDailyWorkflow(id, 42, 3)).toEqual(generateDailyWorkflow(id, 42, 3));
    }
  });

  it('varies selections or ordering across sessions', () => {
    for (const id of DAILY_WORKFLOW_IDS) {
      const serialized = new Set(
        Array.from({ length: 8 }, (_, session) =>
          JSON.stringify(generateDailyWorkflow(id, 9, session).steps),
        ),
      );
      expect(serialized.size, id).toBeGreaterThan(1);
    }
  });

  it('rejects seeds and sessions outside their contract', () => {
    expect(() => generateDailyWorkflow('documentation', -1, 0)).toThrow(/seed/);
    expect(() => generateDailyWorkflow('documentation', 1, -1)).toThrow(/session/);
  });
});

describe('daily benchmark comparison', () => {
  it('validates accounting and rejects corrupt records', () => {
    expect(validateDailyRunRecord(record())).toEqual(record());
    expect(() => validateDailyRunRecord(record({ requestedCalls: 4 }))).toThrow(
      /requestedCalls/,
    );
    expect(() => validateDailyRunRecord(record({ speculativeCalls: 4 }))).toThrow(
      /speculativeCalls/,
    );
    expect(() => validateDailyRunRecord(record({ predictorHitsAt1: 3 }))).toThrow(
      /prediction rank/,
    );
    expect(() => validateDailyRunRecord(record({ toolWaitSamplesMs: [60] }))).toThrow(
      /length/,
    );
  });

  it('computes paired measured and estimated utility', () => {
    const off = record({
      arm: 'off',
      hits: 0,
      joins: 0,
      misses: 3,
      speculativeCalls: 0,
      terminalWasted: 0,
      predictorOpportunities: 0,
      predictorHitsAt1: 0,
      predictorHitsAt3: 0,
      toolWaitMs: 300,
      toolWaitSamplesMs: [80, 100, 120],
      estimatedSavedMs: 0,
      estimatedAddedWaitMs: 0,
      upstreamCalls: 3,
    });
    const candidate = record();
    const result = compareDailyRuns([candidate, off]);
    expect(result.measuredWaitDeltaMsPer100).toBe(8_000);
    expect(result.estimatedNetSavedMsPer100).toBe(1_500);
    expect(result.extraUpstreamCallsPerSavedSecond).toBeCloseTo(1 / 0.24);
    expect(result.p50ToolWaitMs).toBe(20);
    expect(result.p95ToolWaitMs).toBe(20);
  });

  it('requires exact off pairs and rejects duplicates', () => {
    expect(() => compareDailyRuns([record()])).toThrow(/missing off pair/);
    expect(() => compareDailyRuns([record(), record()])).toThrow(/duplicate/);
  });

  it('handles empty percentiles and invalid fractions', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(() => percentile([1], 2)).toThrow(/fraction/);
  });

  it('does not include argument or result payloads in validated output', () => {
    const serialized = JSON.stringify(validateDailyRunRecord(record()));
    expect(serialized).not.toContain('args');
    expect(serialized).not.toContain('result');
    expect(serialized).not.toContain('/workspace/secret');
  });
});
