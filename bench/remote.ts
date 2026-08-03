/**
 * Live remote-upstream benchmark.
 *
 * Every performance number elsewhere in this repo comes from the bundled mock
 * server with synthetic latency (bench/bench.ts). This one measures Speculate
 * against a REAL hosted MCP server over the real internet, which is where the
 * latency it exists to hide actually lives: a local stdio server answers in
 * single-digit milliseconds and has nothing worth prefetching.
 *
 * GATED. It never runs in CI or under `npm test`: it needs both
 * SPECULATE_E2E_LIVE=1 and a credential, and prints why it skipped otherwise.
 *
 *   SPECULATE_E2E_LIVE=1 GITHUB_TOKEN=$(gh auth token) npm run bench:remote
 *
 * READ-ONLY BY CONSTRUCTION. Every tool the session calls is checked against
 * the server's own `readOnlyHint` annotation at run time; anything not
 * affirmatively read-only aborts the benchmark before a single call is made.
 *
 * THE TOKEN IS NEVER WRITTEN TO DISK. The generated proxy config contains the
 * literal string `Bearer ${GITHUB_TOKEN}`; the child proxy resolves it from
 * its inherited environment (src/config.ts), which is the feature this
 * benchmark exists to exercise.
 *
 * Options:
 *   --runs N        alternating off/on session pairs (default 3)
 *   --owner OWNER   repository owner   (env SPECULATE_BENCH_OWNER)
 *   --repo REPO     repository name    (env SPECULATE_BENCH_REPO)
 *   --profile NAME  attach a vetted profile to the remote server
 *                   (env SPECULATE_BENCH_PROFILE); default: none, which is
 *                   what a user gets by simply pointing Speculate at the URL
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { resultText } from '../src/upstream.js';
import type { SpeculationMode, StatsReport } from '../src/types.js';
import { SCENARIOS, type Scenario, type ScenarioContext, type ScriptStep } from './scenarios.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');


const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

interface Options {
  runs: number;
  scenario: Scenario;
  profile: string | null;
  /** Empty when the scenario needs no credential. */
  token: string;
}

/**
 * Both gates must be open. Returns null (and explains itself) otherwise,
 * with exit code 0, because "no credentials" is not a failure, it is the default.
 */
function gate(): Options | null {
  const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 ? process.argv[i + 1] : undefined;
  };
  const key = flag('scenario') ?? process.env['SPECULATE_BENCH_SCENARIO'] ?? 'github';
  const scenario = SCENARIOS[key];
  if (!scenario) {
    console.log();
    console.log(bold(`  unknown scenario '${key}'`));
    console.log(dim(`  available: ${Object.keys(SCENARIOS).join(', ')}`));
    console.log();
    return null;
  }

  const live = process.env['SPECULATE_E2E_LIVE'] === '1';
  // A scenario with no `tokenEnv` needs no credential, so demanding one would
  // block the single most reproducible measurement in the repo.
  const token = scenario.tokenEnv ? (process.env[scenario.tokenEnv] ?? '') : '';
  const needsToken = scenario.tokenEnv !== null && token === '';
  if (!live || needsToken) {
    const invocation =
      scenario.tokenEnv === null
        ? `SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario ${scenario.key}`
        : `SPECULATE_E2E_LIVE=1 ${scenario.tokenEnv}=$(gh auth token) npm run bench:remote`;
    console.log();
    console.log(bold('  remote benchmark skipped'));
    console.log(dim('  it calls a real hosted MCP server, so it is opt-in:'));
    if (!live) console.log(`    ${yellow('SPECULATE_E2E_LIVE')} is not set to 1`);
    if (needsToken) console.log(`    ${yellow(scenario.tokenEnv!)} is empty or unset`);
    console.log();
    console.log(dim('  to run it:'));
    console.log(dim(`    ${invocation}`));
    if (scenario.tokenEnv !== null) {
      console.log(
        dim(`  (PowerShell: $env:SPECULATE_E2E_LIVE=1; $env:${scenario.tokenEnv}=(gh auth token))`),
      );
    }
    console.log();
    return null;
  }

  const runsRaw = Number(flag('runs') ?? 3);
  const profile = flag('profile') ?? process.env['SPECULATE_BENCH_PROFILE'] ?? '';
  return {
    runs: Number.isFinite(runsRaw) && runsRaw >= 1 ? Math.floor(runsRaw) : 3,
    scenario,
    profile: profile === '' || profile === 'none' ? null : profile,
    token,
  };
}

// ---------------------------------------------------------------------------
// Discovery: what does this server actually offer, and what may we call?
// ---------------------------------------------------------------------------

/**
 * Connect directly (no proxy) to read the tool list, prove every tool the
 * session will call is affirmatively read-only, and let the scenario pick
 * real arguments.
 */
async function discover(
  opts: Options,
): Promise<{ tools: Tool[]; script: ScriptStep[]; ctx: ScenarioContext }> {
  const { scenario } = opts;
  const client = new Client({ name: 'speculate-bench', version: '0.1.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(scenario.url), {
      ...(opts.token
        ? { requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } }
        : {}),
    }),
  );
  const { tools } = await client.listTools();
  const readOnly = new Set(
    tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
  );

  const missing = scenario.needTools.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length > 0) {
    await client.close();
    throw new Error(
      `server at ${scenario.url} does not expose ${missing.join(', ')}: ` +
        `it has ${tools.length} tools (${tools.map((t) => t.name).slice(0, 8).join(', ')}…)`,
    );
  }

  // The safety gate. `readOnlyHint` is an untrusted hint in general (DESIGN.md
  // threat model), but here it is the SERVER'S OWN claim about its own tools,
  // and refusing to proceed without it is what keeps this benchmark harmless.
  const notReadOnly = scenario.needTools.filter((n) => !readOnly.has(n));
  if (notReadOnly.length > 0) {
    await client.close();
    throw new Error(
      `refusing to run: ${notReadOnly.join(', ')} ${notReadOnly.length === 1 ? 'is' : 'are'} ` +
        `not annotated readOnlyHint:true by the server. This benchmark only ever calls ` +
        `affirmatively read-only tools.`,
    );
  }

  const ctx = await scenario.plan(
    (name, args) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
  );
  await client.close();
  return { tools, script: scenario.script(ctx), ctx };
}

// ---------------------------------------------------------------------------
// One session through the proxy
// ---------------------------------------------------------------------------

interface RunResult {
  perCall: { tool: string; ms: number; failed: boolean }[];
  toolWaitMs: number;
  stats: StatsReport | null;
}

async function runSession(
  opts: Options,
  mode: SpeculationMode,
  steps: ScriptStep[],
  statePath: string | null,
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-remote-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mode,
        log: 'off',
        persistence: statePath ? { enabled: true, path: statePath } : { enabled: false },
        servers: {
          upstream: {
            url: opts.scenario.url,
            // The literal placeholder, NOT the token: the child proxy resolves
            // it from its environment at config load. Nothing secret is
            // written to disk, and this is the code path under test. Scenarios
            // that need no credential get no headers block at all.
            ...(opts.scenario.tokenEnv
              ? { headers: { Authorization: `Bearer \${${opts.scenario.tokenEnv}}` } }
              : {}),
            ...(opts.profile ? { profile: opts.profile } : {}),
          },
        },
      },
      null,
      2,
    ),
  );

  const client = new Client({ name: 'speculate-bench', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: NODE,
    args: [TSX_CLI, join(ROOT, 'src', 'cli.ts'), '--config', configPath],
    env: { ...process.env } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);

  const perCall: RunResult['perCall'] = [];
  for (const step of steps) {
    if (step.kind === 'call') {
      const t0 = performance.now();
      const res = (await client.callTool({
        name: step.tool!,
        arguments: step.args!,
      })) as CallToolResult;
      perCall.push({
        tool: `${step.tool!}${methodSuffix(step.args)}`,
        ms: performance.now() - t0,
        failed: res.isError === true,
      });
    } else {
      await sleep(step.ms ?? (step.kind === 'think' ? 500 : 100));
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
  return { perCall, toolWaitMs: perCall.reduce((a, c) => a + c.ms, 0), stats };
}

/** `issue_read` is four different reads; label them apart in the table. */
function methodSuffix(args: Record<string, unknown> | undefined): string {
  const m = args?.['method'];
  return typeof m === 'string' ? ` (${m})` : '';
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main(): Promise<void> {
  const opts = gate();
  if (!opts) return;

  console.log();
  console.log(bold('  Speculate live remote benchmark'));
  console.log(dim(`  ${opts.scenario.label} — ${opts.scenario.url}`));
  console.log();

  console.log(dim('  discovering tools and picking read-only targets…'));
  const { tools, script: steps, ctx } = await discover(opts);
  const readOnlyCount = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
  const calls = steps.filter((s) => s.kind === 'call').length;
  console.log(
    dim(
      `  ${tools.length} tools (${readOnlyCount} annotated read-only) · session: ${calls} calls · ` +
        `${opts.scenario.describe(ctx)} · profile ${opts.profile ?? 'none (zero-config)'}`,
    ),
  );
  console.log();

  // One state directory shared by every speculating run, and none for the
  // baseline. That is deliberate and it is what makes run 1 vs run N honest:
  // Speculate persists what it learns, so a real user's second time through a
  // workflow is not a cold start, and reporting only the cold number would
  // understate it exactly as much as reporting only the warm one overstates.
  const stateDir = mkdtempSync(join(tmpdir(), 'speculate-remote-state-'));
  const statePath = join(stateDir, 'state.json');

  const offRuns: RunResult[] = [];
  const onRuns: RunResult[] = [];
  try {
    for (let r = 1; r <= opts.runs; r++) {
      // Interleaved, so a slow minute on the network hits both arms rather
      // than whichever one happened to run during it.
      process.stdout.write(dim(`  run ${r}/${opts.runs}: baseline (off)… `));
      offRuns.push(await runSession(opts, 'off', steps, null));
      process.stdout.write(dim(`${fmtMs(offRuns.at(-1)!.toolWaitMs)}  ·  speculating… `));
      onRuns.push(await runSession(opts, 'annotated', steps, statePath));
      console.log(dim(fmtMs(onRuns.at(-1)!.toolWaitMs)));
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }

  const failures = [...offRuns, ...onRuns].flatMap((r) => r.perCall.filter((c) => c.failed));
  if (failures.length > 0) {
    console.log();
    console.log(red(`  WARNING: ${failures.length} tool call(s) returned isError; numbers below`));
    console.log(red('  include failed calls and should not be trusted.'));
  }

  // --- per-run spread ------------------------------------------------------
  console.log();
  console.log(bold('  total tool wait per run (network noise is real, so read the spread)'));
  const w = 12;
  console.log(dim(`  ${'run'.padEnd(6)}${'off'.padStart(w)}${'speculating'.padStart(w + 2)}`));
  for (let r = 0; r < opts.runs; r++) {
    const o = offRuns[r]!.toolWaitMs;
    const n = onRuns[r]!.toolWaitMs;
    const cold = r === 0 ? dim('  (cold: nothing learned yet)') : '';
    console.log(
      `  ${String(r + 1).padEnd(6)}${fmtMs(o).padStart(w)}${fmtMs(n).padStart(w + 2)}${cold}`,
    );
  }
  const offMed = median(offRuns.map((r) => r.toolWaitMs));
  const onMed = median(onRuns.map((r) => r.toolWaitMs));
  console.log(dim(`  ${'─'.repeat(6 + w + w + 2)}`));
  console.log(
    bold(`  ${'median'.padEnd(6)}${fmtMs(offMed).padStart(w)}${fmtMs(onMed).padStart(w + 2)}`),
  );
  const reduction = offMed > 0 ? (1 - onMed / offMed) * 100 : 0;
  const warmOff = median(offRuns.slice(1).map((r) => r.toolWaitMs));
  const warmOn = median(onRuns.slice(1).map((r) => r.toolWaitMs));
  const warmReduction = warmOff > 0 ? (1 - warmOn / warmOff) * 100 : 0;
  console.log();
  console.log(`  median tool-wait change, all runs   ${pct(reduction)}`);
  if (opts.runs > 1) {
    console.log(`  median tool-wait change, warm only  ${pct(warmReduction)}   ${dim('(run 1 excluded)')}`);
  }

  // --- per call, warmest run ----------------------------------------------
  const lastOn = onRuns.at(-1)!;
  const offPerCall = lastOn.perCall.map((_, i) => median(offRuns.map((r) => r.perCall[i]?.ms ?? 0)));
  const tw = Math.max(...lastOn.perCall.map((c) => c.tool.length)) + 2;
  console.log();
  console.log(bold(`  per call, baseline median vs run ${opts.runs} (warmest)`));
  console.log(
    dim(`  ${'tool call'.padEnd(tw)}${'off (med)'.padStart(11)}${'on'.padStart(11)}   outcome`),
  );
  console.log(dim(`  ${'─'.repeat(tw + 40)}`));
  for (let i = 0; i < lastOn.perCall.length; i++) {
    const o = offPerCall[i]!;
    const n = lastOn.perCall[i]!;
    // Classified against the measured baseline for THIS call, not a fixed
    // threshold: a live server's per-tool latency varies by an order of
    // magnitude (a diff is not a list).
    const outcome =
      n.ms < o * 0.2
        ? green('prefetched')
        : n.ms < o * 0.75
          ? cyan('faster (join or partial)')
          : dim('live call');
    console.log(
      `  ${n.tool.padEnd(tw)}${fmtMs(o).padStart(11)}${fmtMs(n.ms).padStart(11)}   ${outcome}`,
    );
  }

  // --- speculation stats ---------------------------------------------------
  const s = lastOn.stats;
  if (s) {
    const eligible = s.hits + s.joins + s.misses;
    const hitRate = eligible ? ((s.hits + s.joins) / eligible) * 100 : 0;
    console.log();
    console.log(bold(`  speculation stats (run ${opts.runs}, cumulative state)`));
    console.log(`    speculative calls   ${s.speculativeCalls}`);
    console.log(
      `    hits / joins        ${s.hits} / ${s.joins}  ${dim(`(${hitRate.toFixed(0)}% of ${eligible} eligible reads)`)}`,
    );
    console.log(
      `    wasted              ${s.wasted}  ${dim(`(${(s.wastePerHit ?? 0).toFixed(2)} per hit)`)}`,
    );
    console.log(`    est. time saved     ${fmtMs(s.estimatedSavedMs)}`);
    const suppressed = Object.entries(s.suppressed).filter(([, n]) => n > 0);
    if (suppressed.length > 0) {
      console.log(
        dim(`    suppressed          ${suppressed.map(([k, n]) => `${k}=${n}`).join(', ')}`),
      );
    }
  }
  console.log();
}

function pct(v: number): string {
  const s = `${v >= 0 ? '-' : '+'}${Math.abs(v).toFixed(0)}%`;
  return v >= 5 ? green(s) : v <= -5 ? red(s) : yellow(s);
}

main().catch((err) => {
  console.error(red(`\n  ${(err as Error).message}\n`));
  process.exit(1);
});
