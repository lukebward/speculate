import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPEATED_WORKFLOW_IDS,
  generateRepeatedWorkflow,
  type RepeatedWorkflowId,
} from '../bench/repeatedWorkflows.js';
import {
  armStatePath,
  compareEnabledArms,
  digestToolResults,
  finalizeAccounting,
  mergeArtifactRecords,
  orderedArms,
  parseRepeatedCliArgs,
  runRepeatedBenchmark,
  validatePairedOutputs,
  type RepeatedRunRecord,
} from '../bench/repeated.js';

describe('repeated workflow fixtures', () => {
  it('generates byte-identical chronological sessions for the same coordinates', () => {
    for (const workflow of REPEATED_WORKFLOW_IDS) {
      expect(generateRepeatedWorkflow(workflow, 17, 6, 4)).toEqual(
        generateRepeatedWorkflow(workflow, 17, 6, 4),
      );
    }
  });

  it('uses disjoint identifiers and changed order in held-out sessions', () => {
    for (const workflow of REPEATED_WORKFLOW_IDS.filter(
      (id): id is Exclude<RepeatedWorkflowId, 'negative-control'> => id !== 'negative-control',
    )) {
      const train = generateRepeatedWorkflow(workflow, 11, 3, 4);
      const heldOut = generateRepeatedWorkflow(workflow, 11, 4, 4);
      expect(heldOut.phase).toBe('holdout');
      expect(heldOut.fixtureIds.some((id) => train.fixtureIds.includes(id))).toBe(false);
      expect(heldOut.orderToken).not.toBe(train.orderToken);
    }
  });

  it('does not put selected future identifiers in list-call arguments', () => {
    for (const workflow of REPEATED_WORKFLOW_IDS.filter(
      (id) => id !== 'negative-control',
    )) {
      const generated = generateRepeatedWorkflow(workflow, 5, 1, 4);
      const first = generated.steps[0]!;
      expect(first.tool).toMatch(/list|scan|survey/);
      for (const id of generated.fixtureIds) {
        expect(JSON.stringify(first.args)).not.toContain(id);
      }
    }
  });

  it('changes negative-control calls without creating repeated exact keys', () => {
    const session = generateRepeatedWorkflow('negative-control', 9, 2, 4);
    const keys = session.steps.map((step) => `${step.tool}:${JSON.stringify(step.args)}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(generateRepeatedWorkflow('negative-control', 9, 3, 4).steps).not.toEqual(session.steps);
  });
});

describe('repeated benchmark orchestration', () => {
  it('rotates arm order while preserving the requested arms', () => {
    const arms = ['off', 'stable', 'candidate'] as const;
    expect(orderedArms(arms, 1, 0)).toEqual(['stable', 'candidate', 'off']);
    expect(orderedArms(arms, 1, 1)).toEqual(['candidate', 'off', 'stable']);
    expect(orderedArms(arms, 1, 2)).toEqual(['off', 'stable', 'candidate']);
  });

  it('isolates persistent state by arm, workflow, and seed', () => {
    const root = mkdtempSync(join(tmpdir(), 'speculate-repeat-state-test-'));
    try {
      const paths = new Set([
        armStatePath(root, 'stable', 'pr-review', 1),
        armStatePath(root, 'candidate', 'pr-review', 1),
        armStatePath(root, 'stable', 'issue-triage', 1),
        armStatePath(root, 'stable', 'pr-review', 2),
      ]);
      expect(paths.size).toBe(4);
      for (const path of paths) expect(path.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts the final outstanding batch as shutdown waste', () => {
    expect(
      finalizeAccounting({
        requestedCalls: 5,
        hits: 1,
        joins: 1,
        misses: 3,
        speculativeCalls: 6,
        wasted: 2,
        ready: 1,
        inFlight: 1,
      }),
    ).toEqual({
      terminalWasted: 2,
      outstandingAtSnapshot: 2,
      shutdownWaste: 4,
    });
  });

  it('rejects unpaired or byte-different real outputs', () => {
    const stable = record({ arm: 'stable', outputDigest: 'same' });
    const off = record({ arm: 'off', outputDigest: 'same' });
    const candidate = record({ arm: 'candidate', outputDigest: 'different' });
    expect(() => validatePairedOutputs([off, stable, candidate])).toThrow(/output digest/i);
    expect(() => validatePairedOutputs([stable])).toThrow(/off pair/i);
  });

  it('includes structured content in exact result digests', () => {
    const left = digestToolResults([{ content: [{ type: 'text', text: '{}' }], structuredContent: { id: 1 } }]);
    const right = digestToolResults([{ content: [{ type: 'text', text: '{}' }], structuredContent: { id: 2 } }]);
    expect(left).not.toBe(right);
  });

  it('combines split arm artifacts without accepting duplicate records', () => {
    const off = record({ arm: 'off' });
    const stable = record({ arm: 'stable' });
    expect(mergeArtifactRecords([off], [stable])).toEqual([off, stable]);
    expect(() => mergeArtifactRecords([off], [off])).toThrow(/duplicate/i);
  });

  it('compares stable and candidate from exact record pairs', () => {
    const stable = record({ arm: 'stable', toolWaitMs: 90, toolWaitSamplesMs: [20, 30, 40] });
    const candidate = record({
      arm: 'candidate',
      hits: 2,
      joins: 1,
      misses: 0,
      speculativeCalls: 3,
      terminalWasted: 0,
      shutdownWaste: 0,
      toolWaitMs: 30,
      toolWaitSamplesMs: [5, 10, 15],
    });
    const compared = compareEnabledArms([stable, candidate]);
    expect(compared).toMatchObject({
      pairedRecords: 1,
      requestedCalls: 3,
      measuredWaitDeltaMsPer100: 2_000,
      recallAt3Delta: 0,
      wastePerUsefulDelta: -0.5,
    });
    expect(compared?.hitRateDelta).toBeCloseTo(1 / 3);
    expect(compareEnabledArms([stable])).toBeNull();
  });

  it('parses the documented CLI and rejects unknown arms', () => {
    expect(
      parseRepeatedCliArgs([
        '--baseline', 'C:/base', '--candidate', 'C:/next', '--seeds', '2,7',
        '--train', '3', '--holdout', '5', '--latency', '90', '--arms', 'off,stable',
        '--json', 'out.json',
      ]),
    ).toMatchObject({
      baselineRoot: 'C:/base',
      candidateRoot: 'C:/next',
      seeds: [2, 7],
      trainSessions: 3,
      holdoutSessions: 5,
      latencyMs: 90,
      arms: ['off', 'stable'],
      jsonPath: 'out.json',
    });
    expect(() => parseRepeatedCliArgs(['--arms', 'off,other'])).toThrow(/arm/i);
  });

  it(
    'executes one deterministic session through the real proxy and fixture server',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'speculate-repeat-run-test-'));
      const previousXdg = process.env['XDG_STATE_HOME'];
      try {
        process.env['XDG_STATE_HOME'] = join(root, 'host-state');
        const progress: string[] = [];
        const artifact = await runRepeatedBenchmark({
          baselineRoot: process.cwd(),
          candidateRoot: process.cwd(),
          seeds: [1],
          trainSessions: 0,
          holdoutSessions: 1,
          latencyMs: 2,
          arms: ['off'],
          workflows: ['renamed-transfer'],
          stateRoot: join(root, 'state'),
          onProgress: (line) => progress.push(line),
        });
        expect(artifact.latency).toEqual({ kind: 'synthetic-injected', milliseconds: 2 });
        expect(artifact.records).toHaveLength(1);
        expect(artifact.records[0]).toMatchObject({
          workflow: 'renamed-transfer',
          phase: 'holdout',
          arm: 'off',
          hits: 0,
          joins: 0,
          misses: 5,
          speculativeCalls: 0,
          shutdownWaste: 0,
          upstreamCalls: 5,
        });
        expect(artifact.records[0]!.outputDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(progress).toHaveLength(1);
        expect(progress[0]).toMatch(/off renamed-transfer seed=1 session=0 holdout/);
        expect(existsSync(join(root, 'host-state', 'speculate', 'usage'))).toBe(false);
      } finally {
        if (previousXdg === undefined) delete process.env['XDG_STATE_HOME'];
        else process.env['XDG_STATE_HOME'] = previousXdg;
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function record(overrides: Partial<RepeatedRunRecord> = {}): RepeatedRunRecord {
  return {
    schemaVersion: 1,
    workflow: 'pr-review',
    workflowVersion: 1,
    arm: 'candidate',
    seed: 1,
    session: 4,
    phase: 'holdout',
    requestedCalls: 3,
    eligibleCalls: 3,
    hits: 1,
    joins: 1,
    misses: 1,
    speculativeCalls: 3,
    terminalWasted: 1,
    outstandingAtSnapshot: 0,
    shutdownWaste: 1,
    predictorOpportunities: 2,
    predictorHitsAt1: 1,
    predictorHitsAt3: 2,
    toolWaitMs: 60,
    toolWaitSamplesMs: [10, 20, 30],
    estimatedSavedMs: 50,
    estimatedAddedWaitMs: 5,
    upstreamCalls: 4,
    outputDigest: 'same',
    wallTimeMs: 100,
    cpuUserMicros: 1,
    cpuSystemMicros: 1,
    rssDeltaBytes: 0,
    stateBytes: 10,
    ...overrides,
  };
}
