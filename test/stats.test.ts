import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWindows } from './platform.js';
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
    // `cli` totals only ever come from <=0.10 records now (CLI speculation
    // was retired in 0.11); the formatter must still render them.
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

  it('omits the CLI line when no CLI records exist (fresh 0.11 installs)', () => {
    const fixture: UsageReport = {
      ...report,
      bySource: { ...report.bySource, cli: totals() },
    };

    const output = formatUsageReport(fixture);
    expect(output).not.toContain('CLI:');
    expect(output).toContain('MCP: 1m 10s saved');
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

  it('rejects the retired CLI-speculation commands and flags (removed in v0.11)', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'speculate-stats-cli-legacy-'));
    try {
      // `exec` survives ONLY as the compatibility pass-through below: it
      // still needs a command, and unknown flags are still usage errors.
      const exec = await runCli(['exec'], stateHome);
      expect(exec.code).toBe(2);
      expect(exec.stderr).toContain("exec: expected '--' followed by a command");

      const execFlag = await runCli(['exec', '--bogus', '--', 'true'], stateHome);
      expect(execFlag.code).toBe(2);
      expect(execFlag.stderr).toContain("unknown exec argument '--bogus'");

      const execDaemon = await runCli(['exec-daemon'], stateHome);
      expect(execDaemon.code).toBe(2);
      expect(execDaemon.stderr).toContain("unknown argument 'exec-daemon'");

      const onNoPlugin = await runCli(['on', '--no-plugin'], stateHome);
      expect(onNoPlugin.code).toBe(2);
      expect(onNoPlugin.stderr).toContain("unknown on argument '--no-plugin'");
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  it('exec is a thin pass-through for a stranded ≤0.10 Bash hook', async () => {
    // A ≤0.10 plugin hook still rewrites the agent's `git status`/`rg`/`ls`
    // to `speculate exec [--cwd <dir>] -- <argv...>` in every project the
    // user hasn't cleaned up yet. Failing those calls breaks the agent's
    // basic workflow, so exec stays as a verbatim pass-through (one stderr
    // line names the retirement and the fix) until 0.12.
    const stateHome = mkdtempSync(join(tmpdir(), 'speculate-exec-'));
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'speculate-exec-cwd-')));
    try {
      const ok = await runCli(
        ['exec', '--', process.execPath, '-e', 'console.log("passed-through")'],
        stateHome,
      );
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('passed-through');
      expect(ok.stderr).toContain(
        "[speculate] CLI speculation was retired in 0.11 — this is a compatibility pass-through; run 'speculate on' to remove the legacy hook.",
      );

      // The child's exit code is the CLI's exit code.
      const failed = await runCli(
        ['exec', '--', process.execPath, '-e', 'process.exit(3)'],
        stateHome,
      );
      expect(failed.code).toBe(3);

      // --cwd is honored (the hook passes the project directory).
      const cwd = await runCli(
        ['exec', '--cwd', workDir, '--', process.execPath, '-e', 'console.log(process.cwd())'],
        stateHome,
      );
      expect(cwd.code).toBe(0);
      expect(cwd.stdout.trim()).toBe(workDir);

      // A command that cannot be spawned fails loudly, never silently.
      const missing = await runCli(
        ['exec', '--', 'speculate-no-such-binary-xyz'],
        stateHome,
      );
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain('speculate-no-such-binary-xyz');

      // spawn() also throws SYNCHRONOUSLY (never emitting 'error'): an empty
      // argv0 is ERR_INVALID_ARG_VALUE on every platform. That must land as
      // the same fail-soft 127, not an unhandled '[speculate] fatal:'.
      const empty = await runCli(['exec', '--', ''], stateHome);
      expect(empty.code).toBe(127);
      expect(empty.stderr).toContain("[speculate] exec: cannot run ''");
      expect(empty.stderr).not.toContain('fatal');
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isWindows)('exec fails soft on a .cmd target (Node throws EINVAL synchronously)', async () => {
    // Since CVE-2024-27980 Node refuses to spawn a batch file: spawn() throws
    // EINVAL right there rather than emitting 'error'. exec is a one-release
    // compatibility shim, so the contract is a clean 127 with the same
    // "cannot run" line as any other unspawnable command — never a crash.
    const stateHome = mkdtempSync(join(tmpdir(), 'speculate-exec-cmd-'));
    try {
      const shim = join(stateHome, 'legacy.cmd');
      writeFileSync(shim, '@echo off\r\necho should-not-run\r\n');
      const res = await runCli(['exec', '--', shim], stateHome);
      expect(res.code).toBe(127);
      expect(res.stdout).not.toContain('should-not-run');
      expect(res.stderr).toContain(`[speculate] exec: cannot run '${shim}'`);
      expect(res.stderr).not.toContain('fatal');
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
