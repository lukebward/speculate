export type SemanticRankingMode = 'off' | 'shadow' | 'rank';

export function isPinnedJevModel(value: string): boolean {
  return /^jev-\d+\.\d+\.\d+$/.test(value);
}

export interface SemanticRankingConfig {
  mode: SemanticRankingMode;
  model: string;
  timeoutMs: number;
  maxCandidates: number;
  horizonMs: number;
  maxRequestsPerMinute: number;
  maxRequestsPerSession: number;
}

export interface SemanticCandidateProjection {
  readonly id: string;
  readonly routeId: string;
  readonly generation: number;
  readonly server: string;
  readonly tool: string;
  readonly toolDescription?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly baselineScore: number;
  readonly conservativeLatencyMs: number;
  readonly effectiveTtlMs: number;
}

export interface SemanticRankingRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly batchId: string;
  readonly sourceEventId: string;
  readonly ownerInstanceId: string;
  readonly launchId: string;
  readonly conversationId?: string;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly batchDigest: string;
  readonly candidates: readonly SemanticCandidateProjection[];
}

export interface SemanticTokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface SemanticRankingReply {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly batchId: string;
  readonly sourceEventId: string;
  readonly ownerInstanceId: string;
  readonly launchId: string;
  readonly conversationId: string;
  readonly batchDigest: string;
  readonly contextRevision: number;
  readonly model: string;
  readonly questionVersion: string;
  readonly providerDurationMs: number;
  readonly tokenUsage?: SemanticTokenUsage;
  readonly scores: Readonly<Record<string, number>>;
}

export type ProxyDemandEvent =
  | {
      readonly phase: 'start';
      readonly requestId: string;
      readonly sourceEventId: string;
      readonly ownerInstanceId: string;
      readonly routeId: string;
      readonly generation: number;
      readonly server: string;
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly startedAt: number;
    }
  | {
      readonly phase: 'complete';
      readonly requestId: string;
      readonly sourceEventId: string;
      readonly ownerInstanceId: string;
      readonly routeId: string;
      readonly generation: number;
      readonly completedAt: number;
      readonly success: boolean;
    };

export type PendingProxyDemandStart = Extract<ProxyDemandEvent, { phase: 'start' }>;

export type VerifiedProxyDemandEvent = ProxyDemandEvent & {
  readonly conversationId: string;
};

export interface VerifiedSemanticContext {
  readonly launchId: string;
  readonly conversationId: string;
  readonly revision: number;
  readonly task: string;
  readonly workspace?: string;
  readonly recentCalls: readonly SemanticRecentCall[];
}

export interface SemanticRecentCall {
  readonly server: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly success: boolean;
  readonly relativeMs: number;
}

export interface SemanticEvaluationReport {
  readonly judged: number;
  readonly positives: number;
  readonly negatives: number;
  readonly censored: number;
  readonly censoredFraction: number | null;
  readonly brierScore: number | null;
  readonly reliability: readonly SemanticReliabilityBin[];
  readonly evicted: number;
}

export interface SemanticReliabilityBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly positives: number;
  readonly meanProbability: number | null;
}

export interface SemanticServiceReport {
  readonly mode: SemanticRankingMode;
  readonly model: string;
  readonly questionVersion: string;
  readonly requestsDispatched: number;
  readonly successes: number;
  readonly failures: number;
  readonly totalProviderDurationMs: number;
  readonly totalJudgingDurationMs: number;
  readonly candidatesJudged: number;
  readonly candidatesBypassed: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly fallbacks: Readonly<Record<string, number>>;
  readonly evaluation: SemanticEvaluationReport;
}
