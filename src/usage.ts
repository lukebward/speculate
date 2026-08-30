import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultStateDirectory } from './persistence.js';

export type UsageSource = 'mcp' | 'cli'; // 'cli' survives only to read <=0.10 stats files

export interface UsageCounters {
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  wasted: number;
  estimatedSavedMs: number;
  estimatedAddedWaitMs: number;
  predictionOpportunities: number;
  predictionOffered: number;
  predictionHitsAt1: number;
  predictionHitsAt3: number;
  nearMisses: number;
  nearMissDistanceOne: number;
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
  /** Optional in v1 files; added without changing the compatible envelope. */
  breakdown?: UsageBreakdown;
}

interface UsageArchive {
  version: 1;
  kind: 'archive';
  snapshots: UsageSnapshot[];
}

export interface UsageBreakdown {
  servers: Record<string, UsageCounters>;
  tools: Record<string, Record<string, UsageCounters>>;
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
  predictionRecallAt1: number | null;
  predictionRecallAt3: number | null;
  predictionPrecisionAt3: number | null;
}

export interface UsageReport {
  since: string | null;
  updatedAt: string | null;
  ignoredRecords: number;
  totals: UsageTotals;
  bySource: Record<UsageSource, UsageTotals>;
  workspaces: Array<UsageTotals & { workspace: string }>;
  servers: Array<UsageTotals & { server: string }>;
  tools: Array<UsageTotals & { server: string; tool: string }>;
}

const ZERO_COUNTERS: UsageCounters = {
  hits: 0,
  joins: 0,
  misses: 0,
  speculativeCalls: 0,
  wasted: 0,
  estimatedSavedMs: 0,
  estimatedAddedWaitMs: 0,
  predictionOpportunities: 0,
  predictionOffered: 0,
  predictionHitsAt1: 0,
  predictionHitsAt3: 0,
  nearMisses: 0,
  nearMissDistanceOne: 0,
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

  update(counters: UsageCounters, breakdown?: UsageBreakdown): void {
    this.snapshot.counters = {
      hits: counters.hits,
      joins: counters.joins,
      misses: counters.misses,
      speculativeCalls: counters.speculativeCalls,
      wasted: counters.wasted,
      estimatedSavedMs: counters.estimatedSavedMs,
      estimatedAddedWaitMs: counters.estimatedAddedWaitMs,
      predictionOpportunities: counters.predictionOpportunities,
      predictionOffered: counters.predictionOffered,
      predictionHitsAt1: counters.predictionHitsAt1,
      predictionHitsAt3: counters.predictionHitsAt3,
      nearMisses: counters.nearMisses,
      nearMissDistanceOne: counters.nearMissDistanceOne,
    };
    this.snapshot.breakdown = breakdown;
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
const QUALITY_COUNT_KEYS = [
  'predictionOpportunities',
  'predictionOffered',
  'predictionHitsAt1',
  'predictionHitsAt3',
  'nearMisses',
  'nearMissDistanceOne',
] as const;

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

function isUsageCounters(value: unknown, legacyQuality: boolean): value is UsageCounters {
  if (!isRecord(value)) return false;
  if (
    !COUNT_KEYS.every(
      (key) =>
        typeof value[key] === 'number' &&
        Number.isSafeInteger(value[key]) &&
        (value[key] as number) >= 0,
    ) ||
    typeof value.estimatedSavedMs !== 'number' ||
    !Number.isFinite(value.estimatedSavedMs) ||
    value.estimatedSavedMs < 0 ||
    (value.estimatedAddedWaitMs !== undefined &&
      (typeof value.estimatedAddedWaitMs !== 'number' ||
        !Number.isFinite(value.estimatedAddedWaitMs) ||
        value.estimatedAddedWaitMs < 0))
  ) {
    return false;
  }
  return QUALITY_COUNT_KEYS.every((key) => {
    const item = value[key];
    return (
      (legacyQuality && item === undefined) ||
      (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
    );
  });
}

function isUsageBreakdown(value: unknown): value is UsageBreakdown {
  if (!isRecord(value) || !isRecord(value.servers) || !isRecord(value.tools)) return false;
  if (!Object.values(value.servers).every((counters) => isUsageCounters(counters, false))) {
    return false;
  }
  return Object.values(value.tools).every(
    (byTool) =>
      isRecord(byTool) &&
      Object.values(byTool).every((counters) => isUsageCounters(counters, false)),
  );
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!isRecord(value) || !isUsageCounters(value.counters, true)) return false;
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
  return value.breakdown === undefined || isUsageBreakdown(value.breakdown);
}

function emptyTotals(): UsageTotals {
  return {
    ...ZERO_COUNTERS,
    sessions: 0,
    hitRate: null,
    wastePerHit: null,
    predictionRecallAt1: null,
    predictionRecallAt3: null,
    predictionPrecisionAt3: null,
  };
}

function addSnapshot(totals: UsageTotals, snapshot: UsageSnapshot): void {
  totals.sessions += 1;
  addCounters(totals, snapshot.counters);
}

function isUsageArchive(value: unknown): value is UsageArchive {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === 'archive' &&
    Array.isArray(value.snapshots) &&
    value.snapshots.every(isUsageSnapshot)
  );
}

function addCounters(totals: UsageTotals, counters: UsageCounters): void {
  for (const key of COUNT_KEYS) totals[key] += counters[key];
  for (const key of QUALITY_COUNT_KEYS) totals[key] += counters[key] ?? 0;
  totals.estimatedSavedMs += counters.estimatedSavedMs;
  totals.estimatedAddedWaitMs += counters.estimatedAddedWaitMs ?? 0;
}

function deriveRatios(totals: UsageTotals): void {
  const used = totals.hits + totals.joins;
  const eligible = used + totals.misses;
  totals.hitRate = eligible === 0 ? null : used / eligible;
  totals.wastePerHit = used === 0 ? null : totals.wasted / used;
  totals.predictionRecallAt1 =
    totals.predictionOpportunities === 0
      ? null
      : totals.predictionHitsAt1 / totals.predictionOpportunities;
  totals.predictionRecallAt3 =
    totals.predictionOpportunities === 0
      ? null
      : totals.predictionHitsAt3 / totals.predictionOpportunities;
  totals.predictionPrecisionAt3 =
    totals.predictionOffered === 0
      ? null
      : totals.predictionHitsAt3 / totals.predictionOffered;
}

export function readUsageReport(
  directory: string = join(defaultStateDirectory(), 'usage'),
  filters: { sinceMs?: number; workspace?: string } = {},
): UsageReport {
  const report: UsageReport = {
    since: null,
    updatedAt: null,
    ignoredRecords: 0,
    totals: emptyTotals(),
    bySource: { mcp: emptyTotals(), cli: emptyTotals() },
    workspaces: [],
    servers: [],
    tools: [],
  };
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return report;
  }

  const workspaces = new Map<string, UsageTotals>();
  const servers = new Map<string, UsageTotals>();
  const tools = new Map<string, UsageTotals>();
  const seenSessions = new Set<string>();
  let earliestStartedAt: number | null = null;
  let latestUpdatedAt: number | null = null;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let snapshots: UsageSnapshot[];
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, entry), 'utf8'));
      if (isUsageSnapshot(value)) snapshots = [value];
      else if (isUsageArchive(value)) snapshots = value.snapshots;
      else {
        report.ignoredRecords += 1;
        continue;
      }
    } catch {
      report.ignoredRecords += 1;
      continue;
    }

    for (const snapshot of snapshots) {
      // Archives are written before their source files are removed. A crash
      // in between leaves duplicates, so session id is the recovery key.
      if (seenSessions.has(snapshot.sessionId)) continue;
      seenSessions.add(snapshot.sessionId);

      if (filters.sinceMs !== undefined && snapshot.updatedAt < filters.sinceMs) continue;
      if (filters.workspace !== undefined && snapshot.workspace !== resolve(filters.workspace)) continue;

      addSnapshot(report.totals, snapshot);
      addSnapshot(report.bySource[snapshot.source], snapshot);
      const workspaceTotals = workspaces.get(snapshot.workspace) ?? emptyTotals();
      addSnapshot(workspaceTotals, snapshot);
      workspaces.set(snapshot.workspace, workspaceTotals);
      for (const [server, counters] of Object.entries(snapshot.breakdown?.servers ?? {})) {
        const totals = servers.get(server) ?? emptyTotals();
        addCounters(totals, counters);
        totals.sessions += 1;
        servers.set(server, totals);
      }
      for (const [server, byTool] of Object.entries(snapshot.breakdown?.tools ?? {})) {
        for (const [tool, counters] of Object.entries(byTool)) {
          const key = `${server}\x00${tool}`;
          const totals = tools.get(key) ?? emptyTotals();
          addCounters(totals, counters);
          totals.sessions += 1;
          tools.set(key, totals);
        }
      }
      earliestStartedAt =
        earliestStartedAt === null
          ? snapshot.startedAt
          : Math.min(earliestStartedAt, snapshot.startedAt);
      latestUpdatedAt =
        latestUpdatedAt === null
          ? snapshot.updatedAt
          : Math.max(latestUpdatedAt, snapshot.updatedAt);
    }
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
  report.servers = Array.from(servers, ([server, totals]) => {
    deriveRatios(totals);
    return { server, ...totals };
  }).sort((a, b) => b.estimatedSavedMs - a.estimatedSavedMs || a.server.localeCompare(b.server));
  report.tools = Array.from(tools, ([key, totals]) => {
    deriveRatios(totals);
    const split = key.indexOf('\x00');
    return { server: key.slice(0, split), tool: key.slice(split + 1), ...totals };
  }).sort(
    (a, b) =>
      b.estimatedSavedMs - a.estimatedSavedMs ||
      a.server.localeCompare(b.server) ||
      a.tool.localeCompare(b.tool),
  );
  report.since = earliestStartedAt === null ? null : new Date(earliestStartedAt).toISOString();
  report.updatedAt = latestUpdatedAt === null ? null : new Date(latestUpdatedAt).toISOString();
  return report;
}

/**
 * Pack old completed per-session files into monthly JSON archives. Individual
 * snapshots remain intact, so every existing filter/dimension stays exact;
 * only filesystem fan-out changes. Crash-safe ordering plus reader dedupe
 * makes a half-finished compaction harmless.
 */
export function compactUsageRecords(
  directory: string = join(defaultStateDirectory(), 'usage'),
  beforeMs: number = Date.now() - 30 * 24 * 60 * 60_000,
): { archivedSessions: number; removedFiles: number } {
  const result = { archivedSessions: 0, removedFiles: 0 };
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return result;
  }
  const lock = join(directory, '.compact.lock');
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    return result;
  }
  try {
    const groups = new Map<string, Array<{ entry: string; snapshot: UsageSnapshot }>>();
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.startsWith('archive-')) continue;
      try {
        const value: unknown = JSON.parse(readFileSync(join(directory, entry), 'utf8'));
        if (!isUsageSnapshot(value) || value.endedAt === undefined || value.updatedAt >= beforeMs) {
          continue;
        }
        const month = new Date(value.updatedAt).toISOString().slice(0, 7);
        const group = groups.get(month) ?? [];
        group.push({ entry, snapshot: value });
        groups.set(month, group);
      } catch {}
    }
    for (const [month, group] of groups) {
      if (group.length < 2) continue;
      const archive: UsageArchive = {
        version: 1,
        kind: 'archive',
        snapshots: group.map((item) => item.snapshot),
      };
      const path = join(directory, `archive-${month}-${randomUUID()}.json`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(archive), { mode: 0o600 });
      renameSync(tmp, path);
      result.archivedSessions += group.length;
      for (const { entry } of group) {
        try {
          unlinkSync(join(directory, entry));
          result.removedFiles++;
        } catch {}
      }
    }
    return result;
  } finally {
    try { unlinkSync(lock); } catch {}
  }
}
