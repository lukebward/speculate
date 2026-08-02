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
import type { UsageCounters } from './usage.js';

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
  wasted: number;
  specErrors: number;
}

interface PerRuleCounters {
  predicted: number;
  speculated: number;
  hits: number;
  wasted: number;
  suppressedByFeedback: number;
}

export class Metrics {
  private readonly mode: SpeculationMode;
  private readonly log: 'stderr' | 'off';
  private readonly now: () => number;
  private readonly onUsage: ((counters: UsageCounters) => void) | undefined;
  private readonly startedAt: number;

  private realCalls = 0;
  private speculativeCalls = 0;
  private hits = 0;
  private joins = 0;
  private misses = 0;
  private expired = 0;
  private invalidated = 0;
  private wasted = 0;
  private parserMisses = 0;
  private stdioDelays = 0;
  private estimatedSavedMs = 0;
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
  private readonly perRule = new Map<string, PerRuleCounters>();
  /**
   * Prior-session feedback (§13.6): folded into ruleFeedback() so the
   * suppression loop remembers across restarts, but kept out of
   * statsSnapshot(), which reports this session only.
   */
  private readonly priorFeedback = new Map<
    string,
    { hits: number; wasted: number; speculated: number }
  >();
  /** Bumped whenever a counter feeding ruleFeedback() changes (§13.6 dirty gate). */
  private feedbackMutations = 0;

  get feedbackRevision(): number {
    return this.feedbackMutations;
  }

  constructor(opts: {
    mode: SpeculationMode;
    log: 'stderr' | 'off';
    now?: () => number;
    onUsage?: (counters: UsageCounters) => void;
  }) {
    this.mode = opts.mode;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.onUsage = opts.onUsage;
    this.startedAt = this.now();
  }

  /**
   * Load prior-session feedback. Counts are HALVED on import (floor) and
   * capped: decay lets evidence age out across restarts, so a rule
   * suppressed by ancient waste eventually earns a retrial instead of
   * being muted forever (suppressed rules never speculate, so they could
   * otherwise never redeem themselves). Malformed entries are skipped.
   */
  importRuleFeedback(priors: unknown): void {
    if (priors === null || typeof priors !== 'object') return;
    const CAP = 500;
    for (const [ruleId, raw] of Object.entries(priors as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as { hits?: unknown; wasted?: unknown; speculated?: unknown };
      const clean = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0
          ? Math.min(Math.floor(v / 2), CAP)
          : 0;
      const entry = {
        hits: clean(r.hits),
        wasted: clean(r.wasted),
        speculated: clean(r.speculated),
      };
      if (entry.hits + entry.wasted + entry.speculated > 0) {
        this.priorFeedback.set(ruleId, entry);
      }
    }
  }

  /** Combined (prior + session) feedback for persistence. */
  exportRuleFeedback(): Record<string, { hits: number; wasted: number; speculated: number }> {
    const out: Record<string, { hits: number; wasted: number; speculated: number }> = {};
    const ids = new Set([...this.priorFeedback.keys(), ...this.perRule.keys()]);
    for (const id of ids) {
      const fb = this.ruleFeedback(id);
      if (fb.hits + fb.wasted + fb.speculated > 0) out[id] = fb;
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
      case 'spec_error':
        usageChanged = true;
        this.server(event.server).specErrors++;
        this.recordWaste(event);
        break;
      case 'parser_miss':
        this.parserMisses++;
        break;
      case 'stdio_delay':
        this.stdioDelays++;
        break;
      case 'predicted':
        if (event.ruleId !== undefined) this.rule(event.ruleId).predicted++;
        break;
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
      this.onUsage?.({
        hits: this.hits,
        joins: this.joins,
        misses: this.misses,
        speculativeCalls: this.speculativeCalls,
        wasted: this.wasted,
        estimatedSavedMs: this.estimatedSavedMs,
      });
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
    return {
      hits: (r?.hits ?? 0) + (p?.hits ?? 0),
      wasted: (r?.wasted ?? 0) + (p?.wasted ?? 0),
      speculated: (r?.speculated ?? 0) + (p?.speculated ?? 0),
    };
  }

  statsSnapshot(): StatsReport {
    const used = this.hits + this.joins;
    const perServer: StatsReport['perServer'] = {};
    for (const [server, c] of this.perServer) {
      perServer[server] = { ...c };
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
      wasted: this.wasted,
      parserMisses: this.parserMisses,
      stdioDelays: this.stdioDelays,
      suppressed: Object.fromEntries(
        [...this.suppressedByReason.entries()].sort((a, b) => b[1] - a[1]),
      ),
      estimatedSavedMs: this.estimatedSavedMs,
      wastePerHit: used === 0 ? null : this.wasted / used,
      ageAtHit: this.ageAtHit(),
      perServer,
      perRule,
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
    this.estimatedSavedMs += event.savedMs ?? 0;
    this.server(event.server).hits++;
    if (event.ruleId !== undefined) {
      this.rule(event.ruleId).hits++;
      this.feedbackMutations++;
    }
  }

  /** Shared bookkeeping for 'expired' / 'invalidated' / 'spec_error'. */
  private recordWaste(event: DecisionEvent): void {
    this.wasted++;
    this.server(event.server).wasted++;
    if (event.ruleId !== undefined) {
      this.rule(event.ruleId).wasted++;
      this.feedbackMutations++;
    }
  }

  private server(name: string): PerServerCounters {
    let c = this.perServer.get(name);
    if (c === undefined) {
      c = { speculativeCalls: 0, hits: 0, wasted: 0, specErrors: 0 };
      this.perServer.set(name, c);
    }
    return c;
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
