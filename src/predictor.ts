/**
 * Prediction engine (DESIGN.md §5): turns each observed real call into a
 * ranked, validated, feedback-weighted batch of predicted next calls.
 *
 * Pipeline per observed call: parse result (§5.1, fail closed) → run matching
 * rules (§5.2, contained) → validate/normalize predictions → per-rule
 * feedback scoring (§5.6) → batch dedupe on canonical key → rank and cap.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { canonicalKey } from './keys.js';
import type { LatencyEstimator } from './latency.js';
import type { CandidateCalibration } from './calibration.js';
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
  /** Shared persisted latency source used by adaptive admission. */
  latency?: LatencyEstimator;
  /** Correctness calibration used for ranking and adaptive admission. */
  calibration?: CandidateCalibration;
  admission?: Record<string, { enabled: boolean; minExpectedSavedMs: number }>;
}

/** A completed real call, as reported by the proxy core. */
export interface CompletedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  result: CallToolResult;
  latencyMs: number;
  timestamp: number;
  /** Whether this real call was eligible to have been prefetched. */
  eligibleTarget?: boolean;
}

/** A rule must have speculated at least this often before feedback can mute it. */
const FEEDBACK_MIN_SPECULATED = 8;
/** Below this Laplace-smoothed hit rate a well-sampled rule is suppressed. */
const FEEDBACK_EFFECTIVENESS_FLOOR = 0.15;
const DEFAULT_MIN_EXPECTED_SAVED_MS = 15;
const UNKNOWN_UPSTREAM_LATENCY_MS = 100;

interface ScoredPrediction {
  prediction: Prediction;
  /** Stable rule/alternative identity without argument material. */
  candidateId: string;
  /** Calibrated next-call probability, or legacy feedback-weighted score. */
  score: number;
  /** Emission order, used as the stable tie-break when ranking. */
  order: number;
}

export interface PreparedPredictionCandidate {
  readonly id: string;
  readonly prediction: Readonly<Prediction>;
  readonly candidateId: string;
  readonly baselineScore: number;
  readonly conservativeLatencyMs: number;
  readonly baselineUtilityMs: number;
  readonly order: number;
}

export interface PreparedPredictionBatch {
  readonly server: string;
  readonly createdAt: number;
  readonly candidates: readonly PreparedPredictionCandidate[];
  readonly baselineSelection: readonly Readonly<Prediction>[];
}

export interface ResolvedCandidate {
  tool: string;
  args: Record<string, unknown>;
  confidence: number;
  expectedLatencyMs?: number;
  candidateId: string;
  ruleId: string;
  observerAttribution?: import('./types.js').ObserverAttribution;
  executionLease?: import('./types.js').ExecutionLease;
}

export class Predictor {
  private readonly extraRules: Map<string, Rule[]>;
  private readonly learner: PredictorOptions['learner'];
  private readonly maxPerTrigger: number;
  private readonly metrics: PredictorMetrics;
  private readonly admission: Record<string, { enabled: boolean; minExpectedSavedMs: number }>;
  private readonly latency: LatencyEstimator | undefined;
  private readonly calibration: CandidateCalibration | undefined;
  /** Last ranked batch emitted on each server, for real recall@K telemetry. */
  private readonly pendingEvaluation = new Map<string, PendingCandidateEvaluation[]>();

  constructor(opts: PredictorOptions) {
    // A Map avoids Object.prototype lookups for hostile server labels.
    this.extraRules = new Map(Object.entries(opts.extraRules ?? {}));
    this.learner = opts.learner;
    this.maxPerTrigger = opts.maxPerTrigger;
    this.metrics = opts.metrics;
    this.admission = opts.admission ?? {};
    this.latency = opts.latency;
    this.calibration = opts.calibration;
  }

  observe(call: CompletedCall): Prediction[] {
    return this.selectPrepared(this.prepareObserved(call));
  }

  prepareObserved(call: CompletedCall): PreparedPredictionBatch {
    this.evaluatePreviousBatch(call);
    if (call.eligibleTarget !== false) this.latency?.observe(call.server, call.tool, call.latencyMs);
    // §5.1 result access: structuredContent first, then generic JSON-in-text
    // sniffing (most servers serialize JSON into a text block), fail closed
    // to null. A parse failure costs a prefetch, never correctness.
    const parsed = parseResult(call.result);

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
        const p = validatePrediction(raw, call.server, rule.id, 'next');
        if (p) valid.push(p); // malformed predictions are dropped silently
      }
      if (valid.length === 0) continue;

      for (const [index, p] of valid.entries()) {
        const candidateId = index === 0 ? rule.id : `${rule.id}#${index + 1}`;
        const candidate = this.scoreCandidate(p, candidateId, order++, call.timestamp);
        if (candidate) candidates.push(candidate);
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
          const p = validatePrediction(raw, call.server, learnedId, 'next');
          if (!p) continue;
          const candidate = this.scoreCandidate(p, p.ruleId, order++, call.timestamp);
          if (candidate) candidates.push(candidate);
        }
      } catch {
        // Learner errors are contained; rule-based prediction continues.
      }
    }

    return this.prepareBatch(candidates, call.server, call.timestamp);
  }

  /**
   * §13.15 session-start priming: the learner's persisted opening reads for
   * `server`, run through the same feedback/dedupe/cap pipeline as any
   * trigger-driven batch. Returns [] when nothing qualifies; never throws.
   */
  sessionStart(server: string, queueByUtility = false): Prediction[] {
    if (!this.learner?.openerPredictions) return [];

    const candidates: ScoredPrediction[] = [];
    let order = 0;
    try {
      for (const raw of this.learner.openerPredictions(server)) {
        const openerId =
          typeof (raw as { ruleId?: unknown }).ruleId === 'string'
            ? (raw as { ruleId: string }).ruleId
            : 'opener:unknown';
        const p = validatePrediction(raw, server, openerId, 'standing');
        if (!p) continue;
        const candidate = this.scoreCandidate(p, p.ruleId, order++);
        if (candidate) candidates.push(candidate);
      }
    } catch {
      return [];
    }
    return this.selectPrepared(this.prepareBatch(candidates, server), { queueByUtility });
  }

  admitResolved(
    server: string,
    resolved: readonly ResolvedCandidate[],
    options: { timestamp: number; trackNextCall: boolean; queueByUtility?: boolean },
  ): Prediction[] {
    return this.selectPrepared(this.prepareResolved(server, resolved, options), {
      queueByUtility: options.queueByUtility,
    });
  }

  prepareResolved(
    server: string,
    resolved: readonly ResolvedCandidate[],
    options: { timestamp: number; trackNextCall: boolean },
  ): PreparedPredictionBatch {
    const candidates: ScoredPrediction[] = [];
    for (const [order, candidate] of resolved.entries()) {
      const prediction = validatePrediction(candidate, server, candidate.ruleId, 'next');
      if (!prediction) continue;
      const scored = this.scoreCandidate(
        prediction,
        candidate.candidateId,
        order,
        options.timestamp,
        prediction.observerAttribution !== undefined,
      );
      if (scored) candidates.push(scored);
    }
    return this.prepareBatch(candidates, server, options.timestamp, options.trackNextCall);
  }

  /**
   * Shared batch tail: dedupe on canonical cache key (keeping the
   * higher-scored prediction; the key is stamped so the executor reuses it
   * instead of recomputing), rank by score, cap (§5.6), and record events.
   */
  private prepareBatch(
    candidates: ScoredPrediction[],
    server: string,
    timestamp?: number,
    trackNextCall = true,
  ): PreparedPredictionBatch {
    const byKey = new Map<string, ScoredPrediction>();
    for (const cand of candidates) {
      const key = dedupeKey(cand.prediction, cand.order);
      if (!key.startsWith('\x00unkeyable:')) cand.prediction.key = key;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, cand);
      } else if (cand.score > existing.score) {
        this.recordSuppressed(existing.prediction, 'dedup', timestamp);
        byKey.set(key, cand);
      } else {
        this.recordSuppressed(cand.prediction, 'dedup', timestamp);
      }
    }

    const ranked = [...byKey.values()].sort(
      (a, b) => this.utility(b) - this.utility(a) || b.score - a.score || a.order - b.order,
    );
    // Quality telemetry measures the predictor at the shipped rank cap before
    // latency admission. Otherwise a deliberately suppressed 5 ms Git call
    // appears as a model miss, making it impossible to distinguish "wrong"
    // from "right but not worth issuing" in day-to-day diagnostics.
    const evaluated = ranked.slice(0, this.maxPerTrigger);
    const admission = this.admission[server] ?? {
      // Embedders that do not opt into an admission policy retain the
      // predictor's historical behavior. The proxy supplies an explicit
      // enabled policy for every configured server.
      enabled: false,
      minExpectedSavedMs: DEFAULT_MIN_EXPECTED_SAVED_MS,
    };
    const useful = admission.enabled
      ? ranked.filter((candidate) => this.utility(candidate) >= admission.minExpectedSavedMs)
      : ranked;
    const kept = useful.slice(0, this.maxPerTrigger);
    const admitted = new Set(kept);
    if (trackNextCall) this.pendingEvaluation.set(server, evaluated.map((candidate, index) => {
      const { prediction } = candidate;
      return {
        key: dedupeKey(prediction, index),
        tool: prediction.tool,
        ruleId: prediction.ruleId,
        candidateId: candidate.candidateId,
        rank: index + 1,
        probability:
          this.calibration ? candidate.score : prediction.confidence,
        baseConfidence: prediction.confidence,
        admitted: admitted.has(candidate),
      };
    }));
    const prepared = ranked.map((candidate, index): PreparedPredictionCandidate => {
      const prediction = freezePrediction(candidate.prediction);
      const conservativeLatencyMs = this.conservativeLatency(candidate);
      return Object.freeze({
        id: `c${index}`,
        prediction,
        candidateId: candidate.candidateId,
        baselineScore: candidate.score,
        conservativeLatencyMs,
        baselineUtilityMs: candidate.score * conservativeLatencyMs,
        order: candidate.order,
      });
    });
    const keptKeys = new Set(kept.map((candidate) => dedupeKey(candidate.prediction, candidate.order)));
    const baselineSelection = prepared
      .filter((candidate) => keptKeys.has(dedupeKey(candidate.prediction as Prediction, candidate.order)))
      .map((candidate) => candidate.prediction);
    return Object.freeze({
      server,
      createdAt: timestamp ?? Date.now(),
      candidates: Object.freeze(prepared),
      baselineSelection: Object.freeze(baselineSelection),
    });
  }

  selectPrepared(
    batch: PreparedPredictionBatch,
    options: {
      semanticScores?: Readonly<Record<string, number>>;
      remainingWindowMs?: Readonly<Record<string, number>>;
      queueByUtility?: boolean;
    } = {},
  ): Prediction[] {
    const admission = this.admission[batch.server] ?? {
      enabled: false,
      minExpectedSavedMs: DEFAULT_MIN_EXPECTED_SAVED_MS,
    };
    if (!options.semanticScores) {
      const selected = new Set(batch.baselineSelection);
      const useful = batch.candidates.filter((candidate) =>
        !admission.enabled || candidate.baselineUtilityMs >= admission.minExpectedSavedMs,
      );
      this.recordSelection(batch, useful, selected);
      return batch.baselineSelection.map((prediction) => {
        const output = clonePrediction(prediction);
        if (options.queueByUtility) {
          const prepared = batch.candidates.find((candidate) => candidate.prediction === prediction);
          if (prepared) output.schedulingPriorityMs = prepared.baselineUtilityMs;
        }
        return output;
      });
    }
    const ranked = batch.candidates.map((candidate) => {
      const semanticScore = options.semanticScores![candidate.id];
      const judged = typeof semanticScore === 'number' && Number.isFinite(semanticScore) &&
        semanticScore >= 0 && semanticScore <= 1;
      const probability = judged ? semanticScore : candidate.baselineScore;
      const remaining = options.remainingWindowMs?.[candidate.id];
      const latency = judged && typeof remaining === 'number' && Number.isFinite(remaining)
        ? Math.min(candidate.conservativeLatencyMs, Math.max(0, remaining))
        : candidate.conservativeLatencyMs;
      return { candidate, probability, utility: probability * latency };
    }).sort((a, b) =>
      b.utility - a.utility || b.probability - a.probability || a.candidate.order - b.candidate.order,
    );
    const useful = ranked.filter(({ utility }) =>
      !admission.enabled || utility >= admission.minExpectedSavedMs,
    );
    const selected = useful.slice(0, this.maxPerTrigger);
    const selectedPredictions = new Set(selected.map(({ candidate }) => candidate.prediction));
    this.recordSelection(batch, useful.map(({ candidate }) => candidate), selectedPredictions);
    return selected.map(({ candidate, utility }) => ({
        ...clonePrediction(candidate.prediction),
        schedulingPriorityMs: utility,
      }));
  }

  private recordSelection(
    batch: PreparedPredictionBatch,
    useful: readonly PreparedPredictionCandidate[],
    selected: ReadonlySet<Readonly<Prediction>>,
  ): void {
    const usefulSet = new Set(useful);
    for (const candidate of batch.candidates) {
      if (selected.has(candidate.prediction)) {
        const prediction = candidate.prediction;
        this.metrics.record({
          type: 'predicted',
          server: prediction.server,
          tool: prediction.tool,
          ruleId: prediction.ruleId,
          confidence: prediction.confidence,
          timestamp: batch.createdAt,
          observerAttribution: prediction.observerAttribution,
        });
      } else {
        this.recordSuppressed(
          candidate.prediction as Prediction,
          usefulSet.has(candidate) ? 'per-trigger-cap' : 'low-utility',
          batch.createdAt,
        );
      }
    }
  }

  /**
   * Compare the exact next eligible real call with the batch produced after
   * the prior call on this server. This measures predictor recall separately
   * from policy, budget, upstream latency, and TTL timing—the cache hit rate
   * deliberately combines all of those and cannot diagnose model quality.
   */
  private evaluatePreviousBatch(call: CompletedCall): void {
    const prior = this.pendingEvaluation.get(call.server);
    if (prior === undefined) return; // first call: no preceding opportunity
    this.pendingEvaluation.delete(call.server);
    if (call.eligibleTarget === false) return;
    let rank: number | undefined;
    try {
      const actual = canonicalKey(call.server, call.tool, call.args);
      const at = prior.findIndex((candidate) => candidate.key === actual);
      if (at >= 0) rank = at + 1;
      for (const candidate of prior) {
        const correct = candidate.key === actual;
        this.calibration?.observe(candidate.candidateId, correct, call.timestamp);
        this.metrics.record({
          type: 'candidate_evaluated',
          server: call.server,
          tool: candidate.tool,
          ruleId: candidate.ruleId,
          candidateId: candidate.candidateId,
          rank: candidate.rank,
          probability: candidate.probability,
          baseConfidence: candidate.baseConfidence,
          admitted: candidate.admitted,
          correct,
          timestamp: call.timestamp,
        });
      }
    } catch {
      // Unkeyable real args are not a measurable cache opportunity.
      return;
    }
    this.metrics.record({
      type: 'prediction_evaluated',
      server: call.server,
      tool: call.tool,
      rank,
      candidateCount: prior.length,
      timestamp: call.timestamp,
    });
  }

  private utility(candidate: ScoredPrediction): number {
    return candidate.score * this.conservativeLatency(candidate);
  }

  private conservativeLatency(candidate: ScoredPrediction): number {
    const prediction = candidate.prediction;
    return this.latency
      ? this.latency.estimate(
          prediction.server,
          prediction.tool,
          prediction.expectedLatencyMs,
        ).conservativeMs
      : (prediction.expectedLatencyMs !== undefined && prediction.expectedLatencyMs >= 0
          ? prediction.expectedLatencyMs
          : UNKNOWN_UPSTREAM_LATENCY_MS);
  }

  /** Apply the operational cutoff and source-appropriate correctness score. */
  private scoreCandidate(
    prediction: Prediction,
    candidateId: string,
    order: number,
    timestamp?: number,
    operationallyWeighted = false,
  ): ScoredPrediction | null {
    const feedback = this.metrics.ruleFeedback(prediction.ruleId);
    const operational = effectiveness(feedback);
    // A correct next-call prediction may still expire before use. Retain
    // operational waste protection alongside next-call calibration.
    if (
      feedback.speculated >= FEEDBACK_MIN_SPECULATED &&
      operational < FEEDBACK_EFFECTIVENESS_FLOOR
    ) {
      this.recordSuppressed(prediction, 'feedback', timestamp);
      return null;
    }
    const calibrated = this.calibration
      ? this.calibration.probability(candidateId, prediction.confidence).probability
      : prediction.confidence;
    const terminalMass = feedback.hits + feedback.wasted;
    const operationalWeight = this.calibration
      ? (operationallyWeighted
          ? 1 - Math.min(1, terminalMass) * (1 - operational)
          : 1)
      : operational;
    return {
      prediction,
      candidateId,
      score: calibrated * operationalWeight,
      order,
    };
  }

  private recordSuppressed(prediction: Prediction, reason: string, timestamp?: number): void {
    this.metrics.record({
      type: 'suppressed',
      server: prediction.server,
      tool: prediction.tool,
      ruleId: prediction.ruleId,
      reason,
      confidence: prediction.confidence,
      timestamp,
      observerAttribution: prediction.observerAttribution,
    });
  }
}

interface PendingCandidateEvaluation {
  key: string;
  tool: string;
  ruleId: string;
  candidateId: string;
  rank: number;
  probability: number;
  baseConfidence: number;
  admitted: boolean;
}

/**
 * §5.1 structured result access, exported for tests: `structuredContent`
 * when present and non-null; otherwise generic JSON-in-text parsing.
 */
export function parseResult(result: CallToolResult): unknown | null {
  const structured: unknown = result.structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  return genericJsonText(result);
}

/** Best-effort JSON extraction from text/resource blocks; null otherwise. */
function genericJsonText(result: CallToolResult): unknown | null {
  if (result.isError) return null;
  for (const block of result.content ?? []) {
    const text =
      block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : block.type === 'resource' &&
            'resource' in block &&
            typeof (block.resource as { text?: unknown }).text === 'string'
          ? ((block.resource as { text: string }).text)
          : null;
    if (text === null) continue;
    const parsed = parseJsonTextCandidate(text);
    if (parsed.ok) return parsed.value;
  }
  return null;
}

function parseJsonTextCandidate(text: string): { ok: true; value: unknown } | { ok: false } {
  const parse = (candidate: string): { ok: true; value: unknown } | { ok: false } => {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch {
      return { ok: false };
    }
  };

  const direct = parse(text);
  if (direct.ok) return direct;
  // Exact fenced blocks are common in MCP text results and unambiguous.
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = parse(match[1] ?? '');
    if (fenced.ok) return fenced;
  }
  // Prose prefix followed by a JSON value occupying the remainder.
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((at) => at >= 0);
  if (starts.length > 0) return parse(text.slice(Math.min(...starts)));
  return { ok: false };
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
function validatePrediction(
  raw: unknown,
  server: string,
  ruleId: string,
  horizon: 'next' | 'standing',
): Prediction | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as {
    tool?: unknown;
    args?: unknown;
    confidence?: unknown;
    expectedLatencyMs?: unknown;
    observerAttribution?: unknown;
    executionLease?: unknown;
  };
  if (typeof p.tool !== 'string' || p.tool.length === 0) return null;
  if (typeof p.args !== 'object' || p.args === null || Array.isArray(p.args)) return null;
  if (typeof p.confidence !== 'number' || Number.isNaN(p.confidence)) return null;
  return {
    server,
    tool: p.tool,
    args: p.args as Record<string, unknown>,
    confidence: Math.min(1, Math.max(0, p.confidence)),
    ...(typeof p.expectedLatencyMs === 'number' &&
    Number.isFinite(p.expectedLatencyMs) &&
    p.expectedLatencyMs >= 0
      ? { expectedLatencyMs: p.expectedLatencyMs }
      : {}),
    ruleId,
    // Timing follows the entrypoint: trigger batches predict the next
    // call; only session-start predictions may outlive the next real call.
    horizon,
    ...(validObserverAttribution(p.observerAttribution)
      ? { observerAttribution: {
          client: p.observerAttribution.client,
          source: p.observerAttribution.source,
          routeId: p.observerAttribution.routeId,
          generation: p.observerAttribution.generation,
          candidateCreatedAt: p.observerAttribution.candidateCreatedAt,
        } }
      : {}),
    ...(validExecutionLease(p.executionLease) ? { executionLease: { ...p.executionLease } } : {}),
  };
}

function validExecutionLease(value: unknown): value is import('./types.js').ExecutionLease {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const lease = value as Partial<import('./types.js').ExecutionLease>;
  return typeof lease.routeId === 'string' && lease.routeId.length > 0 &&
    typeof lease.generation === 'number' && Number.isInteger(lease.generation) && lease.generation > 0 &&
    (lease.permissionContext === undefined || typeof lease.permissionContext === 'string') &&
    (lease.conversationId === undefined || typeof lease.conversationId === 'string');
}

function validObserverAttribution(value: unknown): value is import('./types.js').ObserverAttribution {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<import('./types.js').ObserverAttribution>;
  return (item.client === 'claude' || item.client === 'codex') &&
    (item.source === 'intent' || item.source === 'transition' || item.source === 'stream') &&
    typeof item.routeId === 'string' && item.routeId.length > 0 &&
    typeof item.generation === 'number' && Number.isInteger(item.generation) && item.generation > 0 &&
    typeof item.candidateCreatedAt === 'number' && Number.isFinite(item.candidateCreatedAt) && item.candidateCreatedAt >= 0;
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

function clonePrediction(prediction: Readonly<Prediction>): Prediction {
  return {
    server: prediction.server,
    tool: prediction.tool,
    args: structuredClone(prediction.args),
    confidence: prediction.confidence,
    ...(prediction.expectedLatencyMs === undefined ? {} : { expectedLatencyMs: prediction.expectedLatencyMs }),
    ruleId: prediction.ruleId,
    ...(prediction.key === undefined ? {} : { key: prediction.key }),
    ...(prediction.horizon === undefined ? {} : { horizon: prediction.horizon }),
    ...(prediction.executionLease === undefined ? {} : { executionLease: { ...prediction.executionLease } }),
    ...(prediction.observerAttribution === undefined
      ? {}
      : { observerAttribution: { ...prediction.observerAttribution } }),
    ...(prediction.schedulingPriorityMs === undefined
      ? {}
      : { schedulingPriorityMs: prediction.schedulingPriorityMs }),
    ...(prediction.semanticRevision === undefined ? {} : { semanticRevision: prediction.semanticRevision }),
    ...(prediction.semanticNextCallRevision === undefined
      ? {}
      : { semanticNextCallRevision: prediction.semanticNextCallRevision }),
  };
}

function freezePrediction(prediction: Prediction): Readonly<Prediction> {
  const snapshot = clonePrediction(prediction);
  deepFreeze(snapshot.args);
  if (snapshot.executionLease) Object.freeze(snapshot.executionLease);
  if (snapshot.observerAttribution) Object.freeze(snapshot.observerAttribution);
  return Object.freeze(snapshot);
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}
