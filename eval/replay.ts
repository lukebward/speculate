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
 *     call that actually happened; the rest are waste.
 */
import { canonicalKey } from '../src/keys.js';
import { TransitionLearner } from '../src/learner.js';
import type { TransitionLearnerOptions } from '../src/learner.js';
import type { ObservedCall } from '../src/types.js';
import { ARCHETYPES, WARMUP_SESSIONS } from './corpus.js';
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
}

export interface EvalRun {
  seed: number;
  reports: RecallReport[];
  /** Full per-archetype results, including the per-transition breakdown. */
  byArchetype: ArchetypeResult[];
  /** Pooled over every archetype, weighted by pairs. */
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
}

/** Replay one archetype end to end against a fresh learner. */
export function replayArchetype(
  archetype: Archetype,
  seed: number,
  opts: ReplayOptions = {},
): ArchetypeResult {
  const warmup = opts.warmupSessions ?? WARMUP_SESSIONS;
  const sessions = archetype.sessions(seed);

  // The injected clock drives LRU recency only; feeding it the call
  // timestamps keeps the run free of wall-clock nondeterminism.
  let clock = 0;
  const learner = new TransitionLearner({
    maxPredictionsPerTrigger: MAX_K,
    ...opts.learner,
    now: () => clock,
  });

  const totals: ReplayTotals = {
    pairs: 0,
    hitsAt1: 0,
    hitsAt3: 0,
    hitsAt5: 0,
    issued: 0,
    wasted: 0,
  };
  const byTransition = new Map<string, TransitionStat>();

  for (let s = 0; s < sessions.length; s++) {
    const session = sessions[s]!;
    const scored = s >= warmup;
    const base = s * SESSION_SPACING_MS;
    let prev: ObservedCall | null = null;

    for (let i = 0; i < session.calls.length; i++) {
      const call = toObserved(session, i, base + i * CALL_SPACING_MS);
      if (prev) {
        const predictions = learner.predict(prev);
        const rank = rankOf(predictions, call);
        if (scored) {
          totals.pairs++;
          const hit3 = rank !== null && rank <= PRODUCTION_K;
          if (rank !== null) {
            if (rank <= 1) totals.hitsAt1++;
            if (rank <= 5) totals.hitsAt5++;
          }
          if (hit3) totals.hitsAt3++;
          const issued = Math.min(predictions.length, PRODUCTION_K);
          totals.issued += issued;
          totals.wasted += hit3 ? issued - 1 : issued;

          const key = `${prev.tool}->${call.tool}`;
          const stat = byTransition.get(key) ?? {
            transition: key,
            pairs: 0,
            hitsAt1: 0,
            hitsAt3: 0,
            hitsAt5: 0,
          };
          stat.pairs++;
          if (rank !== null && rank <= 1) stat.hitsAt1++;
          if (hit3) stat.hitsAt3++;
          if (rank !== null && rank <= 5) stat.hitsAt5++;
          byTransition.set(key, stat);
        }
      }
      clock = call.timestamp;
      learner.observe(call);
      prev = call;
    }
  }

  return {
    report: toReport(archetype.name, totals),
    totals,
    byTransition: [...byTransition.values()].sort(
      (a, b) => b.pairs - a.pairs || (a.transition < b.transition ? -1 : 1),
    ),
  };
}

/** Every archetype, in corpus order. The number later tasks are measured on. */
export function runEval(seed: number): RecallReport[] {
  return runEvalDetailed(seed).reports;
}

/** As `runEval`, plus the raw counters the printed totals row needs. */
export function runEvalDetailed(seed: number, opts: ReplayOptions = {}): EvalRun {
  const byArchetype: ArchetypeResult[] = [];
  const overall: ReplayTotals = {
    pairs: 0,
    hitsAt1: 0,
    hitsAt3: 0,
    hitsAt5: 0,
    issued: 0,
    wasted: 0,
  };
  for (const archetype of ARCHETYPES) {
    const result = replayArchetype(archetype, seed, opts);
    byArchetype.push(result);
    overall.pairs += result.totals.pairs;
    overall.hitsAt1 += result.totals.hitsAt1;
    overall.hitsAt3 += result.totals.hitsAt3;
    overall.hitsAt5 += result.totals.hitsAt5;
    overall.issued += result.totals.issued;
    overall.wasted += result.totals.wasted;
  }
  return { seed, reports: byArchetype.map((r) => r.report), byArchetype, overall };
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
