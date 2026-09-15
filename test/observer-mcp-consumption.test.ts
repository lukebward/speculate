import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/agentAdapters/claude.js';
import { codexAdapter } from '../src/agentAdapters/codex.js';
import {
  SessionBridge,
  type CandidateAuthorizationInput,
} from '../src/sessionBridge.js';
import type {
  AgentAdapter,
  AgentKind,
  HostPermissionDecision,
  RegisteredRoute,
  SessionContext,
} from '../src/observerTypes.js';
import type { StatsReport } from '../src/types.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixtureServer = join(root, 'test', 'fixtures', 'observer', 'mcp-consumption-server.ts');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
}

interface Harness {
  agent: AgentKind;
  adapter: AgentAdapter;
  bridge: SessionBridge;
  client: Client;
  context: SessionContext;
  directory: string;
  workspace: string;
  authorizations: CandidateAuthorizationInput[];
  route(tool: string): Promise<RegisteredRoute>;
  calls(): ToolCallRecord[];
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

function readCalls(path: string): ToolCallRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ToolCallRecord);
}

async function waitFor<T>(read: () => T, accepts: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!accepts(value) && Date.now() < deadline) {
    await delay(10);
    value = read();
  }
  if (!accepts(value)) throw new Error('timed out waiting for integration state');
  return value;
}

async function startHarness(
  agent: AgentKind,
  authorize: () => HostPermissionDecision = () => 'allowed',
  startupPolicy: () => { enabled: boolean; allowTools: string[] | null; denyTools: string[] } = () => ({
    enabled: true,
    allowTools: ['list_directory', 'read_file', 'git_status'],
    denyTools: [],
  }),
  latencyMs = 0,
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), `speculate-consumption-${agent}-`));
  const workspacePath = join(directory, 'workspace');
  const callLog = join(directory, 'calls.jsonl');
  mkdirSync(join(workspacePath, 'src'), { recursive: true });
  const workspace = realpathSync(workspacePath);
  writeFileSync(join(workspace, 'notes.txt'), 'workspace fixture\n');
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const fixture = true;\n');
  writeFileSync(join(workspace, '.git-status.json'), JSON.stringify([
    { path: 'notes.txt', status: 'modified' },
    { path: 'src/index.ts', status: 'untracked' },
  ]));
  const context: SessionContext = {
    launchId: `launch-${agent}`,
    conversationId: `conversation-${agent}`,
    agent,
    cwd: workspace,
  };
  const authorizations: CandidateAuthorizationInput[] = [];
  const bridge = await SessionBridge.start(context, {
    authorizeCandidate: async (input) => {
      authorizations.push(input);
      const decision = authorize();
      return {
        decision,
        permissionContext: decision === 'allowed' ? `permission-${agent}` : null,
      };
    },
    startupPolicy: async () => startupPolicy(),
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      tsxCli,
      join(root, 'src', 'cli.ts'),
      'wrap',
      '--mode', 'strict',
      '--allow', 'list_directory,read_file,git_status',
      '--host-client', agent,
      '--host-server', 'workspace',
      '--cwd', workspace,
      '--',
      process.execPath,
      tsxCli,
      fixtureServer,
    ],
    cwd: root,
    env: {
      ...process.env,
      XDG_STATE_HOME: directory,
      SPECULATE_SESSION_SOCKET: bridge.coordinates.socketPath,
      SPECULATE_SESSION_CAPABILITY: bridge.coordinates.capability,
      SPECULATE_SESSION_LAUNCH_ID: bridge.coordinates.launchId,
      SPECULATE_CONSUMPTION_CALL_LOG: callLog,
      SPECULATE_CONSUMPTION_LATENCY_MS: String(latencyMs),
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: `consumption-${agent}`, version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    await bridge.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const adapterEnvironment = {
    contextForConversation: (conversationId: string) => conversationId === context.conversationId ? context : null,
    routes: () => bridge.listRoutes(),
    now: Date.now,
  };
  const adapter = agent === 'claude'
    ? claudeAdapter(adapterEnvironment)
    : codexAdapter(adapterEnvironment);
  const harness: Harness = {
    agent,
    adapter,
    bridge,
    client,
    context,
    directory,
    workspace,
    authorizations,
    route: async (tool) => waitFor(
      () => bridge.listRoutes().find((route) => route.exposedTool === tool),
      (route): route is RegisteredRoute => route !== undefined,
    ),
    calls: () => readCalls(callLog),
    close: async () => {
      await client.close().catch(() => {});
      await bridge.close().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

async function publishModelSelection(
  harness: Harness,
  route: RegisteredRoute,
  args: Record<string, unknown>,
  callId: string,
): Promise<void> {
  const name = `mcp__workspace__${route.exposedTool}`;
  const connection = harness.adapter.createConnection();
  const observer = connection.startRequest({
    transport: 'http',
    method: 'POST',
    path: harness.agent === 'claude' ? '/v1/messages' : '/v1/responses',
    headers: harness.agent === 'claude'
      ? { 'x-claude-code-session-id': harness.context.conversationId, 'content-type': 'application/json' }
      : { 'thread-id': harness.context.conversationId, 'content-type': 'application/json' },
  });
  if (!observer) throw new Error('adapter did not accept the model request');
  const request = harness.agent === 'claude'
    ? {
        messages: [{ role: 'user', content: 'Inspect the requested workspace data.' }],
        tools: [{ name, input_schema: route.inputSchema }],
      }
    : {
        input: 'Inspect the requested workspace data.',
        tools: [{ type: 'function', name, parameters: route.inputSchema }],
      };
  observer.observeRequestBody(Buffer.from(JSON.stringify(request)));
  observer.observeResponseStart({ status: 200, headers: { 'content-type': 'application/json' } });
  const response = harness.agent === 'claude'
    ? { content: [{ type: 'tool_use', id: callId, name, input: args }] }
    : {
        id: `response-${callId}`,
        status: 'completed',
        output: [{
          id: `item-${callId}`,
          type: 'function_call',
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
          status: 'completed',
        }],
      };
  observer.observeResponseChunk(Buffer.from(JSON.stringify(response)));
  const observations = observer.observeResponseEnd();
  connection.close();
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    kind: 'stream-call',
    routeId: route.routeId,
    args,
  });
  expect(harness.bridge.publishObservation(observations[0]!)).toBe(true);
}

async function publishHookIntent(harness: Harness): Promise<void> {
  const payload = harness.agent === 'claude'
    ? {
        hook_event_name: 'UserPromptSubmit',
        session_id: harness.context.conversationId,
        cwd: harness.workspace,
        prompt: 'List the workspace directory.',
      }
    : {
        type: 'user-prompt-submit',
        thread_id: harness.context.conversationId,
        cwd: harness.workspace,
        prompt: 'List the workspace directory.',
      };
  const observations = harness.adapter.normalizeHook(payload);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ kind: 'prompt', context: harness.context });
  expect(harness.bridge.publishObservation(observations[0]!)).toBe(true);
}

async function callTool(
  harness: Harness,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return await harness.client.callTool({ name: tool, arguments: args }) as CallToolResult;
}

function payload<T>(result: CallToolResult): T {
  const block = result.content.find((item) => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('expected a text result');
  return JSON.parse(block.text) as T;
}

async function stats(harness: Harness): Promise<StatsReport> {
  return payload<StatsReport>(await callTool(harness, 'speculate__stats', {}));
}

async function waitForStats(
  harness: Harness,
  accepts: (report: StatsReport) => boolean,
  timeoutMs = 5_000,
): Promise<StatsReport> {
  const deadline = Date.now() + timeoutMs;
  let report = await stats(harness);
  while (!accepts(report) && Date.now() < deadline) {
    await delay(10);
    report = await stats(harness);
  }
  if (!accepts(report)) throw new Error('timed out waiting for proxy statistics');
  return report;
}

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map((harness) => harness.close()));
});

describe.each(['claude', 'codex'] as const)('%s registered MCP consumption', (agent) => {
  it('consumes hook and model candidates through the real MCP client without duplicate upstream calls', async () => {
    const harness = await startHarness(agent);
    const listRoute = await harness.route('list_directory');
    await publishHookIntent(harness);
    await waitFor(harness.calls, (calls) => calls.length === 1);
    await waitForStats(harness, (report) => report.cache.ready === 1);
    const listing = await callTool(harness, 'list_directory', { path: harness.workspace });
    expect(payload(listing)).toEqual({
      tool: 'list_directory',
      cwd: harness.workspace,
      entries: [
        { name: 'notes.txt', type: 'file' },
        { name: 'src', type: 'directory' },
      ],
    });

    const readRoute = await harness.route('read_file');
    await publishModelSelection(harness, readRoute, { path: 'notes.txt' }, 'read-call');
    await waitFor(harness.calls, (calls) => calls.length === 2);
    await waitForStats(harness, (report) => report.cache.ready === 1);
    expect(payload(await callTool(harness, 'read_file', { path: 'notes.txt' }))).toEqual({
      tool: 'read_file',
      cwd: harness.workspace,
      path: 'notes.txt',
      content: 'workspace fixture\n',
    });

    const gitRoute = await harness.route('git_status');
    await publishModelSelection(harness, gitRoute, {}, 'git-call');
    const calls = await waitFor(harness.calls, (items) => items.length === 3);
    await waitForStats(harness, (report) => report.cache.ready === 1);
    expect(payload(await callTool(harness, 'git_status', {}))).toEqual({
      tool: 'git_status',
      cwd: harness.workspace,
      changes: [
        { path: 'notes.txt', status: 'modified' },
        { path: 'src/index.ts', status: 'untracked' },
      ],
    });

    expect(calls).toEqual([
      { tool: 'list_directory', args: { path: harness.workspace }, cwd: harness.workspace },
      { tool: 'read_file', args: { path: 'notes.txt' }, cwd: harness.workspace },
      { tool: 'git_status', args: {}, cwd: harness.workspace },
    ]);
    expect(harness.calls()).toHaveLength(3);
    expect(harness.authorizations.map(({ candidate, route, context }) => ({
      client: route.hostClient,
      tool: route.exposedTool,
      alias: route.hostServerAlias,
      args: candidate.args,
      cwd: context.cwd,
    }))).toEqual([
      { client: agent, tool: 'list_directory', alias: 'workspace', args: { path: harness.workspace }, cwd: harness.workspace },
      { client: agent, tool: 'read_file', alias: 'workspace', args: { path: 'notes.txt' }, cwd: harness.workspace },
      { client: agent, tool: 'git_status', alias: 'workspace', args: {}, cwd: harness.workspace },
    ]);
    expect(await stats(harness)).toMatchObject({ speculativeCalls: 3, hits: 3, realCalls: 0 });
  }, 30_000);

  it('invalidates prefetched reads across a filesystem mutation', async () => {
    const harness = await startHarness(agent);
    const route = await harness.route('read_file');
    await publishModelSelection(harness, route, { path: 'notes.txt' }, 'before-mutation');
    await waitFor(harness.calls, (calls) => calls.length === 1);
    await waitForStats(harness, (report) => report.cache.ready === 1);

    expect((await callTool(harness, 'write_file', {
      path: 'notes.txt',
      content: 'changed fixture\n',
    })).isError).toBeFalsy();
    expect(payload(await callTool(harness, 'read_file', { path: 'notes.txt' }))).toMatchObject({
      cwd: harness.workspace,
      content: 'changed fixture\n',
    });
    expect(harness.calls().map(({ tool }) => tool)).toEqual(['read_file', 'write_file', 'read_file']);
    expect((await stats(harness)).invalidated).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it.each(['denied', 'approval-required'] as const)('abstains when exact host authorization is %s', async (decision) => {
    const harness = await startHarness(agent, () => decision);
    const route = await harness.route('read_file');
    await publishModelSelection(harness, route, { path: 'notes.txt' }, `blocked-${decision}`);
    await waitFor(() => harness.authorizations, (items) => items.length === 1);

    expect(harness.calls()).toEqual([]);
    expect(harness.authorizations).toHaveLength(1);
    expect(payload(await callTool(harness, 'read_file', { path: 'notes.txt' }))).toMatchObject({
      cwd: harness.workspace,
      content: 'workspace fixture\n',
    });
    expect(harness.calls()).toHaveLength(1);
    expect(await stats(harness)).toMatchObject({ speculativeCalls: 0, hits: 0, misses: 1, realCalls: 1 });
  }, 30_000);

  it('falls back to the upstream after the session owner disconnects', async () => {
    const harness = await startHarness(agent);
    const route = await harness.route('read_file');
    await publishModelSelection(harness, route, { path: 'notes.txt' }, 'disconnect-call');
    await waitFor(harness.calls, (calls) => calls.length === 1);
    await waitForStats(harness, (report) => report.cache.ready === 1);
    await harness.bridge.close();
    await waitForStats(harness, (report) => report.cache.ready === 0);

    expect(payload(await callTool(harness, 'read_file', { path: 'notes.txt' }))).toMatchObject({
      cwd: harness.workspace,
      content: 'workspace fixture\n',
    });
    expect(harness.calls().map(({ tool }) => tool)).toEqual(['read_file', 'read_file']);
  }, 30_000);
});

describe('Claude launch policy projection', () => {
  it.each([
    ['allowed', ['list_directory', 'read_file', 'git_status'], true],
    ['denied-or-ask', [], false],
  ] as const)('gates learned baseline predictions when exact host policy is %s', async (_label, allowTools, expectsSpeculation) => {
    const harness = await startHarness('claude', () => 'allowed', () => ({
      enabled: true, allowTools: [...allowTools], denyTools: [],
    }), 25);
    for (let repetition = 0; repetition < 4; repetition++) {
      await callTool(harness, 'list_directory', { path: harness.workspace });
      await delay(5);
      await callTool(harness, 'read_file', { path: 'notes.txt' });
      await delay(5);
    }
    await callTool(harness, 'list_directory', { path: harness.workspace });
    await delay(100);

    expect(harness.calls().map(({ tool }) => tool)).toEqual([
      'list_directory', 'read_file', 'list_directory', 'read_file',
      'list_directory', 'read_file', 'list_directory', 'read_file', 'list_directory',
      ...(expectsSpeculation ? ['read_file'] : []),
    ]);
    const speculativeCalls = (await stats(harness)).speculativeCalls;
    if (expectsSpeculation) expect(speculativeCalls).toBeGreaterThan(0);
    else expect(speculativeCalls).toBe(0);
  }, 30_000);
});
