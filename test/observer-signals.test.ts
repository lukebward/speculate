import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/agentAdapters/claude.js';
import { codexAdapter } from '../src/agentAdapters/codex.js';
import { SessionPredictor } from '../src/sessionPredictor.js';
import { SessionBridge, connectSessionBridgeOwner } from '../src/sessionBridge.js';
import { Metrics } from '../src/metrics.js';
import { Predictor } from '../src/predictor.js';
import { SpeculateProxy, type ProxySessionEvent, type ProxySessionRuntime } from '../src/proxy.js';
import type { Upstream } from '../src/upstream.js';
import type { ObserverLifecycleEvent } from '../src/types.js';
import type {
  AgentAdapter,
  Observation,
  RegisteredRoute,
  SessionContext,
} from '../src/observerTypes.js';

const clients = ['claude', 'codex'] as const;

const prSchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    pull_number: { type: 'integer' },
  },
  required: ['owner', 'repo', 'pull_number'],
  additionalProperties: false,
};

const listSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

function context(agent: typeof clients[number]): SessionContext {
  return { launchId: 'launch', conversationId: 'thread', agent, cwd: '/work' };
}

function routes(agent: typeof clients[number]): RegisteredRoute[] {
  return [
    {
      routeId: `${agent}-pr`, generation: 1, instanceId: 'github-owner', hostClient: agent,
      hostServerAlias: 'github', exposedTool: 'get_pull_request', upstreamServer: 'upstream',
      upstreamTool: 'get_pull_request', inputSchema: prSchema,
    },
    {
      routeId: `${agent}-list`, generation: 1, instanceId: 'workspace-owner', hostClient: agent,
      hostServerAlias: 'workspace', exposedTool: 'list_directory', upstreamServer: 'upstream',
      upstreamTool: 'list_directory', inputSchema: listSchema,
    },
  ];
}

function prompt(agent: typeof clients[number], text: string, eventId = 'prompt-1', occurrenceId?: string): Observation {
  return {
    kind: 'prompt', context: context(agent), eventId, observedAt: 10, text,
    ...(occurrenceId ? { occurrenceId } : {}),
  } as Observation;
}

function signalFixtures(): Array<{
  id: string;
  text: string;
  expected: null | { tool: string; args: Record<string, unknown> };
}> {
  const path = fileURLToPath(new URL('fixtures/observer/signals.json', import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { cases: ReturnType<typeof signalFixtures> }).cases;
}

function adapter(agent: typeof clients[number], routeList: RegisteredRoute[], clock: () => number): AgentAdapter {
  const environment = {
    contextForConversation: (conversationId: string) => conversationId === 'thread' ? context(agent) : null,
    routes: () => routeList,
    now: clock,
  };
  return agent === 'claude' ? claudeAdapter(environment) : codexAdapter(environment);
}

describe.each(clients)('%s explicit intent', (agent) => {
  it.each(signalFixtures())('$id', ({ text, expected }) => {
    const routeList = routes(agent);
    const predictor = new SessionPredictor({ routes: () => routeList, now: () => 20 });
    const candidates = predictor.observe(prompt(agent, text));

    expect(candidates.map((candidate) => ({
      tool: routeList.find((route) => route.routeId === candidate.routeId)?.exposedTool,
      args: candidate.args,
    }))).toEqual(expected ? [expected] : []);
    if (expected) expect(candidates[0]).toMatchObject({ source: 'intent', createdAt: 20 });
  });

  it('requires a unique live capability whose exact schema accepts the mapped arguments', () => {
    const duplicate = { ...routes(agent)[0]!, routeId: `${agent}-duplicate`, instanceId: 'other-owner' };
    const wrongSchema = { ...routes(agent)[1]!, inputSchema: { ...listSchema, required: ['path', 'depth'] } };
    const permissiveSchema = { ...routes(agent)[1]!, inputSchema: { type: 'object' } };
    const ambiguous = new SessionPredictor({ routes: () => [routes(agent)[0]!, duplicate], now: () => 20 });
    const invalid = new SessionPredictor({ routes: () => [wrongSchema], now: () => 20 });
    const unknown = new SessionPredictor({ routes: () => [permissiveSchema], now: () => 20 });

    expect(ambiguous.observe(prompt(agent, 'Review https://github.com/acme/api/pull/17.'))).toEqual([]);
    expect(invalid.observe(prompt(agent, 'List the workspace directory.'))).toEqual([]);
    expect(unknown.observe(prompt(agent, 'List the workspace directory.'))).toEqual([]);
  });

  it('maps the consolidated hosted GitHub reader only when its discriminator schema matches', () => {
    const hosted: RegisteredRoute = {
      routeId: `${agent}-hosted-pr`, generation: 1, instanceId: 'github-owner', hostClient: agent,
      hostServerAlias: 'github', exposedTool: 'pull_request_read', upstreamServer: 'upstream',
      upstreamTool: 'pull_request_read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' }, repo: { type: 'string' }, pullNumber: { type: 'integer' },
          method: { type: 'string', enum: ['get', 'get_files'] },
        },
        required: ['owner', 'repo', 'pullNumber', 'method'],
        additionalProperties: false,
      },
    };
    const predictor = new SessionPredictor({ routes: () => [hosted], now: () => 20 });

    expect(predictor.observe(prompt(agent, 'Open https://github.com/acme/api/pull/17.'))[0]).toMatchObject({
      routeId: hosted.routeId,
      args: { owner: 'acme', repo: 'api', pullNumber: 17, method: 'get' },
    });
  });
});

describe.each(clients)('%s completed stream', (agent) => {
  it('turns one completed structured call into a schema-valid stream candidate', () => {
    const routeList = routes(agent);
    const predictor = new SessionPredictor({ routes: () => routeList, now: () => 30 });
    const event: Observation = {
      kind: 'stream-call', context: context(agent), eventId: 'adapter-copy', observedAt: 25,
      routeId: routeList[1]!.routeId, callId: 'provider-call', args: { path: '/work' },
    };

    expect(predictor.observe(event)).toEqual([
      expect.objectContaining({
        routeId: routeList[1]!.routeId,
        source: 'stream',
        sourceEventId: 'provider-call',
        args: { path: '/work' },
        createdAt: 30,
      }),
    ]);
    expect(predictor.observe({ ...event, eventId: 'repeated-notification' })).toEqual([]);
    expect(predictor.observe({ ...event, callId: 'later-provider-call', eventId: 'later' })).toHaveLength(1);
    expect(predictor.observe({ ...event, callId: 'invalid-call', args: { path: 4 } })).toEqual([]);
  });
});

describe('adapter prompt occurrence identity', () => {
  it('coalesces a Claude hook/proxy copy but preserves a later same-channel repeat', () => {
    let clock = 100;
    const routeList = routes('claude');
    const active = adapter('claude', routeList, () => clock);
    const fromHook = active.normalizeHook({
      hook_event_name: 'UserPromptSubmit', session_id: 'thread', prompt: 'List the workspace directory.',
    })[0] as Extract<Observation, { kind: 'prompt' }>;
    const request = active.createConnection().startRequest({
      transport: 'http', method: 'POST', path: '/v1/messages', headers: { 'x-claude-code-session-id': 'thread' },
    })!;
    const fromProxy = request.observeRequestBody(Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'List the workspace directory.' }], tools: [],
    })))[0] as Extract<Observation, { kind: 'prompt' }>;
    clock++;
    const repeated = active.normalizeHook({
      hook_event_name: 'UserPromptSubmit', session_id: 'thread', prompt: 'List the workspace directory.',
    })[0] as Extract<Observation, { kind: 'prompt' }>;

    expect(fromHook.occurrenceId).toBe(fromProxy.occurrenceId);
    expect(repeated.occurrenceId).not.toBe(fromHook.occurrenceId);
    const predictor = new SessionPredictor({ routes: () => routeList, now: () => clock });
    expect(predictor.observe(fromHook)).toHaveLength(1);
    expect(predictor.observe(fromProxy)).toEqual([]);
    expect(predictor.observe(repeated)).toHaveLength(1);
  });

  it('coalesces a repeated Claude request carrying the same current turn in longer history', () => {
    const active = adapter('claude', routes('claude'), () => 100);
    const first = active.createConnection().startRequest({
      transport: 'http', method: 'POST', path: '/v1/messages', headers: { 'x-claude-code-session-id': 'thread' },
    })!;
    const repeated = active.createConnection().startRequest({
      transport: 'http', method: 'POST', path: '/v1/messages', headers: { 'x-claude-code-session-id': 'thread' },
    })!;
    const original = first.observeRequestBody(Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'List the workspace directory.' }], tools: [],
    })))[0] as Extract<Observation, { kind: 'prompt' }>;
    const copied = repeated.observeRequestBody(Buffer.from(JSON.stringify({
      messages: [
        { role: 'user', content: 'List the workspace directory.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'other', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] },
      ],
      tools: [],
    })))[0] as Extract<Observation, { kind: 'prompt' }>;

    expect(copied.occurrenceId).toBe(original.occurrenceId);
  });

  it('uses Codex continuation identity to preserve a later intentional repeat', () => {
    const active = adapter('codex', routes('codex'), () => 100);
    const observe = (previousResponseId: string) => {
      const request = active.createConnection().startRequest({
        transport: 'http', method: 'POST', path: '/v1/responses', headers: { 'thread-id': 'thread' },
      })!;
      return request.observeRequestBody(Buffer.from(JSON.stringify({
        previous_response_id: previousResponseId,
        input: 'List the workspace directory.',
        tools: [],
      })))[0] as Extract<Observation, { kind: 'prompt' }>;
    };

    const first = observe('response-1');
    expect(observe('response-1').occurrenceId).toBe(first.occurrenceId);
    expect(observe('response-2').occurrenceId).not.toBe(first.occurrenceId);
  });
});

describe.each(clients)('%s stream completion boundary', (agent) => {
  it('does not expose a parsable prefix or interleaved call until its item completes', () => {
    const routeList = routes(agent);
    const active = adapter(agent, routeList, () => 40);
    const connection = active.createConnection();
    const request = connection.startRequest({
      transport: 'http', method: 'POST', path: agent === 'claude' ? '/v1/messages' : '/v1/responses',
      headers: agent === 'claude' ? { 'x-claude-code-session-id': 'thread' } : { 'thread-id': 'thread' },
    })!;
    const definitions = agent === 'claude'
      ? routeList.map((route) => ({ name: `mcp__${route.hostServerAlias}__${route.exposedTool}`, input_schema: route.inputSchema }))
      : routeList.map((route) => ({ type: 'function', name: `mcp__${route.hostServerAlias}__${route.exposedTool}`, parameters: route.inputSchema }));
    request.observeRequestBody(Buffer.from(JSON.stringify(agent === 'claude'
      ? { messages: [{ role: 'user', content: 'continue' }], tools: definitions }
      : { input: 'continue', tools: definitions })));
    request.observeResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } });
    const chunk = (event: unknown) => request.observeResponseChunk(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));

    if (agent === 'claude') {
      expect(chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-a', name: 'mcp__workspace__list_directory', input: {} } })).toEqual([]);
      expect(chunk({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-b', name: 'mcp__github__get_pull_request', input: {} } })).toEqual([]);
      expect(chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/work"}' } })).toEqual([]);
      expect(chunk({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"owner":"acme","repo":"api","pull_number":17}' } })).toEqual([]);
      expect(chunk({ type: 'content_block_stop', index: 2 })).toEqual([
        expect.objectContaining({ kind: 'stream-call', callId: 'call-b' }),
      ]);
      expect(chunk({ type: 'content_block_stop', index: 1 })).toEqual([
        expect.objectContaining({ kind: 'stream-call', callId: 'call-a' }),
      ]);
    } else {
      expect(chunk({ type: 'response.output_item.added', item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'mcp__workspace__list_directory', arguments: '' } })).toEqual([]);
      expect(chunk({ type: 'response.output_item.added', item: { id: 'item-b', type: 'function_call', call_id: 'call-b', name: 'mcp__github__get_pull_request', arguments: '' } })).toEqual([]);
      expect(chunk({ type: 'response.function_call_arguments.delta', item_id: 'item-a', delta: '{"path":"/work"}' })).toEqual([]);
      expect(chunk({ type: 'response.function_call_arguments.delta', item_id: 'item-b', delta: '{"owner":"acme","repo":"api","pull_number":17}' })).toEqual([]);
      expect(chunk({ type: 'response.function_call_arguments.done', item_id: 'item-a', arguments: '{"path":"/work"}' })).toEqual([]);
      expect(chunk({ type: 'response.output_item.done', item: { id: 'item-b', type: 'function_call', call_id: 'call-b', name: 'mcp__github__get_pull_request', arguments: '{"owner":"acme","repo":"api","pull_number":17}', status: 'completed' } })).toEqual([
        expect.objectContaining({ kind: 'stream-call', callId: 'call-b' }),
      ]);
      expect(chunk({ type: 'response.output_item.done', item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'mcp__workspace__list_directory', arguments: '{"path":"/work"}', status: 'completed' } })).toEqual([
        expect.objectContaining({ kind: 'stream-call', callId: 'call-a' }),
      ]);
    }
  });
});

describe('observer attribution validation', () => {
  it('projects internal attribution onto its allowlisted fields', () => {
    const metrics = new Metrics({ mode: 'strict', log: 'off', now: () => 10 });
    const predictor = new Predictor({ maxPerTrigger: 3, metrics });
    const [prediction] = predictor.admitResolved('upstream', [{
      tool: 'read', args: {}, confidence: 1, candidateId: 'observer:claude:intent', ruleId: 'observer:claude:intent',
      observerAttribution: {
        client: 'claude', source: 'intent', routeId: 'route', generation: 1, candidateCreatedAt: 5,
        secret: 'must-not-survive',
      } as never,
    }], { timestamp: 10, trackNextCall: false });

    expect(prediction?.observerAttribution).toEqual({
      client: 'claude', source: 'intent', routeId: 'route', generation: 1, candidateCreatedAt: 5,
    });
  });

  it('sanitizes terminal errors and contains callback failures', () => {
    const seen: ObserverLifecycleEvent[] = [];
    const metrics = new Metrics({
      mode: 'strict', log: 'off', now: () => 20,
      onObserverLifecycle: (event) => {
        seen.push(event);
        throw new Error('observer failed');
      },
    });
    expect(() => metrics.record({
      type: 'spec_error', server: 'secret-server', tool: 'secret-tool', ruleId: 'observer:claude:stream',
      reason: 'credential-shaped upstream error',
      observerIssue: {
        client: 'claude', source: 'stream', routeId: 'route', generation: 1, candidateCreatedAt: 5,
        issueId: 'local-1', specDispatchAt: 10,
      },
    })).not.toThrow();

    expect(seen).toEqual([{
      type: 'spec_error', timestamp: 20, ruleId: 'observer:claude:stream',
      observerAttribution: { client: 'claude', source: 'stream', routeId: 'route', generation: 1, candidateCreatedAt: 5 },
      issueId: 'local-1', specDispatchAt: 10,
    }]);
  });
});

describe('route-scoped observer retention', () => {
  it('keeps replay and source caps for route B when route A is invalidated', async () => {
    const bridge = await SessionBridge.start(context('claude'), { now: () => 100 });
    const first = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'a', onCandidates: () => {},
    });
    const second = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'b', onCandidates: () => {},
    });
    try {
      const [routeA] = await first.register([{
        exposedTool: 'list_directory', upstreamServer: 'a', upstreamTool: 'list_directory', inputSchema: listSchema,
      }]);
      const [routeB] = await second.register([{
        exposedTool: 'list_directory', upstreamServer: 'b', upstreamTool: 'list_directory', inputSchema: listSchema,
      }]);
      expect(routeA).toBeDefined();
      for (let index = 0; index < 3; index++) {
        expect(bridge.submit({
          ...observedCandidate('claude', routeB!, 'stream', 100, `b-${index}`),
          sourceEventId: 'b-source',
        })).toBe(true);
      }

      await first.invalidate('a', 'replace-a');

      expect(bridge.submit({
        ...observedCandidate('claude', routeB!, 'stream', 100, 'b-0'),
        sourceEventId: 'b-source',
      })).toBe(false);
      expect(bridge.submit({
        ...observedCandidate('claude', routeB!, 'stream', 100, 'b-3'),
        sourceEventId: 'b-source',
      })).toBe(false);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await bridge.close();
    }
  });
});

class SignalRuntime implements ProxySessionRuntime {
  routes: RegisteredRoute[] = [];
  private handler: (candidates: unknown) => void = () => {};

  constructor(private readonly agent: typeof clients[number]) {}

  setCandidateHandler(handler: (candidates: unknown) => void): void {
    this.handler = handler;
  }

  async replaceRoutes(local: readonly Omit<RegisteredRoute, 'routeId' | 'generation' | 'instanceId' | 'hostClient' | 'hostServerAlias'>[]): Promise<readonly RegisteredRoute[]> {
    this.routes = local.map((route, index) => ({
      ...route,
      routeId: `${this.agent}-route-${index}`,
      generation: 1,
      instanceId: 'owner',
      hostClient: this.agent,
      hostServerAlias: 'workspace',
    }));
    return this.routes;
  }

  async invalidateServer(): Promise<void> {}
  async publishCompleted(_event: ProxySessionEvent): Promise<boolean> { return true; }
  async close(): Promise<void> {}
  deliver(candidates: unknown): void { this.handler(candidates); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function lifecycleHarness(agent: typeof clients[number], clock: { now: number }, lifecycle: ObserverLifecycleEvent[]) {
  const runtime = new SignalRuntime(agent);
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const proxy = new SpeculateProxy({
    mode: 'strict', maxPredictionsPerTrigger: 3, log: 'off',
    servers: { upstream: { allowTools: ['list_directory'], speculation: { defaultTtlMs: 1_000 } } },
  }, {
    now: () => clock.now,
    onObserverLifecycle: (event) => lifecycle.push(event),
    session: {
      launchId: 'launch', hostClient: agent, hostServerAlias: 'workspace', runtime,
      permissionContext: () => 'allowed-context', permissionGate: { check: () => 'allowed' },
    },
  });
  const tool = {
    name: 'list_directory', inputSchema: listSchema, annotations: { readOnlyHint: true },
  };
  proxy.upstreams.set('upstream', {
    connected: true, transport: 'http', tools: [tool],
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ tool: name, args });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  } as unknown as Upstream);
  proxy.policy.updateTools('upstream', [tool]);
  (proxy as unknown as { rebuildRoutes(): void }).rebuildRoutes();
  return { proxy, runtime, calls };
}

async function ready(runtime: SignalRuntime): Promise<RegisteredRoute> {
  for (let attempt = 0; attempt < 20 && runtime.routes.length === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return runtime.routes[0]!;
}

function observedCandidate(
  agent: typeof clients[number],
  route: RegisteredRoute,
  source: 'intent' | 'stream',
  createdAt: number,
  suffix = source,
) {
  return {
    version: 1 as const,
    launchId: 'launch',
    conversationId: 'thread',
    candidateId: `wire-${suffix}`,
    routeId: route.routeId,
    generation: route.generation,
    sourceEventId: `source-${suffix}`,
    source,
    args: { path: '/work' },
    confidence: 1,
    createdAt,
  };
}

async function actualCall(proxy: SpeculateProxy, args: Record<string, unknown> = { path: '/work' }): Promise<unknown> {
  return (proxy as unknown as {
    handleToolCall(route: unknown, args: Record<string, unknown>, opts: object): Promise<unknown>;
  }).handleToolCall({ server: 'upstream', tool: { name: 'list_directory' }, exposed: 'list_directory' }, args, {});
}

describe.each(clients)('%s observer lifecycle', (agent) => {
  it('attributes one ready hit to the issued winner and suppresses the duplicate source', async () => {
    const clock = { now: 100 };
    const lifecycle: ObserverLifecycleEvent[] = [];
    const h = lifecycleHarness(agent, clock, lifecycle);
    const route = await ready(h.runtime);

    clock.now = 130;
    h.runtime.deliver([observedCandidate(agent, route, 'intent', 100)]);
    h.runtime.deliver([observedCandidate(agent, route, 'stream', 110)]);
    await new Promise((resolve) => setImmediate(resolve));
    clock.now = 200;
    await actualCall(h.proxy);

    expect(h.calls).toHaveLength(1);
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: 'speculated', ruleId: `observer:${agent}:intent`, timestamp: 130,
        issueId: expect.any(String), specDispatchAt: 130,
        observerAttribution: expect.objectContaining({ client: agent, source: 'intent', candidateCreatedAt: 100 }),
      }),
      expect.objectContaining({
        type: 'suppressed', ruleId: `observer:${agent}:stream`, suppression: 'dedup',
        observerAttribution: expect.objectContaining({ client: agent, source: 'stream', candidateCreatedAt: 110 }),
      }),
      expect.objectContaining({
        type: 'hit', ruleId: `observer:${agent}:intent`, timestamp: 200,
        issueId: expect.any(String), specDispatchAt: 130, realDemandAt: 200,
      }),
    ]);
    expect(lifecycle[1]).not.toHaveProperty('issueId');
    expect(lifecycle[1]).not.toHaveProperty('server');
    expect(lifecycle[1]).not.toHaveProperty('tool');
    expect(lifecycle[1]).not.toHaveProperty('reason');
    expect(h.proxy.metrics.statsSnapshot().perRule).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: `observer:${agent}:intent`, speculated: 1, hits: 1, wasted: 0 }),
    ]));
  });

  it('records real demand before an in-flight join settles', async () => {
    const clock = { now: 300 };
    const lifecycle: ObserverLifecycleEvent[] = [];
    const h = lifecycleHarness(agent, clock, lifecycle);
    const pending = deferred<{ content: Array<{ type: 'text'; text: string }> }>();
    h.proxy.upstreams.get('upstream')!.callTool = async () => pending.promise;
    const route = await ready(h.runtime);

    clock.now = 320;
    h.runtime.deliver([observedCandidate(agent, route, 'stream', 300)]);
    await new Promise((resolve) => setImmediate(resolve));
    clock.now = 350;
    const result = actualCall(h.proxy);
    clock.now = 900;
    pending.resolve({ content: [{ type: 'text', text: 'joined' }] });
    await result;

    expect(lifecycle).toEqual([
      expect.objectContaining({ type: 'speculated', specDispatchAt: 320 }),
      expect.objectContaining({ type: 'joined', specDispatchAt: 320, realDemandAt: 350 }),
    ]);
  });

  it('keeps a different-args real request as a miss and settles unused work only at expiry', async () => {
    const clock = { now: 500 };
    const lifecycle: ObserverLifecycleEvent[] = [];
    const h = lifecycleHarness(agent, clock, lifecycle);
    const route = await ready(h.runtime);
    h.runtime.deliver([observedCandidate(agent, route, 'stream', 500)]);
    await new Promise((resolve) => setImmediate(resolve));

    clock.now = 505;
    await actualCall(h.proxy, { path: '/other' });
    expect(h.proxy.metrics.statsSnapshot()).toMatchObject({ misses: 1, expired: 0, wasted: 0 });
    expect(lifecycle).toHaveLength(1);

    clock.now = 2_000;
    h.proxy.cache.sweep();
    expect(lifecycle).toEqual([
      expect.objectContaining({ type: 'speculated' }),
      expect.objectContaining({ type: 'expired' }),
    ]);
    expect(lifecycle.every((event) => !Object.hasOwn(event, 'realDemandAt'))).toBe(true);
    expect(h.proxy.metrics.statsSnapshot()).toMatchObject({ misses: 1, expired: 1, wasted: 1 });
  });

  it('suppresses queued work after its route generation is invalidated', async () => {
    const clock = { now: 700 };
    const lifecycle: ObserverLifecycleEvent[] = [];
    const h = lifecycleHarness(agent, clock, lifecycle);
    const route = await ready(h.runtime);
    expect(h.proxy.budget.tryAcquire('upstream')).toEqual({ ok: true });
    h.runtime.deliver([observedCandidate(agent, route, 'intent', 700)]);
    await new Promise((resolve) => setImmediate(resolve));

    h.proxy.invalidateObservedServer('upstream', 'route-replaced');
    h.proxy.budget.release('upstream');
    h.proxy.executor.drainServer('upstream');

    expect(h.calls).toEqual([]);
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: 'suppressed', suppression: 'stale-generation',
        observerAttribution: expect.objectContaining({ routeId: route.routeId, generation: route.generation }),
      }),
    ]);
  });

  it('settles one late in-flight resolution against the invalidated generation', async () => {
    const clock = { now: 800 };
    const lifecycle: ObserverLifecycleEvent[] = [];
    const h = lifecycleHarness(agent, clock, lifecycle);
    const pending = deferred<{ content: Array<{ type: 'text'; text: string }> }>();
    h.proxy.upstreams.get('upstream')!.callTool = async () => pending.promise;
    const route = await ready(h.runtime);
    h.runtime.deliver([observedCandidate(agent, route, 'stream', 800)]);
    await new Promise((resolve) => setImmediate(resolve));

    h.proxy.invalidateObservedServer('upstream', 'route-replaced');
    h.proxy.cache.invalidateServer('upstream');
    clock.now = 900;
    pending.resolve({ content: [{ type: 'text', text: 'stale' }] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(lifecycle).toEqual([
      expect.objectContaining({ type: 'speculated' }),
      expect.objectContaining({
        type: 'invalidated',
        observerAttribution: expect.objectContaining({ routeId: route.routeId, generation: route.generation }),
      }),
    ]);
    expect(lifecycle.filter((event) => event.type === 'invalidated')).toHaveLength(1);
  });
});
