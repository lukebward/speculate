/**
 * Metrics and decision log (DESIGN.md §9).
 *
 * Every speculative decision is recorded as a DecisionEvent; with
 * log === 'stderr' each event is also emitted as one JSON line on stderr —
 * never stdout, which carries the MCP stdio protocol. Counters roll up into
 * the StatsReport served by `/stats` and the session summary, including the
 * honest metric: estimated ms saved vs. wasted calls per hit.
 */
import process from 'node:process';
import type {
  AgeAtHitReport,
  DecisionEvent,
  RuleStats,
  SpeculationMode,
  StatsReport,
} from './types.js';
import type { UsageBreakdown, UsageCounters } from './usage.js';

/**
 * Age-at-hit histogram resolution and reach (§9). 100 ms bins out to 60 s is
 * 601 counters — nothing, and fine enough to read a median around one second
 * against the 30 s default TTL. Anything older lands in the overflow bin;
 * `maxMs` is tracked exactly, so a long tail is never rounded out of sight.
 */
const AGE_BIN_MS = 100;
const AGE_BINS = 600;

/** Reported age bands, as [label, exclusive upper bound in ms]. */
const AGE_BANDS: ReadonlyArray<readonly [string, number]> = [
  ['<1s', 1_000],
  ['1-5s', 5_000],
  ['5-15s', 15_000],
  ['15-30s', 30_000],
  ['30-60s', 60_000],
  ['60s+', Number.POSITIVE_INFINITY],
];

interface PerServerCounters {
  speculativeCalls: number;
  hits: number;
  joins: number;
  misses: number;
  wasted: number;
  specErrors: number;
  estimatedSavedMs: number;
  estimatedAddedWaitMs: number;
  predictionOpportunities: number;
  predictionOffered: number;
  predictionHitsAt1: number;
  predictionHitsAt3: number;
  nearMisses: number;
  nearMissDistanceOne: number;
}

function emptyDimension(): PerServerCounters {
  return {
    speculativeCalls: 0,
    hits: 0,
    joins: 0,
    misses: 0,
    wasted: 0,
    specErrors: 0,
    estimatedSavedMs: 0,
    estimatedAddedWaitMs: 0,
    predictionOpportunities: 0,
    predictionOffered: 0,
    predictionHitsAt1: 0,
    predictionHitsAt3: 0,
    nearMisses: 0,
    nearMissDistanceOne: 0,
  };
}

function usageFromDimension(c: PerServerCounters): UsageCounters {
  return {
    hits: c.hits,
    joins: c.joins,
    misses: c.misses,
    speculativeCalls: c.speculativeCalls,
    wasted: c.wasted,
    estimatedSavedMs: c.estimatedSavedMs,
    estimatedAddedWaitMs: c.estimatedAddedWaitMs,
    predictionOpportunities: c.predictionOpportunities,
    predictionOffered: c.predictionOffered,
    predictionHitsAt1: c.predictionHitsAt1,
    predictionHitsAt3: c.predictionHitsAt3,
    nearMisses: c.nearMisses,
    nearMissDistanceOne: c.nearMissDistanceOne,
  };
}

interface PerRuleCounters {
  predicted: number;
  speculated: number;
  hits: number;
  wasted: number;
  suppressedByFeedback: number;
}

/** Same topical horizon as learned transition evidence (about a 9.7-day half-life). */
const FEEDBACK_TAU_MS = 14 * 24 * 60 * 60_000;
const MAX_PRIOR_FEEDBACK = 500;

interface PriorRuleFeedback {
  hits: number;
  wasted: number;
  speculated: number;
  lastUpdated: number;
}

function feedbackDecayFactor(from: number, to: number): number {
  const elapsed = Math.max(0, to - from);
  return Math.exp(-elapsed / FEEDBACK_TAU_MS);
}

export class Metrics {
  private readonly mode: SpeculationMode;
  private readonly log: 'stderr' | 'off';
  private readonly now: () => number;
  private readonly onUsage:
    | ((counters: UsageCounters, breakdown: UsageBreakdown) => void)
    | undefined;
  private readonly startedAt: number;

  private realCalls = 0;
  private speculativeCalls = 0;
  private hits = 0;
  private joins = 0;
  private misses = 0;
  private expired = 0;
  private invalidated = 0;
  private abandoned = 0;
  private wasted = 0;
  private parserMisses = 0;
  private stdioDelays = 0;
  private estimatedSavedMs = 0;
  private estimatedAddedWaitMs = 0;
  private predictionOpportunities = 0;
  private predictionOffered = 0;
  private predictionHitsAt1 = 0;
  private predictionHitsAt3 = 0;
  private candidateEvaluations = 0;
  private candidateCorrect = 0;
  private candidateBrierSum = 0;
  private staticCandidateBrierSum = 0;
  private correctButSuppressed = 0;
  private admittedButWrong = 0;
  private readonly calibrationBuckets = Array.from({ length: 5 }, () => ({
    count: 0,
    correct: 0,
    probabilitySum: 0,
  }));
  private nearMisses = 0;
  private nearMissDistanceOne = 0;
  private readonly suppressedByReason = new Map<string, number>();

  /**
   * Freshness of what was actually served (§6.2/§9). Better prediction
   * fetches earlier and further ahead, so entries are consumed OLDER; these
   * are the only counters that would show it. Aggregate only: bin counts and
   * durations, never a key, an argument, or a result.
   */
  private readonly ageBins = new Array<number>(AGE_BINS + 1).fill(0);
  private ageCount = 0;
  private ageMaxMs = 0;
  private readonly ttlQuarters: [number, number, number, number] = [0, 0, 0, 0];

  private readonly perServer = new Map<string, PerServerCounters>();
  private readonly perTool = new Map<string, PerServerCounters>();
  private readonly perRule = new Map<string, PerRuleCounters>();
  /**
   * Prior-session feedback (§13.6): folded into ruleFeedback() so the
   * suppression loop remembers across restarts, but kept out of
   * statsSnapshot(), which reports this session only.
   */
  private readonly priorFeedback = new Map<string, PriorRuleFeedback>();
  /** Bumped whenever a counter feeding ruleFeedback() changes (§13.6 dirty gate). */
  private feedbackMutations = 0;

  get feedbackRevision(): number {
    return this.feedbackMutations;
  }

  constructor(opts: {
    mode: SpeculationMode;
    log: 'stderr' | 'off';
    now?: () => number;
    onUsage?: (counters: UsageCounters, breakdown: UsageBreakdown) => void;
  }) {
    this.mode = opts.mode;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.onUsage = opts.onUsage;
    this.startedAt = this.now();
  }

  /**
   * Load prior-session feedback. Current snapshots decay by elapsed time,
   * rather than by restart count: opening ten short sessions in one day must
   * not forget evidence faster than leaving one session open. Legacy entries
   * have no timestamp, so they retain the old one-time halving behaviour and
   * are stamped on the next export. Malformed entries are skipped.
   */
  importRuleFeedback(priors: unknown): void {
    if (priors === null || typeof priors !== 'object') return;
    const now = this.now();
    for (const [ruleId, raw] of Object.entries(priors as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as {
        hits?: unknown;
        wasted?: unknown;
        speculated?: unknown;
        lastUpdated?: unknown;
      };
      const clean = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0
          ? Math.min(v, MAX_PRIOR_FEEDBACK)
          : 0;
      const stamp =
        typeof r.lastUpdated === 'number' && Number.isFinite(r.lastUpdated)
          ? Math.min(r.lastUpdated, now)
          : null;
      const factor = stamp === null ? 0.5 : feedbackDecayFactor(stamp, now);
      const entry = {
        hits: clean(r.hits) * factor,
        wasted: clean(r.wasted) * factor,
        speculated: clean(r.speculated) * factor,
        lastUpdated: now,
      };
      if (entry.hits + entry.wasted + entry.speculated > 0) {
        this.priorFeedback.set(ruleId, entry);
      }
    }
  }

  /** Combined (prior + session) feedback for persistence. */
  exportRuleFeedback(): Record<
    string,
    { hits: number; wasted: number; speculated: number; lastUpdated: number }
  > {
    const out: Record<
      string,
      { hits: number; wasted: number; speculated: number; lastUpdated: number }
    > = {};
    const now = this.now();
    const ids = new Set([...this.priorFeedback.keys(), ...this.perRule.keys()]);
    for (const id of ids) {
      const fb = this.ruleFeedback(id);
      if (fb.hits + fb.wasted + fb.speculated > 0) out[id] = { ...fb, lastUpdated: now };
    }
    return out;
  }

  record(ev: DecisionEvent): void {
    const event: DecisionEvent =
      ev.timestamp === undefined ? { ...ev, timestamp: this.now() } : ev;
    let usageChanged = false;

    if (this.log === 'stderr') {
      process.stderr.write(`${JSON.stringify({ speculate: event })}\n`);
    }

    switch (event.type) {
      case 'real_call':
        this.realCalls++;
        break;
      case 'speculated':
        this.speculativeCalls++;
        usageChanged = true;
        this.server(event.server).speculativeCalls++;
        this.tool(event.server, event.tool).speculativeCalls++;
        if (event.ruleId !== undefined) {
          this.rule(event.ruleId).speculated++;
          this.feedbackMutations++;
        }
        break;
      case 'hit':
        this.hits++;
        usageChanged = true;
        this.recordUse(event);
        this.recordAge(event);
        break;
      case 'joined':
        this.joins++;
        usageChanged = true;
        this.recordUse(event);
        break;
      case 'miss':
        this.misses++;
        usageChanged = true;
        this.server(event.server).misses++;
        this.tool(event.server, event.tool).misses++;
        if (event.nearMissDistance !== undefined) {
          this.nearMisses++;
          this.server(event.server).nearMisses++;
          this.tool(event.server, event.tool).nearMisses++;
          if (event.nearMissDistance === 1) {
            this.nearMissDistanceOne++;
            this.server(event.server).nearMissDistanceOne++;
            this.tool(event.server, event.tool).nearMissDistanceOne++;
          }
        }
        break;
      case 'expired':
        this.expired++;
        usageChanged = true;
        this.recordWaste(event);
        break;
      case 'invalidated':
        this.invalidated++;
        usageChanged = true;
        this.recordWaste(event);
        break;
      case 'abandoned':
        this.abandoned++;
        usageChanged = true;
        this.recordWaste(event);
        break;
      case 'spec_error':
        usageChanged = true;
        this.server(event.server).specErrors++;
        this.tool(event.server, event.tool).specErrors++;
        this.recordWaste(event);
        break;
      case 'parser_miss':
        this.parserMisses++;
        break;
      case 'stdio_delay':
        this.stdioDelays++;
        this.estimatedAddedWaitMs += Math.max(0, event.latencyMs ?? 0);
        this.server(event.server).estimatedAddedWaitMs += Math.max(0, event.latencyMs ?? 0);
        this.tool(event.server, event.tool).estimatedAddedWaitMs += Math.max(
          0,
          event.latencyMs ?? 0,
        );
        usageChanged = true;
        break;
      case 'predicted':
        if (event.ruleId !== undefined) this.rule(event.ruleId).predicted++;
        break;
      case 'prediction_evaluated': {
        this.predictionOpportunities++;
        const offered = Math.max(0, Math.floor(event.candidateCount ?? 0));
        if (offered > 0) this.predictionOffered++;
        if (event.rank === 1) this.predictionHitsAt1++;
        if (event.rank !== undefined && event.rank <= 3) this.predictionHitsAt3++;
        for (const counters of [this.server(event.server), this.tool(event.server, event.tool)]) {
          counters.predictionOpportunities++;
          if (offered > 0) counters.predictionOffered++;
          if (event.rank === 1) counters.predictionHitsAt1++;
          if (event.rank !== undefined && event.rank <= 3) counters.predictionHitsAt3++;
        }
        usageChanged = true;
        break;
      }
      case 'candidate_evaluated': {
        if (typeof event.correct !== 'boolean') break;
        if (typeof event.probability !== 'number' || !Number.isFinite(event.probability)) break;
        const probability = Math.max(0, Math.min(1, event.probability));
        const baseConfidence =
          typeof event.baseConfidence === 'number' && Number.isFinite(event.baseConfidence)
            ? Math.max(0, Math.min(1, event.baseConfidence))
            : probability;
        const outcome = event.correct ? 1 : 0;
        this.candidateEvaluations++;
        this.candidateCorrect += outcome;
        this.candidateBrierSum += (probability - outcome) ** 2;
        this.staticCandidateBrierSum += (baseConfidence - outcome) ** 2;
        if (event.correct && event.admitted === false) this.correctButSuppressed++;
        if (!event.correct && event.admitted === true) this.admittedButWrong++;
        const bucket = this.calibrationBuckets[Math.min(4, Math.floor(probability * 5))]!;
        bucket.count++;
        bucket.correct += outcome;
        bucket.probabilitySum += probability;
        break;
      }
      case 'suppressed': {
        if (event.reason === 'feedback' && event.ruleId !== undefined) {
          this.rule(event.ruleId).suppressedByFeedback++;
        }
        const reason = event.reason ?? 'unknown';
        this.suppressedByReason.set(reason, (this.suppressedByReason.get(reason) ?? 0) + 1);
        break;
      }
      default:
        // Waste is derived from its terminal causes (expired / invalidated /
        // spec_error); remaining event types carry no counters.
        break;
    }
    if (usageChanged) {
      this.onUsage?.(this.usageCounters(), this.usageBreakdown());
    }
  }

  /**
   * Per-rule feedback for the predictor's suppression loop (§5.6):
   * this session's counters plus decayed prior-session counters.
   */
  ruleFeedback(ruleId: string): {
    hits: number;
    wasted: number;
    speculated: number;
  } {
    const r = this.perRule.get(ruleId);
    const p = this.priorFeedback.get(ruleId);
    const factor = p ? feedbackDecayFactor(p.lastUpdated, this.now()) : 0;
    return {
      hits: (r?.hits ?? 0) + (p?.hits ?? 0) * factor,
      wasted: (r?.wasted ?? 0) + (p?.wasted ?? 0) * factor,
      speculated: (r?.speculated ?? 0) + (p?.speculated ?? 0) * factor,
    };
  }

  statsSnapshot(): StatsReport {
    const used = this.hits + this.joins;
    const perServer: StatsReport['perServer'] = {};
    for (const [server, c] of this.perServer) {
      perServer[server] = { ...c };
    }
    const perTool: StatsReport['perTool'] = {};
    for (const [key, c] of this.perTool) {
      const split = key.indexOf('\x00');
      const server = key.slice(0, split);
      const tool = key.slice(split + 1);
      (perTool[server] ??= {})[tool] = { ...c };
    }
    const perRule: RuleStats[] = [...this.perRule.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ruleId, c]) => ({ ruleId, ...c }));
    return {
      mode: this.mode,
      uptimeMs: this.now() - this.startedAt,
      realCalls: this.realCalls,
      speculativeCalls: this.speculativeCalls,
      hits: this.hits,
      joins: this.joins,
      misses: this.misses,
      expired: this.expired,
      invalidated: this.invalidated,
      abandoned: this.abandoned,
      wasted: this.wasted,
      parserMisses: this.parserMisses,
      stdioDelays: this.stdioDelays,
      suppressed: Object.fromEntries(
        [...this.suppressedByReason.entries()].sort((a, b) => b[1] - a[1]),
      ),
      estimatedSavedMs: this.estimatedSavedMs,
      estimatedAddedWaitMs: this.estimatedAddedWaitMs,
      netEstimatedSavedMs: this.estimatedSavedMs - this.estimatedAddedWaitMs,
      nearMisses: { sameTool: this.nearMisses, distanceOne: this.nearMissDistanceOne },
      wastePerHit: used === 0 ? null : this.wasted / used,
      predictionQuality: this.predictionQuality(),
      calibration: this.calibrationReport(),
      ageAtHit: this.ageAtHit(),
      perServer,
      perTool,
      perRule,
    };
  }

  private predictionQuality(): import('./types.js').PredictionQualityReport {
    const opportunities = this.predictionOpportunities;
    return {
      opportunities,
      offered: this.predictionOffered,
      hitsAt1: this.predictionHitsAt1,
      hitsAt3: this.predictionHitsAt3,
      recallAt1: opportunities === 0 ? null : this.predictionHitsAt1 / opportunities,
      recallAt3: opportunities === 0 ? null : this.predictionHitsAt3 / opportunities,
      precisionAt3:
        this.predictionOffered === 0 ? null : this.predictionHitsAt3 / this.predictionOffered,
    };
  }

  private calibrationReport(): import('./types.js').CalibrationReport {
    return {
      evaluations: this.candidateEvaluations,
      correct: this.candidateCorrect,
      brierScore:
        this.candidateEvaluations === 0 ? null : this.candidateBrierSum / this.candidateEvaluations,
      staticBrierScore:
        this.candidateEvaluations === 0
          ? null
          : this.staticCandidateBrierSum / this.candidateEvaluations,
      correctButSuppressed: this.correctButSuppressed,
      admittedButWrong: this.admittedButWrong,
      buckets: this.calibrationBuckets.map((bucket, index) => ({
        lower: index / 5,
        upper: (index + 1) / 5,
        count: bucket.count,
        correct: bucket.correct,
        meanProbability: bucket.count === 0 ? null : bucket.probabilitySum / bucket.count,
      })),
    };
  }

  /**
   * Age-at-hit distribution (§9). A 'joined' call never sat in the buffer, so
   * it contributes nothing here: folding it in as age 0 would drag the whole
   * distribution towards "everything is fresh", which is exactly the
   * comforting lie this metric exists to prevent.
   */
  private recordAge(event: DecisionEvent): void {
    // INVARIANT: count === sum(ttlQuarters). The two numbers describe the
    // same sample from two angles, so they are admitted together or not at
    // all — the cache produces both in one branch, and letting a half-formed
    // event into one and not the other would make `lastTtlQuarter` a share of
    // a different population than `count`, which is unreadable without
    // saying so. Pinned by test.
    const { ageMs, ttlFraction } = event;
    if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return;
    if (typeof ttlFraction !== 'number' || !Number.isFinite(ttlFraction)) return;

    const bin = Math.min(AGE_BINS, Math.floor(ageMs / AGE_BIN_MS));
    this.ageBins[bin]!++;
    this.ageCount++;
    if (ageMs > this.ageMaxMs) this.ageMaxMs = ageMs;
    const quarter = Math.min(3, Math.max(0, Math.floor(ttlFraction * 4)));
    this.ttlQuarters[quarter]!++;
  }

  private ageAtHit(): AgeAtHitReport {
    const buckets: Record<string, number> = {};
    for (const [label] of AGE_BANDS) buckets[label] = 0;
    for (let bin = 0; bin <= AGE_BINS; bin++) {
      const count = this.ageBins[bin]!;
      if (count === 0) continue;
      // The overflow bin is >= AGE_BINS * AGE_BIN_MS, i.e. always the top band.
      const lower = bin * AGE_BIN_MS;
      const band = AGE_BANDS.find(([, upper]) => lower < upper) ?? AGE_BANDS.at(-1)!;
      buckets[band[0]]! += count;
    }
    return {
      count: this.ageCount,
      p50Ms: this.agePercentile(0.5),
      p95Ms: this.agePercentile(0.95),
      maxMs: this.ageCount === 0 ? null : this.ageMaxMs,
      lastTtlQuarter: this.ageCount === 0 ? null : this.ttlQuarters[3] / this.ageCount,
      buckets,
      ttlQuarters: [...this.ttlQuarters],
    };
  }

  /**
   * Nearest-rank percentile over the histogram, reported as the bin midpoint
   * (so ±AGE_BIN_MS/2); the overflow bin reports its lower edge, and `maxMs`
   * carries the exact tail.
   *
   * The midpoint is clamped to the exact maximum, because a rounded-up
   * percentile beside an exact maximum can otherwise report a median LARGER
   * than the largest sample: two hits at 0 ms and 30 ms against a 100 ms bin
   * read p50 = 50 ms, max = 30 ms. That is reachable against a fast local
   * server, where every age lands in the first bin, and it makes the report
   * look broken at exactly the moment it has the best news.
   */
  private agePercentile(p: number): number | null {
    if (this.ageCount === 0) return null;
    const rank = Math.max(1, Math.ceil(p * this.ageCount));
    let seen = 0;
    for (let bin = 0; bin <= AGE_BINS; bin++) {
      seen += this.ageBins[bin]!;
      if (seen >= rank) {
        const estimate =
          bin === AGE_BINS ? AGE_BINS * AGE_BIN_MS : bin * AGE_BIN_MS + AGE_BIN_MS / 2;
        return Math.min(estimate, this.ageMaxMs);
      }
    }
    return this.ageMaxMs;
  }

  /** Shared bookkeeping for 'hit' and 'joined'. */
  private recordUse(event: DecisionEvent): void {
    const saved = event.savedMs ?? 0;
    this.estimatedSavedMs += saved;
    for (const counters of [this.server(event.server), this.tool(event.server, event.tool)]) {
      if (event.type === 'joined') counters.joins++;
      else counters.hits++;
      counters.estimatedSavedMs += saved;
    }
    if (event.ruleId !== undefined) {
      this.rule(event.ruleId).hits++;
      this.feedbackMutations++;
    }
  }

  /** Shared bookkeeping for 'expired' / 'invalidated' / 'spec_error'. */
  private recordWaste(event: DecisionEvent): void {
    this.wasted++;
    this.server(event.server).wasted++;
    this.tool(event.server, event.tool).wasted++;
    if (event.ruleId !== undefined) {
      this.rule(event.ruleId).wasted++;
      this.feedbackMutations++;
    }
  }

  private server(name: string): PerServerCounters {
    let c = this.perServer.get(name);
    if (c === undefined) {
      c = emptyDimension();
      this.perServer.set(name, c);
    }
    return c;
  }

  private tool(server: string, tool: string): PerServerCounters {
    const key = `${server}\x00${tool}`;
    let c = this.perTool.get(key);
    if (c === undefined) {
      c = emptyDimension();
      this.perTool.set(key, c);
    }
    return c;
  }

  private usageCounters(): UsageCounters {
    return {
      hits: this.hits,
      joins: this.joins,
      misses: this.misses,
      speculativeCalls: this.speculativeCalls,
      wasted: this.wasted,
      estimatedSavedMs: this.estimatedSavedMs,
      estimatedAddedWaitMs: this.estimatedAddedWaitMs,
      predictionOpportunities: this.predictionOpportunities,
      predictionOffered: this.predictionOffered,
      predictionHitsAt1: this.predictionHitsAt1,
      predictionHitsAt3: this.predictionHitsAt3,
      nearMisses: this.nearMisses,
      nearMissDistanceOne: this.nearMissDistanceOne,
    };
  }

  private usageBreakdown(): UsageBreakdown {
    const servers: Record<string, UsageCounters> = {};
    for (const [name, counters] of this.perServer) servers[name] = usageFromDimension(counters);
    const tools: Record<string, Record<string, UsageCounters>> = {};
    for (const [key, counters] of this.perTool) {
      const split = key.indexOf('\x00');
      const server = key.slice(0, split);
      const tool = key.slice(split + 1);
      (tools[server] ??= {})[tool] = usageFromDimension(counters);
    }
    return { servers, tools };
  }

  private rule(ruleId: string): PerRuleCounters {
    let c = this.perRule.get(ruleId);
    if (c === undefined) {
      c = {
        predicted: 0,
        speculated: 0,
        hits: 0,
        wasted: 0,
        suppressedByFeedback: 0,
      };
      this.perRule.set(ruleId, c);
    }
    return c;
  }
}
