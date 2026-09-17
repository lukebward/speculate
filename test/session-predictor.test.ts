import { afterEach, describe, expect, it } from 'vitest';
import { SessionPredictor } from '../src/sessionPredictor.js';
import type { Observation, RegisteredRoute, SessionContext } from '../src/observerTypes.js';
import { SessionBridge, connectSessionBridgeOwner, type SessionBridgeOwner } from '../src/sessionBridge.js';
import { SpeculateProxy, type ProxySessionEvent } from '../src/proxy.js';
import type { Upstream } from '../src/upstream.js';

const baseContext: SessionContext = {
  launchId: 'launch',
  conversationId: 'thread',
  agent: 'claude',
  cwd: '/work',
};

const issueRoute: RegisteredRoute = {
  routeId: 'issues-r1',
  generation: 1,
  instanceId: 'issues-owner',
  hostClient: 'claude',
  hostServerAlias: 'issues',
  exposedTool: 'get_issue',
  upstreamServer: 'upstream',
  upstreamTool: 'get_issue',
  inputSchema: { type: 'object' },
};

const searchRoute: RegisteredRoute = {
  routeId: 'workspace-r1',
  generation: 1,
  instanceId: 'workspace-owner',
  hostClient: 'claude',
  hostServerAlias: 'workspace',
  exposedTool: 'search',
  upstreamServer: 'upstream',
  upstreamTool: 'search',
  inputSchema: { type: 'object' },
};

function completed(
  eventId: string,
  routeId: string,
  args: Record<string, unknown>,
  parsed: unknown = null,
  over: Partial<Extract<Observation, { kind: 'tool-complete' }>> = {},
): Extract<Observation, { kind: 'tool-complete' }> {
  return {
    context: baseContext,
    kind: 'tool-complete',
    eventId,
    observedAt: Number(eventId.replace(/\D/g, '')) || 1,
    routeId,
    args,
    parsed: parsed as never,
    latencyMs: 5,
    ordered: true,
    ...over,
  };
}

function trainCopiedWorkflow(predictor: SessionPredictor): void {
  predictor.observe(completed('a1', issueRoute.routeId, { issue: 1 }));
  predictor.observe(completed('b1', searchRoute.routeId, { issue: 1, query: 'TODO' }));
  predictor.observe(completed('a2', issueRoute.routeId, { issue: 2 }));
  predictor.observe(completed('b2', searchRoute.routeId, { issue: 2, query: 'TODO' }));
}

describe('SessionPredictor', () => {
  it('learns a cross-server workflow and copies current arguments into the destination', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    trainCopiedWorkflow(predictor);

    const args = { issue: 9 };
    const candidates = predictor.observe(completed('a3', issueRoute.routeId, args));
    args.issue = 10;

    expect(candidates).toEqual([
      expect.objectContaining({
        launchId: 'launch',
        conversationId: 'thread',
        routeId: searchRoute.routeId,
        generation: searchRoute.generation,
        sourceEventId: 'a3',
        source: 'transition',
        args: { issue: 9, query: 'TODO' },
        createdAt: 50,
      }),
    ]);
  });

  it('derives destination arguments from the current parsed result', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    for (const [index, path] of ['/one', '/two'].entries()) {
      predictor.observe(completed(`a${index + 1}`, issueRoute.routeId, {}, { workspace: { path } }));
      predictor.observe(completed(`b${index + 1}`, searchRoute.routeId, { path, query: 'TODO' }));
    }

    const candidates = predictor.observe(completed('a3', issueRoute.routeId, {}, {
      workspace: { path: '/current' },
    }));

    expect(candidates[0]?.args).toEqual({ path: '/current', query: 'TODO' });
  });

  it('keeps conversations isolated', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    const other = { ...baseContext, conversationId: 'subagent' };
    predictor.observe(completed('a1', issueRoute.routeId, { issue: 1 }));
    predictor.observe(completed('b1', searchRoute.routeId, { issue: 1 }));
    predictor.observe(completed('a2', issueRoute.routeId, { issue: 2 }, null, { context: other }));
    predictor.observe(completed('b2', searchRoute.routeId, { issue: 2 }, null, { context: other }));

    expect(predictor.observe(completed('a3', issueRoute.routeId, { issue: 3 }))).toEqual([]);
    expect(predictor.observe(completed('a4', issueRoute.routeId, { issue: 4 }, null, { context: other }))).toEqual([]);
  });

  it('does not learn adjacency across calls marked unordered', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    predictor.observe(completed('a1', issueRoute.routeId, { issue: 1 }));
    predictor.observe(completed('b1', searchRoute.routeId, { issue: 1 }, null, { ordered: false }));
    predictor.observe(completed('a2', issueRoute.routeId, { issue: 2 }));
    predictor.observe(completed('b2', searchRoute.routeId, { issue: 2 }, null, { ordered: false }));

    expect(predictor.observe(completed('a3', issueRoute.routeId, { issue: 3 }))).toEqual([]);
  });

  it('deduplicates hook and wrapper copies by stable event identity', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    const first = completed('a1', issueRoute.routeId, { issue: 1 });
    const second = completed('b1', searchRoute.routeId, { issue: 1, query: 'TODO' });
    predictor.observe(first);
    predictor.observe(second);
    predictor.observe(structuredClone(first));
    predictor.observe(structuredClone(second));

    expect(predictor.observe(completed('a2', issueRoute.routeId, { issue: 2 }))).toEqual([]);
    predictor.observe(completed('b2', searchRoute.routeId, { issue: 2, query: 'TODO' }));
    expect(predictor.observe(completed('a3', issueRoute.routeId, { issue: 3 }))).toHaveLength(1);
  });

  it('drops learned route state after invalidation and requires fresh evidence for a new generation', () => {
    let routes: RegisteredRoute[] = [issueRoute, searchRoute];
    const predictor = new SessionPredictor({ routes: () => routes, now: () => 50 });
    trainCopiedWorkflow(predictor);
    predictor.invalidate([issueRoute.routeId, searchRoute.routeId]);
    routes = [
      { ...issueRoute, routeId: 'issues-r2', generation: 2 },
      { ...searchRoute, routeId: 'workspace-r2', generation: 2 },
    ];

    predictor.observe(completed('fresh-a1', 'issues-r2', { issue: 1 }));
    predictor.observe(completed('fresh-b1', 'workspace-r2', { issue: 1, query: 'TODO' }));

    expect(predictor.observe(completed('fresh-a2', 'issues-r2', { issue: 2 }))).toEqual([]);
  });

  it('drops a conversation before retained observation material exceeds its cap', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    trainCopiedWorkflow(predictor);
    for (let index = 0; index < 5; index++) {
      predictor.observe(completed(`large-${index}`, issueRoute.routeId, {}, {
        large: `${index}:${'x'.repeat(1_800_000)}`,
      }));
    }

    const candidates = predictor.observe(completed('after-cap', issueRoute.routeId, { issue: 9 }));

    expect(candidates.some((candidate) => candidate.routeId === searchRoute.routeId)).toBe(false);
  });

  it('evicts the oldest conversation before the session estimate exceeds 32 MiB', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    trainCopiedWorkflow(predictor);
    for (let index = 0; index < 5; index++) {
      predictor.observe(completed(`session-large-${index}`, issueRoute.routeId, {}, {
        large: `${index}:${'x'.repeat(1_700_000)}`,
      }, { context: { ...baseContext, conversationId: index === 0 ? 'thread' : `thread-${index}` } }));
    }

    const candidates = predictor.observe(completed('after-session-cap', issueRoute.routeId, { issue: 9 }));

    expect(candidates.some((candidate) => candidate.routeId === searchRoute.routeId)).toBe(false);
  });

  it('evicts the oldest conversation through the same accounting path at the count cap', () => {
    const predictor = new SessionPredictor({ routes: () => [issueRoute, searchRoute], now: () => 50 });
    trainCopiedWorkflow(predictor);
    for (let index = 1; index < 256; index++) {
      predictor.observe(completed(`fill-${index}`, issueRoute.routeId, {}, null, {
        context: { ...baseContext, conversationId: `thread-${index}` },
      }));
    }
    predictor.observe(completed('newest', issueRoute.routeId, {}, null, {
      context: { ...baseContext, conversationId: 'thread-newest' },
    }));

    const candidates = predictor.observe(completed('after-count-cap', issueRoute.routeId, { issue: 9 }));

    expect(candidates.some((candidate) => candidate.routeId === searchRoute.routeId)).toBe(false);
  });
});

describe('real completion bridge integration', () => {
  const bridges: SessionBridge[] = [];
  const owners: SessionBridgeOwner[] = [];

  afterEach(async () => {
    await Promise.allSettled(owners.splice(0).map((owner) => owner.close()));
    await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
  });

  async function proxyFor(
    bridge: SessionBridge,
    alias: string,
    toolName: string,
    inputSchema: Record<string, unknown>,
    calls: Array<Record<string, unknown>>,
    now: () => number,
    completeCall: () => void,
  ): Promise<SpeculateProxy> {
    const runtime = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude',
      hostServerAlias: alias,
      onCandidates: () => {},
    });
    owners.push(runtime);
    const proxy = new SpeculateProxy({
      mode: 'strict',
      maxPredictionsPerTrigger: 3,
      log: 'off',
      servers: { upstream: { allowTools: [toolName] } },
    }, {
      now,
      session: {
        launchId: 'launch',
        hostClient: 'claude',
        hostServerAlias: alias,
        runtime,
        permissionContext: () => 'permission-context',
        permissionGate: { check: () => 'allowed' },
      },
    });
    const tool = { name: toolName, inputSchema, annotations: { readOnlyHint: true } };
    proxy.upstreams.set('upstream', {
      connected: true,
      transport: 'http',
      tools: [tool],
      callTool: async (_name: string, args: Record<string, unknown>) => {
        calls.push(structuredClone(args));
        completeCall();
        return { content: [{ type: 'text', text: JSON.stringify({ args }) }] };
      },
      close: async () => {},
    } as unknown as Upstream);
    proxy.policy.updateTools('upstream', [tool]);
    (proxy as unknown as { rebuildRoutes(): void }).rebuildRoutes();
    return proxy;
  }

  async function call(proxy: SpeculateProxy, toolName: string, args: Record<string, unknown>): Promise<void> {
    await (proxy as unknown as {
      handleToolCall(route: unknown, args: Record<string, unknown>, opts: object): Promise<unknown>;
    }).handleToolCall({
      server: 'upstream',
      tool: { name: toolName, inputSchema: { type: 'object' } },
      exposed: toolName,
    }, args, {});
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('routes learned cross-server candidates into the owning cache after correlation', async () => {
    let clock = 100;
    const bridge = await SessionBridge.start(baseContext, {
      now: () => clock,
      correlateCompletion: (event: ProxySessionEvent) => ({
        conversationId: 'thread',
        eventId: event.eventId,
      }),
    });
    bridges.push(bridge);
    const issueCalls: Array<Record<string, unknown>> = [];
    const searchCalls: Array<Record<string, unknown>> = [];
    const issueProxy = await proxyFor(bridge, 'issues', 'get_issue', {
      type: 'object', properties: { issue: { type: 'number' } }, required: ['issue'], additionalProperties: false,
    }, issueCalls, () => clock, () => { clock += 100; });
    const searchProxy = await proxyFor(bridge, 'workspace', 'search', {
      type: 'object',
      properties: { issue: { type: 'number' }, query: { type: 'string' } },
      required: ['issue', 'query'],
      additionalProperties: false,
    }, searchCalls, () => clock, () => { clock += 100; });
    for (let attempt = 0; attempt < 20 && bridge.listRoutes().length < 2; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await call(issueProxy, 'get_issue', { issue: 1 });
    await call(searchProxy, 'search', { issue: 1, query: 'TODO' });
    await call(issueProxy, 'get_issue', { issue: 2 });
    await call(searchProxy, 'search', { issue: 2, query: 'TODO' });
    await call(issueProxy, 'get_issue', { issue: 3 });
    for (let attempt = 0; attempt < 20 && searchCalls.length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await call(searchProxy, 'search', { issue: 3, query: 'TODO' });

    expect(issueCalls).toHaveLength(3);
    expect(searchCalls).toEqual([
      { issue: 1, query: 'TODO' },
      { issue: 2, query: 'TODO' },
      { issue: 3, query: 'TODO' },
    ]);
    expect(searchProxy.metrics.statsSnapshot().hits).toBe(1);

    await Promise.all([issueProxy.close(), searchProxy.close()]);
  });

  it('abstains from wrapper completions when correlation is unavailable', async () => {
    const bridge = await SessionBridge.start(baseContext, { now: () => 100 });
    bridges.push(bridge);
    const runtime = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'issues', onCandidates: () => {},
    });
    owners.push(runtime);
    const [route] = await runtime.register([{
      exposedTool: 'get_issue', upstreamServer: 'upstream', upstreamTool: 'get_issue', inputSchema: { type: 'object' },
    }]);
    const seen: Observation[] = [];
    bridge.subscribe((event) => seen.push(event));

    expect(await runtime.publishCompleted({
      kind: 'tool-complete',
      launchId: 'launch',
      hostClient: 'claude',
      hostServerAlias: 'issues',
      conversationId: null,
      eventId: 'call',
      routeId: route!.routeId,
      generation: route!.generation,
      exposedTool: 'get_issue',
      upstreamServer: 'upstream',
      upstreamTool: 'get_issue',
      args: { issue: 1 },
      result: { content: [{ type: 'text', text: '{}' }] },
      latencyMs: 5,
      startedAt: 95,
      completedAt: 100,
    })).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([]);
  });

  it('marks overlapping completions from independent owners unordered', async () => {
    const bridge = await SessionBridge.start(baseContext, {
      now: () => 100,
      correlateCompletion: (event) => ({ conversationId: 'thread', eventId: event.eventId }),
    });
    bridges.push(bridge);
    const first = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'issues', onCandidates: () => {},
    });
    const second = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'workspace', onCandidates: () => {},
    });
    owners.push(first, second);
    const [firstRoute] = await first.register([{
      exposedTool: 'get_issue', upstreamServer: 'upstream', upstreamTool: 'get_issue', inputSchema: { type: 'object' },
    }]);
    const [secondRoute] = await second.register([{
      exposedTool: 'search', upstreamServer: 'upstream', upstreamTool: 'search', inputSchema: { type: 'object' },
    }]);
    const seen: Array<Extract<Observation, { kind: 'tool-complete' }>> = [];
    bridge.subscribe((event) => {
      if (event.kind === 'tool-complete') seen.push(event);
    });
    const event = (
      route: RegisteredRoute,
      eventId: string,
      startedAt: number,
      completedAt: number,
    ): ProxySessionEvent => ({
      kind: 'tool-complete',
      launchId: 'launch',
      hostClient: 'claude',
      hostServerAlias: route.hostServerAlias,
      conversationId: null,
      eventId,
      routeId: route.routeId,
      generation: route.generation,
      exposedTool: route.exposedTool,
      upstreamServer: route.upstreamServer,
      upstreamTool: route.upstreamTool,
      args: {},
      result: { content: [{ type: 'text', text: '{}' }] },
      success: true,
      latencyMs: completedAt - startedAt,
      startedAt,
      completedAt,
    });

    expect(await first.publishCompleted(event(firstRoute!, 'first', 0, 10))).toBe(true);
    expect(await second.publishCompleted(event(secondRoute!, 'second', 5, 15))).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen.map(({ eventId, ordered }) => ({ eventId, ordered }))).toEqual([
      { eventId: 'first', ordered: true },
      { eventId: 'second', ordered: false },
    ]);
  });
});
