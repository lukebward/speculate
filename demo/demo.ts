/**
 * Live README demo: MCP client ↔ Speculate proxy ↔ bundled gh workspace
 * server ↔ real GitHub. Two passes of "list PRs, read the top one": the
 * first pass teaches the learner, the second is served from prefetch.
 *
 * Usage: npm run demo [-- --repo cli/cli]   (requires an authenticated gh)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resultText } from '../src/upstream.js';
import type { StatsReport } from '../src/types.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const THINK_MS = 1500;

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
  const repoArg = process.argv.indexOf('--repo');
  const repo = repoArg !== -1 ? process.argv[repoArg + 1]! : 'cli/cli';

  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    console.error('gh is not authenticated (run: gh auth login)');
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'speculate-demo-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: 'annotated',
      log: 'off',
      persistence: { enabled: false },
      servers: {
        workspace: {
          command: TSX,
          args: [join(ROOT, 'shell', 'speculate-shell.ts'), '--cwd', ROOT],
          env: {
            GH_REPO: repo,
            ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
            ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
          },
          profile: 'none',
        },
      },
    }),
  );

  const client = new Client({ name: 'demo', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [join(ROOT, 'src', 'cli.ts'), '--config', configPath],
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
    const out = (JSON.parse(resultText(result)) as { output: PrItem[] }).output;
    if (!out.length) throw new Error(`repo ${repo} has no open PRs — try --repo <owner/repo>`);
    return out[0]!;
  };

  console.log();
  console.log(bold('  Speculate demo: a real agent workflow against live GitHub'));
  console.log(dim(`  list PRs, then read the top one · repo ${repo} · no mocks, no injected latency\n`));

  console.log(dim('  pass 1: Speculate watches the workflow'));
  const list1 = await timed('gh_pr_list', { limit: 10 });
  console.log(callLine('gh_pr_list', list1.ms));
  await sleep(THINK_MS);
  const pr1 = topPr(list1.result);
  const view1 = await timed('gh_pr_view', { number: pr1.number });
  const title = pr1.title.length > 36 ? `${pr1.title.slice(0, 35)}…` : pr1.title;
  console.log(callLine(`gh_pr_view #${pr1.number}`, view1.ms, dim(`"${title}"`)));
  console.log();

  await sleep(1200);
  console.log(dim('  pass 2: the same workflow'));
  const list2 = await timed('gh_pr_list', { limit: 10 });
  const pr2 = topPr(list2.result);
  console.log(callLine('gh_pr_list', list2.ms, dim(`→ prefetches gh_pr_view #${pr2.number}`)));
  await sleep(THINK_MS);
  const view2 = await timed('gh_pr_view', { number: pr2.number });
  const speedup = view1.ms / Math.max(view2.ms, 1);
  console.log(callLine(`gh_pr_view #${pr2.number}`, view2.ms, green(`prefetched ✓ ${speedup.toFixed(0)}× faster`)));
  console.log();

  const stats = JSON.parse(
    resultText((await client.callTool({ name: 'speculate__stats', arguments: {} })) as CallToolResult),
  ) as StatsReport;
  await client.close();
  rmSync(dir, { recursive: true, force: true });

  if (stats.hits + stats.joins < 1) {
    console.error(yellow('  prefetch did not land this run (slow upstream?); rerun the demo'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
