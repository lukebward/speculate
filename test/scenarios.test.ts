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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, StatsReport } from '../src/types.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

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
  dir: string;
}

const harnesses: Harness[] = [];

async function startProxy(
  opts: {
    mode?: 'strict' | 'annotated' | 'off';
    profile?: 'github' | 'none';
    speculation?: ServerConfig['speculation'];
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-scenario-'));
  const callLogPath = join(dir, 'calls.jsonl');
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: opts.mode ?? 'strict',
      log: 'off',
      persistence: { enabled: false }, // hermetic: no learner state on disk
      servers: {
        github: {
          command: TSX,
          args: [join(ROOT, 'mock', 'mock-github.ts')],
          env: {
            SPECULATE_MOCK_LATENCY_MS: String(L),
            SPECULATE_MOCK_CALL_LOG: callLogPath,
          },
          profile: opts.profile ?? 'github',
          ...(opts.speculation ? { speculation: opts.speculation } : {}),
        },
      },
    }),
  );
  const client = new Client({ name: 'scenario', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);
  const h = { client, callLogPath, dir };
  harnesses.push(h);
  return h;
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
  offMs: number | null;
  onMs: number;
  savedMs: number;
  note: string;
}

const rows: Row[] = [];

function record(
  name: string,
  stats: StatsReport,
  onMs: number,
  offMs: number | null,
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

const fmtMs = (ms: number | null): string =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;

afterAll(() => {
  const pad = (s: string, w: number) => s.padEnd(w);
  const num = (s: string, w: number) => s.padStart(w);
  console.log(`\n  scenario metrics (upstream latency ${L} ms, mock GitHub, speculation on)\n`);
  console.log(
    `  ${pad('scenario', 26)}${num('reads', 6)}${num('hit%', 6)}${num('spec', 6)}${num('unused', 7)}${num('off', 9)}${num('on', 9)}${num('cut', 6)}${num('saved', 9)}  note`,
  );
  console.log(`  ${'─'.repeat(104)}`);
  for (const r of rows) {
    const cut =
      r.offMs === null ? '—' : `${Math.round((1 - r.onMs / Math.max(r.offMs, 1)) * 100)}%`;
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
    const { client, callLogPath } = await startProxy({ mode: 'strict' });

    await runScript(client, [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(600), // comments(42) + open-PRs prefetches land — pre-write data
    ]);
    await runScript(client, [
      call('add_issue_comment', { ...REPO, issue_number: 42, body: 'scenario-comment' }),
    ]);

    // The flush must beat us here: a stale hit would miss the new comment.
    const afterWrite = await runScript(client, [
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
    ]);
    const comments = textPayload<{ body: string }[]>(afterWrite.perCall[0]!.result);
    expect(comments.some((c) => c.body === 'scenario-comment'), 'read-your-own-writes').toBe(true);
    expect(afterWrite.perCall[0]!.ms, 'post-write read is live').toBeGreaterThanOrEqual(LIVE_MS);

    await runScript(client, [call('merge_pull_request', { ...REPO, pull_number: 7 })]);
    const pr = await runScript(client, [
      call('get_pull_request', { ...REPO, pull_number: 7 }),
      think(400),
    ]);
    expect(textPayload<{ state: string }>(pr.perCall[0]!.result).state).toBe('merged');

    const stats = await readStats(client);
    record('mutation-heavy', stats, 0, null, 'writes flush; reads stay correct');

    expect(stats.invalidated, 'mutations invalidated cached entries').toBeGreaterThanOrEqual(1);
    const upstream = loggedTools(callLogPath);
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
    const { client } = await startProxy({ mode: 'annotated', profile: 'none' });

    const curve: number[] = [];
    for (const n of [41, 42, 43, 41]) {
      await runScript(client, [call('get_issue', { ...REPO, issue_number: n }), think(500)]);
      const followUp = await runScript(client, [
        call('get_issue_comments', { ...REPO, issue_number: n }),
      ]);
      curve.push(followUp.perCall[0]!.ms);
    }
    const stats = await readStats(client);

    console.log(
      `  S5 learner warm-up curve (follow-up latency per iteration): ${curve
        .map((ms, i) => `#${i + 1} ${fmtMs(ms)}`)
        .join(' · ')}`,
    );
    record('learner warm-up', stats, curve.reduce((a, b) => a + b, 0), null, 'unprofiled server');

    expect(curve[0]!, 'iteration 1 is cold (live)').toBeGreaterThanOrEqual(LIVE_MS);
    expect(curve[2]!, 'iteration 3 is prefetched').toBeLessThan(HIT_MS);
    expect(curve[3]!, 'iteration 4 stays prefetched').toBeLessThan(HIT_MS);
    expect(stats.perRule.some((r) => r.ruleId.startsWith('learned:'))).toBe(true);
  }, 60_000);

  it('S6 TTL expiry: a stale entry is never served', async () => {
    const { client } = await startProxy({
      mode: 'strict',
      speculation: { ttlMsByTool: { get_issue_comments: 350 } },
    });

    await runScript(client, [
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(1200), // prefetch lands ~L, then outlives its 350 ms TTL
    ]);
    const stale = await runScript(client, [
      call('get_issue_comments', { ...REPO, issue_number: 42 }),
    ]);
    const stats = await readStats(client);

    record('ttl expiry', stats, stale.toolWaitMs, null, 'expired entry → live call');

    expect(stale.perCall[0]!.ms, 'expired entry not served').toBeGreaterThanOrEqual(LIVE_MS);
    expect(stats.expired).toBeGreaterThanOrEqual(1);
    expect(stats.hits).toBe(0);
  }, 60_000);

  it('S7 budget storm: maxPerMinute caps spend and real calls are untouched', async () => {
    const { client } = await startProxy({
      mode: 'strict',
      speculation: { maxPerMinute: 2 },
    });

    const run = await runScript(client, [
      call('get_issue', { ...REPO, issue_number: 41 }),
      think(450),
      call('get_issue', { ...REPO, issue_number: 42 }),
      think(450),
      call('list_issues', { ...REPO, state: 'open' }),
      think(450),
    ]);
    const stats = await readStats(client);

    record('budget storm', stats, run.toolWaitMs, null, `cap 2 → spec ${stats.speculativeCalls}`);

    expect(stats.speculativeCalls, 'per-minute budget respected').toBeLessThanOrEqual(2);
    expect(stats.realCalls).toBe(3);
    for (const c of run.perCall) {
      expect(c.result.isError ?? false, `real call ${c.tool} succeeded`).toBe(false);
    }
    const suppressionReasons = Object.keys(stats.suppressed);
    expect(
      suppressionReasons.some((r) => r.includes('minute') || r.includes('budget')),
      `budget suppressions recorded (saw: ${suppressionReasons.join(', ') || 'none'})`,
    ).toBe(true);
  }, 60_000);

  it('S8 think-time sweep: savings scale with the idle head start', async () => {
    const sweep: { thinkMs: number; followUpWaitMs: number; stats: StatsReport }[] = [];
    for (const thinkMs of [0, 300, 1000]) {
      const { client } = await startProxy({ mode: 'strict' });
      const run = await runScript(client, [
        call('get_issue', { ...REPO, issue_number: 42 }),
        think(thinkMs),
        call('get_issue_comments', { ...REPO, issue_number: 42 }),
        think(thinkMs),
        call('list_pull_requests', { ...REPO, state: 'open' }),
        think(thinkMs),
        call('get_pull_request', { ...REPO, pull_number: 7 }),
      ]);
      const stats = await readStats(client);
      const followUpWaitMs = run.perCall.slice(1).reduce((a, c) => a + c.ms, 0);
      sweep.push({ thinkMs, followUpWaitMs, stats });
    }

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
      last.followUpWaitMs,
      sweep[0]!.followUpWaitMs,
      'off column = zero-think wait',
    );

    expect(
      last.followUpWaitMs,
      'long think beats zero think',
    ).toBeLessThan(sweep[0]!.followUpWaitMs * 0.75);
    expect(last.stats.hits, 'long think converts to completed prefetches').toBeGreaterThanOrEqual(2);
    expect(last.stats.estimatedSavedMs).toBeGreaterThanOrEqual(sweep[0]!.stats.estimatedSavedMs);
  }, 120_000);
});
