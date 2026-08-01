/**
 * Scenario metrics suite: replays diverse scripted agent sessions through the
 * real proxy + mock GitHub upstream over stdio — no credentials — and reports
 * live speculation metrics per traffic shape: the profiled ceiling, an
 * adversarial floor, correctness under writes, zero-think bursts, learner
 * warm-up, TTL expiry, budget caps, and think-time sensitivity. Each scenario
 * prints its measured numbers and asserts only what DESIGN.md promises for
 * that shape (guarantees always; performance thresholds only where §10
 * commits to them).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, StatsReport } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const L = 200; // injected upstream latency
const HIT_MS = L * 0.5; // served from buffer
const LIVE_MS = L * 0.8; // went upstream

const REPO = { owner: 'acme', repo: 'api' };
const READ_TOOLS = new Set([
  'get_issue',
  'get_issue_comments',
  'list_issues',
  'list_pull_requests',
  'get_pull_request',
  'get_pull_request_diff',
  'get_file_contents',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  client: Client;
  callLogPath: string;
  configPath: string;
  dir: string;
}

const harnesses: Harness[] = [];

/** Bundled mock upstreams, each mirroring its real server's shapes. */
const MOCK_SERVERS = {
  github: 'mock-github.ts',
  filesystem: 'mock-filesystem.ts',
  slack: 'mock-slack.ts',
} as const;

async function startProxy(
  opts: {
    mode?: 'strict' | 'annotated' | 'off';
    server?: keyof typeof MOCK_SERVERS;
    profile?: string;
    speculation?: ServerConfig['speculation'];
    /** Enables persistence at this path (default: hermetic, no state). */
    statePath?: string;
    /** Share a state home across sessions (default: this harness's tmp dir). */
    xdgStateHome?: string;
  } = {},
): Promise<Harness> {
  const server = opts.server ?? 'github';
  const dir = mkdtempSync(join(tmpdir(), 'speculate-scenario-'));
  const callLogPath = join(dir, 'calls.jsonl');
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: opts.mode ?? 'strict',
      log: 'off',
      persistence: opts.statePath ? { path: opts.statePath } : { enabled: false },
      servers: {
        [server]: {
          command: TSX,
          args: [TSX_CLI, join(ROOT, 'mock', MOCK_SERVERS[server])],
          env: {
            SPECULATE_MOCK_LATENCY_MS: String(L),
            SPECULATE_MOCK_CALL_LOG: callLogPath,
          },
          profile: opts.profile ?? server,
          ...(opts.speculation ? { speculation: opts.speculation } : {}),
        },
      },
    }),
  );
  const client = new Client({ name: 'scenario', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    // Sandboxed state home: usage snapshots land in the harness dir, never
    // in the runner's real XDG state.
    env: {
      ...process.env,
      XDG_STATE_HOME: opts.xdgStateHome ?? dir,
    } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);
  const h = { client, callLogPath, configPath, dir };
  harnesses.push(h);
  return h;
}

/** Mid-test teardown for multi-session scenarios (restart flows). */
async function closeHarness(h: Harness): Promise<void> {
  const i = harnesses.indexOf(h);
  if (i !== -1) harnesses.splice(i, 1);
  await h.client.close().catch(() => {});
  rmSync(h.dir, { recursive: true, force: true });
}

afterEach(async () => {
  while (harnesses.length) {
    const h = harnesses.pop()!;
    await h.client.close().catch(() => {});
    rmSync(h.dir, { recursive: true, force: true });
  }
});

type Step = { tool: string; args: Record<string, unknown> } | { think: number };
const call = (tool: string, args: Record<string, unknown>): Step => ({ tool, args });
const think = (ms: number): Step => ({ think: ms });

interface TimedCall {
  tool: string;
  ms: number;
  result: CallToolResult;
}

async function runScript(
  client: Client,
  steps: Step[],
): Promise<{ perCall: TimedCall[]; toolWaitMs: number }> {
  const perCall: TimedCall[] = [];
  for (const step of steps) {
    if ('think' in step) {
      await sleep(step.think);
      continue;
    }
    const t0 = performance.now();
    const result = (await client.callTool({
      name: step.tool,
      arguments: step.args,
    })) as CallToolResult;
    perCall.push({ tool: step.tool, ms: performance.now() - t0, result });
  }
  return { perCall, toolWaitMs: perCall.reduce((a, c) => a + c.ms, 0) };
}

function textPayload<T>(result: CallToolResult): T {
  const text = (result.content as { type: string; text?: string }[]).find(
    (c) => c.type === 'text',
  )?.text;
  expect(text, 'result should carry a text block').toBeTruthy();
  return JSON.parse(text!) as T;
}

async function readStats(client: Client): Promise<StatsReport> {
  const result = (await client.callTool({
    name: 'speculate__stats',
    arguments: {},
  })) as CallToolResult;
  return textPayload<StatsReport>(result);
}

function loggedTools(callLogPath: string): string[] {
  if (!existsSync(callLogPath)) return [];
  return readFileSync(callLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { tool: string }).tool);
}

// --------------------------------------------------------------------------
// Cross-scenario summary
// --------------------------------------------------------------------------

interface Row {
  name: string;
  eligible: number;
  hitPct: number;
  spec: number;
  unused: number;
  offMs: number;
  onMs: number;
  savedMs: number;
  note: string;
}

const rows: Row[] = [];

function record(
  name: string,
  stats: StatsReport,
  onMs: number,
  offMs: number,
  note: string,
): void {
  const eligible = stats.hits + stats.joins + stats.misses;
  rows.push({
    name,
    eligible,
    hitPct: eligible ? ((stats.hits + stats.joins) / eligible) * 100 : 0,
    spec: stats.speculativeCalls,
    unused: stats.speculativeCalls - stats.hits - stats.joins,
    offMs,
    onMs,
    savedMs: stats.estimatedSavedMs,
    note,
  });
}

const fmtMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;

afterAll(() => {
  const pad = (s: string, w: number) => s.padEnd(w);
  const num = (s: string, w: number) => s.padStart(w);
  console.log(`\n  scenario metrics (upstream latency ${L} ms, mock GitHub, speculation on)\n`);
  console.log(
    `  ${pad('scenario', 26)}${num('reads', 6)}${num('hit%', 6)}${num('spec', 6)}${num('unused', 7)}${num('off', 9)}${num('on', 9)}${num('cut', 6)}${num('saved', 9)}  note`,
  );
  console.log(`  ${'─'.repeat(104)}`);
  for (const r of rows) {
    const cut = `${Math.round((1 - r.onMs / Math.max(r.offMs, 1)) * 100)}%`;
    console.log(
      `  ${pad(r.name, 26)}${num(String(r.eligible), 6)}${num(`${r.hitPct.toFixed(0)}%`, 6)}${num(String(r.spec), 6)}${num(String(r.unused), 7)}${num(fmtMs(r.offMs), 9)}${num(fmtMs(r.onMs), 9)}${num(cut, 6)}${num(fmtMs(r.savedMs), 9)}  ${r.note}`,
    );
  }
  console.log();
});

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

describe('scenario metrics (mock upstream, no credentials)', () => {
  it('S1 workflow ceiling: profiled review flow meets the §10 criteria', async () => {
    const script = [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(600),
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
      think(400),
      call('list_pull_requests', { ...REPO, state: 'open' }),
      think(600),
      call('get_pull_request', { ...REPO, pull_number: 7 }),
      think(100), // shorter than upstream latency → in-flight join territory
      call('get_pull_request_diff', { ...REPO, pull_number: 7 }),
      think(400),
      call('list_issues', { ...REPO, state: 'open' }),
      think(600),
      call('get_issue', { ...REPO, issue_number: 41 }),
      think(600), // let tail speculation settle so the spend numbers are stable
    ];

    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'strict' });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    const eligible = stats.hits + stats.joins + stats.misses;
    const hitRate = ((stats.hits + stats.joins) / eligible) * 100;
    const reduction = (1 - onRun.toolWaitMs / offRun.toolWaitMs) * 100;
    const spendPerHit =
      (stats.speculativeCalls - stats.hits - stats.joins) / Math.max(stats.hits + stats.joins, 1);

    record('workflow ceiling', stats, onRun.toolWaitMs, offRun.toolWaitMs, 'profiled review flow');

    expect(hitRate, '§10: hit rate on eligible reads ≥ 40%').toBeGreaterThanOrEqual(40);
    expect(reduction, '§10: tool-wait reduction ≥ 30%').toBeGreaterThanOrEqual(30);
    expect(stats.wastePerHit ?? 0, '§10: waste ≤ 2 per hit').toBeLessThanOrEqual(2);
    expect(spendPerHit, 'unused speculative spend ≤ 2 per hit').toBeLessThanOrEqual(2);
    expect(stats.estimatedSavedMs).toBeGreaterThan(0);
  }, 120_000);

  it('S2 adversarial floor: unpredictable session must not get slower', async () => {
    // Every prediction this script provokes targets a call that never comes:
    // list_issues(closed) → get_issue(43); get_issue(41) → comments(41) +
    // open PRs; list_pull_requests(closed) → get_pull_request(5). No
    // transition repeats, so the learner stays silent too.
    const script = [
      call('get_file_contents', { ...REPO, path: 'README.md' }),
      think(500),
      call('list_issues', { ...REPO, state: 'closed' }),
      think(500),
      call('get_issue', { ...REPO, issue_number: 41 }),
      think(500),
      call('get_pull_request_diff', { ...REPO, pull_number: 5 }),
      think(500),
      call('list_pull_requests', { ...REPO, state: 'closed' }),
      think(500),
      call('get_file_contents', { ...REPO, path: 'src/limiter.ts' }),
      think(500),
    ];

    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'strict' });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    record(
      'adversarial floor',
      stats,
      onRun.toolWaitMs,
      offRun.toolWaitMs,
      'predictions never used',
    );

    // The floor promise is "purely additive": real traffic never pays
    // materially for wrong guesses (§3.3), and spend stays capped (§5.6).
    expect(
      onRun.toolWaitMs,
      'on-run must not be materially slower than off',
    ).toBeLessThanOrEqual(offRun.toolWaitMs * 1.25 + 250);
    expect(stats.speculativeCalls).toBeLessThanOrEqual(stats.realCalls * 3);
    const requested = new Set(script.filter((s) => 'tool' in s).map((s) => (s as { tool: string }).tool));
    for (const tool of loggedTools(on.callLogPath)) {
      if (!requested.has(tool)) {
        expect(READ_TOOLS.has(tool), `speculated on non-allowlisted tool ${tool}`).toBe(true);
      }
    }
  }, 120_000);

  it('S3 mutation-heavy: writes invalidate, reads see their effects, writes reach upstream exactly once', async () => {
    const script = [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(600), // comments(42) + open-PRs prefetches land — pre-write data
      call('add_issue_comment', { ...REPO, issue_number: 42, body: 'scenario-comment' }),
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
      call('merge_pull_request', { ...REPO, pull_number: 7 }),
      call('get_pull_request', { ...REPO, pull_number: 7 }),
      think(400), // let tail speculation settle before reading stats
    ];

    // Each proxy spawns its own mock, so the off-run's writes are isolated.
    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'strict' });
    const onRun = await runScript(on.client, script);

    // The flush must beat the post-write read: a stale hit would miss the
    // new comment.
    const afterWrite = onRun.perCall[2]!;
    const comments = textPayload<{ body: string }[]>(afterWrite.result);
    expect(comments.some((c) => c.body === 'scenario-comment'), 'read-your-own-writes').toBe(true);
    expect(afterWrite.ms, 'post-write read is live').toBeGreaterThanOrEqual(LIVE_MS);
    expect(textPayload<{ state: string }>(onRun.perCall[4]!.result).state).toBe('merged');

    const stats = await readStats(on.client);
    record(
      'mutation-heavy',
      stats,
      onRun.toolWaitMs,
      offRun.toolWaitMs,
      'writes flush; reads stay correct',
    );

    expect(stats.invalidated, 'mutations invalidated cached entries').toBeGreaterThanOrEqual(1);
    const upstream = loggedTools(on.callLogPath);
    for (const write of ['add_issue_comment', 'merge_pull_request']) {
      expect(
        upstream.filter((t) => t === write).length,
        `${write} reaches upstream exactly once`,
      ).toBe(1);
    }
    for (const tool of upstream) {
      if (!READ_TOOLS.has(tool)) {
        expect(
          ['add_issue_comment', 'merge_pull_request'].includes(tool),
          `unexpected non-read upstream call ${tool}`,
        ).toBe(true);
      }
    }
  }, 60_000);

  it('S4 zero-think burst: no idle to harvest, and no penalty either', async () => {
    const script = [
      call('get_issue', { ...REPO, issue_number: 42 }),
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
      call('list_pull_requests', { ...REPO, state: 'open' }),
      call('get_pull_request', { ...REPO, pull_number: 7 }),
      call('get_pull_request_diff', { ...REPO, pull_number: 7 }),
    ];

    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'strict' });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    record(
      'zero-think burst',
      stats,
      onRun.toolWaitMs,
      offRun.toolWaitMs,
      `joins ${stats.joins}, stdio delays ${stats.stdioDelays}`,
    );

    // §3.1's bounded-delay promise, measured: even with zero head start the
    // on-run stays within noise + one bounded stdio wait of the off-run.
    expect(onRun.toolWaitMs).toBeLessThanOrEqual(offRun.toolWaitMs * 1.35 + 300);
  }, 60_000);

  it('S5 learner warm-up: an unprofiled server earns hits from repetition', async () => {
    const script = [41, 42, 43, 41].flatMap((n) => [
      call('get_issue', { ...REPO, issue_number: n }),
      think(500),
      call('get_issue_comments', { ...REPO, issue_number: n }),
    ]);

    const off = await startProxy({ mode: 'off', profile: 'none' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'annotated', profile: 'none' });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    const curve = onRun.perCall.filter((c) => c.tool === 'get_issue_comments').map((c) => c.ms);
    console.log(
      `  S5 learner warm-up curve (follow-up latency per iteration): ${curve
        .map((ms, i) => `#${i + 1} ${fmtMs(ms)}`)
        .join(' · ')}`,
    );
    record('learner warm-up', stats, onRun.toolWaitMs, offRun.toolWaitMs, 'unprofiled server');

    expect(curve[0]!, 'iteration 1 is cold (live)').toBeGreaterThanOrEqual(LIVE_MS);
    expect(curve[2]!, 'iteration 3 is prefetched').toBeLessThan(HIT_MS);
    expect(curve[3]!, 'iteration 4 stays prefetched').toBeLessThan(HIT_MS);
    expect(stats.perRule.some((r) => r.ruleId.startsWith('learned:'))).toBe(true);
  }, 60_000);

  it('S6 TTL expiry: a stale entry is never served', async () => {
    const script = [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(1200), // prefetch lands ~L, then outlives its 350 ms TTL
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
    ];

    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({
      mode: 'strict',
      speculation: { ttlMsByTool: { get_issue_comments: 350 } },
    });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    record('ttl expiry', stats, onRun.toolWaitMs, offRun.toolWaitMs, 'expired entry → live call');

    expect(onRun.perCall[1]!.ms, 'expired entry not served').toBeGreaterThanOrEqual(LIVE_MS);
    expect(stats.expired).toBeGreaterThanOrEqual(1);
    expect(stats.hits).toBe(0);
  }, 60_000);

  it('S7 budget storm: maxPerMinute caps spend and real calls are untouched', async () => {
    const script = [
      call('get_issue', { ...REPO, issue_number: 41 }),
      think(450),
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(450),
      call('list_issues', { ...REPO, state: 'open' }),
      think(450),
    ];

    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({
      mode: 'strict',
      speculation: { maxPerMinute: 2 },
    });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    record(
      'budget storm',
      stats,
      onRun.toolWaitMs,
      offRun.toolWaitMs,
      `cap 2 → spec ${stats.speculativeCalls}`,
    );

    expect(stats.speculativeCalls, 'per-minute budget respected').toBeLessThanOrEqual(2);
    expect(stats.realCalls).toBe(3);
    for (const c of onRun.perCall) {
      expect(c.result.isError ?? false, `real call ${c.tool} succeeded`).toBe(false);
    }
    const suppressionReasons = Object.keys(stats.suppressed);
    expect(
      suppressionReasons.some((r) => r.includes('minute') || r.includes('budget')),
      `budget suppressions recorded (saw: ${suppressionReasons.join(', ') || 'none'})`,
    ).toBe(true);
  }, 60_000);

  it('S8 think-time sweep: savings scale with the idle head start', async () => {
    const chain = (thinkMs: number): Step[] => [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(thinkMs),
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
      think(thinkMs),
      call('list_pull_requests', { ...REPO, state: 'open' }),
      think(thinkMs),
      call('get_pull_request', { ...REPO, pull_number: 7 }),
    ];

    const sweep: {
      thinkMs: number;
      followUpWaitMs: number;
      totalMs: number;
      stats: StatsReport;
    }[] = [];
    for (const thinkMs of [0, 300, 1000]) {
      const { client } = await startProxy({ mode: 'strict' });
      const run = await runScript(client, chain(thinkMs));
      const stats = await readStats(client);
      const followUpWaitMs = run.perCall.slice(1).reduce((a, c) => a + c.ms, 0);
      sweep.push({ thinkMs, followUpWaitMs, totalMs: run.toolWaitMs, stats });
    }
    const off = await startProxy({ mode: 'off' });
    const offRun = await runScript(off.client, chain(1000));

    console.log(
      `  S8 think-time sweep (3 follow-up reads): ${sweep
        .map(
          (s) =>
            `${s.thinkMs}ms think → wait ${fmtMs(s.followUpWaitMs)} (${s.stats.hits}h/${s.stats.joins}j, saved ${fmtMs(s.stats.estimatedSavedMs)})`,
        )
        .join(' · ')}`,
    );
    const last = sweep[sweep.length - 1]!;
    record(
      'think-time sweep',
      last.stats,
      last.totalMs,
      offRun.toolWaitMs,
      'row = 1000 ms think; sweep above',
    );

    expect(
      last.followUpWaitMs,
      'long think beats zero think',
    ).toBeLessThan(sweep[0]!.followUpWaitMs * 0.75);
    expect(last.stats.hits, 'long think converts to completed prefetches').toBeGreaterThanOrEqual(2);
    expect(last.stats.estimatedSavedMs).toBeGreaterThanOrEqual(sweep[0]!.stats.estimatedSavedMs);
  }, 120_000);

  it('S9 session-start priming: a session-opening read goes from cold to prefetched (v0.10)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'speculate-openers-'));
    const statePath = join(stateDir, 'state.json');
    const firstCallMs: number[] = [];
    let finalStats: StatsReport | null = null;

    // Three sessions sharing one state file, each opening with the same read.
    for (let session = 1; session <= 3; session++) {
      const h = await startProxy({ mode: 'strict', statePath });
      await sleep(700); // the pre-first-request idle window (§13.15)
      const run = await runScript(h.client, [call('get_issue', { ...REPO, issue_number: 42 })]);
      firstCallMs.push(run.perCall[0]!.ms);
      await sleep(1_300); // let the debounced state save land
      if (session === 3) finalStats = await readStats(h.client);
      await closeHarness(h);
    }
    rmSync(stateDir, { recursive: true, force: true });

    console.log(
      `  S9 first-call latency per session: ${firstCallMs
        .map((ms, i) => `#${i + 1} ${fmtMs(ms)}`)
        .join(' · ')}`,
    );
    record(
      'session-start priming',
      finalStats!,
      firstCallMs[2]!,
      firstCallMs[0]!,
      'first call: cold session vs primed session',
    );

    expect(firstCallMs[0]!, 'session 1 opener is cold').toBeGreaterThanOrEqual(LIVE_MS);
    expect(firstCallMs[1]!, 'session 2 opener still cold (threshold is 2)').toBeGreaterThanOrEqual(
      LIVE_MS,
    );
    expect(firstCallMs[2]!, 'session 3 opener is prefetched at start').toBeLessThan(HIT_MS);
    expect(
      finalStats!.perRule.some((r) => r.ruleId === 'opener:github:get_issue' && r.hits >= 1),
      'the opener rule owns the hit',
    ).toBe(true);
  }, 120_000);

  it('S10 filesystem profile: listing/search flows meet the §10 criteria (v0.10)', async () => {
    const script = [
      call('list_directory', { path: '/ws/src' }),
      think(600), // fs:list→read prefetches the first files
      call('read_text_file', { path: '/ws/src/app.ts' }),
      think(400),
      call('read_text_file', { path: '/ws/src/util.ts' }),
      think(400),
      call('search_files', { path: '/ws', pattern: 'limiter' }),
      think(600), // fs:search→read prefetches the match
      call('read_text_file', { path: '/ws/src/lib/limiter.ts' }),
      think(400),
    ];

    const off = await startProxy({ mode: 'off', server: 'filesystem' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'strict', server: 'filesystem' });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    const eligible = stats.hits + stats.joins + stats.misses;
    const hitRate = ((stats.hits + stats.joins) / eligible) * 100;
    const reduction = (1 - onRun.toolWaitMs / offRun.toolWaitMs) * 100;
    record('filesystem profile', stats, onRun.toolWaitMs, offRun.toolWaitMs, 'new vetted profile');

    expect(hitRate, 'hit rate ≥ 40%').toBeGreaterThanOrEqual(40);
    expect(reduction, 'tool-wait reduction ≥ 30%').toBeGreaterThanOrEqual(30);
    expect(stats.wastePerHit ?? 0).toBeLessThanOrEqual(2);
  }, 120_000);

  it('S11 slack profile: channel/thread/user flows meet the §10 criteria (v0.10)', async () => {
    const script = [
      call('slack_list_channels', {}),
      think(600), // slack:channels→history prefetches the top channels
      call('slack_get_channel_history', { channel_id: 'C0001' }),
      think(600), // slack:history→thread prefetches the threaded message
      call('slack_get_thread_replies', { channel_id: 'C0001', thread_ts: '1752500000.000100' }),
      think(400),
      call('slack_get_users', {}),
      think(600), // slack:users→profile prefetches the top users
      call('slack_get_user_profile', { user_id: 'U100' }),
      think(400),
    ];

    const off = await startProxy({ mode: 'off', server: 'slack' });
    const offRun = await runScript(off.client, script);
    const on = await startProxy({ mode: 'strict', server: 'slack' });
    const onRun = await runScript(on.client, script);
    const stats = await readStats(on.client);

    const eligible = stats.hits + stats.joins + stats.misses;
    const hitRate = ((stats.hits + stats.joins) / eligible) * 100;
    const reduction = (1 - onRun.toolWaitMs / offRun.toolWaitMs) * 100;
    record('slack profile', stats, onRun.toolWaitMs, offRun.toolWaitMs, 'new vetted profile');

    expect(hitRate, 'hit rate ≥ 40%').toBeGreaterThanOrEqual(40);
    expect(reduction, 'tool-wait reduction ≥ 30%').toBeGreaterThanOrEqual(30);
    expect(stats.wastePerHit ?? 0).toBeLessThanOrEqual(2);
  }, 120_000);

  it('S12 receipts: usage accumulates across sessions, stats reads it, contents stay aggregate-only (v0.10)', async () => {
    const xdgStateHome = mkdtempSync(join(tmpdir(), 'speculate-receipts-'));
    const script = [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(600),
      call('get_issue_comments', { ...REPO, issue_number: 42 }), // prefetch hit
      think(1_200), // debounced usage snapshot flush
    ];

    const runs: { toolWaitMs: number }[] = [];
    let finalReceiptStats: StatsReport | null = null;
    for (let session = 1; session <= 2; session++) {
      const h = await startProxy({ mode: 'strict', xdgStateHome });
      runs.push(await runScript(h.client, script));
      if (session === 2) finalReceiptStats = await readStats(h.client);
      await closeHarness(h);
    }
    await sleep(300); // let the shutdown flush settle

    const statsCliOut = execFileSync(
      process.execPath,
      [TSX_CLI, join(ROOT, 'src', 'cli.ts'), 'stats', '--json'],
      { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: xdgStateHome } },
    );
    const report = JSON.parse(statsCliOut) as {
      totals: { sessions: number; hits: number; joins: number; estimatedSavedMs: number };
      bySource: { mcp: { sessions: number; hits: number } };
    };
    expect(report.totals.sessions, 'both sessions counted').toBe(2);
    expect(report.bySource.mcp.sessions).toBe(2);
    expect(
      report.totals.hits + report.totals.joins,
      'hits accumulated across sessions',
    ).toBeGreaterThanOrEqual(2);
    expect(report.totals.estimatedSavedMs).toBeGreaterThan(0);

    // Usage snapshots are aggregate-only: no tool or server names, no
    // arguments, and never fetched result content.
    const usageDir = join(xdgStateHome, 'speculate', 'usage');
    const snapshotFiles = readdirSync(usageDir).filter((f) => f.endsWith('.json'));
    expect(snapshotFiles.length).toBe(2);
    for (const file of snapshotFiles) {
      const text = readFileSync(join(usageDir, file), 'utf8');
      for (const leaked of [
        'get_issue',
        '"args"',
        'Rate limiter drops burst',
        'Token bucket refill',
        'Repro: 100 rps',
      ]) {
        expect(text, `usage snapshot must not contain "${leaked}"`).not.toContain(leaked);
      }
    }

    record(
      'receipts (2 sessions)',
      finalReceiptStats!,
      runs[1]!.toolWaitMs,
      runs[0]!.toolWaitMs,
      'row = session1 vs session2 wait',
    );
    rmSync(xdgStateHome, { recursive: true, force: true });
  }, 120_000);
});
