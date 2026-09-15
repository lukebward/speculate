import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { AddressInfo, createConnection } from 'node:net';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { claudeAdapter, buildLaunchPlan as buildClaudeLaunchPlan } from '../src/agentAdapters/claude.js';
import { codexAdapter, buildLaunchPlan as buildCodexLaunchPlan } from '../src/agentAdapters/codex.js';
import { startLlmProxy, type LlmProxy } from '../src/llmProxy.js';
import { Metrics } from '../src/metrics.js';
import type { AgentKind, Candidate, LocalRouteDescriptor, Observation, SessionContext } from '../src/observerTypes.js';
import { CompletionLedger, prepareAgentRun, runAgent, SessionMeasurementCollector, type PreparedAgentRun } from '../src/runAgent.js';
import { SessionBridge, connectSessionBridgeOwner } from '../src/sessionBridge.js';
import { UsageRecorder } from '../src/usage.js';

const roots: string[] = [];
const servers: Server[] = [];
const proxies: LlmProxy[] = [];
const webSocketServers: WebSocketServer[] = [];
const webSocketClients: WebSocket[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const client of webSocketClients.splice(0)) client.terminate();
  await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.allSettled(webSocketServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'speculate-observer-recovery-'));
  roots.push(value);
  return value;
}

function context(agent: AgentKind, launchId = 'launch'): SessionContext {
  return { launchId, conversationId: 'thread', agent, cwd: '/work' };
}

const route: LocalRouteDescriptor = {
  exposedTool: 'read',
  upstreamServer: 'upstream',
  upstreamTool: 'read',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

function hookPayload(agent: AgentKind, event: string): Record<string, unknown> {
  return agent === 'claude'
    ? {
        hook_event_name: event,
        session_id: 'thread',
        tool_name: 'mcp__files__read',
        tool_use_id: 'call',
        tool_input: { path: '/work/a' },
      }
    : {
        type: event,
        thread_id: 'thread',
        tool_name: 'mcp__files__read',
        tool_use_id: 'call',
        arguments: { path: '/work/a' },
      };
}

async function detectedGap(agent: AgentKind, events: string[]): Promise<Observation[]> {
  const launchContext = context(agent);
  const bridge = await SessionBridge.start(launchContext, { now: () => 100 });
  const owner = await connectSessionBridgeOwner(bridge.coordinates, {
    hostClient: agent,
    hostServerAlias: 'files',
    onCandidates: () => {},
  });
  await owner.register([route]);
  const observations: Observation[] = [];
  bridge.subscribe((observation) => observations.push(observation));
  let sequence = 0;
  const adapter = (agent === 'claude' ? claudeAdapter : codexAdapter)({
    contextForConversation: () => launchContext,
    routes: () => bridge.listRoutes(),
    now: () => 100,
    onTrackingLoss: (observedAt) => {
      bridge.publishObservation({
        kind: 'invalidate',
        context: launchContext,
        eventId: `tracking-gap:${++sequence}`,
        observedAt,
        routeIds: [],
        reason: 'observer-tracking-gap',
      });
    },
  });
  for (const event of events) adapter.normalizeHook(hookPayload(agent, event), 100);
  await new Promise((resolve) => setImmediate(resolve));
  const result = [...observations];
  await owner.close();
  await bridge.close();
  return result;
}

async function sendHook(coordinates: { socketPath: string; capability: string; launchId: string }, payload: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(coordinates.socketPath, () => {
      socket.end(`${JSON.stringify({
        type: 'hook',
        capability: coordinates.capability,
        launchId: coordinates.launchId,
        hostClient: 'claude',
        payload,
      })}\n`, resolve);
    });
    socket.once('error', reject);
  });
}

describe('detected hook boundary gaps', () => {
  it.each([
    ['claude', ['PostToolUse']],
    ['codex', ['after-tool-use']],
  ] as const)('invalidates %s observation state when a settle arrives without its start', async (agent, events) => {
    const observations = await detectedGap(agent, [...events]);
    expect(observations).toContainEqual(expect.objectContaining({
      kind: 'invalidate',
      routeIds: [],
      reason: 'observer-tracking-gap',
    }));
  });

  it.each([
    ['claude', ['PreToolUse', 'SessionEnd']],
    ['codex', ['before-tool-use', 'SessionEnd']],
  ] as const)('invalidates %s observation state when a session ends without a settle', async (agent, events) => {
    const observations = await detectedGap(agent, [...events]);
    expect(observations).toContainEqual(expect.objectContaining({
      kind: 'invalidate',
      routeIds: [],
      reason: 'observer-tracking-gap',
    }));
  });

  it.each([
    ['claude', ['PreToolUse', 'PostToolUseFailure', 'SessionEnd']],
    ['codex', ['before-tool-use', 'tool-use-error', 'SessionEnd']],
  ] as const)('keeps %s tracking healthy when a cancelled tool has both hook boundaries', async (agent, events) => {
    const observations = await detectedGap(agent, [...events]);
    expect(observations.filter((observation) => observation.kind === 'invalidate')).toEqual([]);
  });

  it.each(['claude', 'codex'] as const)('bounds %s hook phase state and reports overflow as tracking loss', (agent) => {
    const launchContext = context(agent);
    let losses = 0;
    const adapter = (agent === 'claude' ? claudeAdapter : codexAdapter)({
      contextForConversation: () => launchContext,
      routes: () => [],
      now: () => 100,
      onTrackingLoss: () => { losses++; },
    });
    const start = agent === 'claude' ? 'PreToolUse' : 'before-tool-use';
    for (let index = 0; index <= 1_024; index++) {
      adapter.normalizeHook({ ...hookPayload(agent, start), tool_use_id: `call-${index}` }, 100);
    }
    expect(losses).toBe(1);
  });

  it('clears learned prompt replay through the prepared launch priority path after a detected gap', async () => {
    const testRoot = root();
    const home = join(testRoot, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { files: { command: process.execPath } } }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['mcp__files__list_directory'] },
    }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SPECULATE_CLAUDE_BIN', process.execPath);
    const prepared = await prepareAgentRun({ agent: 'claude', observe: 'hooks', clientArgs: [], jsonReport: null });
    const mcpPath = prepared.plan.args.find((arg) => arg.startsWith('--mcp-config='))!.slice('--mcp-config='.length);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    const ownerCoordinates = {
      socketPath: mcp.mcpServers.files.env.SPECULATE_SESSION_SOCKET,
      capability: mcp.mcpServers.files.env.SPECULATE_SESSION_CAPABILITY,
      launchId: mcp.mcpServers.files.env.SPECULATE_SESSION_LAUNCH_ID,
    };
    const hookCoordinates = {
      socketPath: prepared.plan.env.SPECULATE_OBSERVER_SOCKET!,
      capability: prepared.plan.env.SPECULATE_OBSERVER_CAPABILITY!,
      launchId: prepared.plan.env.SPECULATE_OBSERVER_LAUNCH_ID!,
    };
    const received: Candidate[] = [];
    const owner = await connectSessionBridgeOwner(ownerCoordinates, {
      hostClient: 'claude',
      hostServerAlias: 'files',
      onCandidates: (values) => received.push(...values.map((value) => 'candidate' in value ? value.candidate : value)),
    });
    const [registered] = await owner.register([{
      exposedTool: 'list_directory',
      upstreamServer: 'upstream',
      upstreamTool: 'list_directory',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }]);
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'thread',
      cwd: process.cwd(),
      prompt: 'list workspace',
    };
    await sendHook(hookCoordinates, prompt);
    for (let attempt = 0; attempt < 30 && received.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(received).toHaveLength(1);
    await sendHook(hookCoordinates, {
      hook_event_name: 'PostToolUse',
      session_id: 'thread',
      cwd: process.cwd(),
      tool_name: 'mcp__files__list_directory',
      tool_use_id: 'missing-start',
      tool_input: { path: process.cwd() },
    });
    for (let attempt = 0; attempt < 30 && !prepared.disabledCapabilities().includes('completion-correlation:tracking-lost'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(prepared.disabledCapabilities()).toContain('completion-correlation:tracking-lost');
    await owner.publishObservation({
      kind: 'prompt',
      context: { launchId: ownerCoordinates.launchId, conversationId: 'thread', agent: 'claude', cwd: process.cwd() },
      eventId: 'proxy-copy',
      occurrenceId: received[0]!.sourceEventId,
      observedAt: Date.now(),
      text: 'list workspace',
    });
    for (let attempt = 0; attempt < 30 && received.length === 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ routeId: registered!.routeId, launchId: ownerCoordinates.launchId });
    await owner.close();
    await prepared.close();
  });
});

interface ProviderCall {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

async function exchange(url: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function cancelExchange(url: string, headers: Record<string, string>, body: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      response.once('data', () => {
        request.destroy();
        response.destroy();
        resolve();
      });
    });
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
      else reject(error);
    });
    request.end(body);
  });
}

function webSocketEvent(socket: WebSocket, event: 'open' | 'close' | 'message'): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onEvent);
      socket.off('error', onError);
    };
    const onEvent = (...args: unknown[]) => {
      cleanup();
      resolve(args);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once(event, onEvent);
    socket.once('error', onError);
  });
}

describe('client-owned relay recovery', () => {
  it.each(['claude', 'codex'] as const)('surfaces one failed %s exchange and uses fresh auth, model, and endpoint only on the client retry', async (agent) => {
    const calls: ProviderCall[] = [];
    let cancelled = false;
    const provider = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        calls.push({ path: request.url ?? '/', headers: request.headers, body: Buffer.concat(chunks) });
        if (request.url?.endsWith('/failed')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('partial');
          response.socket!.destroy();
          return;
        }
        if (request.url?.endsWith('/cancelled')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('partial');
          response.on('close', () => { if (!response.writableEnded) cancelled = true; });
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    servers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const upstreamBaseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const adapter = (agent === 'claude' ? claudeAdapter : codexAdapter)({
      contextForConversation: (conversationId) => ({
        launchId: 'launch', conversationId, agent, cwd: '/work',
      }),
      routes: () => [],
    });
    const failedRelay = await startLlmProxy({ upstreamBaseUrl, adapter });
    const freshRelay = await startLlmProxy({ upstreamBaseUrl, adapter });
    proxies.push(failedRelay, freshRelay);
    const path = agent === 'claude' ? '/v1/messages' : '/v1/responses';
    const oldBody = Buffer.from('{"model":"old-model"}');
    await expect(exchange(`${failedRelay.baseUrl}${path}/failed`, {
      authorization: 'Bearer old-token',
      'content-type': 'application/json',
      ...(agent === 'claude' ? { 'x-claude-code-session-id': 'thread' } : { 'thread-id': 'thread' }),
    }, oldBody)).resolves.toEqual({ status: 502, body: Buffer.alloc(0) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(failedRelay.debugObservationState().totalRequests).toBe(1);
    expect(failedRelay.debugObservationState().failures).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    await failedRelay.close();
    proxies.splice(proxies.indexOf(failedRelay), 1);

    const testRoot = root();
    const freshBody = Buffer.from('{"model":"fresh-model"}');
    if (agent === 'claude') {
      const home = join(testRoot, 'home');
      const cwd = join(testRoot, 'work');
      mkdirSync(home);
      mkdirSync(cwd);
      const coordinates = { socketPath: '/private/observer.sock', capability: 'capability', launchId: 'launch' };
      const plan = await buildClaudeLaunchPlan({
        cwd,
        home,
        env: { HOME: home, ANTHROPIC_BASE_URL: upstreamBaseUrl },
        clientArgs: ['--model', 'fresh-model'],
        observe: 'proxy',
        relayBaseUrl: freshRelay.baseUrl,
        session: coordinates,
        hook: coordinates,
        self: { command: process.execPath, args: [] },
        clientBin: process.execPath,
      });
      expect(plan.env.ANTHROPIC_BASE_URL).toBe(freshRelay.baseUrl);
      expect(plan.upstreamBaseUrl).toBe(upstreamBaseUrl);
      expect(plan.args.slice(-2)).toEqual(['--model', 'fresh-model']);
      await plan.cleanup();
    } else {
      const nativeConfig = {
        config: {
          model: 'fresh-model',
          model_provider: 'synthetic',
          model_providers: { synthetic: { base_url: upstreamBaseUrl } },
        },
        layers: [],
        origins: {},
      };
      const original = structuredClone(nativeConfig);
      const coordinates = { socketPath: '/private/observer.sock', capability: 'capability', launchId: 'launch' };
      const plan = await buildCodexLaunchPlan({
        cwd: testRoot,
        env: {},
        clientArgs: ['exec'],
        observe: 'proxy',
        relayBaseUrl: freshRelay.baseUrl,
        session: coordinates,
        hook: coordinates,
        self: { command: process.execPath, args: [] },
        clientBin: process.execPath,
        nativeConfig,
        nativeUpstreamBaseUrl: upstreamBaseUrl,
        nativeGlobalArgs: [],
      });
      expect(plan.args).toContain(`model_providers.synthetic.base_url=${JSON.stringify(freshRelay.baseUrl)}`);
      expect(nativeConfig).toEqual(original);
      await plan.cleanup();
    }

    await expect(exchange(`${freshRelay.baseUrl}${path}/retried`, {
      authorization: 'Bearer fresh-token',
      'content-type': 'application/json',
      ...(agent === 'claude' ? { 'x-claude-code-session-id': 'thread' } : { 'thread-id': 'thread' }),
    }, freshBody)).resolves.toEqual({ status: 200, body: Buffer.from('{"ok":true}') });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.headers.authorization)).toEqual(['Bearer old-token', 'Bearer fresh-token']);
    expect(calls.map((call) => JSON.parse(call.body.toString()).model)).toEqual(['old-model', 'fresh-model']);

    await cancelExchange(`${freshRelay.baseUrl}${path}/cancelled`, {
      authorization: 'Bearer fresh-token',
      'content-type': 'application/json',
      ...(agent === 'claude' ? { 'x-claude-code-session-id': 'thread' } : { 'thread-id': 'thread' }),
    }, freshBody);
    for (let attempt = 0; attempt < 20 && !cancelled; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('surfaces Codex WebSocket loss and forwards only the client-created retry with fresh request state', async () => {
    const upgrades: IncomingHttpHeaders[] = [];
    const messages: string[] = [];
    let connections = 0;
    const webSocketServer = new WebSocketServer({ noServer: true });
    webSocketServers.push(webSocketServer);
    webSocketServer.on('connection', (socket, request) => {
      const connection = ++connections;
      upgrades.push(request.headers);
      socket.on('message', (data) => {
        messages.push(data.toString());
        if (connection === 1) socket.terminate();
        else socket.send('{"type":"response.completed","response":{"id":"fresh","status":"completed"}}');
      });
    });
    const provider = createServer();
    provider.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (accepted) => webSocketServer.emit('connection', accepted, request));
    });
    servers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const upstreamBaseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const adapter = codexAdapter({
      contextForConversation: (conversationId) => ({
        launchId: 'launch', conversationId, agent: 'codex', cwd: '/work',
      }),
      routes: () => [],
    });
    const failedRelay = await startLlmProxy({ upstreamBaseUrl, adapter });
    proxies.push(failedRelay);
    const failedClient = new WebSocket(`${failedRelay.baseUrl.replace(/^http/, 'ws')}/responses`, {
      headers: { authorization: 'Bearer old-token', 'thread-id': 'old-thread' },
    });
    webSocketClients.push(failedClient);
    await webSocketEvent(failedClient, 'open');
    failedClient.send('{"type":"response.create","model":"old-model"}');
    await webSocketEvent(failedClient, 'close');
    expect(messages).toEqual(['{"type":"response.create","model":"old-model"}']);
    expect(failedRelay.debugObservationState().totalRequests).toBe(1);
    expect(failedRelay.debugObservationState().failures).toBe(1);
    await failedRelay.close();
    proxies.splice(proxies.indexOf(failedRelay), 1);

    const freshRelay = await startLlmProxy({ upstreamBaseUrl, adapter });
    proxies.push(freshRelay);
    const freshClient = new WebSocket(`${freshRelay.baseUrl.replace(/^http/, 'ws')}/responses`, {
      headers: { authorization: 'Bearer fresh-token', 'thread-id': 'fresh-thread' },
    });
    webSocketClients.push(freshClient);
    await webSocketEvent(freshClient, 'open');
    const response = webSocketEvent(freshClient, 'message');
    freshClient.send('{"type":"response.create","model":"fresh-model"}');
    await response;
    expect(messages).toEqual([
      '{"type":"response.create","model":"old-model"}',
      '{"type":"response.create","model":"fresh-model"}',
    ]);
    expect(upgrades.map((headers) => headers.authorization)).toEqual(['Bearer old-token', 'Bearer fresh-token']);
    expect(upgrades.map((headers) => headers['thread-id'])).toEqual(['old-thread', 'fresh-thread']);
    freshClient.close();
    await webSocketEvent(freshClient, 'close');
  });
});

function candidate(launchId: string, routeId: string, generation: number, candidateId: string): Candidate {
  return {
    version: 1,
    launchId,
    conversationId: 'thread',
    candidateId,
    routeId,
    generation,
    sourceEventId: `source:${candidateId}`,
    source: 'intent',
    args: { path: '/work/a' },
    confidence: 1,
    createdAt: 100,
  };
}

describe('fresh launch isolation', () => {
  it.each(['claude', 'codex'] as const)('does not admit %s candidates from a stopped launch after the same alias restarts', async (agent) => {
    const first = await SessionBridge.start(context(agent, 'first'), { now: () => 100 });
    const firstOwner = await connectSessionBridgeOwner(first.coordinates, {
      hostClient: agent,
      hostServerAlias: 'files',
      onCandidates: () => {},
    });
    const [firstRoute] = await firstOwner.register([route]);
    await firstOwner.close();
    await first.close();

    const received: Candidate[] = [];
    const second = await SessionBridge.start(context(agent, 'second'), { now: () => 100 });
    const secondOwner = await connectSessionBridgeOwner(second.coordinates, {
      hostClient: agent,
      hostServerAlias: 'files',
      onCandidates: (values) => received.push(...values as Candidate[]),
    });
    const [secondRoute] = await secondOwner.register([route]);
    expect(second.submit(candidate('first', firstRoute!.routeId, firstRoute!.generation, 'old'))).toBe(false);
    expect(second.submit(candidate('second', secondRoute!.routeId, secondRoute!.generation, 'fresh'))).toBe(true);
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(received).toEqual([expect.objectContaining({ candidateId: 'fresh', launchId: 'second' })]);
    await secondOwner.close();
    await second.close();
  });

  it.each(['claude', 'codex'] as const)('restores %s completion correlation with a new launch ledger after sticky loss', async (agent) => {
    const lost = new CompletionLedger();
    lost.markTrackingLoss(110);
    const fresh = new CompletionLedger();
    const freshContext = context(agent, 'fresh');
    fresh.recordToolCall({
      source: 'hook',
      phase: 'started',
      context: freshContext,
      routeId: 'route',
      generation: 1,
      callId: 'call',
      args: { path: '/work/a' },
      observedAt: 120,
    });
    const completion = {
      kind: 'tool-complete' as const,
      launchId: 'fresh',
      hostClient: agent,
      hostServerAlias: 'files',
      conversationId: null,
      eventId: 'completed',
      routeId: 'route',
      generation: 1,
      exposedTool: 'read',
      upstreamServer: 'upstream',
      upstreamTool: 'read',
      args: { path: '/work/a' },
      result: { content: [] },
      latencyMs: 10,
      startedAt: 120,
      completedAt: 130,
    };
    await expect(lost.correlate(completion)).resolves.toBeNull();
    await expect(fresh.correlate(completion)).resolves.toMatchObject({ conversationId: 'thread' });
  });
});

describe.sequential('owned temporary recovery', () => {
  it.skipIf(process.platform === 'win32')('removes only a validated crash-left Claude directory on the next launch', async () => {
    const testRoot = root();
    const temporaryRoot = join(testRoot, 'tmp');
    mkdirSync(temporaryRoot);
    const unrelated = join(temporaryRoot, 'speculate-claude-run-ABC123');
    mkdirSync(unrelated, { mode: 0o700 });
    writeFileSync(join(unrelated, 'settings.json'), '{}', { mode: 0o600 });
    const fixture = join(process.cwd(), 'test', 'fixtures', 'observer', 'crash-claude-launch.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, testRoot], {
      env: { ...process.env, TMPDIR: temporaryRoot },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const crashLeft = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        output += chunk;
        const line = output.split('\n')[0];
        if (line) resolve(line);
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('fixture exited before reporting its launch directory')));
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(existsSync(crashLeft)).toBe(true);

    vi.stubEnv('TMPDIR', temporaryRoot);
    const home = join(testRoot, 'next-home');
    const cwd = join(testRoot, 'next-work');
    mkdirSync(home);
    mkdirSync(cwd);
    const coordinates = { socketPath: '/private/observer.sock', capability: 'capability', launchId: 'next' };
    const plan = await buildClaudeLaunchPlan({
      cwd,
      home,
      env: { HOME: home, TMPDIR: temporaryRoot },
      clientArgs: [],
      observe: 'hooks',
      relayBaseUrl: null,
      session: coordinates,
      hook: coordinates,
      self: { command: process.execPath, args: [] },
      clientBin: process.execPath,
    });
    expect(existsSync(crashLeft)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    const settingsPath = plan.args[plan.args.indexOf('--settings') + 1]!;
    const activeDirectory = dirname(settingsPath);
    const concurrentPlan = await buildClaudeLaunchPlan({
      cwd,
      home,
      env: { HOME: home, TMPDIR: temporaryRoot },
      clientArgs: [],
      observe: 'hooks',
      relayBaseUrl: null,
      session: coordinates,
      hook: coordinates,
      self: { command: process.execPath, args: [] },
      clientBin: process.execPath,
    });
    expect(existsSync(activeDirectory)).toBe(true);
    await concurrentPlan.cleanup();
    await plan.cleanup();
  });

  it.skipIf(process.platform === 'win32')('creates Claude launch directories and files with owner-only modes', async () => {
    const testRoot = root();
    const temporaryRoot = join(testRoot, 'tmp');
    const home = join(testRoot, 'home');
    const cwd = join(testRoot, 'work');
    mkdirSync(temporaryRoot);
    mkdirSync(home);
    mkdirSync(cwd);
    vi.stubEnv('TMPDIR', temporaryRoot);
    const coordinates = { socketPath: '/private/observer.sock', capability: 'capability', launchId: 'launch' };
    const plan = await buildClaudeLaunchPlan({
      cwd,
      home,
      env: { HOME: home, TMPDIR: temporaryRoot },
      clientArgs: [],
      observe: 'hooks',
      relayBaseUrl: null,
      session: coordinates,
      hook: coordinates,
      self: { command: process.execPath, args: [] },
      clientBin: process.execPath,
    });
    const settingsPath = plan.args[plan.args.indexOf('--settings') + 1]!;
    expect(statSync(dirname(settingsPath)).mode & 0o777).toBe(0o700);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    const entries = readdirSync(dirname(settingsPath));
    const ownerFile = entries.find((entry) => entry !== 'settings.json');
    expect(ownerFile).toBeDefined();
    expect(lstatSync(join(dirname(settingsPath), ownerFile!)).isFile()).toBe(true);
    expect(statSync(join(dirname(settingsPath), ownerFile!)).mode & 0o777).toBe(0o600);
    await plan.cleanup();
  });

  it.skipIf(process.platform === 'win32')('creates aggregate report directories and files with owner-only modes', async () => {
    const testRoot = root();
    const report = join(testRoot, 'reports', 'observer.json');
    const child = Object.assign(new EventEmitter(), { kill: () => true });
    const prepared: PreparedAgentRun = {
      plan: {
        command: '/unused',
        args: [],
        env: {},
        upstreamBaseUrl: 'http://127.0.0.1',
        transport: 'messages',
        async cleanup() {},
      },
      mode: 'hooks',
      transport: 'messages',
      clientVersion: null,
      registeredRoutes: () => 0,
      disabledCapabilities: () => [],
      measurements: () => ({ sources: {}, transport: { requests: 0, failures: 0 } }),
      async close() {},
    };
    const run = runAgent({ agent: 'claude', observe: 'hooks', clientArgs: [], jsonReport: report }, {
      prepare: async () => prepared,
      spawn: (() => {
        setImmediate(() => child.emit('exit', 0, null));
        return child;
      }) as never,
      signalSource: new EventEmitter(),
      log: () => {},
    });
    await expect(run).resolves.toBe(0);
    expect(statSync(dirname(report)).mode & 0o777).toBe(0o700);
    expect(statSync(report).mode & 0o777).toBe(0o600);
  });

  it('removes real Claude launch files when the child cannot be spawned', async () => {
    const testRoot = root();
    const home = join(testRoot, 'home');
    const cwd = join(testRoot, 'work');
    mkdirSync(home);
    mkdirSync(cwd);
    const coordinates = { socketPath: '/private/observer.sock', capability: 'capability', launchId: 'launch' };
    const plan = await buildClaudeLaunchPlan({
      cwd,
      home,
      env: { HOME: home },
      clientArgs: [],
      observe: 'hooks',
      relayBaseUrl: null,
      session: coordinates,
      hook: coordinates,
      self: { command: process.execPath, args: [] },
      clientBin: process.execPath,
    });
    const settingsPath = plan.args[plan.args.indexOf('--settings') + 1]!;
    const prepared: PreparedAgentRun = {
      plan,
      mode: 'hooks',
      transport: 'messages',
      clientVersion: null,
      registeredRoutes: () => 0,
      disabledCapabilities: () => [],
      measurements: () => ({ sources: {}, transport: { requests: 0, failures: 0 } }),
      close: () => plan.cleanup(),
    };
    await expect(runAgent({ agent: 'claude', observe: 'hooks', clientArgs: [], jsonReport: null }, {
      prepare: async () => prepared,
      spawn: (() => { throw new Error('synthetic spawn failure'); }) as never,
      signalSource: new EventEmitter(),
      log: () => {},
    })).resolves.toBe(127);
    expect(existsSync(dirname(settingsPath))).toBe(false);
  });
});

describe('durable usage and observer reporting', () => {
  it('persists one terminal outcome while observing the same lifecycle independently', async () => {
    const directory = root();
    const recorder = new UsageRecorder({
      source: 'mcp',
      workspace: '/work',
      directory,
      sessionId: 'session',
      now: () => 100,
      flushDelayMs: 0,
    });
    const collector = new SessionMeasurementCollector();
    const metrics = new Metrics({
      mode: 'strict',
      log: 'off',
      now: () => 100,
      onUsage: (counters, breakdown) => recorder.update(counters, breakdown),
      onObserverLifecycle: (event) => collector.record(event),
    });
    const observerIssue = {
      client: 'claude' as const,
      source: 'intent' as const,
      routeId: 'route',
      generation: 1,
      candidateCreatedAt: 90,
      issueId: 'issue',
      specDispatchAt: 95,
    };
    metrics.record({
      type: 'speculated', server: 'files', tool: 'read', ruleId: 'observer:claude:intent',
      observerIssue,
    });
    metrics.record({
      type: 'invalidated', server: 'files', tool: 'read', ruleId: 'observer:claude:intent',
      observerIssue,
    });
    await recorder.close();
    const snapshot = JSON.parse(readFileSync(join(directory, '100-session.json'), 'utf8'));
    expect(snapshot.counters).toMatchObject({ speculativeCalls: 1, wasted: 1 });
    expect(collector.snapshot({ requests: 0, failures: 0 }).sources.intent).toEqual({
      issued: 1,
      used: 0,
      wasted: 1,
      suppressed: 0,
    });
  });
});
