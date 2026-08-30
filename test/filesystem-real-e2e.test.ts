/**
 * Opt-in real filesystem E2E benchmark.
 *
 * This is deliberately gated: it starts 30+ real processes and is intended
 * for release/experiment runs, not every unit-test invocation.
 *
 *   SPECULATE_REAL_E2E=1 npx vitest run test/filesystem-real-e2e.test.ts
 *
 * SPECULATE_E2E_TARGET_ROOT may point at another Speculate checkout (for
 * example an archived HEAD) while this driver and its filesystem MCP server
 * continue to run from the current checkout.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { readUsageReport } from '../src/usage.js';
import type { StatsReport } from '../src/types.js';

const RUN = process.env.SPECULATE_REAL_E2E === '1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGET_ROOT = resolve(process.env.SPECULATE_E2E_TARGET_ROOT ?? ROOT);
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TARGET_CLI = join(TARGET_ROOT, 'src', 'cli.ts');
const LATENCY_MS = Number.parseInt(process.env.SPECULATE_E2E_LATENCY_MS ?? '120', 10);
const THINK_MS = Number.parseInt(process.env.SPECULATE_E2E_THINK_MS ?? '180', 10);
const SESSIONS = Number.parseInt(process.env.SPECULATE_E2E_SESSIONS ?? '4', 10);
const TEST_TIMEOUT_MS = 240_000;

interface Step {
  tool: string;
  args: Record<string, unknown>;
}

interface ArmConfig {
  name: 'off' | 'default' | 'unconstrained';
  mode: 'off' | 'annotated';
  speculation?: { adaptiveAdmission?: boolean; minExpectedSavedMs?: number };
}

interface ArmResult {
  arm: ArmConfig['name'];
  requestedCalls: number;
  sessions: number;
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  wasted: number;
  hitRate: number;
  wastePerUseful: number | null;
  estimatedSavedMs: number;
  estimatedAddedWaitMs: number;
  netEstimatedSavedMs: number;
  predictor: {
    opportunities: number;
    offered: number;
    hitsAt1: number;
    hitsAt3: number;
    recallAt1: number | null;
    recallAt3: number | null;
    precisionAt3: number | null;
  };
  calibration: {
    evaluations: number;
    correct: number;
    brierScore: number | null;
    staticBrierScore: number | null;
    correctButSuppressed: number;
    admittedButWrong: number;
  };
  latency: { meanMs: number; p50Ms: number; p95Ms: number; totalMs: number };
  sessionHitRates: number[];
  upstreamCalls: number;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function workspaceFiles(root: string): void {
  const files: Record<string, string> = {
    'src/auth.ts': [
      "import { cache } from './cache.js';",
      'export function refreshToken(token: string): string {',
      "  cache.set('token', token);",
      "  return token + '-refreshed';",
      '}',
      'export function validateToken(token: string): boolean {',
      "  return token.startsWith('tok_');",
      '}',
    ].join('\n'),
    'src/cache.ts': [
      'export const cache = new Map<string, string>();',
      'export function clearCache(): void { cache.clear(); }',
    ].join('\n'),
    'src/router.ts': [
      "import { validateToken } from './auth.js';",
      'export class Router {',
      '  route(token: string): boolean { return validateToken(token); }',
      '}',
    ].join('\n'),
    'config/app.json': JSON.stringify({ port: 4310, auth: { refresh: true } }, null, 2),
    'package.json': JSON.stringify(
      { name: 'fixture-app', dependencies: { zod: '^4.4.3', typescript: '^7.0.2' } },
      null,
      2,
    ),
  };
  for (const [relative, text] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${text}\n`);
  }
}

/** Write an SDK-backed MCP server which performs actual fs operations. */
function writeFilesystemServer(target: string): void {
  const mcpUrl = pathToFileURL(
    join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'mcp.js'),
  ).href;
  const stdioUrl = pathToFileURL(
    join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'stdio.js'),
  ).href;
  const zodUrl = pathToFileURL(join(ROOT, 'node_modules', 'zod', 'index.js')).href;
  writeFileSync(
    target,
    String.raw`
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { McpServer } from ${JSON.stringify(mcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const root = resolve(process.env.SPEC_FS_ROOT);
const latency = Number(process.env.SPEC_FS_LATENCY_MS || 0);
const callLog = process.env.SPEC_FS_CALL_LOG;
const delay = () => new Promise((done) => setTimeout(done, latency));
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const inside = (name) => {
  const full = resolve(root, name);
  if (full !== root && !full.startsWith(root + sep)) throw new Error('path outside workspace');
  return full;
};
const rel = (full) => relative(root, full).split(sep).join('/');
const log = (tool, args) => {
  if (callLog) appendFileSync(callLog, JSON.stringify({ tool, args, at: Date.now() }) + '\n');
};
const respond = async (tool, args, fn) => {
  log(tool, args);
  await delay();
  return ok(fn());
};
const sourceFiles = () => readdirSync(inside('src'), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => inside('src/' + entry.name))
  .sort();

const server = new McpServer({ name: 'real-filesystem-e2e', version: '1.0.0' });
const readOnly = { readOnlyHint: true };

server.registerTool('list_files', {
  description: 'List real files in a workspace directory.',
  inputSchema: { directory: z.string() }, annotations: readOnly,
}, async ({ directory }) => respond('list_files', { directory }, () => ({
  directory,
  entries: readdirSync(inside(directory), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, path: (directory + '/' + entry.name).replaceAll('//', '/') }))
    .sort((a, b) => a.path.localeCompare(b.path)),
})));

server.registerTool('read_file', {
  description: 'Read a real workspace file.',
  inputSchema: { path: z.string() }, annotations: readOnly,
}, async ({ path }) => respond('read_file', { path }, () => ({ path, content: readFileSync(inside(path), 'utf8') })));

server.registerTool('search_files', {
  description: 'Search real source files.',
  inputSchema: { query: z.string() }, annotations: readOnly,
}, async ({ query }) => respond('search_files', { query }, () => ({
  matches: sourceFiles().flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line, index) => ({ path: rel(file), line: index + 1, preview: line.trim() }))
    .filter((match) => match.preview.includes(query))),
})));

server.registerTool('list_symbols', {
  description: 'List exported symbols parsed from a real TypeScript file.',
  inputSchema: { path: z.string() }, annotations: readOnly,
}, async ({ path }) => respond('list_symbols', { path }, () => ({
  path,
  symbols: readFileSync(inside(path), 'utf8').split(/\r?\n/).flatMap((line, index) => {
    const match = /^export\s+(?:async\s+)?(function|class|const|interface)\s+(\w+)/.exec(line);
    return match ? [{ symbol: match[2], kind: match[1], line: index + 1 }] : [];
  }),
})));

server.registerTool('get_symbol', {
  description: 'Read one exported symbol from a real TypeScript file.',
  inputSchema: { path: z.string(), symbol: z.string() }, annotations: readOnly,
}, async ({ path, symbol }) => respond('get_symbol', { path, symbol }, () => {
  const lines = readFileSync(inside(path), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes(symbol));
  return { path, symbol, line: at + 1, source: lines.slice(at, at + 4).join('\n') };
}));

server.registerTool('find_references', {
  description: 'Find references to a symbol in real source files.',
  inputSchema: { symbol: z.string() }, annotations: readOnly,
}, async ({ symbol }) => respond('find_references', { symbol }, () => ({
  symbol,
  references: sourceFiles().flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line, index) => ({ path: rel(file), line: index + 1, preview: line.trim() }))
    .filter((match) => match.preview.includes(symbol))),
})));

server.registerTool('list_dependencies', {
  description: 'List dependencies read from a real package.json.',
  inputSchema: { path: z.string() }, annotations: readOnly,
}, async ({ path }) => respond('list_dependencies', { path }, () => {
  const pkg = JSON.parse(readFileSync(inside(path), 'utf8'));
  return { path, dependencies: Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version })) };
}));

server.registerTool('get_dependency', {
  description: 'Get one dependency from the real package.json.',
  inputSchema: { name: z.string() }, annotations: readOnly,
}, async ({ name }) => respond('get_dependency', { name }, () => {
  const pkg = JSON.parse(readFileSync(inside('package.json'), 'utf8'));
  return { name, version: pkg.dependencies[name] };
}));

server.registerTool('list_configs', {
  description: 'List JSON config files in the real config directory.',
  inputSchema: { directory: z.string() }, annotations: readOnly,
}, async ({ directory }) => respond('list_configs', { directory }, () => ({
  directory,
  configs: readdirSync(inside(directory)).sort().map((name) => ({ name, path: directory + '/' + name })),
})));

server.registerTool('get_config', {
  description: 'Read and parse a real JSON config file.',
  inputSchema: { path: z.string() }, annotations: readOnly,
}, async ({ path }) => respond('get_config', { path }, () => ({ path, value: JSON.parse(readFileSync(inside(path), 'utf8')) })));

await server.connect(new StdioServerTransport());
`,
  );
}

const WORKFLOW: Step[] = [
  { tool: 'list_files', args: { directory: 'src' } },
  { tool: 'read_file', args: { path: 'src/auth.ts' } },
  { tool: 'list_symbols', args: { path: 'src/auth.ts' } },
  { tool: 'get_symbol', args: { path: 'src/auth.ts', symbol: 'refreshToken' } },
  { tool: 'find_references', args: { symbol: 'refreshToken' } },
  { tool: 'search_files', args: { query: 'Router' } },
  { tool: 'read_file', args: { path: 'src/router.ts' } },
  { tool: 'list_dependencies', args: { path: 'package.json' } },
  { tool: 'get_dependency', args: { name: 'zod' } },
  { tool: 'list_configs', args: { directory: 'config' } },
  { tool: 'get_config', args: { path: 'config/app.json' } },
];

async function toolCall(client: Client, step: Step): Promise<number> {
  const started = performance.now();
  const result = (await client.callTool({ name: step.tool, arguments: step.args })) as CallToolResult;
  const elapsed = performance.now() - started;
  expect(result.isError, `${step.tool} should succeed`).toBeFalsy();
  return elapsed;
}

function payload<T>(result: CallToolResult): T {
  const block = result.content.find((entry) => entry.type === 'text');
  if (!block || block.type !== 'text') throw new Error('expected a text result');
  return JSON.parse(block.text) as T;
}

async function session(
  root: string,
  serverScript: string,
  arm: ArmConfig,
  sessionIndex: number,
): Promise<{ latencies: number[]; stats: StatsReport }> {
  const armRoot = join(root, arm.name);
  mkdirSync(armRoot, { recursive: true });
  const logPath = join(armRoot, 'upstream.jsonl');
  const configPath = join(armRoot, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: arm.mode,
      log: 'off',
      maxPredictionsPerTrigger: 3,
      persistence: { path: join(armRoot, 'state.json') },
      servers: {
        filesystem: {
          command: process.execPath,
          args: [serverScript],
          env: {
            SPEC_FS_ROOT: join(root, 'workspace'),
            SPEC_FS_LATENCY_MS: String(LATENCY_MS),
            SPEC_FS_CALL_LOG: logPath,
          },
          ...(arm.speculation ? { speculation: arm.speculation } : {}),
        },
      },
    }),
  );
  const client = new Client(
    { name: `filesystem-e2e-${arm.name}-${sessionIndex}`, version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, TARGET_CLI, '--config', configPath],
    cwd: TARGET_ROOT,
    env: { ...process.env, XDG_STATE_HOME: join(armRoot, 'xdg') } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  const latencies: number[] = [];
  try {
    for (const step of WORKFLOW) {
      latencies.push(await toolCall(client, step));
      // Deliberately model a small agent/model reasoning window. This is long
      // enough for one 120 ms prefetch, but not an artificial full-queue drain.
      if (arm.mode !== 'off') await sleep(THINK_MS);
    }
    await sleep(20);
    const statsResult = (await client.callTool({
      name: 'speculate__stats',
      arguments: {},
    })) as CallToolResult;
    return { latencies, stats: payload<StatsReport>(statsResult) };
  } finally {
    await client.close().catch(() => {});
    // Give the detached proxy exit callback time to atomically finish its
    // durable usage snapshot before the next session reads the same state.
    await sleep(80);
  }
}

async function runArm(root: string, serverScript: string, arm: ArmConfig): Promise<ArmResult> {
  const allLatencies: number[] = [];
  const snapshots: StatsReport[] = [];
  const sessionHitRates: number[] = [];
  for (let i = 0; i < SESSIONS; i++) {
    const result = await session(root, serverScript, arm, i);
    allLatencies.push(...result.latencies);
    snapshots.push(result.stats);
    const requests = result.stats.realCalls + result.stats.hits + result.stats.joins;
    sessionHitRates.push(requests === 0 ? 0 : (result.stats.hits + result.stats.joins) / requests);
  }

  const usageDir = join(root, arm.name, 'xdg', 'speculate', 'usage');
  const report = readUsageReport(usageDir);
  const totals = report.totals;
  const requestedCalls = totals.hits + totals.joins + totals.misses;
  const quality = snapshots.reduce(
    (sum, stats) => {
      const q = stats.predictionQuality;
      if (!q) return sum; // HEAD before predictor telemetry.
      sum.opportunities += q.opportunities;
      sum.offered += q.offered;
      sum.hitsAt1 += q.hitsAt1;
      sum.hitsAt3 += q.hitsAt3;
      return sum;
    },
    { opportunities: 0, offered: 0, hitsAt1: 0, hitsAt3: 0 },
  );
  const useful = totals.hits + totals.joins;
  const calibration = snapshots.reduce(
    (sum, stats) => {
      const current = stats.calibration;
      sum.evaluations += current.evaluations;
      sum.correct += current.correct;
      sum.brierSum += (current.brierScore ?? 0) * current.evaluations;
      sum.staticBrierSum += (current.staticBrierScore ?? 0) * current.evaluations;
      sum.correctButSuppressed += current.correctButSuppressed;
      sum.admittedButWrong += current.admittedButWrong;
      return sum;
    },
    {
      evaluations: 0,
      correct: 0,
      brierSum: 0,
      staticBrierSum: 0,
      correctButSuppressed: 0,
      admittedButWrong: 0,
    },
  );
  const logPath = join(root, arm.name, 'upstream.jsonl');
  const upstreamCalls = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const totalMs = allLatencies.reduce((sum, value) => sum + value, 0);
  return {
    arm: arm.name,
    requestedCalls,
    sessions: SESSIONS,
    hits: totals.hits,
    joins: totals.joins,
    misses: totals.misses,
    speculativeCalls: totals.speculativeCalls,
    wasted: totals.wasted,
    hitRate: requestedCalls === 0 ? 0 : useful / requestedCalls,
    wastePerUseful: useful === 0 ? null : totals.wasted / useful,
    estimatedSavedMs: totals.estimatedSavedMs,
    estimatedAddedWaitMs: totals.estimatedAddedWaitMs ?? 0,
    netEstimatedSavedMs: totals.estimatedSavedMs - (totals.estimatedAddedWaitMs ?? 0),
    predictor: {
      ...quality,
      recallAt1: quality.opportunities === 0 ? null : quality.hitsAt1 / quality.opportunities,
      recallAt3: quality.opportunities === 0 ? null : quality.hitsAt3 / quality.opportunities,
      precisionAt3: quality.offered === 0 ? null : quality.hitsAt3 / quality.offered,
    },
    calibration: {
      evaluations: calibration.evaluations,
      correct: calibration.correct,
      brierScore:
        calibration.evaluations === 0 ? null : calibration.brierSum / calibration.evaluations,
      staticBrierScore:
        calibration.evaluations === 0
          ? null
          : calibration.staticBrierSum / calibration.evaluations,
      correctButSuppressed: calibration.correctButSuppressed,
      admittedButWrong: calibration.admittedButWrong,
    },
    latency: {
      meanMs: totalMs / allLatencies.length,
      p50Ms: percentile(allLatencies, 0.5),
      p95Ms: percentile(allLatencies, 0.95),
      totalMs,
    },
    sessionHitRates,
    upstreamCalls,
  };
}

describe.skipIf(!RUN)('real filesystem MCP E2E', () => {
  it(
    'measures off, default admission, and unconstrained prediction across persistent sessions',
    async () => {
      expect(existsSync(TARGET_CLI), `target CLI ${TARGET_CLI}`).toBe(true);
      const root = mkdtempSync(join(tmpdir(), 'speculate-filesystem-real-e2e-'));
      const serverScript = join(root, 'filesystem-server.mjs');
      workspaceFiles(join(root, 'workspace'));
      writeFilesystemServer(serverScript);
      try {
        const arms: ArmConfig[] = [
          { name: 'off', mode: 'off' },
          { name: 'default', mode: 'annotated' },
          {
            name: 'unconstrained',
            mode: 'annotated',
            speculation: { adaptiveAdmission: false, minExpectedSavedMs: 0 },
          },
        ];
        const results: ArmResult[] = [];
        for (const arm of arms) results.push(await runArm(root, serverScript, arm));
        process.stdout.write(
          `FILESYSTEM_REAL_E2E ${JSON.stringify({ target: TARGET_ROOT, latencyMs: LATENCY_MS, thinkMs: THINK_MS, results })}\n`,
        );

        const [off, defaultArm, unconstrained] = results;
        expect(off!.hits + off!.joins).toBe(0);
        if (TARGET_ROOT === ROOT) {
          expect(defaultArm!.predictor.opportunities).toBeGreaterThan(0);
          expect(unconstrained!.predictor.opportunities).toBeGreaterThan(0);
        }
        // The raw predictor should make real calls useful by the final
        // persisted session, even if an alternate target version is under test.
        expect(unconstrained!.sessionHitRates.at(-1)).toBeGreaterThan(0);
        expect(unconstrained!.latency.meanMs).toBeLessThan(off!.latency.meanMs);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
