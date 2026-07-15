import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultStateDirectory } from './persistence.js';

export type UsageSource = 'mcp' | 'cli';

export interface UsageCounters {
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  wasted: number;
  estimatedSavedMs: number;
}

export interface UsageSnapshot {
  version: 1;
  sessionId: string;
  source: UsageSource;
  workspace: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  counters: UsageCounters;
}

export interface UsageRecorderOptions {
  source: UsageSource;
  workspace: string;
  directory?: string;
  sessionId?: string;
  now?: () => number;
  flushDelayMs?: number;
  log?: (line: string) => void;
}

export interface UsageTotals extends UsageCounters {
  sessions: number;
  hitRate: number | null;
  wastePerHit: number | null;
}

export interface UsageReport {
  since: string | null;
  updatedAt: string | null;
  ignoredRecords: number;
  totals: UsageTotals;
  bySource: Record<UsageSource, UsageTotals>;
  workspaces: Array<UsageTotals & { workspace: string }>;
}

const ZERO_COUNTERS: UsageCounters = {
  hits: 0,
  joins: 0,
  misses: 0,
  speculativeCalls: 0,
  wasted: 0,
  estimatedSavedMs: 0,
};

export class UsageRecorder {
  private readonly directory: string;
  private readonly path: string;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly log: (line: string) => void;
  private readonly snapshot: UsageSnapshot;
  private timer: NodeJS.Timeout | null = null;
  private warnedFailure = false;

  constructor(options: UsageRecorderOptions) {
    this.directory = options.directory ?? join(defaultStateDirectory(), 'usage');
    this.now = options.now ?? Date.now;
    this.flushDelayMs = options.flushDelayMs ?? 1000;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    const startedAt = this.now();
    const sessionId = options.sessionId ?? randomUUID();
    this.path = join(this.directory, `${startedAt}-${sessionId}.json`);
    this.snapshot = {
      version: 1,
      sessionId,
      source: options.source,
      workspace: resolve(options.workspace),
      startedAt,
      updatedAt: startedAt,
      counters: { ...ZERO_COUNTERS },
    };
    this.flush();
  }

  update(counters: UsageCounters): void {
    this.snapshot.counters = { ...counters };
    this.snapshot.updatedAt = this.now();
    if (this.flushDelayMs === 0) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelayMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.snapshot.endedAt = this.now();
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(this.snapshot), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      if (this.warnedFailure) return;
      this.warnedFailure = true;
      try {
        this.log(`[speculate] usage save failed (will keep retrying silently): ${(error as Error).message}`);
      } catch {}
    }
  }
}

export function createUsageRecorder(
  options: UsageRecorderOptions,
  env: NodeJS.ProcessEnv = process.env,
): UsageRecorder | null {
  return env.SPECULATE_USAGE_OFF === '1' ? null : new UsageRecorder(options);
}

const COUNT_KEYS = ['hits', 'joins', 'misses', 'speculativeCalls', 'wasted'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!isRecord(value) || !isRecord(value.counters)) return false;
  const counters = value.counters;
  if (
    value.version !== 1 ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    (value.source !== 'mcp' && value.source !== 'cli') ||
    typeof value.workspace !== 'string' ||
    !isAbsolute(value.workspace) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.endedAt !== undefined && !isTimestamp(value.endedAt))
  ) {
    return false;
  }
  if (
    !COUNT_KEYS.every(
      (key) =>
        typeof counters[key] === 'number' &&
        Number.isSafeInteger(counters[key]) &&
        counters[key] >= 0,
    )
  ) {
    return false;
  }
  return (
    typeof counters.estimatedSavedMs === 'number' &&
    Number.isFinite(counters.estimatedSavedMs) &&
    counters.estimatedSavedMs >= 0
  );
}

function emptyTotals(): UsageTotals {
  return {
    ...ZERO_COUNTERS,
    sessions: 0,
    hitRate: null,
    wastePerHit: null,
  };
}

function addSnapshot(totals: UsageTotals, snapshot: UsageSnapshot): void {
  totals.sessions += 1;
  for (const key of COUNT_KEYS) totals[key] += snapshot.counters[key];
  totals.estimatedSavedMs += snapshot.counters.estimatedSavedMs;
}

function deriveRatios(totals: UsageTotals): void {
  const used = totals.hits + totals.joins;
  const eligible = used + totals.misses;
  totals.hitRate = eligible === 0 ? null : used / eligible;
  totals.wastePerHit = used === 0 ? null : totals.wasted / used;
}

export function readUsageReport(
  directory: string = join(defaultStateDirectory(), 'usage'),
): UsageReport {
  const report: UsageReport = {
    since: null,
    updatedAt: null,
    ignoredRecords: 0,
    totals: emptyTotals(),
    bySource: { mcp: emptyTotals(), cli: emptyTotals() },
    workspaces: [],
  };
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return report;
  }

  const workspaces = new Map<string, UsageTotals>();
  let earliestStartedAt: number | null = null;
  let latestUpdatedAt: number | null = null;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let snapshot: UsageSnapshot;
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, entry), 'utf8'));
      if (!isUsageSnapshot(value)) {
        report.ignoredRecords += 1;
        continue;
      }
      snapshot = value;
    } catch {
      report.ignoredRecords += 1;
      continue;
    }

    addSnapshot(report.totals, snapshot);
    addSnapshot(report.bySource[snapshot.source], snapshot);
    const workspaceTotals = workspaces.get(snapshot.workspace) ?? emptyTotals();
    addSnapshot(workspaceTotals, snapshot);
    workspaces.set(snapshot.workspace, workspaceTotals);
    earliestStartedAt =
      earliestStartedAt === null
        ? snapshot.startedAt
        : Math.min(earliestStartedAt, snapshot.startedAt);
    latestUpdatedAt =
      latestUpdatedAt === null ? snapshot.updatedAt : Math.max(latestUpdatedAt, snapshot.updatedAt);
  }

  deriveRatios(report.totals);
  deriveRatios(report.bySource.mcp);
  deriveRatios(report.bySource.cli);
  report.workspaces = Array.from(workspaces, ([workspace, totals]) => {
    deriveRatios(totals);
    return { workspace, ...totals };
  }).sort(
    (a, b) =>
      b.estimatedSavedMs - a.estimatedSavedMs ||
      (a.workspace < b.workspace ? -1 : a.workspace > b.workspace ? 1 : 0),
  );
  report.since = earliestStartedAt === null ? null : new Date(earliestStartedAt).toISOString();
  report.updatedAt = latestUpdatedAt === null ? null : new Date(latestUpdatedAt).toISOString();
  return report;
}
