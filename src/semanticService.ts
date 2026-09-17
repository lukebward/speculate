import { projectSemanticArguments, SemanticContextStore } from './semanticContext.js';
import { SemanticEvaluationTracker } from './semanticEvaluation.js';
import { createSecretGuard, type SecretGuard } from './privacy.js';
import {
  JevProvider,
  JevProviderError,
  SEMANTIC_QUESTION_VERSION,
  type JevProviderInput,
} from './semanticProvider.js';
import type {
  SemanticCandidateProjection,
  PendingProxyDemandStart,
  SemanticRankingConfig,
  SemanticRankingReply,
  SemanticRankingRequest,
  SemanticServiceReport,
  VerifiedProxyDemandEvent,
} from './semanticTypes.js';

interface ActiveRequest {
  controller: AbortController;
  requestId: string;
}

export class SemanticRankingService {
  private readonly config: SemanticRankingConfig;
  private readonly apiKey: string;
  private readonly now: () => number;
  private readonly provider: JevProvider | null;
  private readonly evaluation: SemanticEvaluationTracker | null;
  private readonly guard: SecretGuard | null;
  private contextStore: SemanticContextStore | null;
  private launchId: string | null;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly inflight = new Set<ActiveRequest>();
  private readonly requestTimes: number[] = [];
  private readonly fallbacks: Record<string, number> = {};
  private requestCount = 0;
  private successes = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private totalProviderDurationMs = 0;
  private totalJudgingDurationMs = 0;
  private candidatesOffered = 0;
  private candidatesJudged = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private tokenSamples = 0;
  private closed = false;
  private finalReport: SemanticServiceReport | null = null;

  constructor(options: {
    config: SemanticRankingConfig;
    apiKey: string;
    launchId?: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    contextStore?: SemanticContextStore;
    provider?: JevProvider;
    evaluation?: SemanticEvaluationTracker;
    secretValues?: Iterable<string>;
  }) {
    this.config = structuredClone(options.config);
    this.apiKey = options.apiKey;
    this.now = options.now ?? Date.now;
    this.launchId = options.launchId ?? null;
    if (this.config.mode === 'off') {
      this.provider = null;
      this.evaluation = null;
      this.guard = null;
      this.contextStore = null;
      return;
    }
    this.guard = createSecretGuard([this.apiKey, ...(options.secretValues ?? [])]);
    this.evaluation = options.evaluation ?? new SemanticEvaluationTracker({ now: this.now });
    this.contextStore = options.contextStore ?? (this.launchId === null
      ? null
      : this.createContextStore(this.launchId));
    this.provider = options.provider ?? (this.apiKey.length === 0
      ? null
      : new JevProvider({
          apiKey: this.apiKey,
          model: this.config.model,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          now: this.now,
        }));
  }

  observePrompt(input: {
    launchId: string;
    conversationId: string;
    task: string;
    workspace?: string;
    revision?: number;
  }): boolean {
    if (this.closed || this.config.mode === 'off') return false;
    if (this.launchId === null) {
      this.launchId = input.launchId;
      this.contextStore ??= this.createContextStore(input.launchId);
    }
    if (input.launchId !== this.launchId || !this.contextStore) return false;
    this.abortConversation(input.conversationId);
    this.evaluation?.invalidate(input.conversationId);
    return this.contextStore.observePrompt(input);
  }

  observeCall(conversationId: string, input: {
    server: string;
    tool: string;
    args: Readonly<Record<string, unknown>>;
    success: boolean;
    completedAt: number;
  }): boolean {
    if (this.closed || !this.contextStore) return false;
    return this.contextStore.observeCall(conversationId, input);
  }

  async judgeCandidates(request: SemanticRankingRequest): Promise<SemanticRankingReply | null> {
    try {
      request = structuredClone(request);
    } catch {
      return this.fallback('invalid-request');
    }
    this.candidatesOffered += Array.isArray(request.candidates) ? request.candidates.length : 0;
    const now = this.now();
    if (this.closed || this.config.mode === 'off') return this.fallback('off');
    if (!this.provider || this.apiKey.length === 0) return this.fallback('missing-key');
    if (request.launchId !== this.launchId) return this.fallback('wrong-launch');
    if (!validRequest(request)) return this.fallback('invalid-request');
    if (request.deadlineAt <= now) return this.fallback('deadline');
    const context = this.contextStore?.get(request.conversationId ?? '');
    if (!context) return this.fallback('no-context');
    if (now < this.cooldownUntil) return this.fallback('cooldown');
    this.pruneRequestTimes(now);
    if (
      this.requestCount >= this.config.maxRequestsPerSession ||
      this.requestTimes.length >= this.config.maxRequestsPerMinute
    ) return this.fallback('budget');

    const previous = this.active.get(context.conversationId);
    if (previous) {
      if (this.config.mode === 'shadow') return this.fallback('saturated');
      previous.controller.abort(new Error('semantic request superseded'));
      this.active.delete(context.conversationId);
    }
    if (this.inflight.size >= 2) return this.fallback('saturated');

    const projected: SemanticCandidateProjection[] = [];
    const evaluationCandidates = new Map<string, SemanticCandidateProjection>();
    const ids = new Set<string>();
    for (const candidate of request.candidates.slice(0, this.config.maxCandidates)) {
      if (ids.has(candidate.id) || !validCandidate(candidate)) return this.fallback('invalid-request');
      ids.add(candidate.id);
      if (candidate.effectiveTtlMs <= 0) continue;
      if (
        this.guard === null || this.guard.isSensitive(candidate.server) ||
        this.guard.isSensitive(candidate.tool)
      ) continue;
      const args = this.contextStore?.projectCandidate(context.conversationId, candidate.args);
      if (args === null || args === undefined) continue;
      const guardedArgs = this.guard === null ? null : projectSemanticArguments(args, {
        guard: this.guard,
        rejectRedaction: true,
      });
      if (guardedArgs === null) continue;
      let evaluationArgs: Record<string, unknown>;
      try {
        evaluationArgs = JSON.parse(JSON.stringify(candidate.args)) as Record<string, unknown>;
      } catch {
        continue;
      }
      evaluationCandidates.set(candidate.id, { ...candidate, args: evaluationArgs });
      const toolDescription = candidate.toolDescription === undefined
        ? undefined
        : this.safeDescription(candidate.toolDescription);
      const projectedCandidate = { ...candidate, args: guardedArgs };
      if (toolDescription === undefined) delete projectedCandidate.toolDescription;
      else projectedCandidate.toolDescription = toolDescription;
      projected.push(projectedCandidate);
    }
    if (projected.length === 0) return this.fallback('no-candidates');

    const preparedContext = structuredClone(context);
    if (!this.sanitizeContext(preparedContext)) return this.fallback('unsafe-context');
    const windows = projected.map((candidate) => Math.min(this.config.horizonMs, candidate.effectiveTtlMs));
    trimProviderInput(preparedContext, projected, windows);
    if (projected.length === 0) return this.fallback('request-size');

    const controller = new AbortController();
    const active = { controller, requestId: request.requestId };
    this.active.set(context.conversationId, active);
    this.inflight.add(active);
    const remaining = Math.max(0, request.deadlineAt - this.now());
    this.requestTimes.push(now);
    this.requestCount++;
    const input: JevProviderInput = {
      context: preparedContext,
      candidates: projected,
      windowsMs: windows,
      signal: controller.signal,
    };
    const providerOutcome = this.provider.judge(input).then(
      (result) => ({ kind: 'result' as const, result }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ).finally(() => this.inflight.delete(active));
    let resolveAbort!: () => void;
    const abortOutcome = new Promise<{ kind: 'abort' }>((resolve) => {
      resolveAbort = () => resolve({ kind: 'abort' });
      controller.signal.addEventListener('abort', resolveAbort, { once: true });
    });
    const timer = setTimeout(
      () => controller.abort(new Error('semantic request deadline exceeded')),
      Math.min(remaining, this.config.timeoutMs),
    );
    const outcome = await Promise.race([providerOutcome, abortOutcome]);
    this.totalJudgingDurationMs += Math.max(0, this.now() - request.createdAt);
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', resolveAbort);
    if (this.active.get(context.conversationId) === active) this.active.delete(context.conversationId);
    if (outcome.kind === 'abort') {
      if (String(controller.signal.reason?.message).includes('deadline')) {
        this.noteFailure(controller.signal.reason);
      }
      return this.fallback('cancelled');
    }
    if (outcome.kind === 'error') {
      if (controller.signal.aborted) {
        if (String(controller.signal.reason?.message).includes('deadline')) {
          this.noteFailure(controller.signal.reason);
        }
        return this.fallback('cancelled');
      }
      this.noteFailure(outcome.error);
      return this.fallback('provider');
    }
    const result = outcome.result;

    this.consecutiveFailures = 0;
    this.successes++;
    this.candidatesJudged += projected.length;
    this.totalProviderDurationMs += result.durationMs;
    if (result.tokenUsage) {
      this.inputTokens += result.tokenUsage.input;
      this.outputTokens += result.tokenUsage.output;
      this.tokenSamples++;
    }
    if (
      controller.signal.aborted || this.closed || this.now() >= request.deadlineAt ||
      this.contextStore?.get(context.conversationId)?.revision !== context.revision
    ) return this.fallback('stale');
    this.evaluation?.register({
      batchId: request.batchId,
      conversationId: context.conversationId,
      ownerInstanceId: request.ownerInstanceId,
      snapshotAt: request.createdAt,
      candidates: projected.map((candidate, index) => ({
        candidate: evaluationCandidates.get(candidate.id)!,
        probability: result.scores[candidate.id]!,
        windowMs: windows[index]!,
      })),
    });
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      batchId: request.batchId,
      sourceEventId: request.sourceEventId,
      ownerInstanceId: request.ownerInstanceId,
      launchId: request.launchId,
      conversationId: context.conversationId,
      batchDigest: request.batchDigest,
      contextRevision: context.revision,
      model: result.model,
      questionVersion: SEMANTIC_QUESTION_VERSION,
      providerDurationMs: result.durationMs,
      ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
      scores: result.scores,
    };
  }

  async publishDemand(event: VerifiedProxyDemandEvent): Promise<boolean> {
    if (this.closed || !this.evaluation || event.conversationId.length === 0) return false;
    this.evaluation.sweep();
    const accepted = this.evaluation.observeDemand(event);
    if (accepted && event.phase === 'start' && this.config.mode === 'rank') {
      this.abortConversation(event.conversationId);
    }
    return accepted;
  }

  notePendingDemand(event: PendingProxyDemandStart): boolean {
    if (this.closed || !this.evaluation) return false;
    return this.evaluation.notePendingDemand(event);
  }

  censorPendingDemand(ownerInstanceId: string, requestId: string): boolean {
    if (this.closed || !this.evaluation) return false;
    return this.evaluation.censorPendingDemand(ownerInstanceId, requestId);
  }

  invalidate(conversationId: string): void {
    this.abortConversation(conversationId);
    this.evaluation?.invalidate(conversationId);
    this.contextStore?.invalidate(conversationId);
  }

  report(): SemanticServiceReport {
    if (this.finalReport) return structuredClone(this.finalReport);
    this.evaluation?.sweep();
    return this.buildReport();
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.inflight) active.controller.abort(new Error('semantic service shut down'));
    this.active.clear();
    this.evaluation?.clear();
    this.contextStore?.clear();
    this.finalReport = this.buildReport();
  }

  private buildReport(): SemanticServiceReport {
    return {
      mode: this.config.mode,
      model: this.config.model,
      questionVersion: SEMANTIC_QUESTION_VERSION,
      requestsDispatched: this.requestCount,
      successes: this.successes,
      failures: this.failures,
      totalProviderDurationMs: this.totalProviderDurationMs,
      totalJudgingDurationMs: this.totalJudgingDurationMs,
      candidatesJudged: this.candidatesJudged,
      candidatesBypassed: Math.max(0, this.candidatesOffered - this.candidatesJudged),
      inputTokens: this.successes > 0 && this.tokenSamples === this.successes ? this.inputTokens : null,
      outputTokens: this.successes > 0 && this.tokenSamples === this.successes ? this.outputTokens : null,
      fallbacks: { ...this.fallbacks },
      evaluation: this.evaluation?.report() ?? emptyEvaluationReport(),
    };
  }

  private createContextStore(launchId: string): SemanticContextStore {
    return new SemanticContextStore({
      launchId,
      now: this.now,
      ...(this.guard === null ? {} : { guard: this.guard }),
      onEvict: (conversationId) => this.evaluation?.invalidate(conversationId),
    });
  }

  private safeDescription(value: string): string | undefined {
    if (this.guard === null) return undefined;
    const redacted = this.guard.redact(value);
    return this.guard.isSensitive(redacted) || Buffer.byteLength(redacted, 'utf8') > 2 * 1024
      ? undefined
      : redacted;
  }

  private sanitizeContext(context: {
    task: string;
    workspace?: string;
    recentCalls: readonly {
      server: string;
      tool: string;
      args: Readonly<Record<string, unknown>>;
    }[];
  }): boolean {
    if (this.guard === null) return false;
    context.task = this.guard.redact(context.task);
    if (this.guard.isSensitive(context.task)) return false;
    if (context.workspace !== undefined) {
      context.workspace = this.guard.redact(context.workspace);
      if (this.guard.isSensitive(context.workspace)) return false;
    }
    for (const call of context.recentCalls) {
      const mutableCall = call as { server: string; tool: string; args: Record<string, unknown> };
      mutableCall.server = this.guard.redact(call.server);
      mutableCall.tool = this.guard.redact(call.tool);
      if (this.guard.isSensitive(mutableCall.server) || this.guard.isSensitive(mutableCall.tool)) return false;
      const args = projectSemanticArguments(call.args, {
        guard: this.guard,
        rejectRedaction: false,
      });
      if (args === null) return false;
      mutableCall.args = args;
    }
    return true;
  }

  private abortConversation(conversationId: string): void {
    const active = this.active.get(conversationId);
    if (!active) return;
    active.controller.abort(new Error('semantic context invalidated'));
    this.active.delete(conversationId);
  }

  private pruneRequestTimes(now: number): void {
    while (this.requestTimes.length > 0 && this.requestTimes[0]! <= now - 60_000) {
      this.requestTimes.shift();
    }
  }

  private noteFailure(error: unknown): void {
    this.failures++;
    this.consecutiveFailures++;
    if (error instanceof JevProviderError && (error.status === 429 || error.status === 529)) {
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + (error.retryAfterMs ?? 30_000));
    } else if (this.consecutiveFailures >= 3) {
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + 30_000);
    }
  }

  private fallback(reason: string): null {
    this.fallbacks[reason] = (this.fallbacks[reason] ?? 0) + 1;
    return null;
  }
}

function validRequest(request: SemanticRankingRequest): boolean {
  return request.protocolVersion === 1 &&
    [request.requestId, request.batchId, request.sourceEventId, request.ownerInstanceId,
      request.launchId, request.batchDigest].every((value) => value.length > 0 && value.length <= 512) &&
    Number.isFinite(request.createdAt) && Number.isFinite(request.deadlineAt) &&
    Array.isArray(request.candidates);
}

function validCandidate(candidate: SemanticCandidateProjection): boolean {
  return [candidate.id, candidate.routeId, candidate.server, candidate.tool]
    .every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512) &&
    Number.isSafeInteger(candidate.generation) && candidate.generation > 0 &&
    Number.isFinite(candidate.baselineScore) && Number.isFinite(candidate.conservativeLatencyMs) &&
    candidate.conservativeLatencyMs >= 0 && Number.isFinite(candidate.effectiveTtlMs);
}

function trimProviderInput(
  context: { recentCalls: readonly unknown[] },
  candidates: SemanticCandidateProjection[],
  windows: number[],
): void {
  const mutableContext = context as { recentCalls: unknown[] };
  const bytes = () => Buffer.byteLength(JSON.stringify({ context, candidates, windows }), 'utf8');
  while (bytes() > 48 * 1024 && mutableContext.recentCalls.length > 0) mutableContext.recentCalls.shift();
  while (bytes() > 48 * 1024 && candidates.length > 0) {
    let lowest = 0;
    for (let index = 1; index < candidates.length; index++) {
      const candidateUtility = candidates[index]!.baselineScore * candidates[index]!.conservativeLatencyMs;
      const lowestUtility = candidates[lowest]!.baselineScore * candidates[lowest]!.conservativeLatencyMs;
      if (candidateUtility <= lowestUtility) lowest = index;
    }
    candidates.splice(lowest, 1);
    windows.splice(lowest, 1);
  }
}

function emptyEvaluationReport() {
  return {
    judged: 0,
    positives: 0,
    negatives: 0,
    censored: 0,
    censoredFraction: null,
    brierScore: null,
    reliability: Array.from({ length: 10 }, (_value, index) => ({
      lower: index / 10,
      upper: (index + 1) / 10,
      count: 0,
      positives: 0,
      meanProbability: null,
    })),
    evicted: 0,
  };
}
