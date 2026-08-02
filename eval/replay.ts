/**
 * Offline replay of the evaluation corpus against the real TransitionLearner
 * (DESIGN.md §5.3, §10 item 8).
 *
 * Entirely in-process: no MCP server, no subprocess, no clock, no I/O. A full
 * run is milliseconds, so it can be re-run after every change to the model.
 *
 * Protocol per session, mirroring what the proxy does in production
 * (Predictor.observe → learner.observe, then learner.predict on the same
 * call): for call N we ask the learner what it expects after call N-1, note
 * the RANK of the call that actually happened, and only then let the learner
 * see call N. A call is a hit only when the predicted tool AND the predicted
 * arguments match the real ones under the canonical cache key — a prediction
 * with the right tool and the wrong id would never serve a real call from
 * cache, so scoring it as a hit would be measuring nothing.
 *
 * Two knobs deserve naming:
 *   - The learner is built with maxPredictionsPerTrigger = MAX_K (5) so
 *     recall@5 is observable at all; production defaults to 3. recall@3 is
 *     therefore the production-faithful headline.
 *   - Waste is accounted at PRODUCTION_K (3), the real per-trigger cap: each
 *     scored pair issues up to 3 predictions, at most one of which can be the
 *     call that actually happened; the rest are waste. The predictions fired
 *     after a session's LAST call are billed too — nothing can ever claim
 *     them — so waste/hit is a production estimate rather than a lower bound.
 */
import { canonicalKey } from '../src/keys.js';
import { TransitionLearner } from '../src/learner.js';
import type { TransitionLearnerOptions } from '../src/learner.js';
import type { ObservedCall } from '../src/types.js';
import { ARCHETYPES, ARCHETYPE_TIMING, FLOOR_ARCHETYPES, warmupFor } from './corpus.js';
import type { Archetype, EvalSession } from './corpus.js';

export interface RecallReport {
  archetype: string;
  pairs: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  wastePerHit: number;
}

/** Deepest rank the harness can score. Also the learner's per-trigger cap here. */
export const MAX_K = 5;
/**
 * Seeds the BASELINE pools over by default. One seed is not enough: the
 * cross-seed spread of a single-seed headline is about 0.03, the same order as
 * the movement a real model change produces, so a one-seed number cannot
 * distinguish a win from a draw. A full three-seed run costs ~10 ms.
 */
export const DEFAULT_SEEDS: readonly number[] = [1, 2, 3];
/** The per-trigger cap Speculate actually ships with (§5.6); waste is billed here. */
export const PRODUCTION_K = 3;
/** Spacing between calls inside one session (well under the learner's maxGapMs). */
const CALL_SPACING_MS = 1_500;
/**
 * Spacing between sessions. Larger than the learner's default maxGapMs
 * (120 s), so a session boundary breaks the transition chain exactly as an
 * idle gap would in production.
 */
const SESSION_SPACING_MS = 600_000;

/** Per-archetype counters, kept raw so totals stay exact. */
export interface ReplayTotals {
  pairs: number;
  hitsAt1: number;
  hitsAt3: number;
  hitsAt5: number;
  /** Predictions issued at PRODUCTION_K across scored pairs. */
  issued: number;
  /** Issued predictions that were not the call that happened. */
  wasted: number;
}

/**
 * Per-transition breakdown. The headline number says whether prediction got
 * better; this says WHICH transition moved — the difference between "recall
 * went up" and "recall went up because list→detail finally works".
 */
export interface TransitionStat {
  /** `prevTool->nextTool`. */
  transition: string;
  pairs: number;
  hitsAt1: number;
  hitsAt3: number;
  hitsAt5: number;
}

export interface ArchetypeResult {
  report: RecallReport;
  totals: ReplayTotals;
  /** Scored pairs grouped by transition, most frequent first. */
  byTransition: TransitionStat[];
  /** Sessions replayed per seed (archetypes are not all the same length). */
  sessions: number;
  /** Sessions observed but not scored, per seed. */
  warmupSessions: number;
}

export interface EvalRun {
  seeds: number[];
  reports: RecallReport[];
  /** Full per-archetype results, including the per-transition breakdown. */
  byArchetype: ArchetypeResult[];
  /**
   * THE HEADLINE: pooled over the workflow archetypes only. The floor is
   * excluded on purpose — see FLOOR_ARCHETYPES in corpus.ts.
   */
  workflow: ReplayTotals;
  /** The floor archetypes, pooled. Read next to the headline, never into it. */
  floor: ReplayTotals;
  /** Everything pooled, for reference only. */
  overall: ReplayTotals;
}

export interface ReplayOptions {
  /** Leading sessions observed but not scored. Default: WARMUP_SESSIONS. */
  warmupSessions?: number;
  /**
   * Learner overrides, for A/B-ing a model knob against the same corpus
   * without touching the harness. The injected clock is always the
   * harness's; everything else is the caller's. Note that overriding
   * `maxPredictionsPerTrigger` below MAX_K makes recall@5 unreadable.
   */
  learner?: Omit<TransitionLearnerOptions, 'now'>;
  /**
   * Overrides the idle gap an archetype declares in ARCHETYPE_TIMING. Only
   * `regime-shift` declares one; setting this to 0 collapses its 45-day
   * silence, which is how the suite proves that archetype measures elapsed
   * time (i.e. decay) rather than anything else about the corpus.
   */
  idleGapMs?: number;
}

/** Replay one archetype end to end against a fresh learner. */
export function replayArchetype(
  archetype: Archetype,
  seed: number,
  opts: ReplayOptions = {},
): ArchetypeResult {
  const warmup = opts.warmupSessions ?? warmupFor(archetype.name);
  const idleGap = ARCHETYPE_TIMING.get(archetype.name)?.idleGap;
  const idleGapMs = opts.idleGapMs ?? idleGap?.ms ?? 0;
  const sessions = archetype.sessions(seed);

  // The injected clock drives decay and recency only; feeding it the call
  // timestamps keeps the run free of wall-clock nondeterminism.
  let clock = 0;
  const learner = new TransitionLearner({
    maxPredictionsPerTrigger: MAX_K,
    ...opts.learner,
    now: () => clock,
  });

  const totals = emptyTotals();
  const byTransition = new Map<string, TransitionStat>();

  for (let s = 0; s < sessions.length; s++) {
    const session = sessions[s]!;
    const scored = s >= warmup;
    // The declared idle gap lands once, before its session, and every later
    // session carries it forward — the clock does not rewind.
    const base =
      s * SESSION_SPACING_MS + (idleGap && s >= idleGap.beforeSession ? idleGapMs : 0);
    let prev: ObservedCall | null = null;

    for (let i = 0; i < session.calls.length; i++) {
      const call = toObserved(session, i, base + i * CALL_SPACING_MS);
      if (prev) {
        const predictions = learner.predict(prev);
        const rank = rankOf(predictions, call);
        if (scored) {
          totals.pairs++;
          const hit = scoreRank(totals, rank);
          bill(totals, predictions.length, hit);

          const key = `${prev.tool}->${call.tool}`;
          const stat = byTransition.get(key) ?? blankStat(key);
          stat.pairs++;
          scoreRank(stat, rank);
          byTransition.set(key, stat);
        }
      }
      clock = call.timestamp;
      learner.observe(call);
      prev = call;
    }

    // The session's LAST call also triggers a prediction in production, and
    // nothing ever claims it — the next session is 600 s away, past any TTL.
    // It scores no pair (there is no next call to rank) but it is real waste,
    // so it is billed. Excluding it would understate production waste by
    // roughly the reciprocal of the session length.
    if (scored && prev) bill(totals, learner.predict(prev).length, false);
  }

  return {
    report: toReport(archetype.name, totals),
    totals,
    byTransition: [...byTransition.values()].sort(
      (a, b) => b.pairs - a.pairs || (a.transition < b.transition ? -1 : 1),
    ),
    sessions: sessions.length,
    warmupSessions: warmup,
  };
}

/** As `replayArchetype`, with the counters pooled over several seeds. */
export function replayArchetypeSeeds(
  archetype: Archetype,
  seeds: readonly number[],
  opts: ReplayOptions = {},
): ArchetypeResult {
  const totals = emptyTotals();
  const merged = new Map<string, TransitionStat>();
  let shape = { sessions: 0, warmupSessions: 0 };
  for (const seed of seeds) {
    const result = replayArchetype(archetype, seed, opts);
    shape = { sessions: result.sessions, warmupSessions: result.warmupSessions };
    addTotals(totals, result.totals);
    for (const stat of result.byTransition) {
      const into = merged.get(stat.transition) ?? blankStat(stat.transition);
      into.pairs += stat.pairs;
      into.hitsAt1 += stat.hitsAt1;
      into.hitsAt3 += stat.hitsAt3;
      into.hitsAt5 += stat.hitsAt5;
      merged.set(stat.transition, into);
    }
  }
  return {
    report: toReport(archetype.name, totals),
    totals,
    byTransition: [...merged.values()].sort(
      (a, b) => b.pairs - a.pairs || (a.transition < b.transition ? -1 : 1),
    ),
    ...shape,
  };
}

/**
 * Every archetype, in corpus order, for ONE seed. Signature fixed by the
 * task brief; `runEvalDetailed` is the multi-seed entry point.
 */
export function runEval(seed: number): RecallReport[] {
  return runEvalDetailed(seed).reports;
}

/**
 * As `runEval`, plus the raw counters and the headline/floor split. Accepts
 * a list of seeds and pools the counters across them: the cross-seed spread
 * of a single-seed run is the same order of magnitude as the movement a real
 * model change produces, so a one-seed headline cannot tell them apart.
 */
export function runEvalDetailed(
  seeds: number | readonly number[],
  opts: ReplayOptions = {},
): EvalRun {
  const list = typeof seeds === 'number' ? [seeds] : [...seeds];
  const byArchetype: ArchetypeResult[] = [];
  const workflow = emptyTotals();
  const floor = emptyTotals();
  const overall = emptyTotals();
  for (const archetype of ARCHETYPES) {
    const result = replayArchetypeSeeds(archetype, list, opts);
    byArchetype.push(result);
    addTotals(overall, result.totals);
    addTotals(FLOOR_ARCHETYPES.has(archetype.name) ? floor : workflow, result.totals);
  }
  return {
    seeds: list,
    reports: byArchetype.map((r) => r.report),
    byArchetype,
    workflow,
    floor,
    overall,
  };
}

function emptyTotals(): ReplayTotals {
  return { pairs: 0, hitsAt1: 0, hitsAt3: 0, hitsAt5: 0, issued: 0, wasted: 0 };
}

function blankStat(transition: string): TransitionStat {
  return { transition, pairs: 0, hitsAt1: 0, hitsAt3: 0, hitsAt5: 0 };
}

function addTotals(into: ReplayTotals, from: ReplayTotals): void {
  into.pairs += from.pairs;
  into.hitsAt1 += from.hitsAt1;
  into.hitsAt3 += from.hitsAt3;
  into.hitsAt5 += from.hitsAt5;
  into.issued += from.issued;
  into.wasted += from.wasted;
}

/** Credits one scored pair to the rank bands; returns "hit within the cap". */
function scoreRank(
  bands: { hitsAt1: number; hitsAt3: number; hitsAt5: number },
  rank: number | null,
): boolean {
  if (rank === null) return false;
  if (rank <= 1) bands.hitsAt1++;
  if (rank <= PRODUCTION_K) bands.hitsAt3++;
  if (rank <= MAX_K) bands.hitsAt5++;
  return rank <= PRODUCTION_K;
}

/** Bills the predictions a trigger issued at the shipped cap. */
function bill(totals: ReplayTotals, predicted: number, hit: boolean): void {
  const issued = Math.min(predicted, PRODUCTION_K);
  totals.issued += issued;
  totals.wasted += hit ? issued - 1 : issued;
}

/**
 * Recall/waste view of raw counters. `wastePerHit` is Infinity when
 * predictions were issued and none ever landed — an honest "all cost, no
 * benefit" — and 0 when nothing was issued at all.
 */
export function toReport(name: string, t: ReplayTotals): RecallReport {
  const hits = t.hitsAt3; // waste is billed at the production cap
  return {
    archetype: name,
    pairs: t.pairs,
    recallAt1: ratio(t.hitsAt1, t.pairs),
    recallAt3: ratio(t.hitsAt3, t.pairs),
    recallAt5: ratio(t.hitsAt5, t.pairs),
    wastePerHit:
      hits > 0 ? t.wasted / hits : t.wasted > 0 ? Number.POSITIVE_INFINITY : 0,
  };
}

function ratio(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

/**
 * 1-based rank of the call that actually happened among the predictions, or
 * null for a miss. Server + tool + canonical args must all match: that is
 * exactly the condition under which the cache would have served the call.
 */
function rankOf(predictions: readonly { tool: string; args: Record<string, unknown> }[], actual: ObservedCall): number | null {
  const want = canonicalKey(actual.server, actual.tool, actual.args);
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i]!;
    if (canonicalKey(actual.server, p.tool, p.args) === want) return i + 1;
  }
  return null;
}

/**
 * Corpus call → ObservedCall. The synthetic `result` carries the parsed value
 * as a JSON text block, the shape most MCP servers actually return, so the
 * same session replays identically through the full Predictor (whose generic
 * JSON-in-text fallback recovers the same `parsed`) if a later task wants it.
 */
function toObserved(session: EvalSession, index: number, timestamp: number): ObservedCall {
  const call = session.calls[index]!;
  return {
    server: session.server,
    tool: call.tool,
    args: call.args,
    result: { content: [{ type: 'text', text: JSON.stringify(call.parsed) }] },
    parsed: call.parsed,
    timestamp,
    latencyMs: 40,
  };
}
