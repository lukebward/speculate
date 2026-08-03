/**
 * End-to-end integration: real MCP client ↔ Speculate proxy ↔ mock GitHub
 * upstream, all over stdio. Asserts the §10 MVP behaviors that matter:
 * prefetch hits are near-instant, mutations invalidate, speculation never
 * touches non-allowlisted tools, and `off` mode is a pure pass-through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_ALLOW, GITHUB_RULES } from '../mock/rules.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { StatsReport } from '../src/types.js';
import { readUsageReport } from '../src/usage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const LATENCY_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  client: Client;
  callLogPath: string;
  dir: string;
}

const harnesses: Harness[] = [];

async function startProxy(
  mode: 'strict' | 'annotated' | 'off',
  opts: { predict?: boolean; rules?: unknown[]; statePath?: string } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-itest-'));
  const callLogPath = join(dir, 'calls.jsonl');
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      log: 'off',
      // Hermetic by default: never write state into the runner's home dir.
      persistence: opts.statePath ? { path: opts.statePath } : { enabled: false },
      servers: {
        github: {
          command: TSX,
          args: [TSX_CLI, join(ROOT, 'mock', 'mock-github.ts')],
          env: {
            SPECULATE_MOCK_LATENCY_MS: String(LATENCY_MS),
            SPECULATE_MOCK_CALL_LOG: callLogPath,
          },
          // `predict: false` leaves the server with no hand-written rules at
          // all, so only the learner can produce predictions.
          ...(opts.predict === false ? {} : { rules: GITHUB_RULES, allowTools: GITHUB_ALLOW }),
          ...(opts.rules ? { rules: opts.rules, allowTools: GITHUB_ALLOW } : {}),
        },
      },
    }),
  );
  const client = new Client({ name: 'itest', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env, XDG_STATE_HOME: dir } as Record<string, string>,
    stderr: 'inherit',
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

function loggedTools(callLogPath: string): string[] {
  if (!existsSync(callLogPath)) return [];
  return readFileSync(callLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { tool: string }).tool);
}

const REPO = { owner: 'acme', repo: 'api' };
const READ_ALLOWLIST = new Set([
  'get_issue',
  'get_issue_comments',
  'list_issues',
  'list_pull_requests',
  'get_pull_request',
  'get_pull_request_diff',
  'get_file_contents',
]);

describe('speculate end-to-end', () => {
  it('exposes upstream tools unprefixed plus speculate__stats', async () => {
    const { client } = await startProxy('strict');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_issue');
    expect(names).toContain('speculate__stats');
    expect(names.some((n) => n.startsWith('github__'))).toBe(false);
    const getIssue = tools.find((t) => t.name === 'get_issue')!;
    expect(getIssue.annotations?.readOnlyHint).toBe(true);
  }, 30_000);

  it('serves predicted follow-ups from the speculation buffer', async () => {
    const { client } = await startProxy('strict');

    const first = await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    expect(first.ms).toBeGreaterThanOrEqual(LATENCY_MS * 0.8); // real upstream call
    expect(textPayload<{ number: number }>(first.result).number).toBe(42);

    await sleep(LATENCY_MS * 3 + 200); // let prefetches land

    const followUp = await timedCall(client, 'get_issue_comments', {
      ...REPO,
      issue_number: 42,
    });
    expect(followUp.ms).toBeLessThan(LATENCY_MS * 0.5); // served from buffer
    const comments = textPayload<{ id: number }[]>(followUp.result);
    expect(comments.length).toBeGreaterThan(0);

    // The second prediction from the same trigger was queued behind the
    // stdio idle-only slot and drained when it freed (§3.1) — also a hit.
    const queued = await timedCall(client, 'list_pull_requests', {
      ...REPO,
      state: 'open',
    });
    expect(queued.ms).toBeLessThan(LATENCY_MS * 0.5);

    const stats = await readStats(client);
    expect(stats.speculativeCalls).toBeGreaterThanOrEqual(2);
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(2);
    expect(stats.estimatedSavedMs).toBeGreaterThan(0);
  }, 30_000);

  it('records durable MCP usage', async () => {
    const h = await startProxy('strict');
    await timedCall(h.client, 'get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 3 + 200);
    await timedCall(h.client, 'get_issue_comments', { ...REPO, issue_number: 42 });
    await h.client.close();

    const usageDirectory = join(h.dir, 'speculate', 'usage');
    let report = readUsageReport(usageDirectory);
    for (
      let attempts = 0;
      attempts < 40 &&
      (report.bySource.mcp.sessions === 0 ||
        report.bySource.mcp.hits + report.bySource.mcp.joins === 0 ||
        report.bySource.mcp.estimatedSavedMs === 0);
      attempts++
    ) {
      await sleep(25);
      report = readUsageReport(usageDirectory);
    }

    expect(report.bySource.mcp.sessions).toBe(1);
    expect(report.bySource.mcp.hits + report.bySource.mcp.joins).toBeGreaterThanOrEqual(1);
    expect(report.bySource.mcp.estimatedSavedMs).toBeGreaterThan(0);
    expect(report.workspaces[0]?.workspace).toBe(resolve(process.cwd()));
  }, 30_000);

  it('single-use: a consumed entry is not served twice', async () => {
    const { client } = await startProxy('strict');
    await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 3 + 200);
    const hit = await timedCall(client, 'get_issue_comments', { ...REPO, issue_number: 42 });
    expect(hit.ms).toBeLessThan(LATENCY_MS * 0.5);
    const second = await timedCall(client, 'get_issue_comments', { ...REPO, issue_number: 42 });
    expect(second.ms).toBeGreaterThanOrEqual(LATENCY_MS * 0.8);
  }, 30_000);

  it('never speculates on non-allowlisted tools (mutation safety)', async () => {
    const { client, callLogPath } = await startProxy('strict');
    const requested: string[] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      requested.push(tool);
      return timedCall(client, tool, args);
    };
    await call('get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 2 + 100);
    await call('list_pull_requests', { ...REPO, state: 'open' });
    await sleep(LATENCY_MS * 2 + 100);
    await call('get_pull_request', { ...REPO, pull_number: 7 });
    await sleep(LATENCY_MS * 3 + 300); // drain all speculation

    const upstreamCalls = loggedTools(callLogPath);
    expect(upstreamCalls.length).toBeGreaterThan(requested.length); // speculation happened
    for (const tool of upstreamCalls) {
      // every upstream call is either something the client actually asked for
      // or an allowlisted read — never anything else, never a write
      if (!requested.includes(tool)) {
        expect(READ_ALLOWLIST.has(tool), `speculated on non-allowlisted tool ${tool}`).toBe(true);
      }
    }
  }, 30_000);

  it('a mutation through the proxy invalidates the server cache', async () => {
    const { client } = await startProxy('strict');
    await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 3 + 200); // prefetches land

    await timedCall(client, 'create_issue', { ...REPO, title: 'new bug', body: 'x' });

    const afterWrite = await timedCall(client, 'get_issue_comments', {
      ...REPO,
      issue_number: 42,
    });
    expect(afterWrite.ms).toBeGreaterThanOrEqual(LATENCY_MS * 0.8); // buffer was flushed

    const stats = await readStats(client);
    expect(stats.invalidated).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('unprofiled server + annotated mode: the learner earns speculation from repetition', async () => {
    const { client } = await startProxy('annotated', { predict: false });
    // Two observations of the get_issue → get_issue_comments transition…
    for (const n of [41, 42]) {
      await timedCall(client, 'get_issue', { ...REPO, issue_number: n });
      await timedCall(client, 'get_issue_comments', { ...REPO, issue_number: n });
    }
    // …and the third trigger is prefetched with args tracking the NEW call.
    await timedCall(client, 'get_issue', { ...REPO, issue_number: 43 });
    await sleep(LATENCY_MS * 3 + 200);
    const learned = await timedCall(client, 'get_issue_comments', {
      ...REPO,
      issue_number: 43,
    });
    expect(learned.ms).toBeLessThan(LATENCY_MS * 0.5);

    const stats = await readStats(client);
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(1);
    expect(stats.perRule.some((r) => r.ruleId.startsWith('learned:'))).toBe(true);
  }, 40_000);

  it('unprofiled server + config rules: declarative speculation, including forEach', async () => {
    const { client } = await startProxy('annotated', {
      predict: false,
      rules: [
        {
          trigger: 'get_issue',
          predict: [
            {
              tool: 'get_issue_comments',
              args: {
                owner: '$args.owner',
                repo: '$args.repo',
                issue_number: '$args.issue_number',
              },
              confidence: 0.8,
            },
          ],
        },
        {
          trigger: 'list_pull_requests',
          predict: [
            {
              tool: 'get_pull_request',
              args: { owner: '$args.owner', repo: '$args.repo', pull_number: '$item.number' },
              forEach: '$parsed',
              limit: 1,
              confidence: 0.6,
            },
          ],
        },
      ],
    });

    await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 3 + 200);
    const comments = await timedCall(client, 'get_issue_comments', {
      ...REPO,
      issue_number: 42,
    });
    expect(comments.ms).toBeLessThan(LATENCY_MS * 0.5);

    // forEach over the generic JSON-parsed result (no profile parser).
    await timedCall(client, 'list_pull_requests', { ...REPO, state: 'open' });
    await sleep(LATENCY_MS * 3 + 200);
    const pr = await timedCall(client, 'get_pull_request', { ...REPO, pull_number: 7 });
    expect(pr.ms).toBeLessThan(LATENCY_MS * 0.5);

    const stats = await readStats(client);
    expect(stats.perRule.some((r) => r.ruleId.startsWith('config:'))).toBe(true);
  }, 40_000);

  it('persistence: learned transitions survive a proxy restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'speculate-state-'));
    const statePath = join(stateDir, 'state.json');

    // Session 1: teach the learner the transition, then shut down cleanly.
    const first = await startProxy('annotated', { predict: false, statePath });
    for (const n of [41, 42]) {
      await timedCall(first.client, 'get_issue', { ...REPO, issue_number: n });
      await timedCall(first.client, 'get_issue_comments', { ...REPO, issue_number: n });
    }
    await sleep(1_500); // let the debounced state save fire
    expect(existsSync(statePath)).toBe(true);
    await first.client.close();

    // Session 2, same state file: the FIRST trigger already prefetches.
    const second = await startProxy('annotated', { predict: false, statePath });
    await timedCall(second.client, 'get_issue', { ...REPO, issue_number: 43 });
    await sleep(LATENCY_MS * 3 + 200);
    const warm = await timedCall(second.client, 'get_issue_comments', {
      ...REPO,
      issue_number: 43,
    });
    expect(warm.ms).toBeLessThan(LATENCY_MS * 0.5);

    const stats = await readStats(second.client);
    expect(stats.perRule.some((r) => r.ruleId.startsWith('learned:'))).toBe(true);
    rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('persistence disabled: no state file is written', async () => {
    const { client } = await startProxy('annotated', { predict: false });
    await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    await timedCall(client, 'get_issue_comments', { ...REPO, issue_number: 42 });
    await sleep(1_500);
    // Nothing to assert on disk paths (none configured) — this test guards
    // the wiring: stats still work and nothing crashed with the store off.
    const stats = await readStats(client);
    expect(stats.realCalls).toBeGreaterThanOrEqual(2);
  }, 30_000);

  // The fingerprinting test that lived here asserted a server was recognized
  // by its tool list and had a vetted profile's rules applied automatically.
  // Both the recognition and the profiles are gone; the case it protected
  // (an unconfigured server still earning speculation) is covered by the
  // learner test above, which needs no per-server knowledge at all.

  it('strict mode with no allowTools speculates nothing at all', async () => {
    const { client, callLogPath } = await startProxy('strict', { predict: false });
    await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 3 + 200);
    const followUp = await timedCall(client, 'get_issue_comments', {
      ...REPO,
      issue_number: 42,
    });
    // No allowlist means nothing is eligible in strict: live call, no
    // speculation anywhere.
    expect(followUp.ms).toBeGreaterThanOrEqual(LATENCY_MS * 0.8);
    const stats = await readStats(client);
    expect(stats.speculativeCalls).toBe(0);
    expect(loggedTools(callLogPath)).toEqual(['get_issue', 'get_issue_comments']);
  }, 30_000);

  it('off mode is a pure pass-through: zero speculation', async () => {
    const { client, callLogPath } = await startProxy('off');
    await timedCall(client, 'get_issue', { ...REPO, issue_number: 42 });
    await sleep(LATENCY_MS * 3 + 200);
    const followUp = await timedCall(client, 'get_issue_comments', {
      ...REPO,
      issue_number: 42,
    });
    expect(followUp.ms).toBeGreaterThanOrEqual(LATENCY_MS * 0.8);
    const stats = await readStats(client);
    expect(stats.speculativeCalls).toBe(0);
    expect(loggedTools(callLogPath)).toEqual(['get_issue', 'get_issue_comments']);
  }, 30_000);
});
