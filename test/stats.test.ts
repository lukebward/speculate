import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatUsageReport,
  parseStatsArgs,
  runStats,
} from '../src/stats.js';
import { UsageRecorder, type UsageReport, type UsageTotals } from '../src/usage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runCli(
  args: string[],
  stateHome: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [TSX_CLI, join(ROOT, 'src', 'cli.ts'), ...args],
      { env: { ...process.env, XDG_STATE_HOME: stateHome }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

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

  it('reports malformed records when no valid sessions exist', () => {
    const fixture: UsageReport = { ...emptyReport, ignoredRecords: 2 };

    expect(formatUsageReport(fixture)).toBe(
      'No Speculate usage recorded yet.\n' +
      'Collection starts after installing this version.\n' +
      'Ignored records: 2\n',
    );
  });

  it('escapes workspace controls only in human output', () => {
    const workspace = '/workspace/a\n\u001b[31mred\u001b[0m';
    const fixture: UsageReport = {
      ...report,
      workspaces: [{ ...report.workspaces[0]!, workspace }],
    };
    let json = '';
    runStats(
      { json: true },
      { read: () => fixture, write: (text) => { json += text; } },
    );

    expect(JSON.parse(json).workspaces[0].workspace).toBe(workspace);
    const human = formatUsageReport(fixture);
    expect(human).toContain('/workspace/a\\n\\u001b[31mred\\u001b[0m: 1m 30s saved');
    expect(human).not.toContain('\u001b');
  });
});

describe('runStats', () => {
  it('exposes stats through the real CLI', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'speculate-stats-cli-'));
    try {
      const recorder = new UsageRecorder({
        source: 'mcp',
        workspace: '/workspace/a',
        directory: join(stateHome, 'speculate', 'usage'),
        sessionId: 'test',
        now: () => 1000,
        flushDelayMs: 0,
      });
      recorder.update({
        hits: 1,
        joins: 0,
        misses: 0,
        speculativeCalls: 1,
        wasted: 0,
        estimatedSavedMs: 1500,
      });
      recorder.close();

      const human = await runCli(['stats'], stateHome);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('Estimated time saved: 2s');

      const json = await runCli(['stats', '--json'], stateHome);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout).totals.estimatedSavedMs).toBe(1500);

      const bad = await runCli(['stats', '--bogus'], stateHome);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("unknown stats argument '--bogus'");
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

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
