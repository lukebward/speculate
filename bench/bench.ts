/**
 * Benchmark harness (DESIGN.md §10 item 8).
 *
 * Replays a scripted GitHub-flavoured agent session through the proxy twice —
 * speculation off, then on — against the bundled mock server with injected
 * upstream latency, and reports per-call wall clock, hit outcomes, and waste.
 *
 * `--hetero` swaps the flat latency for a per-tool one (a PR diff is not a
 * get_issue) and replays a longer triage session that puts more candidates in
 * front of the per-trigger cap than the cap can hold. The default run is
 * latency-UNIFORM, so it cannot say anything about prioritizing between
 * candidates — every candidate is worth the same wall clock by construction.
 *
 * `--cap N` overrides the per-trigger cap. At the shipped default of 3 the
 * bundled profile never offers more candidates than the cap holds, so how
 * candidates rank AGAINST EACH OTHER is unobservable here — everything
 * offered gets issued. Lower the cap to put the run in the regime where the
 * ranking actually decides something.
 *
 * Usage: npm run bench [-- --latency 400] [-- --hetero] [-- --cap 1]
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

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScriptStep {
  kind: 'call' | 'think' | 'turn';
  label?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
}

/**
 * A plausible "review issue #42" session. `think` steps simulate model
 * generation time between tool calls; `turn` steps simulate the user reading
 * and typing the next message.
 */
function script(): ScriptStep[] {
  const repo = { owner: 'acme', repo: 'api' };
  return [
    { kind: 'turn', label: 'user: "what is issue 42 about?"' },
    { kind: 'call', tool: 'get_issue', args: { ...repo, issue_number: 42 } },
    { kind: 'think', ms: 1200 },
    { kind: 'call', tool: 'get_issue_comments', args: { ...repo, issue_number: 42 } },
    { kind: 'turn', label: 'user: "is there a fix in flight?"', ms: 2500 },
    { kind: 'call', tool: 'list_pull_requests', args: { ...repo, state: 'open' } },
    { kind: 'think', ms: 900 },
    { kind: 'call', tool: 'get_pull_request', args: { ...repo, pull_number: 7 } },
    { kind: 'think', ms: 250 }, // shorter than upstream latency → exercises in-flight join
    { kind: 'call', tool: 'get_pull_request_diff', args: { ...repo, pull_number: 7 } },
    { kind: 'turn', label: 'user: "anything else open?"', ms: 2000 },
    { kind: 'call', tool: 'list_issues', args: { ...repo, state: 'open' } },
    { kind: 'think', ms: 800 },
    { kind: 'call', tool: 'get_issue', args: { ...repo, issue_number: 41 } },
  ];
}

/**
 * Per-tool upstream latency for `--hetero`, in the proportions a real GitHub
 * API shows: a unified diff is a large payload and an order of magnitude
 * slower than fetching one issue; list endpoints sit in between. Chosen for
 * plausibility before any of it was measured, not tuned against the result.
 */
const HETERO_LATENCY_MS: Record<string, number> = {
  get_issue: 120,
  get_issue_comments: 260,
  get_pull_request: 260,
  list_issues: 700,
  list_pull_requests: 700,
  get_file_contents: 900,
  get_pull_request_diff: 2_400,
};

/**
 * A longer triage session over four issues. Two things differ from the
 * default script and both are needed for the per-trigger cap to bind at all:
 * the same triggers recur (so the learner adds candidates alongside the
 * profile rules, pushing each batch past the cap of 3) and the pauses are
 * short (so the budget cannot simply run everything offered).
 */
function heteroScript(): ScriptStep[] {
  const repo = { owner: 'acme', repo: 'api' };
  const steps: ScriptStep[] = [
    { kind: 'turn', label: 'user: "triage the open issues"' },
    { kind: 'call', tool: 'list_issues', args: { ...repo, state: 'open' } },
    { kind: 'think', ms: 700 },
  ];
  // Read an issue, then follow it up — comments for some, the open-PR list
  // for others, the diff when a PR is in play. That mix is what makes the
  // trigger's candidates genuinely competitive rather than a single obvious
  // next call.
  const followUps: ScriptStep[][] = [
    [{ kind: 'call', tool: 'get_issue_comments', args: { ...repo, issue_number: 42 } }],
    [
      { kind: 'call', tool: 'list_pull_requests', args: { ...repo, state: 'open' } },
      { kind: 'think', ms: 700 },
      { kind: 'call', tool: 'get_pull_request', args: { ...repo, pull_number: 7 } },
      { kind: 'think', ms: 700 },
      { kind: 'call', tool: 'get_pull_request_diff', args: { ...repo, pull_number: 7 } },
    ],
    [{ kind: 'call', tool: 'get_issue_comments', args: { ...repo, issue_number: 41 } }],
    [
      { kind: 'call', tool: 'list_pull_requests', args: { ...repo, state: 'open' } },
      { kind: 'think', ms: 700 },
      { kind: 'call', tool: 'get_pull_request', args: { ...repo, pull_number: 8 } },
    ],
  ];
  const issues = [42, 7, 41, 40];
  for (let i = 0; i < issues.length; i++) {
    steps.push({ kind: 'turn', label: `user: "issue ${issues[i]}?"`, ms: 1_200 });
    steps.push({ kind: 'call', tool: 'get_issue', args: { ...repo, issue_number: issues[i] } });
    steps.push({ kind: 'think', ms: 700 });
    steps.push(...followUps[i]!);
  }
  return steps;
}

interface RunResult {
  perCall: { tool: string; ms: number }[];
  toolWaitMs: number;
  stats: StatsReport | null;
}

async function runSession(
  mode: 'strict' | 'off',
  latencyMs: number,
  hetero: boolean,
  maxPredictionsPerTrigger?: number,
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-bench-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      log: 'off',
      persistence: { enabled: false }, // keep benchmark runs cold and hermetic
      ...(maxPredictionsPerTrigger !== undefined ? { maxPredictionsPerTrigger } : {}),
      servers: {
        github: {
          command: TSX,
          args: [TSX_CLI, join(ROOT, 'mock', 'mock-github.ts')],
          env: {
            SPECULATE_MOCK_LATENCY_MS: String(latencyMs),
            ...(hetero
              ? { SPECULATE_MOCK_LATENCY_BY_TOOL: JSON.stringify(HETERO_LATENCY_MS) }
              : {}),
          },
          profile: 'github',
        },
      },
    }),
  );

  const client = new Client({ name: 'bench', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);

  const perCall: { tool: string; ms: number }[] = [];
  for (const step of hetero ? heteroScript() : script()) {
    if (step.kind === 'call') {
      const t0 = performance.now();
      await client.callTool({ name: step.tool!, arguments: step.args! });
      perCall.push({ tool: step.tool!, ms: performance.now() - t0 });
    } else if (step.kind === 'think') {
      await sleep(step.ms ?? 500);
    } else {
      await sleep(step.ms ?? 100);
    }
  }

  let stats: StatsReport | null = null;
  if (mode !== 'off') {
    const res = (await client.callTool({
      name: 'speculate__stats',
      arguments: {},
    })) as CallToolResult;
    const text = resultText(res);
    stats = text ? (JSON.parse(text) as StatsReport) : null;
  }

  await client.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    perCall,
    toolWaitMs: perCall.reduce((a, c) => a + c.ms, 0),
    stats,
  };
}

async function main(): Promise<void> {
  const latencyArg = process.argv.indexOf('--latency');
  const parsed = latencyArg !== -1 ? Number(process.argv[latencyArg + 1]) : 400;
  const latencyMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 400;
  const hetero = process.argv.includes('--hetero');
  // The per-trigger cap (DESIGN.md §5.6), overridable so the run can be put
  // in the regime where the cap actually BINDS. At the shipped default of 3
  // the bundled profile never offers more candidates than the cap holds, so
  // nothing about how candidates are ranked against each other is
  // observable — every one of them is issued.
  const capArg = process.argv.indexOf('--cap');
  const capParsed = capArg !== -1 ? Number(process.argv[capArg + 1]) : Number.NaN;
  const cap =
    Number.isInteger(capParsed) && capParsed >= 1 && capParsed <= 16 ? capParsed : undefined;

  console.log();
  console.log(bold('  Speculate benchmark — scripted agent session, mock GitHub upstream'));
  if (hetero) {
    const range = Object.values(HETERO_LATENCY_MS);
    console.log(
      dim(
        `  per-tool upstream latency ${Math.min(...range)}–${Math.max(...range)} ms · ` +
          `${heteroScript().filter((s) => s.kind === 'call').length} tool calls across 5 user turns\n`,
      ),
    );
  } else {
    console.log(dim(`  upstream latency ${latencyMs} ms · 7 tool calls across 3 user turns\n`));
  }

  if (cap !== undefined) console.log(dim(`  per-trigger cap ${cap}\n`));

  console.log(dim('  running with speculation off…'));
  const off = await runSession('off', latencyMs, hetero, cap);
  console.log(dim('  running with speculation on (strict mode)…\n'));
  const on = await runSession('strict', latencyMs, hetero, cap);

  const w = Math.max(...off.perCall.map((c) => c.tool.length)) + 2;
  console.log(bold(`  ${'tool call'.padEnd(w)}${'off'.padStart(9)}${'on'.padStart(9)}   outcome`));
  console.log(dim(`  ${'─'.repeat(w + 30)}`));
  for (let i = 0; i < off.perCall.length; i++) {
    const o = off.perCall[i]!;
    const n = on.perCall[i]!;
    const speedup = o.ms / Math.max(n.ms, 0.1);
    // Classify against what THIS tool costs upstream, which is the flat
    // latency unless --hetero gave it its own.
    const cost = (hetero ? HETERO_LATENCY_MS[o.tool] : undefined) ?? latencyMs;
    const outcome =
      n.ms < cost * 0.25
        ? green('prefetched ✓')
        : n.ms < cost * 0.9
          ? cyan('joined in flight ~')
          : dim('miss (live call)');
    console.log(
      `  ${o.tool.padEnd(w)}${fmtMs(o.ms).padStart(9)}${fmtMs(n.ms).padStart(9)}   ${outcome} ${speedup > 2 ? green(`${speedup.toFixed(0)}×`) : ''}`,
    );
  }
  console.log(dim(`  ${'─'.repeat(w + 30)}`));
  const reduction = (1 - on.toolWaitMs / off.toolWaitMs) * 100;
  console.log(
    bold(
      `  ${'total tool wait'.padEnd(w)}${fmtMs(off.toolWaitMs).padStart(9)}${fmtMs(on.toolWaitMs).padStart(9)}   ${green(`−${reduction.toFixed(0)}%`)}\n`,
    ),
  );

  if (on.stats) {
    const s = on.stats;
    const eligibleReads = s.hits + s.joins + s.misses;
    const hitRate = eligibleReads ? ((s.hits + s.joins) / eligibleReads) * 100 : 0;
    console.log(bold('  speculation stats (strict run)'));
    console.log(`    speculative calls   ${s.speculativeCalls}`);
    console.log(`    hits / joins        ${s.hits} / ${s.joins}  ${dim(`(${hitRate.toFixed(0)}% of eligible reads)`)}`);
    console.log(`    wasted              ${s.wasted}  ${dim(`(${(s.wastePerHit ?? 0).toFixed(2)} per hit)`)}`);
    console.log(`    est. time saved     ${green(fmtMs(s.estimatedSavedMs))}`);
    console.log();
    const target = { hitRate: 40, reduction: 30, wastePerHit: 2 };
    const ok = (b: boolean) => (b ? green('pass') : yellow('miss'));
    console.log(bold('  vs DESIGN.md §10 success criteria'));
    console.log(`    hit rate ≥ ${target.hitRate}%        ${hitRate.toFixed(0)}%   ${ok(hitRate >= target.hitRate)}`);
    console.log(`    tool-wait cut ≥ ${target.reduction}%   ${reduction.toFixed(0)}%   ${ok(reduction >= target.reduction)}`);
    console.log(
      `    waste ≤ ${target.wastePerHit}/hit         ${(s.wastePerHit ?? 0).toFixed(2)}   ${ok((s.wastePerHit ?? 0) <= target.wastePerHit)}`,
    );
    console.log();
  }
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
