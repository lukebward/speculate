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
import { builtinProfiles } from '../src/profiles/index.js';
import {
  ARCHETYPES,
  FLOOR_ARCHETYPES,
  SESSIONS_PER_ARCHETYPE,
  WARMUP_SESSIONS,
  WORKFLOW_ARCHETYPES,
  warmupFor,
} from '../eval/corpus.js';
import { baselineLine, table } from '../eval/format.js';
import {
  DEFAULT_SEEDS,
  replayArchetype,
  runEval,
  runEvalDetailed,
  toAgeReport,
} from '../eval/replay.js';
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

  it('moves the headline when ranking gets worse, and leaves the floor alone', () => {
    // THE property the whole instrument rests on. Tightening the per-trigger
    // cap is a strictly worse ranking and nothing else: candidates past rank 1
    // stop being issued, so a model that ranked well loses hits and a corpus
    // of noise — where the only materializable candidate was already alone at
    // rank 1 — loses nothing.
    //
    // Knobs like maxTransitions/minObservations are NOT used here: measured
    // per archetype they move the floor more than the workflow rows, so an
    // assertion built on them is carried by the noise archetype and proves
    // "fires more aggressively", not "predicts better".
    const base = runEvalDetailed(DEFAULT_SEEDS);
    const worse = runEvalDetailed(DEFAULT_SEEDS, {
      learner: { maxPredictionsPerTrigger: 1 },
    });

    expect(worse.workflow.pairs).toBe(base.workflow.pairs);
    expect(worse.workflow.hitsAt3 / worse.workflow.pairs).toBeLessThan(
      base.workflow.hitsAt3 / base.workflow.pairs,
    );
    // The other half, and the one that makes the first half mean anything.
    expect(worse.floor.pairs).toBe(base.floor.pairs);
    expect(worse.floor.hitsAt3).toBe(base.floor.hitsAt3);
  });

  it('pools seeds instead of trusting one draw', () => {
    expect(DEFAULT_SEEDS.length).toBeGreaterThan(1);
    const pooled = runEvalDetailed([1, 2, 3]);
    const single = runEvalDetailed(1);
    expect(pooled.seeds).toEqual([1, 2, 3]);
    expect(pooled.workflow.pairs).toBe(single.workflow.pairs * 3);
  });
});

// --- staleness ----------------------------------------------------------------

describe('regime-shift', () => {
  const archetype = ARCHETYPES.find((a) => a.name === 'regime-shift')!;

  it('is scored in the headline, not treated as a floor', () => {
    expect(FLOOR_ARCHETYPES.has('regime-shift')).toBe(false);
    expect(WORKFLOW_ARCHETYPES.map((a) => a.name)).toContain('regime-shift');
  });

  it('scores only the post-shift phase', () => {
    // Phase 1 is warm-up in full: scoring it would measure the workflow the
    // user abandoned, which is the opposite of the question being asked.
    const { warmupSessions, sessions, byTransition } = replayArchetype(archetype, 1);
    expect(warmupSessions).toBeGreaterThan(0);
    expect(sessions).toBeGreaterThan(warmupSessions);
    // Every scored pair is the same trigger, and it is the NEW follow-up.
    expect(byTransition.map((t) => t.transition)).toEqual([
      'pipeline_status->pipeline_get_deploy',
    ]);
  });

  it('depends on elapsed time — collapse the idle gap and it collapses', () => {
    // The archetype's whole claim is that it measures staleness. If the same
    // sessions replayed back-to-back scored the same, it would be measuring
    // something else and would be worthless as a decay guard.
    const stale = replayArchetype(archetype, 1);
    const fresh = replayArchetype(archetype, 1, { idleGapMs: 0 });
    expect(fresh.totals.pairs).toBe(stale.totals.pairs);
    expect(fresh.report.recallAt3).toBeLessThan(stale.report.recallAt3);
    // The right candidate exists in both worlds; only its rank differs. If
    // this stopped holding, the archetype would have started measuring
    // capability rather than ordering.
    expect(fresh.report.recallAt5).toBe(stale.report.recallAt5);
  });

  it('is crowded out by the shipped per-trigger cap, not absent', () => {
    // Without decay the fresh transition ranks behind three stale ones, so it
    // falls outside the cap of 3 while still being inside the top 5. That gap
    // is the mechanism the archetype exists to expose.
    const fresh = replayArchetype(archetype, 1, { idleGapMs: 0 });
    expect(fresh.report.recallAt3).toBeLessThan(fresh.report.recallAt5);
  });
});

// --- entity memory ------------------------------------------------------------

describe('direct-recall', () => {
  const archetype = ARCHETYPES.find((a) => a.name === 'direct-recall')!;

  /** Every scalar reachable anywhere inside a value. */
  function scalars(value: unknown, out: Set<string>): Set<string> {
    if (value === null || typeof value !== 'object') {
      out.add(JSON.stringify(value));
    } else if (Array.isArray(value)) {
      for (const v of value) scalars(v, out);
    } else {
      for (const v of Object.values(value)) scalars(v, out);
    }
    return out;
  }

  it('is scored in the headline, not treated as a floor', () => {
    expect(FLOOR_ARCHETYPES.has('direct-recall')).toBe(false);
    expect(WORKFLOW_ARCHETYPES.map((a) => a.name)).toContain('direct-recall');
  });

  it('never leaves the target derivable from the previous call', () => {
    // THE guarantee. If this ever fails, the archetype has quietly become a
    // test of argument derivation — which the rest of the corpus already
    // covers — and any conclusion drawn from it about memory is void.
    for (const seed of [1, 2, 3]) {
      for (const session of archetype.sessions(seed)) {
        const trigger = session.calls[0]!;
        const target = JSON.stringify(session.calls[1]!.args['ticketId']);
        const reachable = scalars(trigger.parsed, scalars(trigger.args, new Set()));
        expect(reachable.has(target), `seed ${seed}: ${target} was in the trigger`).toBe(
          false,
        );
      }
    }
  });

  it('reaches the same entities from one common and several rare triggers', () => {
    // The two legs measure different things and must both stay populated:
    // the common one guards memory that already works, the rare ones are the
    // headroom for evidence that is scoped per transition instead of per
    // entity. Pooling them into one number would hide both.
    const { byTransition } = replayArchetype(archetype, 1);
    expect(byTransition.every((t) => t.transition.endsWith('->desk_ticket_get'))).toBe(true);
    const common = byTransition.filter((t) => t.transition.startsWith('desk_list_recent'));
    const rare = byTransition.filter((t) => !t.transition.startsWith('desk_list_recent'));
    expect(common).toHaveLength(1);
    expect(rare.length).toBeGreaterThanOrEqual(4);
    expect(common[0]!.pairs).toBeGreaterThan(rare.reduce((a, t) => a + t.pairs, 0));
    // No rare trigger may become common enough to memorize the ids by itself.
    for (const t of rare) expect(t.pairs).toBeLessThan(common[0]!.pairs / 4);
  });
});

// --- age at consumption -------------------------------------------------------

describe('age at consumption', () => {
  it('measures every simulated hit and reports a distribution, not just a mean', () => {
    const run = runEvalDetailed(DEFAULT_SEEDS);
    const age = toAgeReport(run.age.all);
    expect(age.hits).toBeGreaterThan(0);
    expect(age.p50Ms).not.toBeNull();
    expect(age.p95Ms).not.toBeNull();
    expect(age.p95Ms!).toBeGreaterThanOrEqual(age.p50Ms!);
    expect(age.maxMs!).toBeGreaterThanOrEqual(age.p95Ms!);
    // Nothing can be consumed after it expires, by construction.
    expect(age.maxMs!).toBeLessThan(run.ttlMs);
    expect(age.lastQuarterShare).toBeGreaterThanOrEqual(0);
    expect(age.lastQuarterShare).toBeLessThanOrEqual(1);
  });

  it('splits the buffer into the classes that get different TTLs', () => {
    const run = runEvalDetailed(DEFAULT_SEEDS);
    expect(run.age.next.hits + run.age.standing.hits).toBe(run.age.all.hits);
    expect(run.age.all.ages).toHaveLength(run.age.all.hits);
    // Both classes must stay populated or the comparison is vacuous.
    expect(run.age.next.hits).toBeGreaterThan(0);
    expect(run.age.standing.hits).toBeGreaterThan(0);
  });

  it('MOVES when consumption is delayed — the property the metric rests on', () => {
    // An age metric that reads the same however far apart the calls are would
    // be measuring the corpus's shape, not staleness. Tripling the spacing
    // must triple the ages.
    const base = runEvalDetailed(DEFAULT_SEEDS);
    const slow = runEvalDetailed(DEFAULT_SEEDS, { callSpacingMs: 4_500 });
    const b = toAgeReport(base.age.all);
    const s = toAgeReport(slow.age.all);
    expect(s.p50Ms!).toBeGreaterThan(b.p50Ms! * 2);
    expect(s.lastQuarterShare!).toBeGreaterThanOrEqual(b.lastQuarterShare!);
  });

  it('MOVES when the TTL shrinks — entries land nearer the edge of a shorter life', () => {
    const long = runEvalDetailed(DEFAULT_SEEDS);
    const short = runEvalDetailed(DEFAULT_SEEDS, { ttlMs: 3_000 });
    expect(toAgeReport(short.age.all).lastQuarterShare!).toBeGreaterThan(
      toAgeReport(long.age.all).lastQuarterShare!,
    );
  });

  it('counts a lead of 1 for an entry the very next call claims', () => {
    const run = runEvalDetailed(DEFAULT_SEEDS);
    // leadCounts[0] is unused: a prediction cannot be claimed by the call
    // that triggered it.
    expect(run.age.all.leadCounts[0] ?? 0).toBe(0);
    expect(run.age.all.leadCounts[1]!).toBeGreaterThan(0);
    const total = run.age.all.leadCounts.reduce((a, b) => a + b, 0);
    expect(total).toBe(run.age.all.hits);
  });

  it('leaves recall alone: the sim observes the buffer, it does not feed it', () => {
    // The eval scores rank-of-actual-call and is age-blind by design. If
    // instrumenting the buffer moved recall, the instrument would be
    // participating in the thing it measures.
    const withSim = runEvalDetailed(DEFAULT_SEEDS);
    const otherTtl = runEvalDetailed(DEFAULT_SEEDS, { ttlMs: 1 });
    expect(otherTtl.workflow.hitsAt3).toBe(withSim.workflow.hitsAt3);
    expect(otherTtl.workflow.pairs).toBe(withSim.workflow.pairs);
    expect(otherTtl.floor.hitsAt3).toBe(withSim.floor.hitsAt3);
  });

  it('honours single use: one prediction is consumed at most once', () => {
    const run = runEvalDetailed(DEFAULT_SEEDS);
    // Every hit removes an entry, so hits can never exceed what was issued.
    expect(run.age.all.hits).toBeLessThanOrEqual(run.workflow.issued + run.floor.issued);
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
      // One scored pair per scored call after the first. Computed from the
      // actual sessions: archetypes are not all the same length or warm-up.
      const scored = archetype.sessions(1).slice(warmupFor(archetype.name));
      const expected = scored.reduce((a, s) => a + s.calls.length - 1, 0);
      expect(totals.pairs, archetype.name).toBe(expected);
      // Triggers outnumber pairs, because the last call of each session is a
      // trigger with no pair — that is the batch being billed.
      expect(totals.issued).toBeGreaterThan(0);
      expect(totals.wasted).toBeGreaterThan(0);
    }
  });
});

// --- the corpus must not be shaped to the hand-written rules ------------------

describe('corpus independence', () => {
  it('shares no tool name or server label with any built-in profile', () => {
    const forbidden = new Set<string>();
    for (const profile of Object.values(builtinProfiles)) {
      for (const tool of profile.readOnlyAllowlist) forbidden.add(tool);
      for (const rule of profile.rules) forbidden.add(rule.trigger);
      for (const prime of profile.primes ?? []) for (const tool of prime) forbidden.add(tool);
    }
    expect(forbidden.size).toBeGreaterThan(0);
    const labels = new Set(Object.keys(builtinProfiles));
    for (const archetype of ARCHETYPES) {
      for (const session of archetype.sessions(1)) {
        expect(labels.has(session.server), `${archetype.name}: ${session.server}`).toBe(
          false,
        );
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

  it('moves two arguments together in paired-args, which is the shape it exists to measure', () => {
    // The archetype is worthless if its two ids can be read off different
    // rows: the whole point is that only the pairings the agent actually made
    // are correct, so a model ranking each argument on its own marginal
    // evidence fills the batch with combinations that never occurred.
    const archetype = ARCHETYPES.find((a) => a.name === 'paired-args')!;
    const sessions = archetype.sessions(1);
    let offTop = 0;
    let mixed = 0;
    for (const session of sessions) {
      const listed = session.calls[0]!.parsed as {
        releases: Array<Record<string, unknown>>;
      };
      const opened = session.calls[1]!.args as { releaseId: unknown; buildId: unknown };
      const row = listed.releases.findIndex((r) => r.releaseId === opened.releaseId);
      expect(row).toBeGreaterThanOrEqual(0);
      if (row > 0) offTop++;
      if (listed.releases[row]!.buildId !== opened.buildId) mixed++;
    }
    expect(mixed).toBe(0);
    // And the co-variation has to be observable: if row 0 were always the one
    // opened, there would be no second combination to get wrong.
    expect(offTop).toBeGreaterThan(sessions.length / 4);
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
