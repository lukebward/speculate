import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  UsageRecorder,
  createUsageRecorder,
  readUsageReport,
  type UsageCounters,
} from '../src/usage.js';

const dir = () => mkdtempSync(join(tmpdir(), 'speculate-usage-'));

const counters = (overrides: Partial<UsageCounters> = {}): UsageCounters => ({
  hits: 0,
  joins: 0,
  misses: 0,
  speculativeCalls: 0,
  wasted: 0,
  estimatedSavedMs: 0,
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  sessionId: 'session',
  source: 'mcp',
  workspace: resolve('/workspace/a'),
  startedAt: 1000,
  updatedAt: 1500,
  counters: counters(),
  ...overrides,
});

function writeSnapshot(directory: string, name: string, value: unknown): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), JSON.stringify(value));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageRecorder', () => {
  it('persists an owner-only snapshot atomically', () => {
    const directory = join(dir(), 'nested');
    let now = 1000;
    const recorder = new UsageRecorder({
      source: 'mcp',
      workspace: '/workspace/a',
      directory,
      sessionId: 'a',
      now: () => now,
      flushDelayMs: 0,
    });

    recorder.update(counters({ hits: 2, misses: 1, estimatedSavedMs: 750 }));
    now = 1250;
    recorder.close();

    expect(readdirSync(directory)).toEqual(['1000-a.json']);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, '1000-a.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, '1000-a.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8'))).toMatchObject({
      version: 1,
      sessionId: 'a',
      source: 'mcp',
      workspace: resolve('/workspace/a'),
      startedAt: 1000,
      endedAt: 1250,
      counters: { hits: 2, misses: 1, estimatedSavedMs: 750 },
    });
  });

  it('writes an initial zero snapshot', () => {
    const directory = dir();
    new UsageRecorder({
      source: 'cli',
      workspace: '/workspace/a',
      directory,
      sessionId: 'a',
      now: () => 1000,
    });

    const snapshot = JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8'));
    expect(snapshot.counters).toEqual(counters());
    expect(snapshot.endedAt).toBeUndefined();
  });

  it('persists only approved counter fields from compatible objects', () => {
    const directory = dir();
    const recorder = new UsageRecorder({
      source: 'mcp',
      workspace: '/workspace/a',
      directory,
      sessionId: 'a',
      now: () => 1000,
      flushDelayMs: 0,
    });
    const compatibleCounters = {
      ...counters({ hits: 2, estimatedSavedMs: 750 }),
      perServer: { github: 2 },
      perRule: { nextIssue: 1 },
      cache: { entries: 3 },
    };

    recorder.update(compatibleCounters);
    recorder.close();

    const saved = JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8'));
    expect(saved.counters).toEqual(counters({ hits: 2, estimatedSavedMs: 750 }));
  });

  it('keeps simultaneous sessions in independent files', () => {
    const directory = dir();
    const a = new UsageRecorder({
      source: 'mcp',
      workspace: '/workspace/a',
      directory,
      sessionId: 'a',
      now: () => 1000,
      flushDelayMs: 0,
    });
    const b = new UsageRecorder({
      source: 'cli',
      workspace: '/workspace/b',
      directory,
      sessionId: 'b',
      now: () => 1000,
      flushDelayMs: 0,
    });

    a.update(counters({ hits: 1 }));
    b.update(counters({ joins: 1 }));
    a.close();
    b.close();

    expect(readdirSync(directory)).toEqual(['1000-a.json', '1000-b.json']);
    expect(JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8')).counters.hits).toBe(1);
    expect(JSON.parse(readFileSync(join(directory, '1000-b.json'), 'utf8')).counters.joins).toBe(1);
  });

  it('flushes the latest counters after one second', () => {
    vi.useFakeTimers();
    const directory = dir();
    let now = 1000;
    const recorder = new UsageRecorder({
      source: 'mcp',
      workspace: '/workspace/a',
      directory,
      sessionId: 'a',
      now: () => now,
    });

    now = 1100;
    recorder.update(counters({ hits: 1 }));
    now = 1200;
    recorder.update(counters({ hits: 2, joins: 1 }));
    vi.advanceTimersByTime(999);
    expect(JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8')).counters).toEqual(counters());
    vi.advanceTimersByTime(1);

    expect(JSON.parse(readFileSync(join(directory, '1000-a.json'), 'utf8'))).toMatchObject({
      updatedAt: 1200,
      counters: { hits: 2, joins: 1 },
    });
    recorder.close();
  });

  it('warns once when repeated flushes fail', () => {
    const base = dir();
    const directory = join(base, 'blocked');
    const warnings: string[] = [];
    writeFileSync(directory, 'occupied');
    const recorder = new UsageRecorder({
      source: 'mcp',
      workspace: '/workspace/a',
      directory,
      sessionId: 'a',
      now: () => 1000,
      flushDelayMs: 0,
      log: (line) => warnings.push(line),
    });

    recorder.update(counters({ hits: 1 }));
    expect(warnings).toHaveLength(1);
    recorder.close();
    expect(warnings).toHaveLength(1);
  });

  it('can be disabled through the environment', () => {
    const directory = join(dir(), 'usage');
    expect(
      createUsageRecorder(
        { source: 'mcp', workspace: '/workspace/a', directory },
        { SPECULATE_USAGE_OFF: '1' },
      ),
    ).toBeNull();
    expect(existsSync(directory)).toBe(false);
  });
});

describe('readUsageReport', () => {
  it('aggregates sessions by source and workspace', () => {
    const directory = dir();
    writeSnapshot(
      directory,
      'mcp.json',
      snapshot({
        sessionId: 'mcp-session',
        counters: counters({
          hits: 2,
          misses: 1,
          speculativeCalls: 4,
          wasted: 1,
          estimatedSavedMs: 2000,
        }),
      }),
    );
    writeSnapshot(
      directory,
      'cli.json',
      snapshot({
        sessionId: 'cli-session',
        source: 'cli',
        workspace: resolve('/workspace/b'),
        startedAt: 2000,
        updatedAt: 3000,
        counters: counters({
          joins: 1,
          misses: 1,
          speculativeCalls: 2,
          estimatedSavedMs: 500,
        }),
      }),
    );

    const report = readUsageReport(directory);

    expect(report.totals).toMatchObject({
      sessions: 2,
      hits: 2,
      joins: 1,
      misses: 2,
      speculativeCalls: 6,
      wasted: 1,
      estimatedSavedMs: 2500,
      hitRate: 0.6,
      wastePerHit: 1 / 3,
    });
    expect(report.since).toBe(new Date(1000).toISOString());
    expect(report.updatedAt).toBe(new Date(3000).toISOString());
    expect(report.ignoredRecords).toBe(0);
    expect(report.bySource.mcp.sessions).toBe(1);
    expect(report.bySource.cli.joins).toBe(1);
    expect(report.workspaces.map((row) => row.workspace)).toEqual([
      resolve('/workspace/a'),
      resolve('/workspace/b'),
    ]);
  });

  it('rejects malformed and invalid records', () => {
    const directory = dir();
    const valid = snapshot();
    writeFileSync(join(directory, 'malformed.json'), '{not json');
    writeSnapshot(directory, 'version.json', { ...valid, version: 2 });
    writeSnapshot(directory, 'negative.json', {
      ...valid,
      sessionId: 'negative',
      counters: counters({ hits: -1 }),
    });
    writeSnapshot(directory, 'relative.json', {
      ...valid,
      sessionId: 'relative',
      workspace: 'relative/path',
    });
    writeFileSync(
      join(directory, 'infinity.json'),
      JSON.stringify({ ...valid, sessionId: 'infinity' }).replace(
        '"estimatedSavedMs":0',
        '"estimatedSavedMs":1e309',
      ),
    );
    writeFileSync(join(directory, 'ignored.txt'), JSON.stringify(valid));

    const report = readUsageReport(directory);

    expect(report.totals.sessions).toBe(0);
    expect(report.ignoredRecords).toBe(5);
  });

  it('returns an empty report for a missing directory', () => {
    const report = readUsageReport(join(dir(), 'missing'));

    expect(report.totals.sessions).toBe(0);
    expect(report.totals.hitRate).toBeNull();
    expect(report.totals.wastePerHit).toBeNull();
    expect(report.ignoredRecords).toBe(0);
    expect(report.since).toBeNull();
    expect(report.updatedAt).toBeNull();
    expect(report.workspaces).toEqual([]);
  });
});
