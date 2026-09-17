import { createHmac, randomBytes } from 'node:crypto';
import { stableStringify } from './keys.js';
import type {
  SemanticCandidateProjection,
  SemanticEvaluationReport,
  SemanticReliabilityBin,
  PendingProxyDemandStart,
  VerifiedProxyDemandEvent,
} from './semanticTypes.js';

const DEFAULT_LIMITS = {
  maxPerConversation: 512,
  maxPerLaunch: 4_096,
  maxBytes: 4 * 1024 * 1024,
};

interface EvaluationRecord {
  id: string;
  conversationId: string;
  ownerInstanceId: string;
  routeId: string;
  generation: number;
  identity: string;
  snapshotAt: number;
  windowEnd: number;
  probability: number;
  bytes: number;
}

interface DemandEvidence {
  conversationId: string;
  ownerInstanceId: string;
  identity: string;
  startedAt: number;
  bytes: number;
}

interface PendingDemandEvidence {
  ownerInstanceId: string;
  identity: string;
  startedAt: number;
  bytes: number;
}

export interface SemanticEvaluationRegistration {
  batchId: string;
  conversationId: string;
  ownerInstanceId: string;
  snapshotAt: number;
  candidates: readonly {
    candidate: SemanticCandidateProjection;
    probability: number;
    windowMs: number;
  }[];
}

export class SemanticEvaluationTracker {
  private readonly records = new Map<string, EvaluationRecord>();
  private readonly seenCompletions = new Map<string, number>();
  private readonly recentStarts = new Map<string, DemandEvidence>();
  private readonly pendingStarts = new Map<string, PendingDemandEvidence>();
  private readonly censoredStarts = new Map<string, PendingDemandEvidence>();
  private readonly now: () => number;
  private readonly drainMs: number;
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly digestKey: Buffer;
  private readonly evidenceRetentionMs: number;
  private totalBytes = 0;
  private auxiliaryBytes = 0;
  private judged = 0;
  private positives = 0;
  private negatives = 0;
  private censored = 0;
  private evicted = 0;
  private trackingLost = false;
  private brierSum = 0;
  private readonly bins = Array.from({ length: 10 }, () => ({ count: 0, positives: 0, probabilitySum: 0 }));

  constructor(options: {
    now?: () => number;
    drainMs?: number;
    digestKey?: Uint8Array;
    evidenceRetentionMs?: number;
    limits?: Partial<typeof DEFAULT_LIMITS>;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.drainMs = options.drainMs ?? 1_000;
    this.digestKey = Buffer.from(options.digestKey ?? randomBytes(32));
    this.evidenceRetentionMs = options.evidenceRetentionMs ?? 31_000;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  register(input: SemanticEvaluationRegistration): number {
    let registered = 0;
    for (const item of input.candidates) {
      if (
        !Number.isFinite(input.snapshotAt) || !Number.isFinite(item.windowMs) || item.windowMs <= 0 ||
        !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1
      ) continue;
      if (this.trackingLost) {
        this.judged++;
        this.censored++;
        registered++;
        continue;
      }
      const id = `${input.batchId}\u0000${item.candidate.id}`;
      if (this.records.has(id)) continue;
      const identity = this.identity(
        item.candidate.routeId,
        item.candidate.generation,
        item.candidate.server,
        item.candidate.tool,
        item.candidate.args,
      );
      const record: EvaluationRecord = {
        id,
        conversationId: input.conversationId,
        ownerInstanceId: input.ownerInstanceId,
        routeId: item.candidate.routeId,
        generation: item.candidate.generation,
        identity,
        snapshotAt: input.snapshotAt,
        windowEnd: input.snapshotAt + item.windowMs,
        probability: item.probability,
        bytes: 0,
      };
      record.bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (record.bytes > this.limits.maxBytes) {
        this.judged++;
        this.censored++;
        this.evicted++;
        continue;
      }
      this.records.set(id, record);
      this.totalBytes += record.bytes;
      this.judged++;
      registered++;
      for (const evidence of this.recentStarts.values()) {
        if (this.matches(record, evidence)) {
          this.resolve(record, 'positive');
          break;
        }
      }
      for (const evidence of this.censoredStarts.values()) {
        if (this.pendingMatches(record, evidence)) {
          this.resolve(record, 'censored');
          break;
        }
      }
      this.enforceLimits(input.conversationId);
    }
    return registered;
  }

  observeDemand(event: VerifiedProxyDemandEvent): boolean {
    if (
      event.requestId.length === 0 || event.requestId.length > 512 ||
      event.ownerInstanceId.length === 0 || event.ownerInstanceId.length > 512 ||
      event.conversationId.length === 0 || event.conversationId.length > 512
    ) return false;
    const demandKey = `${event.ownerInstanceId}\u0000${event.requestId}`;
    if (event.phase === 'complete') {
      if (this.seenCompletions.has(demandKey)) return false;
      const bytes = Buffer.byteLength(demandKey, 'utf8');
      this.seenCompletions.set(demandKey, bytes);
      this.auxiliaryBytes += bytes;
      this.enforceAuxiliaryLimit();
      return true;
    }
    if (this.recentStarts.has(demandKey)) return false;
    this.removePending(demandKey);
    this.removeCensored(demandKey);
    const identity = this.identity(event.routeId, event.generation, event.server, event.tool, event.args);
    const evidence: DemandEvidence = {
      conversationId: event.conversationId,
      ownerInstanceId: event.ownerInstanceId,
      identity,
      startedAt: event.startedAt,
      bytes: 0,
    };
    evidence.bytes = Buffer.byteLength(demandKey, 'utf8') + Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    this.recentStarts.set(demandKey, evidence);
    this.auxiliaryBytes += evidence.bytes;
    for (const record of [...this.records.values()]) {
      if (this.matches(record, evidence)) this.resolve(record, 'positive');
    }
    this.enforceAuxiliaryLimit();
    return true;
  }

  notePendingDemand(event: PendingProxyDemandStart): boolean {
    if (
      event.requestId.length === 0 || event.requestId.length > 512 ||
      event.ownerInstanceId.length === 0 || event.ownerInstanceId.length > 512
    ) return false;
    const demandKey = `${event.ownerInstanceId}\u0000${event.requestId}`;
    if (
      this.pendingStarts.has(demandKey) || this.censoredStarts.has(demandKey) ||
      this.recentStarts.has(demandKey)
    ) return false;
    const evidence: PendingDemandEvidence = {
      ownerInstanceId: event.ownerInstanceId,
      identity: this.identity(event.routeId, event.generation, event.server, event.tool, event.args),
      startedAt: event.startedAt,
      bytes: 0,
    };
    evidence.bytes = Buffer.byteLength(demandKey, 'utf8') + Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    this.pendingStarts.set(demandKey, evidence);
    this.auxiliaryBytes += evidence.bytes;
    this.enforceAuxiliaryLimit();
    return true;
  }

  censorPendingDemand(ownerInstanceId: string, requestId: string): boolean {
    const key = `${ownerInstanceId}\u0000${requestId}`;
    const evidence = this.pendingStarts.get(key);
    if (!evidence) return false;
    this.pendingStarts.delete(key);
    this.censoredStarts.set(key, evidence);
    this.censorMatchingPending(evidence);
    return true;
  }

  invalidate(conversationId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.conversationId === conversationId) this.resolve(record, 'censored');
    }
  }

  sweep(): void {
    const now = this.now();
    for (const record of [...this.records.values()]) {
      if (now <= record.windowEnd + this.drainMs) continue;
      const unresolved = [...this.pendingStarts.values()].some((evidence) =>
        this.pendingMatches(record, evidence));
      this.resolve(record, unresolved ? 'censored' : 'negative');
    }
    for (const [key, evidence] of this.recentStarts) {
      if (now - evidence.startedAt > this.evidenceRetentionMs) {
        this.recentStarts.delete(key);
        this.auxiliaryBytes -= evidence.bytes;
      }
    }
    for (const [key, evidence] of this.pendingStarts) {
      if (now - evidence.startedAt > this.evidenceRetentionMs) {
        this.removePending(key);
        this.censorMatchingPending(evidence);
        this.trackingLost = true;
        for (const record of [...this.records.values()]) this.resolve(record, 'censored');
      }
    }
    for (const [key, evidence] of this.censoredStarts) {
      if (now - evidence.startedAt > this.evidenceRetentionMs) {
        this.removeCensored(key);
      }
    }
  }

  report(): SemanticEvaluationReport {
    const resolved = this.positives + this.negatives;
    const reliability: SemanticReliabilityBin[] = this.bins.map((bin, index) => ({
      lower: index / 10,
      upper: (index + 1) / 10,
      count: bin.count,
      positives: bin.positives,
      meanProbability: bin.count === 0 ? null : bin.probabilitySum / bin.count,
    }));
    return {
      judged: this.judged,
      positives: this.positives,
      negatives: this.negatives,
      censored: this.censored,
      censoredFraction: this.judged === 0 ? null : this.censored / this.judged,
      brierScore: resolved === 0 ? null : this.brierSum / resolved,
      reliability,
      evicted: this.evicted,
    };
  }

  clear(): void {
    for (const record of [...this.records.values()]) this.resolve(record, 'censored');
    this.seenCompletions.clear();
    this.recentStarts.clear();
    this.pendingStarts.clear();
    this.censoredStarts.clear();
    this.auxiliaryBytes = 0;
  }

  private identity(
    routeId: string,
    generation: number,
    server: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): string {
    return createHmac('sha256', this.digestKey)
      .update(stableStringify({ routeId, generation, server, tool, args }))
      .digest('base64url');
  }

  private matches(record: EvaluationRecord, evidence: DemandEvidence): boolean {
    return record.conversationId === evidence.conversationId &&
      record.ownerInstanceId === evidence.ownerInstanceId &&
      record.identity === evidence.identity &&
      evidence.startedAt > record.snapshotAt && evidence.startedAt <= record.windowEnd;
  }

  private pendingMatches(record: EvaluationRecord, evidence: PendingDemandEvidence): boolean {
    return record.ownerInstanceId === evidence.ownerInstanceId &&
      record.identity === evidence.identity &&
      evidence.startedAt > record.snapshotAt && evidence.startedAt <= record.windowEnd;
  }

  private removePending(key: string): void {
    const evidence = this.pendingStarts.get(key);
    if (!evidence) return;
    this.pendingStarts.delete(key);
    this.auxiliaryBytes -= evidence.bytes;
  }

  private removeCensored(key: string): void {
    const evidence = this.censoredStarts.get(key);
    if (!evidence) return;
    this.censoredStarts.delete(key);
    this.auxiliaryBytes -= evidence.bytes;
  }

  private censorMatchingPending(evidence: PendingDemandEvidence): void {
    for (const record of [...this.records.values()]) {
      if (this.pendingMatches(record, evidence)) this.resolve(record, 'censored');
    }
  }

  private enforceLimits(conversationId: string): void {
    for (;;) {
      let conversationCount = 0;
      for (const record of this.records.values()) {
        if (record.conversationId === conversationId) conversationCount++;
      }
      if (
        conversationCount <= this.limits.maxPerConversation &&
        this.records.size <= this.limits.maxPerLaunch &&
        this.totalBytes + this.auxiliaryBytes <= this.limits.maxBytes
      ) return;
      const oldest = [...this.records.values()].find(
        (record) => conversationCount > this.limits.maxPerConversation
          ? record.conversationId === conversationId
          : true,
      );
      if (!oldest) return;
      this.evicted++;
      this.resolve(oldest, 'censored');
    }
  }

  private enforceAuxiliaryLimit(): void {
    while (this.totalBytes + this.auxiliaryBytes > this.limits.maxBytes) {
      const oldestEvidence = this.recentStarts.entries().next().value as
        | [string, DemandEvidence]
        | undefined;
      if (oldestEvidence) {
        this.recentStarts.delete(oldestEvidence[0]);
        this.auxiliaryBytes -= oldestEvidence[1].bytes;
        for (const record of [...this.records.values()]) {
          if (
            record.conversationId === oldestEvidence[1].conversationId &&
            record.ownerInstanceId === oldestEvidence[1].ownerInstanceId &&
            oldestEvidence[1].startedAt > record.snapshotAt &&
            oldestEvidence[1].startedAt <= record.windowEnd
          ) {
            this.evicted++;
            this.resolve(record, 'censored');
          }
        }
        continue;
      }
      const oldestPending = this.pendingStarts.entries().next().value as
        | [string, PendingDemandEvidence]
        | undefined;
      if (oldestPending) {
        this.removePending(oldestPending[0]);
        this.censorMatchingPending(oldestPending[1]);
        this.trackingLost = true;
        for (const record of [...this.records.values()]) this.resolve(record, 'censored');
        continue;
      }
      const oldestCensored = this.censoredStarts.entries().next().value as
        | [string, PendingDemandEvidence]
        | undefined;
      if (oldestCensored) {
        this.removeCensored(oldestCensored[0]);
        this.trackingLost = true;
        for (const record of [...this.records.values()]) this.resolve(record, 'censored');
        continue;
      }
      const oldestCompletion = this.seenCompletions.entries().next().value as
        | [string, number]
        | undefined;
      if (!oldestCompletion) break;
      this.seenCompletions.delete(oldestCompletion[0]);
      this.auxiliaryBytes -= oldestCompletion[1];
    }
  }

  private resolve(record: EvaluationRecord, outcome: 'positive' | 'negative' | 'censored'): void {
    if (!this.records.delete(record.id)) return;
    this.totalBytes -= record.bytes;
    if (outcome === 'censored') {
      this.censored++;
      return;
    }
    const observed = outcome === 'positive' ? 1 : 0;
    if (observed === 1) this.positives++;
    else this.negatives++;
    this.brierSum += (record.probability - observed) ** 2;
    const index = Math.min(9, Math.floor(record.probability * 10));
    const bin = this.bins[index]!;
    bin.count++;
    bin.positives += observed;
    bin.probabilitySum += record.probability;
  }
}
