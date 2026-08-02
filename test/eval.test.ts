/**
 * Evaluation-harness tests (eval/): determinism, the adversarial floor, and
 * the guards that keep the harness honest.
 *
 * Deliberately NO absolute recall assertions — later tasks change those
 * numbers by design, and a test that pins them would just have to be edited
 * every time, which is the same as having no test. What is asserted here is
 * structural: the same seed replays identically, the low-predictability
 * archetype scores strictly worse than the workflow-shaped one, the corpus is
 * not secretly shaped to the hand-written GitHub rules, and the score is not
 * saturated at either end (a saturated metric cannot detect an improvement).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { githubProfile } from '../src/profiles/github.js';
import { ARCHETYPES, SESSIONS_PER_ARCHETYPE, WARMUP_SESSIONS } from '../eval/corpus.js';
import { replayArchetype, runEval, runEvalDetailed } from '../eval/replay.js';
import type { RecallReport } from '../eval/replay.js';

const EVAL_SOURCES = ['corpus.ts', 'replay.ts', 'eval.ts'] as const;

function byName(reports: RecallReport[], name: string): RecallReport {
  const found = reports.find((r) => r.archetype === name);
  if (!found) throw new Error(`no report for ${name}`);
  return found;
}

function readEvalSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../eval/${file}`, import.meta.url)), 'utf8');
}

// --- determinism --------------------------------------------------------------

describe('determinism', () => {
  it('produces an identical report for the same seed', () => {
    expect(runEval(11)).toEqual(runEval(11));
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
    for (const file of EVAL_SOURCES) {
      const src = readEvalSource(file);
      expect(src, `${file} must not call Math.random`).not.toContain('Math.random');
      expect(src, `${file} must not call Date.now`).not.toContain('Date.now');
    }
  });
});

// --- the adversarial floor ----------------------------------------------------

describe('adversarial floor', () => {
  it('scores strictly below the workflow-shaped archetype', () => {
    // Checked across several seeds so the floor is a property of the corpus,
    // not of one lucky draw.
    for (const seed of [1, 2, 3, 7, 42]) {
      const reports = runEval(seed);
      const adversarial = byName(reports, 'adversarial');
      const varied = byName(reports, 'list-detail-varied');
      expect(adversarial.recallAt3, `seed ${seed}`).toBeLessThan(varied.recallAt3);
      expect(adversarial.recallAt5, `seed ${seed}`).toBeLessThan(varied.recallAt5);
    }
  });

  it('costs more waste per hit than every workflow-shaped archetype', () => {
    const reports = runEval(1);
    const adversarial = byName(reports, 'adversarial');
    for (const report of reports) {
      if (report.archetype === 'adversarial') continue;
      expect(report.wastePerHit).toBeLessThan(adversarial.wastePerHit);
    }
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
    const { overall } = runEvalDetailed(1);
    const recallAt3 = overall.hitsAt3 / overall.pairs;
    expect(recallAt3).toBeGreaterThan(0.05);
    expect(recallAt3).toBeLessThan(0.95);
  });

  it('separates the rank bands: @1 < @3 < @5 somewhere in the corpus', () => {
    const reports = runEval(1);
    for (const report of reports) {
      expect(report.recallAt1).toBeLessThanOrEqual(report.recallAt3);
      expect(report.recallAt3).toBeLessThanOrEqual(report.recallAt5);
    }
    // Ranking is live (candidates compete) and the per-trigger cap costs
    // something (a real follow-up sits past rank 3).
    expect(reports.some((r) => r.recallAt1 < r.recallAt3)).toBe(true);
    expect(reports.some((r) => r.recallAt3 < r.recallAt5)).toBe(true);
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

  it('exercises the learner with results the parsed-path search can walk', () => {
    // Every non-adversarial session must carry at least one array-of-objects
    // result: that is the shape `enumerateParsedPaths` indexes (0..2), and a
    // corpus of flat constants would test nothing.
    for (const archetype of ARCHETYPES) {
      if (archetype.name === 'adversarial') continue;
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
