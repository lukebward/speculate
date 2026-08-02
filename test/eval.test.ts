/**
 * Evaluation-harness tests (eval/): determinism, the adversarial floor, and
 * the guards that keep the harness honest.
 *
 * Deliberately NO absolute recall assertions — later tasks change those
 * numbers by design, and a test that pins them would just have to be edited
 * every time, which is the same as having no test. What is asserted here is
 * structural: the same seed replays identically, the low-predictability
 * archetype scores strictly worse than the workflow-shaped ones and stays out
 * of the headline, the corpus is not secretly shaped to the hand-written
 * GitHub rules, and the score is not saturated at either end (a saturated
 * metric cannot detect an improvement).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { githubProfile } from '../src/profiles/github.js';
import {
  ARCHETYPES,
  FLOOR_ARCHETYPES,
  SESSIONS_PER_ARCHETYPE,
  WARMUP_SESSIONS,
  WORKFLOW_ARCHETYPES,
} from '../eval/corpus.js';
import { baselineLine, table } from '../eval/format.js';
import { DEFAULT_SEEDS, replayArchetype, runEval, runEvalDetailed } from '../eval/replay.js';
import type { RecallReport } from '../eval/replay.js';

/** Seeds the floor and rank-band properties are checked over. */
const SEEDS = [1, 2, 3, 7, 42];

const EVAL_DIR = fileURLToPath(new URL('../eval/', import.meta.url));

function byName(reports: RecallReport[], name: string): RecallReport {
  const found = reports.find((r) => r.archetype === name);
  if (!found) throw new Error(`no report for ${name}`);
  return found;
}

// --- determinism --------------------------------------------------------------

describe('determinism', () => {
  it('produces an identical report for the same seed', () => {
    expect(runEval(11)).toEqual(runEval(11));
    expect(runEvalDetailed([1, 2])).toEqual(runEvalDetailed([1, 2]));
  });

  it('generates identical sessions for the same seed', () => {
    for (const archetype of ARCHETYPES) {
      expect(JSON.stringify(archetype.sessions(11))).toBe(
        JSON.stringify(archetype.sessions(11)),
      );
    }
  });

  it('actually uses the seed (different seeds, different corpus)', () => {
    for (const archetype of ARCHETYPES) {
      expect(JSON.stringify(archetype.sessions(1))).not.toBe(
        JSON.stringify(archetype.sessions(2)),
      );
    }
  });

  it('draws no randomness from the ambient clock or Math.random', () => {
    // Every .ts under eval/, discovered rather than listed: a file added by a
    // later task must not escape this guard by not being on a hardcoded list.
    const files = readdirSync(EVAL_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const src = readFileSync(join(EVAL_DIR, file), 'utf8');
      expect(src, `${file} must not call Math.random`).not.toContain('Math.random');
      expect(src, `${file} must not call Date.now`).not.toContain('Date.now');
    }
  });
});

// --- the adversarial floor ----------------------------------------------------

describe('adversarial floor', () => {
  it('scores strictly below every workflow archetype', () => {
    // Checked across several seeds so the floor is a property of the corpus,
    // not of one lucky draw.
    for (const seed of SEEDS) {
      const reports = runEval(seed);
      const adversarial = byName(reports, 'adversarial');
      for (const workflow of WORKFLOW_ARCHETYPES) {
        const report = byName(reports, workflow.name);
        expect(adversarial.recallAt3, `${workflow.name} seed ${seed}`).toBeLessThan(
          report.recallAt3,
        );
        expect(adversarial.recallAt5, `${workflow.name} seed ${seed}`).toBeLessThan(
          report.recallAt5,
        );
      }
    }
  });

  it('costs more waste per hit than every workflow archetype', () => {
    const reports = runEval(1);
    const adversarial = byName(reports, 'adversarial');
    for (const workflow of WORKFLOW_ARCHETYPES) {
      expect(byName(reports, workflow.name).wastePerHit).toBeLessThan(
        adversarial.wastePerHit,
      );
    }
  });

  it('stays out of the headline entirely', () => {
    const run = runEvalDetailed(DEFAULT_SEEDS);
    const workflowPairs = run.byArchetype
      .filter((r) => !FLOOR_ARCHETYPES.has(r.report.archetype))
      .reduce((a, r) => a + r.totals.pairs, 0);
    const floorPairs = run.byArchetype
      .filter((r) => FLOOR_ARCHETYPES.has(r.report.archetype))
      .reduce((a, r) => a + r.totals.pairs, 0);
    expect(run.workflow.pairs).toBe(workflowPairs);
    expect(run.floor.pairs).toBe(floorPairs);
    expect(run.overall.pairs).toBe(workflowPairs + floorPairs);
    expect(run.floor.pairs).toBeGreaterThan(0);
    // A floor that outweighs the archetypes it is a control for would drag
    // any pooled number around on its own.
    expect(run.floor.pairs).toBeLessThanOrEqual(run.workflow.pairs / 2);
  });
});

// --- the harness must be able to see a change ---------------------------------

describe('sensitivity', () => {
  it('reports every archetype with a non-empty scored population', () => {
    const reports = runEval(1);
    expect(reports.map((r) => r.archetype)).toEqual(ARCHETYPES.map((a) => a.name));
    for (const report of reports) expect(report.pairs).toBeGreaterThan(0);
  });

  it('is saturated at neither 0 nor 1, so movement in either direction shows', () => {
    const { workflow } = runEvalDetailed(DEFAULT_SEEDS);
    const recallAt3 = workflow.hitsAt3 / workflow.pairs;
    expect(recallAt3).toBeGreaterThan(0.05);
    expect(recallAt3).toBeLessThan(0.95);
  });

  it('separates the rank bands on every checked seed', () => {
    for (const seed of SEEDS) {
      const reports = runEval(seed);
      for (const report of reports) {
        expect(report.recallAt1).toBeLessThanOrEqual(report.recallAt3);
        expect(report.recallAt3).toBeLessThanOrEqual(report.recallAt5);
      }
      // Ranking is live (candidates compete) and the per-trigger cap costs
      // something (a real follow-up sits past rank 3).
      expect(
        reports.some((r) => r.recallAt1 < r.recallAt3),
        `ranking flat at seed ${seed}`,
      ).toBe(true);
      expect(
        reports.some((r) => r.recallAt3 < r.recallAt5),
        `cap costs nothing at seed ${seed}`,
      ).toBe(true);
    }
  });

  it('moves when the model moves', () => {
    const base = runEvalDetailed(1).overall;
    // Starving the transition table is a strictly worse model; the score must
    // notice. (The knob is the harness's A/B affordance, not a shipped one.)
    const starved = ARCHETYPES.reduce(
      (acc, a) => {
        const { totals } = replayArchetype(a, 1, { learner: { maxTransitions: 4 } });
        acc.pairs += totals.pairs;
        acc.hitsAt3 += totals.hitsAt3;
        return acc;
      },
      { pairs: 0, hitsAt3: 0 },
    );
    expect(starved.pairs).toBe(base.pairs);
    expect(starved.hitsAt3 / starved.pairs).toBeLessThan(base.hitsAt3 / base.pairs);
  });

  it('pools seeds instead of trusting one draw', () => {
    expect(DEFAULT_SEEDS.length).toBeGreaterThan(1);
    const pooled = runEvalDetailed([1, 2, 3]);
    const single = runEvalDetailed(1);
    expect(pooled.seeds).toEqual([1, 2, 3]);
    expect(pooled.workflow.pairs).toBe(single.workflow.pairs * 3);
  });
});

// --- the printed artifact -----------------------------------------------------

describe('report rendering', () => {
  it('prints a BASELINE line in the shape later tasks diff against', () => {
    const run = runEvalDetailed(DEFAULT_SEEDS);
    const line = baselineLine(run);
    expect(line).toMatch(
      /^BASELINE recall@3 \d\.\d{4} seeds=\d+(,\d+)* pairs=\d+ waste\/hit=(\d+\.\d{2}|inf) \(workflow\) \| floor recall@3 \d\.\d{4} pairs=\d+ waste\/hit=(\d+\.\d{2}|inf)$/,
    );
    // The headline is the workflow pool, not the whole corpus.
    expect(line).toContain((run.workflow.hitsAt3 / run.workflow.pairs).toFixed(4));
    expect(line).toContain(`pairs=${run.workflow.pairs}`);
    expect(line).not.toContain(`pairs=${run.overall.pairs}`);
  });

  it('attributes an A/B per archetype instead of pooling it', () => {
    const run = runEvalDetailed(1);
    const compare = new Map(run.reports.map((r) => [r.archetype, r.recallAt3 - 0.1]));
    const rows = table(run, { compare });
    expect(rows.some((r) => r.includes('d recall@3'))).toBe(true);
    // Every archetype row carries its own delta, so a pooled claim can be
    // decomposed instead of taken on faith.
    for (const archetype of WORKFLOW_ARCHETYPES) {
      expect(
        rows.find((r) => r.startsWith(archetype.name)),
        archetype.name,
      ).toContain('+0.100');
    }
    expect(table(run).some((r) => r.includes('d recall@3'))).toBe(false);
  });
});

// --- warm-up ------------------------------------------------------------------

describe('warm-up', () => {
  it('learns from warm-up sessions without scoring them', () => {
    const archetype = ARCHETYPES[0]!;
    const warm = replayArchetype(archetype, 1);
    const cold = replayArchetype(archetype, 1, { warmupSessions: 0 });
    expect(cold.totals.pairs).toBeGreaterThan(warm.totals.pairs);
    // Scoring the cold start counts the minObservations gate as failure, so
    // it can only drag the number down.
    expect(cold.report.recallAt3).toBeLessThanOrEqual(warm.report.recallAt3);
  });

  it('leaves most of the corpus scored', () => {
    expect(WARMUP_SESSIONS).toBeGreaterThan(0);
    expect(WARMUP_SESSIONS).toBeLessThan(SESSIONS_PER_ARCHETYPE / 2);
  });
});

// --- waste accounting ---------------------------------------------------------

describe('waste accounting', () => {
  it("bills the batch fired after a session's last call", () => {
    // Nothing can ever claim it, so leaving it out would understate
    // production waste by roughly one prediction per session.
    for (const archetype of ARCHETYPES) {
      const { totals } = replayArchetype(archetype, 1);
      const scoredSessions = SESSIONS_PER_ARCHETYPE - WARMUP_SESSIONS;
      const callsPerSession = archetype.sessions(1)[0]!.calls.length;
      // One scored pair per scored call after the first.
      expect(totals.pairs).toBe(scoredSessions * (callsPerSession - 1));
      // Triggers outnumber pairs, because the last call of each session is a
      // trigger with no pair — that is the batch being billed.
      expect(totals.issued).toBeGreaterThan(0);
      expect(totals.wasted).toBeGreaterThan(0);
    }
  });
});

// --- the corpus must not be shaped to the hand-written rules ------------------

describe('corpus independence', () => {
  it('shares no tool name or server label with the GitHub profile', () => {
    const forbidden = new Set([
      ...githubProfile.readOnlyAllowlist,
      ...githubProfile.rules.map((r) => r.trigger),
      ...(githubProfile.primes ?? []).flat(),
    ]);
    for (const archetype of ARCHETYPES) {
      for (const session of archetype.sessions(1)) {
        expect(session.server).not.toBe('github');
        for (const call of session.calls) {
          expect(forbidden.has(call.tool), `${archetype.name}: ${call.tool}`).toBe(false);
        }
      }
    }
  });

  it('never assumes the agent opens the top of a list', () => {
    // The one assumption the hand-written `gh:pr-list->pr` rule encodes. Every
    // workflow archetype opens something other than row 0 in a good share of
    // its sessions, so a corpus-wide "just predict element 0" shortcut cannot
    // score well here.
    for (const archetype of WORKFLOW_ARCHETYPES) {
      const sessions = archetype.sessions(1);
      let offTop = 0;
      for (const session of sessions) {
        const listed = session.calls[0]!.parsed as Record<string, unknown>;
        const rows = Object.values(listed).find(
          (v): v is Array<Record<string, unknown>> =>
            Array.isArray(v) && v.length > 0 && typeof v[0] === 'object',
        );
        if (!rows) continue;
        const openedValues = new Set(Object.values(session.calls[1]!.args));
        const opensRowZero = Object.values(rows[0]!).some((v) => openedValues.has(v));
        if (!opensRowZero) offTop++;
      }
      // A quarter of sessions is well past what a top-of-list rule could
      // shrug off, and far past sampling noise at 60 sessions.
      expect(offTop, `${archetype.name} nearly always opens row 0`).toBeGreaterThan(
        sessions.length / 4,
      );
    }
  });

  it('exercises the learner with results the parsed-path search can walk', () => {
    // Every workflow session must carry at least one array-of-objects result:
    // that is the shape `enumerateParsedPaths` indexes (0..2), and a corpus of
    // flat constants would test nothing.
    for (const archetype of WORKFLOW_ARCHETYPES) {
      for (const session of archetype.sessions(1)) {
        const hasList = session.calls.some((c) => {
          const parsed = c.parsed as Record<string, unknown> | null;
          if (parsed === null || typeof parsed !== 'object') return false;
          return Object.values(parsed).some(
            (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object',
          );
        });
        expect(hasList, `${archetype.name} session lacks a list result`).toBe(true);
      }
    }
  });
});
