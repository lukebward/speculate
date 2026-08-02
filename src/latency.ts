/**
 * Expected upstream latency per (server, tool) — the "time saved" term of the
 * expected-value ranking (DESIGN.md §5.6, Appendix A / PASTE).
 *
 * Speculate used to rank candidate prefetches by `confidence x rule
 * effectiveness` alone, so a 50 ms call at 0.8 outranked a 2 s call at 0.3
 * even though the second is worth roughly ten times more wall clock. This
 * module supplies the missing factor: a decayed mean of how long each tool
 * actually takes upstream, measured from calls Speculate already makes.
 *
 * Session-scoped and never persisted, deliberately. Latency describes the
 * network path and the upstream's current load, not the agent's workflow;
 * a number written to disk last week says nothing about this process, and
 * with a five-minute time constant it would be fully decayed before the
 * first call anyway. Nothing new therefore reaches the state file, so old
 * state files keep loading unchanged.
 *
 * Never throws, and every degenerate input fails toward "no opinion", which
 * the ranking reads as "fall back to the previous ordering".
 */
import { decayedScore } from './learner.js';

/**
 * Evidence decay time constant for latency — the 1/e time, like the
 * learner's TAU_MS, but five minutes rather than fourteen days, and the gap
 * is the point rather than an inconsistency.
 *
 * The learner's TAU asks "is this workflow still the user's workflow?", a
 * question measured in days. This one asks "is this how long the server is
 * taking right now?", which is a property of the current network path and
 * the upstream's current load. At fourteen days a whole agent session decays
 * by ~0.02%, i.e. the decay would be arithmetically present and practically
 * cosmetic — a plain lifetime mean wearing a decay's clothes. Five minutes
 * keeps roughly the last few minutes of traffic, so a server that slowed
 * down two minutes ago reads as slow, and one that was slow an hour ago no
 * longer does. Half-life is TAU*ln2 ~ 3.5 min, not 5.
 */
export const LATENCY_TAU_MS = 5 * 60_000;

/**
 * Ceiling on a single observation. A hung call that eventually returns at
 * the 30 s speculative timeout — or a real call that took ten minutes —
 * must not pin one tool at the top of the ranking for the rest of the
 * session. Two minutes is far above any healthy MCP call and far below the
 * range where one sample would dominate everything.
 */
const MAX_OBSERVATION_MS = 120_000;

/** Cap on tracked (server, tool) pairs; the weakest is evicted past it. */
const MAX_TRACKED = 512;

/** Exponentially weighted accumulator: mean = sum / weight. */
interface Accumulator {
  /** Decayed observation count as of `lastUpdated`. */
  weight: number;
  /** Decayed sum of observed latencies as of `lastUpdated`. */
  sum: number;
  lastUpdated: number;
}

export interface LatencyModelOptions {
  /** Injectable clock (ms). */
  now?: () => number;
}

/**
 * What the ranking needs from this module. Declared separately so the
 * predictor and executor depend on the question, not on the implementation
 * (and so a test can answer it with a literal).
 */
export interface LatencyOracle {
  /**
   * Expected upstream milliseconds for this call, or undefined when there is
   * no usable evidence — which callers must read as "rank the way you did
   * before", never as zero.
   */
  expected(server: string, tool: string): number | undefined;
}

export class LatencyModel implements LatencyOracle {
  /** Per (server, tool), keyed `<server>\0<tool>`. */
  private readonly tools = new Map<string, Accumulator>();
  /** Per server, the prior for a tool this session has never timed. */
  private readonly servers = new Map<string, Accumulator>();
  private readonly now: () => number;

  constructor(opts: LatencyModelOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Tracked (server, tool) pairs — the eviction bound, for tests. */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Record one completed upstream call. Callers pass the FULL upstream
   * duration (issue → settle), never the residual wait a joiner experienced:
   * the question is what a prefetch of this tool is worth, which is the whole
   * call, not the part of it the agent happened to be awake for.
   */
  record(server: string, tool: string, latencyMs: number): void {
    if (server.length === 0 || tool.length === 0) return;
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
      return; // an unusable measurement is no measurement
    }
    const ms = Math.min(latencyMs, MAX_OBSERVATION_MS);
    const now = this.now();
    const key = `${server}\x00${tool}`;
    this.add(this.tools, key, ms, now);
    this.add(this.servers, server, ms, now);
    this.evict(now, key);
  }

  /**
   * Expected upstream ms for a prefetch of `tool` on `server`: the tool's own
   * decayed mean, else the server's decayed mean across its tools, else
   * undefined.
   *
   * The server-level fallback is what makes the ranking safe to apply. A
   * prediction batch is single-server by construction (predictions never
   * cross servers), so falling back to the server prior means every candidate
   * in a batch is priced or none of them is — the ranking is never half
   * informed, and a tool nobody has timed yet is treated as typical rather
   * than as free.
   */
  expected(server: string, tool: string): number | undefined {
    return this.mean(this.tools.get(`${server}\x00${tool}`)) ?? this.mean(this.servers.get(server));
  }

  private mean(acc: Accumulator | undefined): number | undefined {
    if (acc === undefined || acc.weight <= 0 || acc.sum <= 0) return undefined;
    const m = acc.sum / acc.weight;
    // A non-positive or unusable mean is "no opinion", never a zero weight:
    // multiplying every candidate by 0 would collapse the ranking to
    // emission order, which is a silent behaviour change, not a fallback.
    return Number.isFinite(m) && m > 0 ? m : undefined;
  }

  /** Age the accumulator to `now`, then add this observation at full weight. */
  private add(into: Map<string, Accumulator>, key: string, ms: number, now: number): void {
    const acc = into.get(key);
    if (acc === undefined) {
      into.set(key, { weight: 1, sum: ms, lastUpdated: now });
      return;
    }
    // Both terms decay by the same factor, so the ratio is unchanged by decay
    // alone: what decay buys is the weight of NEW samples relative to old.
    acc.weight = decayedScore(acc.weight, acc.lastUpdated, now, LATENCY_TAU_MS) + 1;
    acc.sum = decayedScore(acc.sum, acc.lastUpdated, now, LATENCY_TAU_MS) + ms;
    acc.lastUpdated = now;
  }

  /**
   * Trim to MAX_TRACKED by value — lowest decayed weight, then stalest —
   * never evicting the pair this call just recorded. (Same admission
   * invariant as the learner's caps: an unprotected value-eviction at the cap
   * deletes every newcomer on the observation that created it, so the table
   * silently freezes.) Server-level accumulators are not evicted here: they
   * are bounded by the config's server list and are the fallback the evicted
   * tools fall back to.
   */
  private evict(now: number, protectKey: string): void {
    if (this.tools.size <= MAX_TRACKED) return;
    let worstKey: string | undefined;
    let worst: Accumulator | undefined;
    for (const [key, acc] of this.tools) {
      if (key === protectKey) continue;
      if (worst === undefined || weakerFirst(acc, worst, now) < 0) {
        worstKey = key;
        worst = acc;
      }
    }
    if (worstKey !== undefined) this.tools.delete(worstKey);
  }
}

function weakerFirst(a: Accumulator, b: Accumulator, now: number): number {
  return (
    decayedScore(a.weight, a.lastUpdated, now, LATENCY_TAU_MS) -
      decayedScore(b.weight, b.lastUpdated, now, LATENCY_TAU_MS) || a.lastUpdated - b.lastUpdated
  );
}
