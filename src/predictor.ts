/**
 * Prediction engine (DESIGN.md §5): turns each observed real call into a
 * ranked, validated, feedback-weighted batch of predicted next calls.
 *
 * Pipeline per observed call: parse result (§5.1, fail closed) → run matching
 * profile rules (§5.2, contained) → validate/normalize predictions → per-rule
 * feedback scoring (§5.6) → batch dedupe on canonical key → rank and cap.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { canonicalKey } from './keys.js';
import type {
  DecisionEvent,
  ObservedCall,
  Prediction,
  ServerProfile,
} from './types.js';

/** Per-rule outcome counters consumed by the §5.6 feedback loop. */
export interface RuleFeedback {
  hits: number;
  wasted: number;
  speculated: number;
}

/** The slice of the metrics module the predictor depends on. */
export interface PredictorMetrics {
  record(ev: DecisionEvent): void;
  ruleFeedback(ruleId: string): RuleFeedback;
}

export interface PredictorOptions {
  /** Profiles keyed by SERVER LABEL (the config name, e.g. 'github'). */
  profiles: Record<string, ServerProfile>;
  /** Per-trigger prediction cap (§5.6). */
  maxPerTrigger: number;
  metrics: PredictorMetrics;
}

/** A completed real call, as reported by the proxy core. */
export interface CompletedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  result: CallToolResult;
  latencyMs: number;
  timestamp: number;
}

/** A rule must have speculated at least this often before feedback can mute it. */
const FEEDBACK_MIN_SPECULATED = 8;
/** Below this Laplace-smoothed hit rate a well-sampled rule is suppressed. */
const FEEDBACK_EFFECTIVENESS_FLOOR = 0.15;

interface ScoredPrediction {
  prediction: Prediction;
  /** confidence × rule effectiveness (§5.6). */
  score: number;
  /** Emission order, used as the stable tie-break when ranking. */
  order: number;
}

export class Predictor {
  private readonly profiles: Map<string, ServerProfile>;
  private readonly maxPerTrigger: number;
  private readonly metrics: PredictorMetrics;

  constructor(opts: PredictorOptions) {
    // A Map avoids Object.prototype lookups for hostile server labels.
    this.profiles = new Map(Object.entries(opts.profiles));
    this.maxPerTrigger = opts.maxPerTrigger;
    this.metrics = opts.metrics;
  }

  observe(call: CompletedCall): Prediction[] {
    const profile = this.profiles.get(call.server);
    if (!profile) return [];

    // §5.1 result access: structuredContent first, profile parser second,
    // fail closed to null. A parse failure costs a prefetch, never correctness.
    const { parsed, parserMiss } = parseResultDetail(profile, call.tool, call.result);
    if (parserMiss) {
      this.metrics.record({
        type: 'parser_miss',
        server: call.server,
        tool: call.tool,
        timestamp: call.timestamp,
      });
    }

    const observed: ObservedCall = {
      server: call.server,
      tool: call.tool,
      args: call.args,
      result: call.result,
      parsed,
      timestamp: call.timestamp,
      latencyMs: call.latencyMs,
    };

    // §5.2 run every matching rule (contained), §5.6 feedback-weight the output.
    const candidates: ScoredPrediction[] = [];
    let order = 0;
    for (const rule of profile.rules) {
      if (rule.trigger !== call.tool) continue;

      let emitted: readonly unknown[];
      try {
        const out: unknown = rule.predict(observed);
        emitted = Array.isArray(out) ? out : [];
      } catch {
        this.metrics.record({
          type: 'suppressed',
          server: call.server,
          tool: call.tool,
          ruleId: rule.id,
          reason: 'rule-error',
          timestamp: call.timestamp,
        });
        continue;
      }

      const valid: Prediction[] = [];
      for (const raw of emitted) {
        const p = validatePrediction(raw, call.server, rule.id);
        if (p) valid.push(p); // malformed predictions are dropped silently
      }
      if (valid.length === 0) continue;

      const fb = this.metrics.ruleFeedback(rule.id);
      const eff = effectiveness(fb);
      if (fb.speculated >= FEEDBACK_MIN_SPECULATED && eff < FEEDBACK_EFFECTIVENESS_FLOOR) {
        // §5.6: a rule that never hits gets suppressed entirely this round.
        for (const p of valid) {
          this.metrics.record({
            type: 'suppressed',
            server: p.server,
            tool: p.tool,
            ruleId: p.ruleId,
            reason: 'feedback',
            confidence: p.confidence,
            timestamp: call.timestamp,
          });
        }
        continue;
      }
      for (const p of valid) {
        candidates.push({ prediction: p, score: p.confidence * eff, order: order++ });
      }
    }

    // Batch dedupe on canonical cache key, keeping the higher-scored prediction.
    const byKey = new Map<string, ScoredPrediction>();
    for (const cand of candidates) {
      const key = dedupeKey(profile, cand.prediction, cand.order);
      const existing = byKey.get(key);
      if (!existing || cand.score > existing.score) byKey.set(key, cand);
    }

    // Rank by score descending (stable on emission order) and cap (§5.6).
    const ranked = [...byKey.values()].sort(
      (a, b) => b.score - a.score || a.order - b.order,
    );
    const kept = ranked.slice(0, this.maxPerTrigger);
    for (const cut of ranked.slice(kept.length)) {
      this.metrics.record({
        type: 'suppressed',
        server: cut.prediction.server,
        tool: cut.prediction.tool,
        ruleId: cut.prediction.ruleId,
        reason: 'per-trigger-cap',
        confidence: cut.prediction.confidence,
        timestamp: call.timestamp,
      });
    }

    for (const { prediction } of kept) {
      this.metrics.record({
        type: 'predicted',
        server: prediction.server,
        tool: prediction.tool,
        ruleId: prediction.ruleId,
        confidence: prediction.confidence,
        timestamp: call.timestamp,
      });
    }
    return kept.map((c) => c.prediction);
  }
}

/**
 * §5.1 structured result access, exported for tests: `structuredContent`
 * when present and non-null; else the profile parser's output (null on
 * throw/null, i.e. fail closed); null when neither source exists.
 */
export function parseResult(
  profile: ServerProfile,
  tool: string,
  result: CallToolResult,
): unknown | null {
  return parseResultDetail(profile, tool, result).parsed;
}

function parseResultDetail(
  profile: ServerProfile,
  tool: string,
  result: CallToolResult,
): { parsed: unknown | null; parserMiss: boolean } {
  const structured: unknown = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    return { parsed: structured, parserMiss: false };
  }
  const parser = Object.prototype.hasOwnProperty.call(profile.parsers, tool)
    ? profile.parsers[tool]
    : undefined;
  if (!parser) return { parsed: null, parserMiss: false }; // nothing to miss
  try {
    const parsed = parser(result);
    if (parsed === null || parsed === undefined) {
      return { parsed: null, parserMiss: true };
    }
    return { parsed, parserMiss: false };
  } catch {
    return { parsed: null, parserMiss: true };
  }
}

/** Laplace-smoothed per-rule hit rate (§5.6): (hits + 1) / (hits + wasted + 2). */
function effectiveness(fb: RuleFeedback): number {
  return (fb.hits + 1) / (fb.hits + fb.wasted + 2);
}

/**
 * Normalize one rule-emitted prediction, or reject it as malformed:
 * - server is forced to the trigger call's server (predictions never cross servers);
 * - ruleId is forced to the emitting rule (feedback must land on the right rule);
 * - tool must be a non-empty string, args a plain object;
 * - confidence must be a number (clamped into [0,1]).
 */
function validatePrediction(raw: unknown, server: string, ruleId: string): Prediction | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as { tool?: unknown; args?: unknown; confidence?: unknown };
  if (typeof p.tool !== 'string' || p.tool.length === 0) return null;
  if (typeof p.args !== 'object' || p.args === null || Array.isArray(p.args)) return null;
  if (typeof p.confidence !== 'number' || Number.isNaN(p.confidence)) return null;
  return {
    server,
    tool: p.tool,
    args: p.args as Record<string, unknown>,
    confidence: Math.min(1, Math.max(0, p.confidence)),
    ruleId,
  };
}

/** Canonical key for in-batch dedupe; degrades rather than throws. */
function dedupeKey(profile: ServerProfile, p: Prediction, order: number): string {
  const canonicalizer = Object.prototype.hasOwnProperty.call(profile.canonicalizers, p.tool)
    ? profile.canonicalizers[p.tool]
    : undefined;
  if (canonicalizer) {
    try {
      return canonicalKey(p.server, p.tool, p.args, canonicalizer);
    } catch {
      // Broken canonicalizer: fall back to the raw-args key below.
    }
  }
  try {
    return canonicalKey(p.server, p.tool, p.args);
  } catch {
    // Unkeyable args (e.g. circular): opt this prediction out of dedupe.
    return `\x00unkeyable:${order}`;
  }
}
