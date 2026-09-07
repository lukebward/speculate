/** Shared record shape and percentile calculation for the repeated benchmark. */

export type BenchmarkArm = 'off' | 'stable' | 'candidate';

export interface BenchmarkRunRecord {
  schemaVersion: 1;
  workflow: string;
  workflowVersion: number;
  arm: BenchmarkArm;
  seed: number;
  session: number;
  requestedCalls: number;
  eligibleCalls: number;
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  terminalWasted: number;
  outstandingAtSnapshot: number;
  predictorOpportunities: number;
  predictorHitsAt1: number;
  predictorHitsAt3: number;
  toolWaitMs: number;
  toolWaitSamplesMs: number[];
  estimatedSavedMs: number;
  estimatedAddedWaitMs: number;
  upstreamCalls: number;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error('percentile fraction must be in [0,1]');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}
