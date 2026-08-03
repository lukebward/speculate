/**
 * Shared contracts for Speculate. Design: DESIGN.md.
 *
 * Modules implement against these types; do not widen them casually —
 * the proxy core, executor, predictor, cache, policy, and budgets all
 * meet here.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Speculation policy (DESIGN.md §4)
// ---------------------------------------------------------------------------

export type SpeculationMode = 'strict' | 'annotated' | 'off';

export interface EligibilityDecision {
  eligible: boolean;
  /** Machine-readable reason, e.g. 'allowlisted', 'not-annotated', 'denylisted', 'suspended:auth' */
  reason: string;
}

// ---------------------------------------------------------------------------
// Prediction engine (DESIGN.md §5)
// ---------------------------------------------------------------------------

/** A completed real call, as fed to the prediction engine. */
export interface ObservedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  result: CallToolResult;
  /**
   * Structured view of `result`: `result.structuredContent` when present,
   * else the profile parser's output, else null (parse failure or no parser).
   * Rules must treat null as "no result access" and fail closed (§5.1).
   */
  parsed: unknown | null;
  timestamp: number;
  latencyMs: number;
}

/** A concrete predicted next call. Args must be fully materialized. */
export interface Prediction {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** Static prior confidence in [0,1] assigned by the rule. */
  confidence: number;
  ruleId: string;
  /**
   * Canonical cache key, stamped by the predictor so the executor never
   * recomputes (or diverges from) the dedupe key. Optional: the executor
   * falls back to computing it.
   */
  key?: CacheKey;
  /**
   * How far ahead this prediction is betting (§6.2 freshness). The default,
   * `'next'`, is derived from the call that just happened: "given what you
   * just saw, this is the next call." `'standing'` is a memorized bet — at
   * least one argument comes from a remembered literal rather than from the
   * trigger, or the prediction has no trigger at all (session openers) — and
   * so claims only "you will ask for this at some point." Standing bets wait
   * longer in the buffer before anything claims them, so the executor fetches
   * them with a shortened TTL (§6.2, LONG_HORIZON_TTL_FACTOR).
   */
  horizon?: 'next' | 'standing';
}

/** A Tier-1 co-occurrence rule (DESIGN.md §5.2). */
export interface Rule {
  id: string;
  /** Tool name that triggers this rule (unprefixed, server-local). */
  trigger: string;
  /**
   * Produce predictions from the observed call. Return [] when the rule
   * has nothing to say (e.g. `call.parsed` is null and the rule needs it).
   * Must not throw; throwing rules are treated as [] and logged.
   */
  predict(call: ObservedCall): Prediction[];
}

/**
 * Parses a tool result into a structured value for rules to consume.
 * Return null on any parse failure (fail closed, §5.1). Must not throw.
 */
export type ResultParser = (result: CallToolResult) => unknown | null;

/**
 * Canonicalizes tool arguments for cache keying (§6.1): materialize
 * server-side defaults, fold case for case-insensitive enums. Returns a
 * NEW object; must not mutate the input.
 */
export type ArgsCanonicalizer = (
  args: Record<string, unknown>,
) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// Cache (DESIGN.md §6)
// ---------------------------------------------------------------------------

/** Opaque canonical cache key. Produced by keys.ts#canonicalKey. */
export type CacheKey = string;

export interface CacheEntryMeta {
  server: string;
  tool: string;
  ruleId: string;
  /** ms timestamp when the speculative call was issued. */
  issuedAt: number;
  /** Upstream latency of the speculative call (set once resolved). */
  upstreamLatencyMs?: number;
}

export type CacheLookup =
  | {
      outcome: 'hit';
      result: CallToolResult;
      meta: CacheEntryMeta;
      /**
       * How long the entry had been READY when it was consumed — the same
       * instant the TTL counts from, so `ageMs / ttl` is exactly how much of
       * the entry's life had elapsed. The payload itself is up to
       * `meta.upstreamLatencyMs` older than this (§9 staleness telemetry).
       */
      ageMs: number;
      /** `ageMs` as a fraction of this entry's TTL, in [0,1). */
      ttlFraction: number;
    }
  | { outcome: 'joined'; promise: Promise<CallToolResult>; meta: CacheEntryMeta }
  | { outcome: 'miss'; /** top-level arg-key distance to nearest same-tool entry, for near-miss telemetry; undefined when no same-tool entries exist */ nearMissDistance?: number };

// ---------------------------------------------------------------------------
// Budgets (DESIGN.md §7)
// ---------------------------------------------------------------------------

export type UpstreamTransport = 'stdio' | 'http';

export interface BudgetDecision {
  ok: boolean;
  /** e.g. 'concurrency', 'per-minute', 'stdio-busy' */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Metrics / decision log (DESIGN.md §9)
// ---------------------------------------------------------------------------

export type DecisionEventType =
  | 'predicted' // a rule emitted a prediction
  | 'suppressed' // prediction filtered out (policy/budget/dedup/feedback)
  | 'speculated' // speculative call issued upstream
  | 'hit' // real call served from completed prefetch
  | 'joined' // real call joined an in-flight prefetch
  | 'miss' // real call had no matching entry
  | 'expired' // entry aged out unused
  | 'invalidated' // entry dropped by mutation/flush
  | 'spec_error' // speculative call failed upstream (incl. a failed join)
  | 'parser_miss' // profile parser failed on a result (§5.1)
  | 'stdio_delay' // a real call waited behind an in-flight speculative call
  | 'real_call'; // a tools/call actually forwarded upstream (bookkeeping)

export interface DecisionEvent {
  type: DecisionEventType;
  server: string;
  tool: string;
  ruleId?: string;
  reason?: string;
  confidence?: number;
  /** For hit/joined: ms of upstream wait the agent skipped. */
  savedMs?: number;
  /** For miss: near-miss key distance when computable. */
  nearMissDistance?: number;
  /** For hit: ms the entry had been ready when the agent consumed it (§9). */
  ageMs?: number;
  /** For hit: `ageMs` as a fraction of that entry's TTL, in [0,1). */
  ttlFraction?: number;
  latencyMs?: number;
  timestamp?: number;
}

export interface RuleStats {
  ruleId: string;
  predicted: number;
  speculated: number;
  hits: number; // hit + joined
  wasted: number;
  suppressedByFeedback: number;
}

/**
 * How stale served prefetches actually were (DESIGN.md §9). Better
 * prediction fires earlier and further ahead, which raises the AGE of an
 * entry at the moment it is consumed; nothing else in the report would show
 * that. Aggregate only, like every other counter here: durations and counts,
 * never keys, arguments, or results.
 */
export interface AgeAtHitReport {
  /**
   * Hits with a measured age. INVARIANT: equals the sum of `ttlQuarters` —
   * a hit is admitted to both or to neither, so every share below is a share
   * of this same population.
   */
  count: number;
  /**
   * Median and 95th percentile age in ms, to AGE_BIN_MS resolution (bin
   * midpoints); null when nothing has hit yet. `maxMs` is exact.
   */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /**
   * Share of hits consumed in the LAST QUARTER of their TTL — the honest
   * "are we scraping the edge?" number. Null before the first hit.
   */
  lastTtlQuarter: number | null;
  /** Hits per age band, ascending. Keys are stable labels ('<1s', '1-5s', …). */
  buckets: Record<string, number>;
  /** Hits per quarter of TTL elapsed: [0-25%, 25-50%, 50-75%, 75-100%]. */
  ttlQuarters: [number, number, number, number];
}

export interface StatsReport {
  mode: SpeculationMode;
  uptimeMs: number;
  realCalls: number;
  speculativeCalls: number;
  hits: number;
  joins: number;
  misses: number;
  expired: number;
  invalidated: number;
  wasted: number;
  parserMisses: number;
  /** Real calls that may have queued behind speculation on a serial upstream (§3.1). */
  stdioDelays: number;
  /** Prediction suppressions by reason (policy:/budget:/dedup/feedback/…). */
  suppressed: Record<string, number>;
  estimatedSavedMs: number;
  wastePerHit: number | null;
  /** Freshness of what was actually served (§6.2/§9). */
  ageAtHit: AgeAtHitReport;
  perServer: Record<
    string,
    { speculativeCalls: number; hits: number; wasted: number; specErrors: number }
  >;
  perRule: RuleStats[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** stdio upstream */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable-HTTP upstream */
  url?: string;
  /**
   * Extra HTTP request headers for a `url` upstream: this is how an
   * AUTHENTICATED remote MCP server is reached (`Authorization: Bearer …`).
   * `${VAR}` placeholders in values are resolved from the environment by
   * config.ts at load, so the token need not live in the config file.
   *
   * AFTER LOADING, THE VALUES HERE ARE SECRETS. Nothing may print one:
   * diagnostics show header NAMES only (doctor.ts), and anything that
   * echoes upstream error text runs it through Upstream#redact first.
   */
  headers?: Record<string, string>;
  /**
   * Path to Speculate's own OAuth credential store, when this `url` upstream
   * is one the user has run `speculate auth` for. Set by the proxy at startup,
   * not written by hand: the store is consulted by URL, so authorizing a
   * server is the only step: nothing has to be added to a config file.
   *
   * Mutually exclusive with an `Authorization` header, and enforced as such,
   * because the transport spreads configured headers AFTER the OAuth bearer
   * (streamableHttp.js `_commonHeaders`) — a stale hand-set header would
   * silently shadow a valid token and present as an inexplicable 401.
   */
  oauthStorePath?: string;
  /**
   * Accepted and ignored. Vetted per-server profiles were removed; the field
   * stays in the type so an older config still LOADS (config.ts warns and
   * drops it) rather than failing a working setup over a dead line.
   */
  profile?: string;
  /**
   * Declarative prediction rules (validated by configRules.ts) so ANY
   * server gets speculation without a vetted profile.
   */
  rules?: import('./configRules.js').ConfigRuleSpec[];
  /** Tools the operator vouches for; the whole `strict`-mode allowlist. */
  allowTools?: string[];
  /** Denylist: never speculate on these, regardless of mode. */
  denyTools?: string[];
  speculation?: {
    defaultTtlMs?: number;
    /** Per-tool TTL overrides; 0 disables. */
    ttlMsByTool?: Record<string, number>;
    /**
     * TTL multiplier for long-horizon ('standing') predictions, in (0,1].
     * Defaults to LONG_HORIZON_TTL_FACTOR, which is 1 (no shortening) on
     * measured grounds — see src/cache.ts and DESIGN.md §13.19 before
     * lowering it, and watch `expired` / `perRule['opener:*'].wasted` if
     * you do.
     */
    longHorizonTtlFactor?: number;
    maxPerMinute?: number;
    maxConcurrent?: number;
  };
}

export interface SpeculateConfig {
  mode: SpeculationMode;
  /** Per-trigger prediction cap (DESIGN.md §5.6). Default 3. */
  maxPredictionsPerTrigger: number;
  servers: Record<string, ServerConfig>;
  /** Decision-log destination: 'stderr' (JSONL) or 'off'. Default 'stderr'. */
  log: 'stderr' | 'off';
  /**
   * Learned-state persistence (§13.6): transition model + rule feedback.
   * Tool results are never persisted. Default: enabled, XDG state dir.
   */
  persistence?: { enabled?: boolean; path?: string };
}

/** Annotations subset Speculate reads (untrusted hints — §4). */
export interface ToolAnnotationsView {
  readOnlyHint?: boolean;
}

export type UpstreamTool = Tool;
