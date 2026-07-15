import { describe, expect, it } from 'vitest';
import {
  formatUsageReport,
  parseStatsArgs,
  runStats,
} from '../src/stats.js';
import type { UsageReport, UsageTotals } from '../src/usage.js';

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  sessions: 0,
  hits: 0,
  joins: 0,
  misses: 0,
  speculativeCalls: 0,
  wasted: 0,
  estimatedSavedMs: 0,
  hitRate: null,
  wastePerHit: null,
  ...overrides,
});

const report: UsageReport = {
  since: '2026-07-14T14:00:00.000Z',
  updatedAt: '2026-07-14T15:00:00.000Z',
  ignoredRecords: 1,
  totals: totals({
    sessions: 2,
    hits: 3,
    joins: 1,
    misses: 2,
    speculativeCalls: 8,
    wasted: 2,
    estimatedSavedMs: 90_000,
    hitRate: 2 / 3,
    wastePerHit: 0.5,
  }),
  bySource: {
    mcp: totals({ sessions: 1, estimatedSavedMs: 70_000 }),
    cli: totals({ sessions: 1, estimatedSavedMs: 20_000 }),
  },
  workspaces: [
    {
      workspace: '/workspace/a',
      ...totals({ sessions: 2, estimatedSavedMs: 90_000 }),
    },
  ],
};

const emptyReport: UsageReport = {
  since: null,
  updatedAt: null,
  ignoredRecords: 0,
  totals: totals(),
  bySource: { mcp: totals(), cli: totals() },
  workspaces: [],
};

describe('parseStatsArgs', () => {
  it('accepts no arguments', () => {
    expect(parseStatsArgs([])).toEqual({ json: false });
  });

  it('accepts JSON output', () => {
    expect(parseStatsArgs(['--json'])).toEqual({ json: true });
  });

  it('rejects unknown arguments', () => {
    expect(parseStatsArgs(['--bogus'])).toEqual({
      error: "unknown stats argument '--bogus'",
    });
  });
});

describe('formatUsageReport', () => {
  it('formats cumulative totals, sources, and workspaces', () => {
    const output = formatUsageReport(report);

    expect(output).toContain('Speculate stats (all time since 2026-07-14)');
    expect(output).toContain('Estimated time saved: 1m 30s');
    expect(output).toContain('Prefetch hits: 4 (3 ready, 1 joined)');
    expect(output).toContain('Hit rate: 66.7%');
    expect(output).toContain('Speculative calls: 8');
    expect(output).toContain('Wasted calls: 2 (0.50 per hit)');
    expect(output).toContain('Sessions: 2');
    expect(output).toContain('MCP: 1m 10s saved');
    expect(output).toContain('CLI: 20s saved');
    expect(output).toContain('/workspace/a: 1m 30s saved');
    expect(output).toContain('Ignored records: 1');
  });

  it.each([
    [999.4, '999ms'],
    [1500, '2s'],
    [90_000, '1m 30s'],
    [3_660_000, '1h 1m'],
  ])('formats %d milliseconds as %s', (estimatedSavedMs, expected) => {
    const fixture: UsageReport = {
      ...report,
      totals: { ...report.totals, estimatedSavedMs },
    };

    expect(formatUsageReport(fixture)).toContain(`Estimated time saved: ${expected}`);
  });

  it('uses an em dash for empty ratios', () => {
    const fixture: UsageReport = {
      ...report,
      totals: totals({ sessions: 1 }),
    };

    const output = formatUsageReport(fixture);
    expect(output).toContain('Hit rate: —');
    expect(output).toContain('Wasted calls: 0 (— per hit)');
  });
});

describe('runStats', () => {
  it('prints guidance when no snapshots exist', () => {
    let stdout = '';

    const exitCode = runStats(
      { json: false },
      { read: () => emptyReport, write: (text) => { stdout += text; } },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      'No Speculate usage recorded yet.\nCollection starts after installing this version.\n',
    );
  });

  it('prints the exact report as JSON', () => {
    let stdout = '';

    const exitCode = runStats(
      { json: true },
      { read: () => report, write: (text) => { stdout += text; } },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(report);
    expect(stdout).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });
});
