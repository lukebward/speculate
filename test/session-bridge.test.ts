import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionBridge,
  connectSessionBridgeOwner,
  type SessionBridgeOwner,
} from '../src/sessionBridge.js';
import type { Candidate, SessionContext } from '../src/observerTypes.js';
import type { LocalRouteDescriptor, RegisteredRoute, HostPermissionDecision } from '../src/observerTypes.js';
import { SpeculateProxy, type ProxySessionRuntime } from '../src/proxy.js';
import type { Upstream } from '../src/upstream.js';
import { canonicalKey } from '../src/keys.js';

const context: SessionContext = {
  launchId: 'launch',
  conversationId: 'thread',
  agent: 'claude',
  cwd: '/work',
};

const bridges: SessionBridge[] = [];
const owners: SessionBridgeOwner[] = [];

afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner.close()));
  await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
});

async function start(now: () => number = Date.now) {
  const bridge = await SessionBridge.start(context, { now });
  bridges.push(bridge);
  return bridge;
}

async function owner(
  bridge: SessionBridge,
  hostServerAlias: string,
  received: Candidate[][] = [],
) {
  const connection = await connectSessionBridgeOwner(bridge.coordinates, {
    hostClient: 'claude',
    hostServerAlias,
    onCandidates: (batch) => received.push(batch),
  });
  owners.push(connection);
  return connection;
}

const localRoute = {
  exposedTool: 'read',
  upstreamServer: 'upstream',
  upstreamTool: 'read',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

function candidate(routeId: string, generation: number, over: Partial<Candidate> = {}): Candidate {
  return {
    version: 1,
    launchId: 'launch',
    conversationId: 'thread',
    candidateId: 'candidate',
    routeId,
    generation,
    sourceEventId: 'event',
    source: 'intent',
    args: { path: '/a' },
    confidence: 0.9,
    createdAt: 100,
    ...over,
  };
}

describe('SessionBridge route ownership', () => {
  it('authenticates local owners and routes a candidate only to its owner', async () => {
    const bridge = await start(() => 100);
    const firstReceived: Candidate[][] = [];
    const secondReceived: Candidate[][] = [];
    const first = await owner(bridge, 'files', firstReceived);
    const second = await owner(bridge, 'other-files', secondReceived);
    const [firstRoute] = await first.register([localRoute]);
    await second.register([localRoute]);

    expect(bridge.submit(candidate(firstRoute!.routeId, firstRoute!.generation))).toBe(true);
    for (let i = 0; i < 20 && firstReceived.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(firstReceived).toEqual([[candidate(firstRoute!.routeId, firstRoute!.generation)]]);
    expect(secondReceived).toEqual([]);
  });

  it('rejects a wrong capability before allocating an owner', async () => {
    const bridge = await start();
    await expect(connectSessionBridgeOwner(
      { ...bridge.coordinates, capability: 'wrong' },
      { hostClient: 'codex', hostServerAlias: 'files', onCandidates: () => {} },
    )).rejects.toThrow(/authentication/i);
    expect(bridge.listRoutes()).toEqual([]);
  });

  it('replaces snapshots atomically and rejects stale generations', async () => {
    const bridge = await start(() => 100);
    const connection = await owner(bridge, 'files');
    const [oldRoute] = await connection.register([localRoute]);
    const [freshRoute] = await connection.register([{ ...localRoute, inputSchema: { type: 'object' } }]);

    expect(bridge.submit(candidate(oldRoute!.routeId, oldRoute!.generation))).toBe(false);
    expect(bridge.submit(candidate(freshRoute!.routeId, freshRoute!.generation, { candidateId: 'fresh' }))).toBe(true);
    expect(bridge.listRoutes()).toEqual([freshRoute]);
  });

  it('reports exact unknown and ambiguous route matches', async () => {
    const bridge = await start();
    const one = await owner(bridge, 'files');
    const two = await owner(bridge, 'files');
    await one.register([localRoute]);
    await two.register([localRoute]);

    expect(bridge.resolveObservedTool('missing', 'read')).toBe('unknown');
    expect(bridge.resolveObservedTool('files', 'read')).toBe('ambiguous');
  });

  it('removes routes immediately on invalidation and disconnect', async () => {
    const bridge = await start();
    const connection = await owner(bridge, 'files');
    await connection.register([localRoute]);
    await connection.invalidate('upstream', 'mutation-start');
    expect(bridge.listRoutes()).toEqual([]);
    await connection.register([localRoute]);
    await connection.close();
    expect(bridge.listRoutes()).toEqual([]);
  });
});

describe('SessionBridge bounds and event seam', () => {
  it('caps candidates per source event and rejects replay and expired envelopes', async () => {
    let now = 100;
    const bridge = await start(() => now);
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);
    for (let i = 0; i < 3; i++) {
      expect(bridge.submit(candidate(route!.routeId, route!.generation, { candidateId: `c${i}` }))).toBe(true);
    }
    expect(bridge.submit(candidate(route!.routeId, route!.generation, { candidateId: 'c3', source: 'stream' }))).toBe(false);
    expect(bridge.submit(candidate(route!.routeId, route!.generation, { candidateId: 'c0' }))).toBe(false);
    now = 1_102;
    expect(bridge.submit(candidate(route!.routeId, route!.generation, { candidateId: 'late', sourceEventId: 'later' }))).toBe(false);
  });

  it('caps source-event tracking across more than 4096 unique events', async () => {
    const bridge = await start(() => 100);
    const received: Candidate[][] = [];
    const connection = await owner(bridge, 'files', received);
    const [route] = await connection.register([localRoute]);
    for (let index = 0; index < 4_097; index++) {
      expect(bridge.submit(candidate(route!.routeId, route!.generation, {
        candidateId: `candidate-${index}`,
        sourceEventId: `event-${index}`,
      }))).toBe(true);
      if (index % 64 === 63) {
        for (let attempt = 0; attempt < 20 && received.length <= index; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    }

    expect((bridge as unknown as { eventCounts: Map<string, unknown> }).eventCounts.size).toBe(4_096);
  });

  it('publishes only known-conversation observations to subscribers', async () => {
    const bridge = await start();
    const seen: string[] = [];
    bridge.subscribe((event) => seen.push(event.eventId));
    const base = { context, observedAt: 1, kind: 'prompt' as const, text: 'read' };
    expect(bridge.publishObservation({ ...base, eventId: 'known' })).toBe(true);
    expect(bridge.publishObservation({ ...base, eventId: 'unknown', context: { ...context, conversationId: 'subagent' } })).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(['known']);
  });

  it('bounds conversation registration', async () => {
    const bridge = await start();
    for (let index = 1; index < 256; index++) {
      expect(bridge.registerConversation({ ...context, conversationId: `thread-${index}` })).toBe(true);
    }
    expect(bridge.registerConversation({ ...context, conversationId: 'thread' })).toBe(true);
    expect(bridge.registerConversation({ ...context, conversationId: 'overflow' })).toBe(false);
  });

  it('bounds observation bytes and prioritizes invalidation over queued observations', async () => {
    const bridge = await start();
    const seen: string[] = [];
    bridge.subscribe((event) => seen.push(event.eventId));
    const text = 'x'.repeat(512 * 1024);
    let accepted = 0;
    while (bridge.publishObservation({ context, eventId: `normal-${accepted}`, observedAt: 1, kind: 'prompt', text })) {
      accepted++;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(256);
    expect(bridge.publishObservation({
      context,
      eventId: 'reset',
      observedAt: 2,
      kind: 'invalidate',
      routeIds: [],
      reason: 'route-invalidated',
    })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen[0]).toBe('reset');
  });

  it('publishes owner route invalidation as a reset observation', async () => {
    const bridge = await start(() => 100);
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);
    const seen: import('../src/observerTypes.js').Observation[] = [];
    bridge.subscribe((event) => seen.push(event));

    await connection.invalidate('upstream', 'mutation-start');
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toContainEqual(expect.objectContaining({
      kind: 'invalidate',
      observedAt: 100,
      routeIds: [route!.routeId],
      reason: 'mutation-start',
    }));
  });
});

class FakeRuntime implements ProxySessionRuntime {
  private generation = 0;
  private handler: (candidates: unknown) => void = () => {};
  routes: RegisteredRoute[] = [];

  constructor(private readonly hostClient: 'claude' | 'codex', private readonly hostServerAlias: string) {}

  setCandidateHandler(handler: (candidates: unknown) => void): void {
    this.handler = handler;
  }

  async replaceRoutes(routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    this.generation++;
    this.routes = routes.map((route, index) => ({
      ...route,
      routeId: `${this.hostServerAlias}-${this.generation}-${index}`,
      generation: this.generation,
      instanceId: this.hostServerAlias,
      hostClient: this.hostClient,
      hostServerAlias: this.hostServerAlias,
    }));
    return this.routes;
  }

  async invalidateServer(upstreamServer?: string): Promise<void> {
    this.generation++;
    this.routes = upstreamServer ? this.routes.filter((route) => route.upstreamServer !== upstreamServer) : [];
  }

  deliver(candidate: unknown): void {
    this.handler([candidate]);
  }

  publishCompleted(): void {}
  async close(): Promise<void> {}
}

function proxyHarness(
  hostClient: 'claude' | 'codex',
  decision: () => HostPermissionDecision,
  mode: 'strict' | 'annotated' | 'off' = 'strict',
) {
  const runtime = new FakeRuntime(hostClient, 'files');
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let permissionContext: string | null | Error = 'context-1';
  let conversationId: string | null = null;
  const events: import('../src/proxy.js').ProxySessionEvent[] = [];
  const proxy = new SpeculateProxy({
    mode,
    maxPredictionsPerTrigger: 3,
    log: 'off',
    servers: { upstream: { allowTools: ['read'] } },
  }, {
    now: () => 100,
    session: {
      launchId: 'launch',
      hostClient,
      hostServerAlias: 'files',
      runtime,
      permissionContext: () => {
        if (permissionContext instanceof Error) throw permissionContext;
        return permissionContext;
      },
      permissionGate: { check: () => decision() },
      conversationIdForCall: () => conversationId,
      onEvent: (event) => events.push(event),
    },
  });
  const tool = {
    name: 'read',
    inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  };
  const upstream = {
    connected: true,
    transport: 'http',
    tools: [tool],
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ tool: name, args });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ name, args }) }] };
    },
  } as unknown as Upstream;
  proxy.upstreams.set('upstream', upstream);
  proxy.policy.updateTools('upstream', [tool]);
  (proxy as unknown as { rebuildRoutes(): void }).rebuildRoutes();
  return {
    proxy,
    runtime,
    calls,
    events,
    setPermissionContext(value: string | null | Error) { permissionContext = value; },
    setConversationId(value: string | null) { conversationId = value; },
  };
}

async function readyRuntime(runtime: FakeRuntime): Promise<RegisteredRoute> {
  for (let i = 0; i < 20 && runtime.routes.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  return runtime.routes[0]!;
}

describe('SpeculateProxy observed candidate ingress', () => {
  it('delivers through the authenticated socket into the existing owner cache', async () => {
    const bridge = await start(() => 100);
    const runtime = await owner(bridge, 'files');
    const calls: string[] = [];
    const proxy = new SpeculateProxy({
      mode: 'strict', maxPredictionsPerTrigger: 3, log: 'off',
      servers: { upstream: { allowTools: ['read'] } },
    }, {
      now: () => 100,
      session: {
        launchId: 'launch', hostClient: 'claude', hostServerAlias: 'files', runtime,
        permissionContext: () => 'context', permissionGate: { check: () => 'allowed' },
      },
    });
    const tool = { name: 'read', inputSchema: localRoute.inputSchema, annotations: { readOnlyHint: true } };
    proxy.upstreams.set('upstream', {
      connected: true, transport: 'http', tools: [tool],
      callTool: async () => {
        calls.push('read');
        return { content: [{ type: 'text', text: 'socket-result' }] };
      },
    } as unknown as Upstream);
    proxy.policy.updateTools('upstream', [tool]);
    (proxy as any).rebuildRoutes();
    for (let i = 0; i < 20 && bridge.listRoutes().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const [route] = bridge.listRoutes();

    expect(bridge.submit(candidate(route!.routeId, route!.generation))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await (proxy as any).handleToolCall(
      { server: 'upstream', tool: { ...tool, name: 'read' }, exposed: 'read' },
      { path: '/a' },
      {},
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'socket-result' }] });
    expect(calls).toEqual(['read']);
    expect(proxy.metrics.statsSnapshot().hits).toBe(1);
  });

  it.each(['claude', 'codex'] as const)('uses %s host authorization and the owner cache', async (hostClient) => {
    const h = proxyHarness(hostClient, () => 'allowed');
    const route = await readyRuntime(h.runtime);
    h.runtime.deliver(candidate(route.routeId, route.generation));
    await new Promise((resolve) => setImmediate(resolve));
    const result = await (h.proxy as unknown as { handleToolCall(route: unknown, args: Record<string, unknown>, opts: object): Promise<unknown> })
      .handleToolCall({ server: 'upstream', tool: { name: 'read', inputSchema: route.inputSchema } }, { path: '/a' }, {});

    expect(result).toMatchObject({ content: [{ type: 'text' }] });
    expect(h.calls).toEqual([{ tool: 'read', args: { path: '/a' } }]);
    expect(h.proxy.metrics.statsSnapshot().hits).toBe(1);
  });

  it.each([
    ['claude', 'denied'], ['claude', 'approval-required'], ['claude', 'unverifiable'],
    ['codex', 'denied'], ['codex', 'approval-required'], ['codex', 'unverifiable'],
  ] as const)('abstains for %s when host authorization is %s', async (client, outcome) => {
    const h = proxyHarness(client, () => outcome);
    const route = await readyRuntime(h.runtime);
    h.runtime.deliver(candidate(route.routeId, route.generation));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.calls).toEqual([]);
  });

  it('reports host identity while leaving uncorrelated conversations unknown', async () => {
    const h = proxyHarness('claude', () => 'allowed');
    await readyRuntime(h.runtime);
    const route = { server: 'upstream', tool: { name: 'read' }, exposed: 'read' };
    await (h.proxy as any).handleToolCall(route, { path: '/one' }, {});
    h.setConversationId('thread');
    await (h.proxy as any).handleToolCall(route, { path: '/two' }, {});

    expect(h.events.map((event) => ({ host: event.hostServerAlias, client: event.hostClient, conversationId: event.conversationId })))
      .toEqual([
        { host: 'files', client: 'claude', conversationId: null },
        { host: 'files', client: 'claude', conversationId: 'thread' },
      ]);
  });

  it('defaults to deny when no permission context can be verified', async () => {
    const h = proxyHarness('codex', () => 'allowed');
    h.setPermissionContext(null);
    const route = await readyRuntime(h.runtime);
    h.runtime.deliver(candidate(route.routeId, route.generation));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.calls).toEqual([]);
  });

  it('drops queued candidates when their admitted permission context changes', async () => {
    const h = proxyHarness('claude', () => 'allowed');
    const route = await readyRuntime(h.runtime);
    expect(h.proxy.budget.tryAcquire('upstream')).toEqual({ ok: true });
    h.runtime.deliver(candidate(route.routeId, route.generation));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.calls).toEqual([]);

    h.setPermissionContext('context-2');
    h.proxy.budget.release('upstream');
    h.proxy.executor.drainServer('upstream');

    expect(h.calls).toEqual([]);
  });

  it.each([
    ['missing', null],
    ['unavailable', new Error('permission context unavailable')],
  ] as const)('does not publish an in-flight result when permission context becomes %s', async (_label, nextContext) => {
    const h = proxyHarness('claude', () => 'allowed');
    const route = await readyRuntime(h.runtime);
    let issued = 0;
    let resolveResult!: (result: { content: Array<{ type: 'text'; text: string }> }) => void;
    const pending = new Promise<{ content: Array<{ type: 'text'; text: string }> }>((resolve) => {
      resolveResult = resolve;
    });
    h.proxy.upstreams.get('upstream')!.callTool = async () => {
      issued++;
      return pending;
    };
    h.runtime.deliver(candidate(route.routeId, route.generation));
    await new Promise((resolve) => setImmediate(resolve));
    expect(issued).toBe(1);

    h.setPermissionContext(nextContext);
    resolveResult({ content: [{ type: 'text', text: 'stale' }] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.proxy.cache.lookup(canonicalKey('upstream', 'read', { path: '/a' })).outcome).toBe('miss');
  });

  it('does not let wire candidate IDs select persisted calibration identities', async () => {
    const h = proxyHarness('claude', () => 'allowed');
    const route = await readyRuntime(h.runtime);
    for (let index = 0; index < 100; index++) {
      (h.proxy as unknown as { calibration: { observe(id: string, correct: boolean, at: number): void } })
        .calibration.observe('ordinary-rule', false, 100);
    }

    h.runtime.deliver(candidate(route.routeId, route.generation, { candidateId: 'ordinary-rule' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.calls).toEqual([{ tool: 'read', args: { path: '/a' } }]);
  });

  it('rejects malformed args, replay, stale generations, and off mode', async () => {
    const h = proxyHarness('claude', () => 'allowed');
    const route = await readyRuntime(h.runtime);
    h.runtime.deliver(candidate(route.routeId, route.generation, { args: { path: 4 } }));
    h.runtime.deliver(candidate(route.routeId, route.generation, { candidateId: 'valid' }));
    h.runtime.deliver(candidate(route.routeId, route.generation, { candidateId: 'valid' }));
    h.proxy.invalidateObservedServer('upstream', 'mutation-start');
    h.runtime.deliver(candidate(route.routeId, route.generation, { candidateId: 'stale', args: { path: '/stale' } }));
    const off = proxyHarness('codex', () => 'allowed', 'off');
    const offRoute = await readyRuntime(off.runtime);
    off.runtime.deliver(candidate(offRoute.routeId, offRoute.generation));
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.calls).toHaveLength(1);
    expect(off.calls).toEqual([]);
  });

  it('re-registers a fresh route generation after a tool-list change', async () => {
    const h = proxyHarness('codex', () => 'allowed');
    const oldRoute = await readyRuntime(h.runtime);
    const upstream = h.proxy.upstreams.get('upstream')!;
    (h.proxy as any).handleUpstreamToolsChanged(upstream);
    for (let i = 0; i < 20 && h.runtime.routes[0]?.routeId === oldRoute.routeId; i++) await new Promise((resolve) => setImmediate(resolve));
    const freshRoute = h.runtime.routes[0]!;
    h.runtime.deliver(candidate(oldRoute.routeId, oldRoute.generation, { candidateId: 'old', args: { path: '/old' } }));
    h.runtime.deliver(candidate(freshRoute.routeId, freshRoute.generation, { candidateId: 'fresh', sourceEventId: 'fresh-event' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(freshRoute.generation).toBeGreaterThan(oldRoute.generation);
    expect(h.calls).toEqual([{ tool: 'read', args: { path: '/a' } }]);
  });

  it('isolates two wrappers with the same internal server and tool names', async () => {
    const first = proxyHarness('claude', () => 'allowed');
    const second = proxyHarness('claude', () => 'allowed');
    const firstRoute = await readyRuntime(first.runtime);
    const secondRoute = await readyRuntime(second.runtime);
    first.runtime.deliver(candidate(firstRoute.routeId, firstRoute.generation));
    await new Promise((resolve) => setImmediate(resolve));
    await (first.proxy as any).handleToolCall({ server: 'upstream', tool: { name: 'read' } }, { path: '/a' }, {});
    await (second.proxy as any).handleToolCall({ server: 'upstream', tool: { name: 'read' } }, { path: '/a' }, {});

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(first.proxy.metrics.statsSnapshot().hits).toBe(1);
    expect(second.proxy.metrics.statsSnapshot().misses).toBe(1);
  });
});
