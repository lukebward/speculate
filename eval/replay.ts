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
 *
 * AGE AT CONSUMPTION (§6.2 freshness). Recall is age-blind: it asks whether
 * the right call was predicted, never how old the answer was when it was
 * served. But better prediction fires more, earlier, and further ahead, which
 * can only raise the age of an entry at the moment it is consumed — so a run
 * of "improvements" could be quietly serving staler answers with no number
 * moving. The replay therefore also simulates the production speculation
 * buffer alongside the rank scoring: predictions enter it when their trigger
 * completes, and a later real call consumes at most one of them, single-use
 * and TTL-bounded, exactly as src/cache.ts does. The buffer is an OBSERVER —
 * nothing it does feeds back into what the learner predicts or how a pair is
 * ranked, so instrumenting it cannot move recall.
 *
 * What it does NOT model: session openers (§13.15 fires those at proxy start,
 * and the corpus has no proxy-start-to-first-call gap to fire them into), and
 * mutation invalidation (the corpus is all reads). Both would only ever
 * shorten the lives measured here.
 */
import { DEFAULT_TTL_MS, LONG_HORIZON_TTL_FACTOR } from '../src/cache.js';
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
export const CALL_SPACING_MS = 1_500;
/**
 * Upstream latency assumed for every call, real or speculative. A
 * speculative call issued at T is therefore READY at T + this, which is the
 * instant its TTL starts counting from (src/cache.ts settles the same way).
 */
const CALL_LATENCY_MS = 40;
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

/**
 * Age-at-consumption counters for one class of prediction. Ages are kept raw
 * rather than binned so the percentiles are exact — the population is one
 * number per simulated hit, a few thousand at most across the whole corpus.
 */
export interface AgeTotals {
  /** Entries a later real call actually consumed. */
  hits: number;
  /** Age in ms at the moment of consumption, one per hit. */
  ages: number[];
  /** Hits consumed in the LAST QUARTER of their own TTL. */
  lastQuarter: number;
  /** leadCounts[n] = hits claimed n calls after the prediction fired (n >= 1). */
  leadCounts: number[];
  /** Entries that expired (or were dropped at a session boundary) unclaimed. */
  unconsumed: number;
}

/**
 * The buffer split by the classes that get DIFFERENT TTLs in production
 * (§6.2): `next` is derived from the trigger, `standing` carries a memorized
 * argument and so bets on "at some point" rather than "next". Pooling them
 * would hide exactly the difference the shortened TTL is aimed at.
 */
export interface AgeBreakdown {
  all: AgeTotals;
  next: AgeTotals;
  standing: AgeTotals;
}

/** Readable view of AgeTotals: the distribution, not the raw sample. */
export interface AgeReport {
  hits: number;
  /** Exact percentiles over the raw ages; null when nothing was consumed. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** Share of hits consumed in the last quarter of their TTL. */
  lastQuarterShare: number | null;
  /** Mean number of calls between a prediction firing and being claimed. */
  meanLead: number | null;
  unconsumed: number;
}

export interface ArchetypeResult {
  report: RecallReport;
  totals: ReplayTotals;
  /** Freshness of what the simulated buffer served (§6.2). */
  age: AgeBreakdown;
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
  /** Age at consumption, pooled over every archetype (§6.2 freshness). */
  age: AgeBreakdown;
  /** The TTL the buffer simulation ran with, so the ages are interpretable. */
  ttlMs: number;
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
  /**
   * TTL the simulated buffer holds entries for. Default DEFAULT_TTL_MS — the
   * production fallback, and an unmeasured guess (see src/cache.ts).
   */
  ttlMs?: number;
  /** TTL multiplier for standing bets. Default LONG_HORIZON_TTL_FACTOR. */
  standingTtlFactor?: number;
  /**
   * Spacing between calls inside a session. Default CALL_SPACING_MS.
   * Raising it delays consumption without changing what is predicted, which
   * is how the suite proves the age numbers measure elapsed time.
   */
  callSpacingMs?: number;
}

/** One live entry in the simulated speculation buffer. */
interface SimEntry {
  /** When the speculative result landed; the TTL counts from here. */
  readyAt: number;
  expiresAt: number;
  /** Index of the call whose completion triggered this prediction. */
  issuedAfterCall: number;
  standing: boolean;
}

/**
 * The production speculation buffer, as much of it as the corpus can speak
 * to: single-use entries, TTL from completion, first-put-wins on a key.
 *
 * Deliberately an OBSERVER. It reads the predictions the learner already
 * made and the calls that already happened; it never changes either, so the
 * recall numbers are bit-identical with or without it.
 */
class SimBuffer {
  private readonly entries = new Map<string, SimEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly standingFactor: number,
    private readonly age: AgeBreakdown,
  ) {}

  /** Admit the batch a completed call triggered, at the shipped cap. */
  issue(
    predictions: readonly { server: string; tool: string; args: Record<string, unknown>; horizon?: string }[],
    callIndex: number,
    completedAt: number,
  ): void {
    for (const p of predictions.slice(0, PRODUCTION_K)) {
      const standing = p.horizon === 'standing';
      const ttl = standing ? Math.max(1, Math.round(this.ttlMs * this.standingFactor)) : this.ttlMs;
      const readyAt = completedAt + CALL_LATENCY_MS;
      let key: string;
      try {
        key = canonicalKey(p.server, p.tool, p.args);
      } catch {
        continue; // unkeyable args never reach the cache in production either
      }
      const existing = this.entries.get(key);
      // First put wins while the incumbent is alive — and the incumbent is
      // the OLDER entry, so dedupe is itself one of the mechanisms that
      // raises the age at which something is finally consumed.
      if (existing && completedAt < existing.expiresAt) continue;
      if (existing) this.drop(existing);
      this.entries.set(key, {
        readyAt,
        expiresAt: readyAt + ttl,
        issuedAfterCall: callIndex,
        standing,
      });
    }
  }

  /** A real call: consume a live entry for its key, if there is one. */
  consume(key: string, callIndex: number, at: number): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    if (at >= entry.expiresAt) {
      this.drop(entry);
      return;
    }
    const ageMs = Math.max(0, at - entry.readyAt);
    const ttl = entry.expiresAt - entry.readyAt;
    const lead = callIndex - entry.issuedAfterCall;
    for (const totals of [this.age.all, entry.standing ? this.age.standing : this.age.next]) {
      totals.hits++;
      totals.ages.push(ageMs);
      if (ttl > 0 && ageMs / ttl >= 0.75) totals.lastQuarter++;
      totals.leadCounts[lead] = (totals.leadCounts[lead] ?? 0) + 1;
    }
  }

  /**
   * End of session. The next session is SESSION_SPACING_MS away — far past
   * any TTL — so everything still held is dead, and counted as such.
   */
  endSession(): void {
    for (const entry of this.entries.values()) this.drop(entry);
    this.entries.clear();
  }

  private drop(entry: SimEntry): void {
    this.age.all.unconsumed++;
    (entry.standing ? this.age.standing : this.age.next).unconsumed++;
  }
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
  const spacingMs = opts.callSpacingMs ?? CALL_SPACING_MS;
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
  const age = emptyAgeBreakdown();
  const buffer = new SimBuffer(
    opts.ttlMs ?? DEFAULT_TTL_MS,
    opts.standingTtlFactor ?? LONG_HORIZON_TTL_FACTOR,
    age,
  );

  for (let s = 0; s < sessions.length; s++) {
    const session = sessions[s]!;
    const scored = s >= warmup;
    // The declared idle gap lands once, before its session, and every later
    // session carries it forward — the clock does not rewind.
    const base =
      s * SESSION_SPACING_MS + (idleGap && s >= idleGap.beforeSession ? idleGapMs : 0);
    let prev: ObservedCall | null = null;

    for (let i = 0; i < session.calls.length; i++) {
      const call = toObserved(session, i, base + i * spacingMs);
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

          // Freshness, in the same order production runs it: the batch the
          // previous call triggered lands in the buffer, and only then does
          // this call look for something to claim.
          buffer.issue(predictions, i - 1, prev.timestamp);
        }
      }
      if (scored) {
        buffer.consume(canonicalKey(call.server, call.tool, call.args), i, call.timestamp);
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
    if (scored && prev) {
      const trailing = learner.predict(prev);
      bill(totals, trailing.length, false);
      buffer.issue(trailing, session.calls.length - 1, prev.timestamp);
    }
    buffer.endSession();
  }

  return {
    report: toReport(archetype.name, totals),
    totals,
    age,
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
  const age = emptyAgeBreakdown();
  const merged = new Map<string, TransitionStat>();
  let shape = { sessions: 0, warmupSessions: 0 };
  for (const seed of seeds) {
    const result = replayArchetype(archetype, seed, opts);
    shape = { sessions: result.sessions, warmupSessions: result.warmupSessions };
    addTotals(totals, result.totals);
    addAge(age, result.age);
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
    age,
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
  const age = emptyAgeBreakdown();
  for (const archetype of ARCHETYPES) {
    const result = replayArchetypeSeeds(archetype, list, opts);
    byArchetype.push(result);
    addTotals(overall, result.totals);
    addTotals(FLOOR_ARCHETYPES.has(archetype.name) ? floor : workflow, result.totals);
    // Freshness pools over EVERYTHING: staleness is a property of the buffer,
    // not of how predictable an archetype is, and the floor's entries are
    // just as capable of being served late as any other.
    addAge(age, result.age);
  }
  return {
    seeds: list,
    reports: byArchetype.map((r) => r.report),
    byArchetype,
    workflow,
    floor,
    overall,
    age,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
  };
}

function emptyAge(): AgeTotals {
  return { hits: 0, ages: [], lastQuarter: 0, leadCounts: [], unconsumed: 0 };
}

function emptyAgeBreakdown(): AgeBreakdown {
  return { all: emptyAge(), next: emptyAge(), standing: emptyAge() };
}

function addAge(into: AgeBreakdown, from: AgeBreakdown): void {
  for (const k of ['all', 'next', 'standing'] as const) {
    const a = into[k];
    const b = from[k];
    a.hits += b.hits;
    a.ages.push(...b.ages);
    a.lastQuarter += b.lastQuarter;
    a.unconsumed += b.unconsumed;
    for (let i = 0; i < b.leadCounts.length; i++) {
      a.leadCounts[i] = (a.leadCounts[i] ?? 0) + (b.leadCounts[i] ?? 0);
    }
  }
}

/**
 * Distribution view of the raw ages. Median and p95 are exact (nearest-rank
 * over the sorted sample), because the whole point is to see the TAIL: a
 * mean would hide a small population of near-expiry serves, which is exactly
 * the failure this instrument exists to catch.
 */
export function toAgeReport(t: AgeTotals): AgeReport {
  if (t.hits === 0) {
    return {
      hits: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      lastQuarterShare: null,
      meanLead: null,
      unconsumed: t.unconsumed,
    };
  }
  const sorted = [...t.ages].sort((a, b) => a - b);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  let leadSum = 0;
  for (let i = 0; i < t.leadCounts.length; i++) leadSum += i * (t.leadCounts[i] ?? 0);
  return {
    hits: t.hits,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1]!,
    lastQuarterShare: t.lastQuarter / t.hits,
    meanLead: leadSum / t.hits,
    unconsumed: t.unconsumed,
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
    latencyMs: CALL_LATENCY_MS,
  };
}
