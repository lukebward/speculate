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
  Rule,
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
  /** Per-trigger prediction cap (§5.6). */
  maxPerTrigger: number;
  metrics: PredictorMetrics;
  /**
   * Declarative rules per server label, compiled from config `rules`. The
   * only hand-written prediction source left; everything else comes from the
   * learner, which needs no per-server code at all.
   */
  extraRules?: Record<string, Rule[]>;
  /**
   * Server-agnostic learned-transition predictor (§5.3 Tier 2). Observes
   * every served call; its predictions join the same validate/feedback/
   * dedupe/cap pipeline as rule output.
   */
  learner?: {
    observe(call: ObservedCall): void;
    predict(call: ObservedCall): Prediction[];
    /** Session-opening reads worth prefetching at proxy start (§13.15). */
    openerPredictions?(server: string): Prediction[];
  };
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
  private readonly extraRules: Map<string, Rule[]>;
  private readonly learner: PredictorOptions['learner'];
  private readonly maxPerTrigger: number;
  private readonly metrics: PredictorMetrics;

  constructor(opts: PredictorOptions) {
    // A Map avoids Object.prototype lookups for hostile server labels.
    this.extraRules = new Map(Object.entries(opts.extraRules ?? {}));
    this.learner = opts.learner;
    this.maxPerTrigger = opts.maxPerTrigger;
    this.metrics = opts.metrics;
  }

  observe(call: CompletedCall): Prediction[] {
    // §5.1 result access: structuredContent first, then generic JSON-in-text
    // sniffing (most servers serialize JSON into a text block), fail closed
    // to null. A parse failure costs a prefetch, never correctness.
    const { parsed, parserMiss } = parseResultDetail(call.result);
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

    // §5.2 run every matching rule (contained), §5.6 feedback-weight the
    // output. Config-authored rules and the learner share one pipeline.
    const rules: Rule[] = this.extraRules.get(call.server) ?? [];
    const candidates: ScoredPrediction[] = [];
    let order = 0;
    for (const rule of rules) {
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

    // §5.3 Tier 2: the learner sees every served call and proposes learned
    // transitions through the same validation/feedback/dedupe/cap pipeline.
    // It is best-effort — a learner failure never costs a real call.
    if (this.learner) {
      try {
        this.learner.observe(observed);
        for (const raw of this.learner.predict(observed)) {
          const learnedId =
            typeof (raw as { ruleId?: unknown }).ruleId === 'string'
              ? (raw as { ruleId: string }).ruleId
              : 'learned:unknown';
          const p = validatePrediction(raw, call.server, learnedId);
          if (!p) continue;
          const fb = this.metrics.ruleFeedback(p.ruleId);
          const eff = effectiveness(fb);
          if (fb.speculated >= FEEDBACK_MIN_SPECULATED && eff < FEEDBACK_EFFECTIVENESS_FLOOR) {
            this.metrics.record({
              type: 'suppressed',
              server: call.server,
              tool: p.tool,
              ruleId: p.ruleId,
              reason: 'feedback',
              confidence: p.confidence,
              timestamp: call.timestamp,
            });
            continue;
          }
          candidates.push({ prediction: p, score: p.confidence * eff, order: order++ });
        }
      } catch {
        // Learner errors are contained; rule-based prediction continues.
      }
    }

    return this.selectBatch(candidates, call.timestamp);
  }

  /**
   * §13.15 session-start priming: the learner's persisted opening reads for
   * `server`, run through the same feedback/dedupe/cap pipeline as any
   * trigger-driven batch. Returns [] when nothing qualifies; never throws.
   */
  sessionStart(server: string): Prediction[] {
    if (!this.learner?.openerPredictions) return [];

    const candidates: ScoredPrediction[] = [];
    let order = 0;
    try {
      for (const raw of this.learner.openerPredictions(server)) {
        const openerId =
          typeof (raw as { ruleId?: unknown }).ruleId === 'string'
            ? (raw as { ruleId: string }).ruleId
            : 'opener:unknown';
        const p = validatePrediction(raw, server, openerId);
        if (!p) continue;
        const fb = this.metrics.ruleFeedback(p.ruleId);
        const eff = effectiveness(fb);
        if (fb.speculated >= FEEDBACK_MIN_SPECULATED && eff < FEEDBACK_EFFECTIVENESS_FLOOR) {
          this.metrics.record({
            type: 'suppressed',
            server,
            tool: p.tool,
            ruleId: p.ruleId,
            reason: 'feedback',
            confidence: p.confidence,
          });
          continue;
        }
        candidates.push({ prediction: p, score: p.confidence * eff, order: order++ });
      }
    } catch {
      return [];
    }
    return this.selectBatch(candidates);
  }

  /**
   * Shared batch tail: dedupe on canonical cache key (keeping the
   * higher-scored prediction; the key is stamped so the executor reuses it
   * instead of recomputing), rank by score, cap (§5.6), and record events.
   */
  private selectBatch(
    candidates: ScoredPrediction[],
    timestamp?: number,
  ): Prediction[] {
    const byKey = new Map<string, ScoredPrediction>();
    for (const cand of candidates) {
      const key = dedupeKey(cand.prediction, cand.order);
      if (!key.startsWith('\x00unkeyable:')) cand.prediction.key = key;
      const existing = byKey.get(key);
      if (!existing || cand.score > existing.score) byKey.set(key, cand);
    }

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
        timestamp,
      });
    }

    for (const { prediction } of kept) {
      this.metrics.record({
        type: 'predicted',
        server: prediction.server,
        tool: prediction.tool,
        ruleId: prediction.ruleId,
        confidence: prediction.confidence,
        timestamp,
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
export function parseResult(result: CallToolResult): unknown | null {
  return parseResultDetail(result).parsed;
}

/**
 * Server-agnostic by construction. Hand-written per-server parsers used to
 * sit between these two branches, but every one of them did exactly what the
 * generic fallback does, so removing them cost nothing and removed a thing
 * that could rot when a server changed its envelope.
 *
 * `parserMiss` survives for config-declared parsing failures elsewhere; this
 * path treats a non-JSON result as ordinary, not as a miss.
 */
function parseResultDetail(result: CallToolResult): {
  parsed: unknown | null;
  parserMiss: boolean;
} {
  const structured: unknown = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    return { parsed: structured, parserMiss: false };
  }
  return { parsed: genericJsonText(result), parserMiss: false };
}

/** Best-effort JSON extraction from the first text block; null otherwise. */
function genericJsonText(result: CallToolResult): unknown | null {
  if (result.isError) return null;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') return null;
    const t = block.text.trimStart();
    // Cheap sniff: only attempt JSON.parse on something JSON-shaped.
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  return null;
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
  const p = raw as {
    tool?: unknown;
    args?: unknown;
    confidence?: unknown;
    horizon?: unknown;
  };
  if (typeof p.tool !== 'string' || p.tool.length === 0) return null;
  if (typeof p.args !== 'object' || p.args === null || Array.isArray(p.args)) return null;
  if (typeof p.confidence !== 'number' || Number.isNaN(p.confidence)) return null;
  return {
    server,
    tool: p.tool,
    args: p.args as Record<string, unknown>,
    confidence: Math.min(1, Math.max(0, p.confidence)),
    ruleId,
    // §6.2: only the two known classes survive validation. Anything else —
    // including nothing, which is what every hand-written rule emits — is
    // left unset, which the executor reads as a trigger-derived next-call
    // prediction on the normal TTL.
    ...(p.horizon === 'standing' || p.horizon === 'next'
      ? { horizon: p.horizon }
      : {}),
  };
}

/** Canonical key for in-batch dedupe; degrades rather than throws. */
function dedupeKey(p: Prediction, order: number): string {
  // Raw args, no canonicalization. Per-server canonicalizers used to fold a
  // missing argument into the server's default so both spellings shared a
  // key; they were removed with profiles because guessing a default wrong
  // does not merely miss a cache share, it serves one query's answer for
  // another. The cost is a missed merge, which is the safe direction.
  try {
    return canonicalKey(p.server, p.tool, p.args);
  } catch {
    // Unkeyable args (cycles, exotic values): fall back to emission order so
    // the prediction is still deduped against itself and nothing else.
    return `${p.server}:${p.tool}:#${order}`;
  }
}

