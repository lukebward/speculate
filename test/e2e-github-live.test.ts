/**
 * Live e2e: real MCP client ↔ Speculate proxy ↔ bundled gh workspace server ↔
 * real GitHub. Real latency, no injected sleep. Gated: runs only with
 * SPECULATE_E2E_LIVE=1 and an authenticated gh; otherwise skipped so `npm test`
 * stays hermetic. Target repo via SPECULATE_E2E_REPO (default cli/cli).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const REPO = process.env.SPECULATE_E2E_REPO ?? 'cli/cli';
const THINK_GAP_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function liveReady(): { ok: boolean; reason: string } {
  if (process.env.SPECULATE_E2E_LIVE !== '1')
    return { ok: false, reason: 'set SPECULATE_E2E_LIVE=1 to run the live GitHub e2e' };
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    return { ok: false, reason: 'gh is not authenticated (run: gh auth login)' };
  }
  return { ok: true, reason: '' };
}
const LIVE = liveReady();
if (!LIVE.ok) console.warn(`[e2e-github-live] SKIP: ${LIVE.reason}`);

interface Harness {
  client: Client;
  dir: string;
}
const harnesses: Harness[] = [];

async function startWrappedShell(mode: 'annotated' | 'off'): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-e2e-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      log: 'off',
      persistence: { enabled: false },
      servers: {
        workspace: {
          command: TSX,
          args: [TSX_CLI, join(ROOT, 'shell', 'speculate-shell.ts'), '--cwd', ROOT],
          // forward token-env auth so the child matches what liveReady()'s gh-auth check validated
          env: {
            GH_REPO: REPO,
            ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
            ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
          },
          profile: 'none',
        },
      },
    }),
  );
  const client = new Client({ name: 'e2e-live', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'inherit',
  });
  await client.connect(transport);
  const h = { client, dir };
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

function payloadText(result: CallToolResult): string {
  return (
    (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? ''
  );
}
function parsePayload<T>(result: CallToolResult): T {
  return JSON.parse(payloadText(result)) as T;
}
async function readStats(client: Client): Promise<StatsReport> {
  const { result } = await timedCall(client, 'speculate__stats', {});
  return parsePayload<StatsReport>(result);
}

// gh catalog tools return { exitCode, output: [...] }; the top item's number.
async function topNumber(
  client: Client,
  listTool: 'gh_pr_list' | 'gh_issue_list',
): Promise<number> {
  const { result } = await timedCall(client, listTool, { limit: 10 });
  const out = parsePayload<{ output: { number: number }[] }>(result).output;
  expect(out.length, `repo ${REPO} must have an open ${listTool === 'gh_pr_list' ? 'PR' : 'issue'}`).toBeGreaterThan(0);
  return out[0].number;
}

describe.skipIf(!LIVE.ok)('live github e2e', () => {
  it('exposes gh tools, read-only annotated, targeting the configured repo', async () => {
    const { client } = await startWrappedShell('annotated');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('gh_pr_list');
    expect(names).toContain('gh_pr_view');
    expect(names).toContain('speculate__stats');
    expect(tools.find((t) => t.name === 'gh_pr_list')!.annotations?.readOnlyHint).toBe(true);
    // Real call proves GH_REPO redirection + auth in the child.
    const n = await topNumber(client, 'gh_pr_list');
    expect(n).toBeGreaterThan(0);
  }, 60_000);

  it('learner prefetches gh_pr_view from a real gh_pr_list (real latency)', async () => {
    const { client } = await startWrappedShell('annotated');

    // Warm-up ×2: teach gh_pr_list → gh_pr_view(top-of-that-list).
    for (let i = 0; i < 2; i++) {
      const n = await topNumber(client, 'gh_pr_list');
      await timedCall(client, 'gh_pr_view', { number: n });
    }

    // The gh_pr_list/gh_pr_view pair is morphologically primed, so it arms early;
    // deriving `n` from THIS pass's list makes it match the prediction by construction.
    await sleep(THINK_GAP_MS);
    const n = await topNumber(client, 'gh_pr_list');
    await sleep(THINK_GAP_MS);
    const view = await timedCall(client, 'gh_pr_view', { number: n });
    expect(view.result.isError ?? false).toBe(false);

    const stats = await readStats(client);
    console.log(`[e2e-github-live] PR gh_pr_view served in ${view.ms.toFixed(0)}ms; ` +
      `hits=${stats.hits} joins=${stats.joins} savedMs≈${stats.estimatedSavedMs}`);
    expect(stats.hits + stats.joins, 'a prefetch should have served gh_pr_view').toBeGreaterThanOrEqual(1);
    expect(
      stats.perRule.some((r) => r.ruleId.startsWith('learned:') && r.ruleId.endsWith('→gh_pr_view')),
      'a learned gh_pr_list→gh_pr_view rule should exist',
    ).toBe(true);
  }, 90_000);

  it('speculated gh_pr_view bytes are byte-identical to a direct upstream call', async () => {
    const on = await startWrappedShell('annotated');
    for (let i = 0; i < 2; i++) {
      const w = await topNumber(on.client, 'gh_pr_list');
      await timedCall(on.client, 'gh_pr_view', { number: w });
    }
    await sleep(THINK_GAP_MS);
    const n = await topNumber(on.client, 'gh_pr_list');
    await sleep(THINK_GAP_MS);
    const speculated = payloadText((await timedCall(on.client, 'gh_pr_view', { number: n })).result);

    // Confirm this really came from a prefetch (not a live fallback).
    const stats = await readStats(on.client);
    console.log(`[e2e-github-live] byte-identity: hits=${stats.hits} joins=${stats.joins}`);
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(1);

    // Direct, unwrapped: off-mode proxy is a pure pass-through to the same server.
    const off = await startWrappedShell('off');
    const direct = payloadText((await timedCall(off.client, 'gh_pr_view', { number: n })).result);

    expect(speculated).toBe(direct);
  }, 90_000);

  it('learner prefetches gh_issue_view from a real gh_issue_list (real latency)', async () => {
    const { client } = await startWrappedShell('annotated');
    for (let i = 0; i < 2; i++) {
      const n = await topNumber(client, 'gh_issue_list');
      await timedCall(client, 'gh_issue_view', { number: n });
    }
    await sleep(THINK_GAP_MS);
    const n = await topNumber(client, 'gh_issue_list');
    await sleep(THINK_GAP_MS);
    const view = await timedCall(client, 'gh_issue_view', { number: n });
    expect(view.result.isError ?? false).toBe(false);

    const stats = await readStats(client);
    console.log(`[e2e-github-live] issue gh_issue_view served in ${view.ms.toFixed(0)}ms; ` +
      `hits=${stats.hits} joins=${stats.joins} savedMs≈${stats.estimatedSavedMs}`);
    expect(stats.hits + stats.joins, 'a prefetch should have served gh_issue_view').toBeGreaterThanOrEqual(1);
    expect(
      stats.perRule.some((r) => r.ruleId.startsWith('learned:') && r.ruleId.endsWith('→gh_issue_view')),
      'a learned gh_issue_list→gh_issue_view rule should exist',
    ).toBe(true);
  }, 90_000);
});
