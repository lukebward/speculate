/**
 * End-to-end integration for CLI speculation (DESIGN.md §13.8, "Tier A"):
 * the bundled speculate-shell MCP server running BEHIND the Speculate proxy
 * with the vetted 'shell' profile, against a real git fixture repo on a real
 * filesystem — real `git`/`rg` execs, real fs-watcher invalidation.
 *
 * Flakiness discipline: this suite runs real subprocesses, so wherever
 * possible assertions are content-based (the post-edit diff must CONTAIN the
 * edited line) rather than timing-based. Timing assertions use a threshold
 * calibrated at suite start from cache-cold git_diff calls through the same
 * proxy stack, never a bare hardcoded constant.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isWindows, hasRipgrep, cliSpeculationLandsHits } from './platform.js';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { StatsReport } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SHELL_SERVER = join(ROOT, 'shell', 'speculate-shell.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Unstaged modification left in every fixture repo (makes it DIRTY). */
const DIRTY_LINE = 'dirty-working-tree-line-7f3a2b';
/** Distinctive token committed into the fixture, for `search` traffic. */
const SEARCH_TOKEN = 'speculate_learned_probe_51c9';

/** Hermetic git for fixture setup: no user/system config may interfere. */
const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * Build a small real git repo: 2 commits, one tracked file left modified so
 * the working tree is DIRTY — required for the sh:status→diff rule to fire.
 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-shell-fixture-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, env: FIXTURE_GIT_ENV, stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'itest@example.invalid');
  git('config', 'user.name', 'Speculate ITest');
  writeFileSync(join(dir, 'README.md'), `# fixture\n\ntoken: ${SEARCH_TOKEN}\n`);
  writeFileSync(join(dir, 'notes.txt'), 'alpha\nbeta\n');
  git('add', '-A');
  git('commit', '-m', 'c1: initial fixture');
  writeFileSync(join(dir, 'tools.txt'), 'hammer\nwrench\n');
  appendFileSync(join(dir, 'notes.txt'), 'gamma\n');
  git('add', '-A');
  git('commit', '-m', 'c2: grow the fixture');
  // Leave the tree dirty: an unstaged edit to a tracked file.
  appendFileSync(join(dir, 'notes.txt'), `${DIRTY_LINE}\n`);
  return dir;
}

interface Harness {
  client: Client;
  /** Temp dir holding the proxy config. */
  dir: string;
  /** The git workspace served by speculate-shell. */
  fixtureDir: string;
}

const harnesses: Harness[] = [];

async function startShellProxy(
  mode: 'strict' | 'annotated',
  opts: { profile?: boolean; track?: boolean } = {},
): Promise<Harness> {
  const fixtureDir = makeFixtureRepo();
  const dir = mkdtempSync(join(tmpdir(), 'speculate-shell-itest-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      log: 'off',
      // Hermetic: never write learned state into the runner's home dir.
      persistence: { enabled: false },
      servers: {
        workspace: {
          command: TSX,
          // Watcher stays ON (default) — the invalidation test exercises it.
          // --no-auto: assert the fixed surface; the catalog is env-sensitive.
          args: [TSX_CLI, SHELL_SERVER, '--cwd', fixtureDir, '--no-auto'],
          ...(opts.profile === false ? {} : { profile: 'shell' }),
        },
      },
    }),
  );
  const client = new Client({ name: 'shell-itest', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'inherit',
  });
  await client.connect(transport);
  const h = { client, dir, fixtureDir };
  if (opts.track !== false) harnesses.push(h);
  return h;
}

async function closeHarness(h: Harness): Promise<void> {
  await h.client.close().catch(() => {});
  rmSync(h.dir, { recursive: true, force: true });
  rmSync(h.fixtureDir, { recursive: true, force: true });
}

afterEach(async () => {
  while (harnesses.length) {
    await closeHarness(harnesses.pop()!);
  }
});

async function timedCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ms: number; result: CallToolResult }> {
  const t0 = performance.now();
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { ms: performance.now() - t0, result };
}

function textPayload<T>(result: CallToolResult): T {
  const text = (result.content as { type: string; text?: string }[]).find(
    (c) => c.type === 'text',
  )?.text;
  expect(text, 'result should carry a text block').toBeTruthy();
  return JSON.parse(text!) as T;
}

async function readStats(client: Client): Promise<StatsReport> {
  const { result } = await timedCall(client, 'speculate__stats', {});
  return textPayload<StatsReport>(result);
}

// ---------------------------------------------------------------------------
// Timing calibration: real `git diff` on a tiny repo can be nearly as fast as
// a cache hit, so the hit threshold is derived from measured cache-cold calls
// through the full client→proxy→shell-server stack, not hardcoded.
// ---------------------------------------------------------------------------

// Floor for "served from the buffer". Windows stdio round-trips cost
// measurably more than POSIX pipes, so the floor is higher there; the
// calibration below still raises it further on a slow machine.
const HIT_FLOOR_MS = isWindows ? 60 : 20;
/** Below this, a live call is too fast for the "hit is 3x faster" ratio to mean anything. */
const RATIO_FLOOR_MS = isWindows ? HIT_FLOOR_MS : 15;
let HIT_THRESHOLD_MS = HIT_FLOOR_MS;
let coldMedianMs = 0;

beforeAll(async () => {
  const h = await startShellProxy('strict', { track: false });
  try {
    const samples: number[] = [];
    // Distinct path args → distinct cache keys → every call is cache-cold.
    for (const path of ['notes.txt', 'tools.txt', 'README.md']) {
      const { ms, result } = await timedCall(h.client, 'git_diff', { path });
      expect(result.isError ?? false).toBe(false);
      samples.push(ms);
    }
    samples.sort((a, b) => a - b);
    coldMedianMs = samples[1]!;
    HIT_THRESHOLD_MS = Math.max(HIT_FLOOR_MS, coldMedianMs * 0.5);
    console.log(
      `[shell-itest] cold git_diff samples: ${samples.map((s) => s.toFixed(1)).join(' / ')} ms` +
        ` → HIT_THRESHOLD ${HIT_THRESHOLD_MS.toFixed(1)} ms`,
    );
  } finally {
    await closeHarness(h);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('speculate-shell behind the proxy (shell profile)', () => {
  it.skipIf(!cliSpeculationLandsHits)('prefetch hit via profile rule: git_status on a dirty tree prefetches git_diff', async () => {
    const { client } = await startShellProxy('strict');

    // Real upstream exec — timing recorded, no floor asserted (tiny repos
    // can be fast). The dirty entry is the precondition for sh:status→diff.
    const status = await timedCall(client, 'git_status', {});
    const st = textPayload<{ entries: unknown[] }>(status.result);
    expect(st.entries.length, 'fixture must be dirty for the rule to fire').toBeGreaterThan(0);

    await sleep(800); // let the speculative git_diff land

    const hit = await timedCall(client, 'git_diff', {});
    const hitDiff = textPayload<{ diff: string }>(hit.result);
    expect(hitDiff.diff).toContain(DIRTY_LINE); // a real diff, not junk
    expect(hit.ms).toBeLessThan(HIT_THRESHOLD_MS);

    // Single-use buffer: the entry was consumed above, so this identical
    // call goes upstream for real — the live baseline for the same call.
    const baseline = await timedCall(client, 'git_diff', {});
    console.log(
      `[shell-itest] git_status ${status.ms.toFixed(1)} ms; git_diff hit ${hit.ms.toFixed(1)} ms` +
        ` vs live baseline ${baseline.ms.toFixed(1)} ms`,
    );
    if (baseline.ms < RATIO_FLOOR_MS) {
      // Floor guard: a near-instant live call makes the 3x ratio meaningless.
      // On Windows the stdio round-trip alone costs more than a live git_diff
      // on a tiny repo, so the ratio is meaningless well past the POSIX floor.
      expect(hit.ms).toBeLessThan(baseline.ms + 5);
    } else {
      expect(hit.ms).toBeLessThan(baseline.ms / 3);
    }

    const stats = await readStats(client);
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(1);
    const rule = stats.perRule.find((r) => r.ruleId === 'sh:status→diff');
    expect(rule, 'sh:status→diff must appear in perRule stats').toBeDefined();
    expect(rule!.hits).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it.skipIf(!cliSpeculationLandsHits)('chained rule with result-derived args: git_log prefetches git_show for the newest sha', async () => {
    const { client, fixtureDir } = await startShellProxy('strict');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixtureDir,
      env: FIXTURE_GIT_ENV,
    })
      .toString()
      .trim();
    expect(headSha).toMatch(/^[0-9a-f]{40}$/); // git_log emits full %H shas

    const log = await timedCall(client, 'git_log', {});
    const parsedLog = textPayload<{ commits: { sha: string }[] }>(log.result);
    // The rule prefetches git_show for commits[0].sha — keys must match.
    expect(parsedLog.commits[0]!.sha).toBe(headSha);

    await sleep(800); // let the speculative git_show land

    const hit = await timedCall(client, 'git_show', { ref: headSha });
    expect(hit.ms).toBeLessThan(HIT_THRESHOLD_MS);
    const shown = textPayload<{ ref: string; text: string }>(hit.result);
    expect(shown.text.length).toBeGreaterThan(0);
    console.log(
      `[shell-itest] git_log ${log.ms.toFixed(1)} ms; git_show hit ${hit.ms.toFixed(1)} ms`,
    );

    const stats = await readStats(client);
    const rule = stats.perRule.find((r) => r.ruleId === 'sh:log→show');
    expect(rule?.hits ?? 0).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('watcher invalidation: a workspace edit flushes the prefetched diff', async () => {
    const { client, fixtureDir } = await startShellProxy('strict');

    await timedCall(client, 'git_status', {});
    await sleep(800); // git_diff {} is now prefetched and resting in the buffer

    // NOW change the workspace: the buffered diff is stale from this moment.
    const sentinel = 'WATCHER_SENTINEL_epsilon_9137';
    appendFileSync(join(fixtureDir, 'notes.txt'), `${sentinel}\n`);
    // watch debounce (300 ms) + tools/list_changed round trip + buffer flush
    await sleep(1_200);

    const after = await timedCall(client, 'git_diff', {});
    const payload = textPayload<{ diff: string }>(after.result);
    // Content-based correctness: a stale cached diff would lack this line.
    expect(payload.diff).toContain(sentinel);

    const stats = await readStats(client);
    expect(stats.invalidated).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it.skipIf(!hasRipgrep)('learner earns speculation from repeated shell traffic (no profile, annotated mode)', async () => {
    const { client } = await startShellProxy('annotated', { profile: false });

    // Two observations of the list_dir → search transition…
    for (let i = 0; i < 2; i++) {
      await timedCall(client, 'list_dir', {});
      await timedCall(client, 'search', { pattern: SEARCH_TOKEN });
    }
    // …and the third list_dir triggers a learned prefetch of the search.
    await timedCall(client, 'list_dir', {});
    await sleep(800);

    const hit = await timedCall(client, 'search', { pattern: SEARCH_TOKEN });
    expect(hit.ms).toBeLessThan(HIT_THRESHOLD_MS);
    const found = textPayload<{ matches: unknown[] }>(hit.result);
    expect(found.matches.length).toBeGreaterThan(0); // token is committed in README.md
    console.log(`[shell-itest] learned search hit ${hit.ms.toFixed(1)} ms`);

    const stats = await readStats(client);
    expect(stats.perRule.some((r) => r.ruleId.startsWith('learned:workspace:'))).toBe(true);
  }, 30_000);

  it.skipIf(!hasRipgrep)('mutation safety: only the 7 read-only tools plus speculate__stats exist, all readOnlyHint', async () => {
    const { client } = await startShellProxy('strict');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'git_branch',
      'git_diff',
      'git_log',
      'git_show',
      'git_status',
      'list_dir',
      'search',
      'speculate__stats',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint: true`).toBe(true);
    }
  }, 30_000);
});
