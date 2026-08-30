/**
 * Opt-in E2E benchmark against a disposable, real Git repository.
 *
 * The upstream is an SDK-backed stdio MCP server whose handlers invoke the
 * installed `git` binary. No upstream latency is injected: this intentionally
 * exercises both schema cold-start prediction and the default admission rule
 * that should avoid speculating when local Git is already too fast to matter.
 *
 *   SPECULATE_REAL_E2E=1 npx vitest run test/git-real-e2e.test.ts
 *
 * Set SPECULATE_E2E_TARGET_ROOT to an archived checkout to compare another
 * implementation while keeping this driver and its fixture identical.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const THINK_MS = Number.parseInt(process.env.SPECULATE_E2E_THINK_MS ?? '50', 10);
const SESSIONS = Number.parseInt(process.env.SPECULATE_E2E_SESSIONS ?? '5', 10);
const TEST_TIMEOUT_MS = 180_000;

interface Step {
  tool: string;
  args: Record<string, unknown>;
}

interface Arm {
  name: 'off' | 'default' | 'unconstrained';
  mode: 'off' | 'annotated';
  speculation?: { adaptiveAdmission: boolean; minExpectedSavedMs: number };
}

interface Result {
  arm: Arm['name'];
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  wasted: number;
  hitRate: number;
  estimatedSavedMs: number;
  estimatedAddedWaitMs: number;
  netEstimatedSavedMs: number;
  predictionOpportunities: number;
  predictionHitsAt3: number;
  recallAt3: number | null;
  calibration: {
    evaluations: number;
    correct: number;
    brierScore: number | null;
    staticBrierScore: number | null;
    correctButSuppressed: number;
    admittedButWrong: number;
  };
  sessionHitRates: number[];
  meanMs: number;
  p95Ms: number;
  upstreamCalls: number;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function write(repo: string, relative: string, text: string): void {
  const target = join(repo, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function createRepository(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'speculate-e2e@example.invalid']);
  git(repo, ['config', 'user.name', 'Speculate E2E']);
  const commits = [
    ['src/auth.ts', 'export function refreshToken(v: string) { return v + "-new"; }\n'],
    ['src/cache.ts', 'export const refreshTokenCache = new Map<string, string>();\n'],
    ['docs/auth.md', 'Call refreshToken when a credential expires.\n'],
    ['src/router.ts', 'export function route(path: string) { return path; }\n'],
  ] as const;
  commits.forEach(([path, text], index) => {
    write(repo, path, text);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', `fixture commit ${index + 1}`]);
  });
  git(repo, ['tag', '-a', 'v1.0.0', '-m', 'fixture release']);
  git(repo, ['branch', 'feature/cache']);
}

/** Write a real-git MCP server using the repository's installed SDK. */
function writeGitServer(target: string): void {
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
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { McpServer } from ${JSON.stringify(mcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const repo = process.env.SPEC_GIT_REPO;
const callLog = process.env.SPEC_GIT_CALL_LOG;
const run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const lines = (value) => value ? value.split(/\r?\n/).filter(Boolean) : [];
const reply = (tool, args, payload) => {
  if (callLog) appendFileSync(callLog, JSON.stringify({ tool, args, at: Date.now() }) + '\n');
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
};
const server = new McpServer({ name: 'real-git-e2e', version: '1.0.0' });
const readOnly = { readOnlyHint: true };

server.registerTool('list_commits', {
  inputSchema: { ref: z.string(), limit: z.number().int().positive() }, annotations: readOnly,
}, async ({ ref, limit }) => reply('list_commits', { ref, limit }, {
  commits: lines(run(['log', '-n', String(limit), '--format=%H%x09%s', ref])).map((line) => {
    const [sha, subject] = line.split('\t'); return { sha, subject };
  }),
}));
server.registerTool('show_commit', {
  inputSchema: { sha: z.string() }, annotations: readOnly,
}, async ({ sha }) => reply('show_commit', { sha }, { sha, text: run(['show', '--stat', '--oneline', sha]) }));
server.registerTool('search_files', {
  inputSchema: { query: z.string() }, annotations: readOnly,
}, async ({ query }) => reply('search_files', { query }, {
  matches: lines(run(['grep', '-l', query])).map((path) => ({ path })),
}));
server.registerTool('read_file', {
  inputSchema: { path: z.string() }, annotations: readOnly,
}, async ({ path }) => reply('read_file', { path }, { path, content: run(['show', 'HEAD:' + path]) }));
server.registerTool('list_tags', {
  inputSchema: {}, annotations: readOnly,
}, async () => reply('list_tags', {}, { tags: lines(run(['tag', '--list'])).map((name) => ({ name })) }));
server.registerTool('show_tag', {
  inputSchema: { name: z.string() }, annotations: readOnly,
}, async ({ name }) => reply('show_tag', { name }, { name, text: run(['show', '--stat', '--oneline', name]) }));
server.registerTool('list_branches', {
  inputSchema: {}, annotations: readOnly,
}, async () => reply('list_branches', {}, {
  branches: lines(run(['branch', '--format=%(refname:short)'])).map((name) => ({ name })),
}));
server.registerTool('show_branch', {
  inputSchema: { name: z.string() }, annotations: readOnly,
}, async ({ name }) => reply('show_branch', { name }, { name, sha: run(['rev-parse', name]) }));
await server.connect(new StdioServerTransport());
`,
  );
}

function workflow(repo: string): Step[] {
  const commits = git(repo, ['rev-list', '--max-count=2', 'HEAD']).split(/\r?\n/);
  return [
    { tool: 'list_commits', args: { ref: 'HEAD', limit: 3 } },
    { tool: 'show_commit', args: { sha: commits[0]! } },
    { tool: 'show_commit', args: { sha: commits[1]! } },
    { tool: 'search_files', args: { query: 'refreshToken' } },
    { tool: 'read_file', args: { path: 'docs/auth.md' } },
    { tool: 'list_tags', args: {} },
    { tool: 'show_tag', args: { name: 'v1.0.0' } },
    { tool: 'list_branches', args: {} },
    { tool: 'show_branch', args: { name: 'feature/cache' } },
  ];
}

function payload<T>(result: CallToolResult): T {
  const block = result.content.find((entry) => entry.type === 'text');
  if (!block || block.type !== 'text') throw new Error('expected JSON text result');
  return JSON.parse(block.text) as T;
}

async function runSession(
  root: string,
  repo: string,
  serverScript: string,
  steps: Step[],
  arm: Arm,
): Promise<{ latencies: number[]; stats: StatsReport }> {
  const armRoot = join(root, arm.name);
  mkdirSync(armRoot, { recursive: true });
  const configPath = join(armRoot, 'config.json');
  const logPath = join(armRoot, 'upstream.jsonl');
  writeFileSync(configPath, JSON.stringify({
    mode: arm.mode,
    log: 'off',
    persistence: { path: join(armRoot, 'state.json') },
    servers: {
      git: {
        command: process.execPath,
        args: [serverScript],
        env: { SPEC_GIT_REPO: repo, SPEC_GIT_CALL_LOG: logPath },
        ...(arm.speculation ? { speculation: arm.speculation } : {}),
      },
    },
  }));
  const client = new Client({ name: `git-e2e-${arm.name}`, version: '1.0.0' }, { capabilities: {} });
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
    for (const step of steps) {
      const started = performance.now();
      const result = (await client.callTool({ name: step.tool, arguments: step.args })) as CallToolResult;
      latencies.push(performance.now() - started);
      expect(result.isError, `${step.tool} should succeed`).toBeFalsy();
      if (arm.mode !== 'off') await sleep(THINK_MS);
    }
    const stats = payload<StatsReport>((await client.callTool({
      name: 'speculate__stats', arguments: {},
    })) as CallToolResult);
    return { latencies, stats };
  } finally {
    await client.close().catch(() => {});
    await sleep(80);
  }
}

async function runArm(
  root: string,
  repo: string,
  serverScript: string,
  steps: Step[],
  arm: Arm,
): Promise<Result> {
  const latencies: number[] = [];
  const sessionHitRates: number[] = [];
  let opportunities = 0;
  let hitsAt3 = 0;
  let calibrationEvaluations = 0;
  let calibrationCorrect = 0;
  let calibrationBrierSum = 0;
  let staticBrierSum = 0;
  let correctButSuppressed = 0;
  let admittedButWrong = 0;
  for (let session = 0; session < SESSIONS; session++) {
    const result = await runSession(root, repo, serverScript, steps, arm);
    latencies.push(...result.latencies);
    const requests = result.stats.hits + result.stats.joins + result.stats.misses;
    sessionHitRates.push(requests === 0 ? 0 : (result.stats.hits + result.stats.joins) / requests);
    opportunities += result.stats.predictionQuality?.opportunities ?? 0;
    hitsAt3 += result.stats.predictionQuality?.hitsAt3 ?? 0;
    const calibration = result.stats.calibration;
    calibrationEvaluations += calibration.evaluations;
    calibrationCorrect += calibration.correct;
    calibrationBrierSum += (calibration.brierScore ?? 0) * calibration.evaluations;
    staticBrierSum += (calibration.staticBrierScore ?? 0) * calibration.evaluations;
    correctButSuppressed += calibration.correctButSuppressed;
    admittedButWrong += calibration.admittedButWrong;
  }
  const report = readUsageReport(join(root, arm.name, 'xdg', 'speculate', 'usage'));
  const totals = report.totals;
  const requested = totals.hits + totals.joins + totals.misses;
  const useful = totals.hits + totals.joins;
  const logPath = join(root, arm.name, 'upstream.jsonl');
  const upstreamCalls = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    arm: arm.name,
    hits: totals.hits,
    joins: totals.joins,
    misses: totals.misses,
    speculativeCalls: totals.speculativeCalls,
    wasted: totals.wasted,
    hitRate: requested === 0 ? 0 : useful / requested,
    estimatedSavedMs: totals.estimatedSavedMs,
    estimatedAddedWaitMs: totals.estimatedAddedWaitMs ?? 0,
    netEstimatedSavedMs: totals.estimatedSavedMs - (totals.estimatedAddedWaitMs ?? 0),
    predictionOpportunities: opportunities,
    predictionHitsAt3: hitsAt3,
    recallAt3: opportunities === 0 ? null : hitsAt3 / opportunities,
    calibration: {
      evaluations: calibrationEvaluations,
      correct: calibrationCorrect,
      brierScore:
        calibrationEvaluations === 0 ? null : calibrationBrierSum / calibrationEvaluations,
      staticBrierScore:
        calibrationEvaluations === 0 ? null : staticBrierSum / calibrationEvaluations,
      correctButSuppressed,
      admittedButWrong,
    },
    sessionHitRates,
    meanMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
    upstreamCalls,
  };
}

describe.skipIf(!RUN)('real local Git MCP E2E', () => {
  it('measures cold prediction and fast-upstream admission over persistent sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'speculate-git-real-e2e-'));
    const repo = join(root, 'repo');
    const serverScript = join(root, 'git-server.mjs');
    createRepository(repo);
    writeGitServer(serverScript);
    try {
      const arms: Arm[] = [
        { name: 'off', mode: 'off' },
        { name: 'default', mode: 'annotated' },
        {
          name: 'unconstrained',
          mode: 'annotated',
          speculation: { adaptiveAdmission: false, minExpectedSavedMs: 0 },
        },
      ];
      const results: Result[] = [];
      for (const arm of arms) results.push(await runArm(root, repo, serverScript, workflow(repo), arm));
      process.stdout.write(`GIT_REAL_E2E ${JSON.stringify({
        target: TARGET_ROOT, thinkMs: THINK_MS, sessions: SESSIONS, results,
      })}\n`);

      const [off, defaultArm, unconstrained] = results;
      expect(off!.hits + off!.joins).toBe(0);
      expect(unconstrained!.sessionHitRates.at(-1)).toBeGreaterThan(0);
      if (TARGET_ROOT === ROOT) {
        expect(defaultArm!.predictionOpportunities).toBeGreaterThan(0);
        expect(unconstrained!.predictionOpportunities).toBeGreaterThan(0);
        // Schema-backed morphology should make the very first list→detail
        // workflow useful before transition persistence exists.
        expect(unconstrained!.sessionHitRates[0]).toBeGreaterThan(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
