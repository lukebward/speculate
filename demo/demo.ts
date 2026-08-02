/**
 * Live README demo: MCP client ↔ Speculate proxy ↔ bundled mock GitHub
 * server (mock/mock-github.ts), with injected upstream latency. Two passes
 * of "list PRs, read the top one": the first pass teaches the learner
 * (both calls are real, unaccelerated), the second is served from
 * prefetch — the same single-session mechanism `speculate on` uses, just
 * watched deliberately instead of live.
 *
 * Usage: npm run demo
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resultText } from '../src/upstream.js';
import type { StatsReport } from '../src/types.js';
import { FIXTURE_OWNER, FIXTURE_REPO } from '../mock/fixtures.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const THINK_MS = 1500;
const LATENCY_MS = 400;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function callLine(label: string, ms: number, note = ''): string {
  return `    ${label.padEnd(21)}${fmtMs(ms).padStart(7)}${note ? `   ${note}` : ''}`;
}

interface PrItem {
  number: number;
  title: string;
}

async function main(): Promise<void> {
  const repo = { owner: FIXTURE_OWNER, repo: FIXTURE_REPO };

  const dir = mkdtempSync(join(tmpdir(), 'speculate-demo-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: 'annotated',
      log: 'off',
      persistence: { enabled: false },
      servers: {
        github: {
          command: TSX,
          args: [TSX_CLI, join(ROOT, 'mock', 'mock-github.ts')],
          env: { SPECULATE_MOCK_LATENCY_MS: String(LATENCY_MS) },
          // No vetted profile: this run demonstrates Tier 2 (the
          // server-agnostic learner), the same path any unprofiled MCP
          // server gets — not the GitHub profile's pre-loaded rules.
          profile: 'none',
        },
      },
    }),
  );

  const client = new Client({ name: 'demo', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);

  const timed = async (name: string, args: Record<string, unknown>) => {
    const t0 = performance.now();
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { ms: performance.now() - t0, result };
  };
  const topPr = (result: CallToolResult): PrItem => {
    const out = JSON.parse(resultText(result)) as PrItem[];
    if (!out.length) throw new Error(`fixture repo ${repo.owner}/${repo.repo} has no open PRs`);
    return out[0]!;
  };

  console.log();
  console.log(bold('  Speculate demo: list PRs, then read the top one'));
  console.log(
    dim(
      `  mock GitHub upstream · repo ${repo.owner}/${repo.repo} · ${LATENCY_MS} ms injected latency\n`,
    ),
  );

  console.log(dim('  pass 1: Speculate watches the workflow'));
  const list1 = await timed('list_pull_requests', repo);
  console.log(callLine('list_pull_requests', list1.ms));
  await sleep(THINK_MS);
  const pr1 = topPr(list1.result);
  const view1 = await timed('get_pull_request', { ...repo, pull_number: pr1.number });
  const title = pr1.title.length > 36 ? `${pr1.title.slice(0, 35)}…` : pr1.title;
  console.log(callLine(`get_pull_request #${pr1.number}`, view1.ms, dim(`"${title}"`)));
  console.log();

  await sleep(1200);
  console.log(dim('  pass 2: the same workflow'));
  const list2 = await timed('list_pull_requests', repo);
  const pr2 = topPr(list2.result);
  console.log(
    callLine('list_pull_requests', list2.ms, dim(`→ prefetches get_pull_request #${pr2.number}`)),
  );
  await sleep(THINK_MS);
  const view2 = await timed('get_pull_request', { ...repo, pull_number: pr2.number });
  const speedup = view1.ms / Math.max(view2.ms, 1);
  console.log(
    callLine(`get_pull_request #${pr2.number}`, view2.ms, green(`prefetched ✓ ${speedup.toFixed(0)}× faster`)),
  );
  console.log();

  const stats = JSON.parse(
    resultText((await client.callTool({ name: 'speculate__stats', arguments: {} })) as CallToolResult),
  ) as StatsReport;
  await client.close();
  rmSync(dir, { recursive: true, force: true });

  if (stats.hits + stats.joins < 1) {
    console.error(yellow('  prefetch did not land this run (slow machine?); rerun the demo'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
