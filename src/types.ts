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

/** A vetted server profile (DESIGN.md §4, §5.1, §6.1). */
export interface ServerProfile {
  name: string;
  /** Upstream server release(s) this profile was validated against. */
  validatedAgainst: string;
  /** Tools affirmatively known read-only (the `strict`-mode allowlist). */
  readOnlyAllowlist: string[];
  defaultTtlMs: number;
  /** Per-tool TTL overrides; 0 means "never speculate on this tool". */
  ttlMsByTool: Record<string, number>;
  /** Per-tool result parsers (§5.1). */
  parsers: Record<string, ResultParser>;
  /** Per-tool argument canonicalizers (§6.1). */
  canonicalizers: Record<string, ArgsCanonicalizer>;
  rules: Rule[];
}

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
  | { outcome: 'hit'; result: CallToolResult; meta: CacheEntryMeta }
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
  estimatedSavedMs: number;
  wastePerHit: number | null;
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
  /** Built-in profile name (e.g. 'github'). */
  profile?: string;
  /**
   * Declarative prediction rules (validated by configRules.ts) so ANY
   * server gets speculation without a vetted profile.
   */
  rules?: import('./configRules.js').ConfigRuleSpec[];
  /** Extra allowlist entries beyond the profile's. */
  allowTools?: string[];
  /** Denylist: never speculate on these, regardless of mode/profile. */
  denyTools?: string[];
  speculation?: {
    defaultTtlMs?: number;
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
