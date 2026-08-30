/** Pure schemas and comparison math for the day-to-day workflow benchmark. */

export type DailyArm = 'off' | 'stable' | 'candidate';

export interface DailyRunRecord {
  schemaVersion: 1;
  workflow: string;
  workflowVersion: number;
  arm: DailyArm;
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

export interface DailyComparison {
  schemaVersion: 1;
  arm: Exclude<DailyArm, 'off'>;
  records: DailyRunRecord[];
  measuredWaitDeltaMsPer100: number | null;
  estimatedNetSavedMsPer100: number | null;
  extraUpstreamCallsPerSavedSecond: number | null;
  p50ToolWaitMs: number;
  p95ToolWaitMs: number;
}

const ARMS = new Set<DailyArm>(['off', 'stable', 'candidate']);
const INTEGER_FIELDS = [
  'workflowVersion',
  'seed',
  'session',
  'requestedCalls',
  'eligibleCalls',
  'hits',
  'joins',
  'misses',
  'speculativeCalls',
  'terminalWasted',
  'outstandingAtSnapshot',
  'predictorOpportunities',
  'predictorHitsAt1',
  'predictorHitsAt3',
  'upstreamCalls',
] as const satisfies readonly (keyof DailyRunRecord)[];

const NUMBER_FIELDS = [
  'toolWaitMs',
  'estimatedSavedMs',
  'estimatedAddedWaitMs',
] as const satisfies readonly (keyof DailyRunRecord)[];

/** Parse an untrusted JSON record and enforce the benchmark's accounting contract. */
export function validateDailyRunRecord(raw: unknown): DailyRunRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('daily benchmark record must be an object');
  }
  const record = raw as Partial<DailyRunRecord>;
  if (record.schemaVersion !== 1) throw new Error('unsupported daily benchmark schema');
  if (typeof record.workflow !== 'string' || record.workflow.length === 0) {
    throw new Error('workflow must be a non-empty string');
  }
  if (!ARMS.has(record.arm as DailyArm)) throw new Error('unknown benchmark arm');

  for (const field of INTEGER_FIELDS) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
  }
  for (const field of NUMBER_FIELDS) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a finite non-negative number`);
    }
  }
  if (!Array.isArray(record.toolWaitSamplesMs)) {
    throw new Error('toolWaitSamplesMs must be an array');
  }
  for (const value of record.toolWaitSamplesMs) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('toolWaitSamplesMs must contain finite non-negative numbers');
    }
  }

  const value = record as DailyRunRecord;
  assertDailyRunInvariants(value);
  return value;
}

/** Fail loudly when counters cannot describe one coherent run. */
export function assertDailyRunInvariants(record: DailyRunRecord): void {
  if (record.requestedCalls !== record.hits + record.joins + record.misses) {
    throw new Error('requestedCalls must equal hits + joins + misses');
  }
  if (
    record.speculativeCalls !==
    record.hits + record.joins + record.terminalWasted + record.outstandingAtSnapshot
  ) {
    throw new Error(
      'speculativeCalls must equal hits + joins + terminalWasted + outstandingAtSnapshot',
    );
  }
  if (
    record.predictorHitsAt1 > record.predictorHitsAt3 ||
    record.predictorHitsAt3 > record.predictorOpportunities
  ) {
    throw new Error('prediction rank counters are inconsistent');
  }
  if (record.toolWaitSamplesMs.length !== record.requestedCalls) {
    throw new Error('toolWaitSamplesMs length must equal requestedCalls');
  }
  const sampleTotal = record.toolWaitSamplesMs.reduce((sum, value) => sum + value, 0);
  const tolerance = Math.max(0.001, record.toolWaitMs * 1e-9);
  if (Math.abs(sampleTotal - record.toolWaitMs) > tolerance) {
    throw new Error('toolWaitMs must equal the sum of toolWaitSamplesMs');
  }
  if (record.eligibleCalls > record.requestedCalls) {
    throw new Error('eligibleCalls cannot exceed requestedCalls');
  }
  if (record.upstreamCalls < record.misses) {
    throw new Error('upstreamCalls cannot be lower than misses');
  }
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error('percentile fraction must be in [0,1]');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

/** Compare one enabled arm with its exact speculation-off pairs. */
export function compareDailyRuns(
  input: readonly DailyRunRecord[],
  arm: Exclude<DailyArm, 'off'> = 'candidate',
): DailyComparison {
  const records = input.map((record) => validateDailyRunRecord(record));
  const keys = new Set<string>();
  for (const record of records) {
    const key = recordKey(record, true);
    if (keys.has(key)) throw new Error(`duplicate daily benchmark record: ${key}`);
    keys.add(key);
  }

  const off = new Map(
    records.filter((record) => record.arm === 'off').map((record) => [recordKey(record), record]),
  );
  const selected = records.filter((record) => record.arm === arm);
  if (selected.length === 0) throw new Error(`no ${arm} records to compare`);

  let requestedCalls = 0;
  let eligibleCalls = 0;
  let measuredSavedMs = 0;
  let estimatedNetSavedMs = 0;
  let extraUpstreamCalls = 0;
  const waits: number[] = [];
  for (const record of selected) {
    const control = off.get(recordKey(record));
    if (!control) throw new Error(`missing off pair for ${recordKey(record)}`);
    if (
      control.requestedCalls !== record.requestedCalls ||
      control.eligibleCalls !== record.eligibleCalls
    ) {
      throw new Error(`paired call counts differ for ${recordKey(record)}`);
    }
    requestedCalls += record.requestedCalls;
    eligibleCalls += record.eligibleCalls;
    measuredSavedMs += control.toolWaitMs - record.toolWaitMs;
    estimatedNetSavedMs += record.estimatedSavedMs - record.estimatedAddedWaitMs;
    extraUpstreamCalls += record.upstreamCalls - control.upstreamCalls;
    waits.push(...record.toolWaitSamplesMs);
  }

  return {
    schemaVersion: 1,
    arm,
    records: [...records].sort(compareRecords),
    measuredWaitDeltaMsPer100:
      requestedCalls === 0 ? null : (100 * measuredSavedMs) / requestedCalls,
    estimatedNetSavedMsPer100:
      eligibleCalls === 0 ? null : (100 * estimatedNetSavedMs) / eligibleCalls,
    extraUpstreamCallsPerSavedSecond:
      measuredSavedMs <= 0 ? null : extraUpstreamCalls / (measuredSavedMs / 1_000),
    p50ToolWaitMs: percentile(waits, 0.5),
    p95ToolWaitMs: percentile(waits, 0.95),
  };
}

function recordKey(record: DailyRunRecord, includeArm = false): string {
  const base = `${record.workflow}@${record.workflowVersion}:${record.seed}:${record.session}`;
  return includeArm ? `${base}:${record.arm}` : base;
}

function compareRecords(a: DailyRunRecord, b: DailyRunRecord): number {
  return (
    a.workflow.localeCompare(b.workflow) ||
    a.workflowVersion - b.workflowVersion ||
    a.seed - b.seed ||
    a.session - b.session ||
    a.arm.localeCompare(b.arm)
  );
}
