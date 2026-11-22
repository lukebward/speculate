/**
 * Live benchmark: the mod in real Claude Code sessions, against real hosted
 * MCP servers, with a real model deciding the calls.
 *
 * Each pair is two headless sessions (`claude -p`) with the same prompt: one
 * without the mod (`off`) and one with it loaded from this checkout (`on`).
 * The order alternates from pair to pair, so a server that answers a repeat
 * faster favours neither arm. The `on` arm keeps one plugin store for the
 * whole run, so what it learns in one pair is there for the next: the first
 * pairs are its learning sessions, and are reported apart from the rest.
 *
 * Tool wait comes from the host's own event timestamps (bench/measure.ts).
 * The mod's counters are read from its plugin store after each session: they
 * give the hit rate (calls answered from a prefetch), how many prefetches
 * were used, and the predictor's own next-call recall.
 *
 * GATED. It calls other people's services and spends model tokens, so it
 * never runs in CI or under `npm test`, and needs SPECULATE_BENCH_LIVE=1:
 *
 *   SPECULATE_BENCH_LIVE=1 npm run bench:live -- --scenario mslearn --json mslearn.json
 *   npm run bench:live -- --summarize mslearn.json huggingface.json
 *
 * READ-ONLY BY CONSTRUCTION. The runner asks the server for its tool list
 * first and stops unless every tool a workload names is annotated
 * `readOnlyHint: true`. Sessions are allowed the server's read-only tools and
 * nothing else: no shell, no file edits, no other MCP server.
 *
 * ISOLATED. Each arm gets its own empty CLAUDE_CONFIG_DIR and an empty working
 * directory, so your settings, hooks, and learned memory neither change nor
 * affect a run. Claude Code must therefore be able to authenticate from the
 * environment (ANTHROPIC_API_KEY, or a host-managed login). Behind an HTTPS
 * proxy, run with NODE_USE_ENV_PROXY=1 so the runner's own check reaches the
 * server; Claude Code reads HTTPS_PROXY by itself.
 *
 * Options:
 *   --scenario KEY      mslearn | huggingface | context7, or mockgithub: the
 *                       bundled mock server with 1.5 s injected into each call
 *                       (default mslearn)
 *   --workload KEY      scripted | repeat | varied | all (default all)
 *   --pairs N           off/on pairs per workload (default 8)
 *   --warmup N          leading pairs reported as learning sessions (default 2)
 *   --model NAME        model for both arms (default haiku)
 *   --mod DIR           the mod to load in the `on` arm (default this checkout)
 *   --proxy CLI         measure a 0.x proxy release in place of the mod: the `on`
 *                       arm loads no mod, and reaches the server through
 *                       `node CLI --config ...` (the release's dist/src/cli.js),
 *                       which keeps its learned state for the whole workload
 *   --cold              forget before every `on` session: the mod never has a
 *                       memory to predict from, so with the scripted workload
 *                       both arms make the same calls and nothing is served.
 *                       What is left is what the mod costs a call it cannot help.
 *   --claude BIN        the Claude Code binary (default claude)
 *   --json FILE         write every session and the summaries
 *   --keep              keep the temporary directories (raw event streams)
 *   --summarize FILES   print the Markdown tables for result files, run nothing
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  markdownHitTable,
  markdownSessionTable,
  markdownTable,
  measureSession,
  readUsage,
  serializeResults,
  summarize,
  summarizeAll,
  usageDelta,
  USAGE_KEYS,
  type Arm,
  type ResultFile,
  type SessionRow,
  type StreamLine,
  type Summary,
  type Usage,
} from './measure.js';
import {
  describeServer,
  SCENARIOS,
  WORKLOADS,
  type DirectResult,
  type Scenario,
  type ScenarioContext,
  type ServerSpec,
  type WorkloadKey,
} from './scenarios.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** A session that has not finished by now is killed and its pair left out. */
const SESSION_TIMEOUT_MS = 300_000;
/** The most one session may spend on the model before Claude Code stops it. */
const SESSION_BUDGET_USD = '1.00';

interface Options {
  scenario: Scenario;
  workloads: WorkloadKey[];
  pairs: number;
  warmup: number;
  model: string;
  mod: string;
  /** A 0.x proxy's cli.js to measure in the `on` arm, in place of the mod. */
  proxy: string | null;
  cold: boolean;
  claude: string;
  json: string | null;
  keep: boolean;
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function count(name: string, fallback: number, least: number): number {
  const raw = Number(flag(name) ?? fallback);
  return Number.isFinite(raw) && raw >= least ? Math.floor(raw) : fallback;
}

function options(): Options | null {
  const key = flag('scenario') ?? 'mslearn';
  const scenario = SCENARIOS[key];
  if (!scenario) {
    console.log(`unknown scenario '${key}'; available: ${Object.keys(SCENARIOS).join(', ')}`);
    return null;
  }
  const workload = flag('workload') ?? 'all';
  const workloads = workload === 'all' ? [...WORKLOADS] : WORKLOADS.filter(w => w === workload);
  if (workloads.length === 0) {
    console.log(`unknown workload '${workload}'; available: ${WORKLOADS.join(', ')}, all`);
    return null;
  }
  if (process.env['SPECULATE_BENCH_LIVE'] !== '1') {
    console.log('live benchmark skipped: it calls a real hosted MCP server and spends model tokens.');
    console.log(`to run it: SPECULATE_BENCH_LIVE=1 npm run bench:live -- --scenario ${scenario.key}`);
    return null;
  }
  const pairs = count('pairs', 8, 1);
  const proxy = flag('proxy');
  if (proxy !== undefined && has('cold')) {
    console.log('--cold clears the mod\'s store; it has no meaning with --proxy');
    return null;
  }
  return {
    scenario,
    workloads,
    pairs,
    warmup: Math.min(count('warmup', 2, 0), pairs),
    model: flag('model') ?? 'haiku',
    mod: resolve(flag('mod') ?? ROOT),
    proxy: proxy === undefined ? null : resolve(proxy),
    cold: has('cold'),
    claude: flag('claude') ?? 'claude',
    json: flag('json') ?? null,
    keep: has('keep'),
  };
}

/**
 * Connects to the server directly: proves every tool a workload names is
 * read-only by the server's own annotation, lists the read-only tools a
 * session may use, and fetches real arguments for the scripted workload.
 */
async function discover(scenario: Scenario): Promise<{ readOnly: string[]; ctx: ScenarioContext }> {
  const client = new Client({ name: 'speculate-bench', version: '1.0.0' }, { capabilities: {} });
  const { server } = scenario;
  await client.connect(
    'url' in server
      ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({
          command: server.command,
          args: [...server.args],
          env: { ...(process.env as Record<string, string>), ...server.env },
          stderr: 'ignore',
        }),
  );
  try {
    const { tools } = await client.listTools();
    const readOnly = tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name);
    const refused = scenario.needTools.filter(name => !readOnly.includes(name));
    if (refused.length > 0) {
      throw new Error(
        `refusing to run: ${refused.join(', ')} not annotated readOnlyHint:true by ${describeServer(server)} ` +
          `(it lists ${tools.map(tool => tool.name).join(', ')})`,
      );
    }
    const ctx = await scenario.plan(
      async (name, args) => (await client.callTool({ name, arguments: args })) as DirectResult,
    );
    return { readOnly, ctx };
  } finally {
    await client.close();
  }
}

/** The mod's store files under one Claude Code config directory. */
function storeFiles(configDir: string): string[] {
  const dir = join(configDir, 'plugins', 'store');
  try {
    return readdirSync(dir)
      .filter(name => name.startsWith('speculate') && name.endsWith('.json'))
      .map(name => join(dir, name));
  } catch {
    return [];
  }
}

/** The mod's cumulative counters. */
function storedUsage(configDir: string): Usage {
  const total = readUsage(null);
  for (const file of storeFiles(configDir)) {
    try {
      const usage = readUsage((JSON.parse(readFileSync(file, 'utf8')) as { totals?: unknown }).totals);
      for (const key of USAGE_KEYS) total[key] += usage[key];
    } catch {
      // A store that cannot be read counts nothing.
    }
  }
  return total;
}

/**
 * A 0.x proxy's cumulative counters: the same names, from its own `stats`
 * command, read from the state directory the `on` arm gave it.
 */
function proxyUsage(cli: string, stateHome: string): Usage {
  try {
    const out = execFileSync(process.execPath, [cli, 'stats', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return readUsage((JSON.parse(out) as { totals?: unknown }).totals);
  } catch {
    return readUsage(null);
  }
}

interface SessionSetup {
  opts: Options;
  arm: Arm;
  prompt: string;
  configDir: string;
  workDir: string;
  mcpConfig: string;
  allowed: string[];
  log: string;
}

function runSession(setup: SessionSetup): Promise<StreamLine[]> {
  const { opts, arm } = setup;
  const args = [
    '-p', setup.prompt,
    '--model', opts.model,
    '--mcp-config', setup.mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', ...setup.allowed,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', SESSION_BUDGET_USD,
    ...(arm === 'on' && opts.proxy === null ? ['--plugin-dir', opts.mod] : []),
  ];
  return new Promise(done => {
    const child = spawn(opts.claude, args, {
      cwd: setup.workDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: setup.configDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines: StreamLine[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), SESSION_TIMEOUT_MS);
    createInterface({ input: child.stdout }).on('line', line => lines.push({ at: Date.now(), line }));
    const finish = (): void => {
      clearTimeout(timer);
      if (opts.keep) writeFileSync(setup.log, lines.map(entry => entry.line).join('\n'));
      done(lines);
    };
    child.on('error', finish);
    child.on('close', finish);
  });
}

/**
 * The session's MCP config for a 0.x proxy in front of the server: the proxy
 * from a config file, so its learned state has one fixed path for the whole
 * workload (a `wrap` registration keys its state on the environment, which a
 * headless session does not hold still). `annotated` is the mode 0.x's own
 * setup used. With one upstream the proxy leaves tool names as they are.
 */
function proxyMcpConfig(cli: string, scenario: Scenario, dir: string): string {
  const proxyConfig = join(dir, 'proxy.json');
  writeFileSync(
    proxyConfig,
    JSON.stringify({
      mode: 'annotated',
      log: 'off',
      persistence: { enabled: true, path: join(dir, 'proxy-state.json') },
      servers: { upstream: 'url' in scenario.server ? { url: scenario.server.url } : { command: scenario.server.command, args: scenario.server.args, env: scenario.server.env } },
    }),
  );
  const env: Record<string, string> = { XDG_STATE_HOME: dir };
  // The proxy is its own HTTP client: behind an egress proxy it needs telling.
  const useEnvProxy = process.env['NODE_USE_ENV_PROXY'];
  if (useEnvProxy !== undefined) env['NODE_USE_ENV_PROXY'] = useEnvProxy;
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: { [scenario.key]: { command: process.execPath, args: [cli, '--config', proxyConfig], env } },
    }),
  );
  return mcpConfig;
}

/** The server as a session's MCP config names it. */
function sessionServer(server: ServerSpec): Record<string, unknown> {
  return 'url' in server
    ? { type: 'http', url: server.url }
    : { command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) };
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);
const ms = (value: number | null): string => (value === null ? 'n/a' : String(Math.round(value)));

function printRow(row: SessionRow): void {
  const served = row.mod ? row.mod.hits + row.mod.joins : null;
  console.log(
    `  ${pad(row.pair, 4)}  ${row.arm.padEnd(3)}  ${pad(row.order, 5)}  ${pad(row.mcpCalls, 5)}  ` +
      `${pad(ms(row.toolWaitMs), 9)}  ${pad(ms(row.durationMs), 10)}  ` +
      `${pad(served ?? '-', 6)}  ${pad(row.mod?.speculativeCalls ?? '-', 8)}  ` +
      `${pad(row.costUsd === null ? 'n/a' : row.costUsd.toFixed(3), 6)}` +
      `${row.ok ? '' : '  FAILED'}${row.mcpErrors > 0 ? `  ${row.mcpErrors} tool error(s)` : ''}`,
  );
}

/** A reduction as words: a negative one is an increase, and says so. */
function change(reduction: number | null): string {
  if (reduction === null) return '';
  const percent = Math.abs(reduction * 100).toFixed(0);
  return ` (${percent}% ${reduction >= 0 ? 'less' : 'more'})`;
}

function printSummary(summary: Summary): void {
  for (const [name, phase] of [['learning', summary.cold], ['warm', summary.warm]] as const) {
    if (phase.pairs + phase.excludedPairs === 0) continue;
    console.log(
      `  ${name}: ${phase.pairs} pair(s)${phase.excludedPairs > 0 ? `, ${phase.excludedPairs} excluded` : ''}; ` +
        `wait per call ${ms(phase.off.meanCallWaitMs)} ms off, ${ms(phase.on.meanCallWaitMs)} ms on` +
        `${change(phase.callWaitReduction)}; ` +
        `hit rate ${phase.hitRate === null ? 'n/a' : `${(phase.hitRate * 100).toFixed(0)}%`} ` +
        `(${phase.served} of ${phase.on.calls + phase.on.errors} calls); ${phase.prefetches} prefetches, ${phase.unused} unused; ` +
        `less tool wait in ${phase.pairsWithLessToolWait} of ${phase.pairs} pair(s)`,
    );
  }
}

function capture(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

async function run(opts: Options): Promise<void> {
  const { scenario } = opts;
  const variant = opts.proxy ? `, proxy ${capture(process.execPath, [opts.proxy, '--version'])} in the on arm` : '';
  console.log(`\n${scenario.label} (${describeServer(scenario.server)}), model ${opts.model}${opts.cold ? ', cold (the mod forgets before every session)' : ''}${variant}`);
  const { readOnly, ctx } = await discover(scenario);
  const allowed = readOnly.map(tool => `mcp__${scenario.key}__${tool}`);

  const root = mkdtempSync(join(tmpdir(), 'speculate-live-'));
  const mcpConfig = join(root, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [scenario.key]: sessionServer(scenario.server) } }));

  const out: ResultFile = {
    meta: {
      startedAt: new Date().toISOString(),
      revision: capture('git', ['rev-parse', 'HEAD']),
      dirtySrc: capture('git', ['status', '--porcelain', '--', 'src', 'hooks']) !== '',
      mod: opts.proxy ? null : opts.mod === resolve(ROOT) ? 'this checkout' : opts.mod,
      proxy: opts.proxy ? capture(process.execPath, [opts.proxy, '--version']) : null,
      claudeCode: capture(opts.claude, ['--version']),
      node: process.version,
      platform: process.platform,
      scenario: scenario.key,
      url: describeServer(scenario.server),
      results: scenario.results,
      model: opts.model,
      pairs: opts.pairs,
      warmupPairs: opts.warmup,
      cold: opts.cold,
      allowedTools: allowed,
      context: ctx,
    },
    sessions: [],
    summaries: [],
  };
  const save = (): void => {
    if (opts.json) writeFileSync(opts.json, serializeResults(out));
  };

  let spent = 0;
  try {
    for (const workload of opts.workloads) {
      // Each workload starts from nothing learned: its own store, both arms.
      const dirs = { off: join(root, `${workload}-off`), on: join(root, `${workload}-on`) };
      const workDir = join(root, `${workload}-work`);
      for (const dir of [dirs.off, dirs.on, workDir]) mkdirSync(dir, { recursive: true });
      const usage = (): Usage => (opts.proxy ? proxyUsage(opts.proxy, dirs.on) : storedUsage(dirs.on));
      const mcpConfigs = { off: mcpConfig, on: opts.proxy ? proxyMcpConfig(opts.proxy, scenario, dirs.on) : mcpConfig };

      console.log(`\n ${workload}`);
      console.log('  pair  arm  order  calls  wait (ms)  total (ms)  served  prefetch    cost');
      const rows: SessionRow[] = [];
      for (let pair = 1; pair <= opts.pairs; pair++) {
        const prompt = scenario.prompt(workload, ctx, pair);
        const arms: Arm[] = pair % 2 === 1 ? ['off', 'on'] : ['on', 'off'];
        for (const [index, arm] of arms.entries()) {
          // Cold: this arm's own store, in the temporary directory made above.
          if (opts.cold && arm === 'on') for (const file of storeFiles(dirs.on)) rmSync(file, { force: true });
          const before = usage();
          const lines = await runSession({
            opts, arm, prompt, allowed, workDir,
            mcpConfig: mcpConfigs[arm],
            configDir: dirs[arm],
            log: join(root, `${workload}-${pair}-${arm}.jsonl`),
          });
          const row: SessionRow = {
            scenario: scenario.key,
            workload,
            model: opts.model,
            pair,
            arm,
            order: index === 0 ? 1 : 2,
            ...measureSession(lines),
            mod: arm === 'on' ? usageDelta(before, usage()) : null,
          };
          rows.push(row);
          out.sessions.push(row);
          out.meta['servedModel'] ??= row.servedModel;
          spent += row.costUsd ?? 0;
          printRow(row);
        }
        save();
      }
      const summary = summarize(rows, opts.warmup);
      out.summaries.push(summary);
      printSummary(summary);
      save();
    }
  } finally {
    out.meta['finishedAt'] = new Date().toISOString();
    out.meta['modelCostUsd'] = Number(spent.toFixed(4));
    save();
    if (opts.keep) console.log(`\n raw event streams kept in ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n model cost of this run: $${spent.toFixed(2)}`);
  printTables(out.summaries);
}

function printTables(summaries: Summary[]): void {
  console.log(`\nWarm pairs, per session (medians)\n\n${markdownSessionTable(summaries)}`);
  console.log(`\nWarm pairs, hit rate\n\n${markdownHitTable(summaries)}`);
  console.log(`\nWarm pairs, per call\n\n${markdownTable(summaries)}`);
  console.log(`\nLearning pairs, per session (medians)\n\n${markdownSessionTable(summaries, 'cold')}`);
  console.log(`\nLearning pairs, hit rate\n\n${markdownHitTable(summaries, 'cold')}`);
  console.log(`\nLearning pairs, per call\n\n${markdownTable(summaries, 'cold')}\n`);
}

function summarizeFiles(files: string[]): void {
  // From the sessions, not the stored summaries: a file written by an older
  // runner is read by today's rules.
  printTables(
    files.flatMap(file => {
      const { meta, sessions } = JSON.parse(readFileSync(file, 'utf8')) as ResultFile;
      const warmup = typeof meta['warmupPairs'] === 'number' ? meta['warmupPairs'] : 2;
      return summarizeAll(sessions, warmup);
    }),
  );
}

const summarizeAt = process.argv.indexOf('--summarize');
if (summarizeAt !== -1) {
  summarizeFiles(process.argv.slice(summarizeAt + 1).filter(arg => !arg.startsWith('--')));
} else {
  const opts = options();
  if (opts) {
    run(opts).catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
  }
}
