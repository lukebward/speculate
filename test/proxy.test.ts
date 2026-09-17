import { describe, expect, it } from 'vitest';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { SpeculateProxy, type ProxySessionEvent, type ProxySessionRuntime } from '../src/proxy.js';
import type {
  ProxyDemandEvent,
  SemanticRankingConfig,
  SemanticRankingReply,
  SemanticRankingRequest,
} from '../src/semanticTypes.js';
import type { LocalRouteDescriptor, RegisteredRoute } from '../src/observerTypes.js';
import type { Upstream } from '../src/upstream.js';

const semanticConfig = (mode: SemanticRankingConfig['mode']): SemanticRankingConfig => ({
  mode,
  model: 'jev-1.13.0',
  timeoutMs: 150,
  maxCandidates: 16,
  horizonMs: 30_000,
  maxRequestsPerMinute: 60,
  maxRequestsPerSession: 1_000,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class SemanticRuntime implements ProxySessionRuntime {
  routes: RegisteredRoute[] = [];
  demands: ProxyDemandEvent[] = [];
  completions: ProxySessionEvent[] = [];
  requests: SemanticRankingRequest[] = [];
  revision = 0;
  judge = (_request: SemanticRankingRequest): Promise<SemanticRankingReply | null> => Promise.resolve(null);
  private candidateHandler: (candidates: unknown) => void = () => {};

  constructor(private readonly config: SemanticRankingConfig) {}

  setCandidateHandler(handler: (candidates: unknown) => void): void {
    this.candidateHandler = handler;
  }

  deliver(candidates: unknown): void {
    this.candidateHandler(candidates);
  }

  async replaceRoutes(routes: readonly LocalRouteDescriptor[]): Promise<readonly RegisteredRoute[]> {
    this.routes = routes.map((route, index) => ({
      ...route,
      routeId: `route-${index}`,
      generation: 1,
      instanceId: 'owner-1',
      hostClient: 'claude',
      hostServerAlias: 'workspace',
    }));
    return this.routes;
  }

  semanticConfig(): SemanticRankingConfig { return this.config; }
  semanticRevision(): number { return this.revision; }
  async judgeCandidates(request: SemanticRankingRequest): Promise<SemanticRankingReply | null> {
    this.requests.push(request);
    return this.judge(request);
  }
  async publishDemand(event: ProxyDemandEvent): Promise<boolean> {
    this.demands.push(event);
    return true;
  }
  async publishCompleted(event: ProxySessionEvent): Promise<boolean> {
    this.completions.push(event);
    return true;
  }
  async invalidateServer(): Promise<void> {}
  async close(): Promise<void> {}
}

function reply(request: SemanticRankingRequest, scores: Record<string, number>): SemanticRankingReply {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    batchId: request.batchId,
    sourceEventId: request.sourceEventId,
    ownerInstanceId: request.ownerInstanceId,
    launchId: request.launchId,
    conversationId: 'thread',
    batchDigest: request.batchDigest,
    contextRevision: 1,
    model: 'jev-1.13.0',
    questionVersion: 'v1',
    providerDurationMs: 5,
    scores,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function harness(mode: SemanticRankingConfig['mode'], clock = { now: 100 }) {
  const runtime = new SemanticRuntime(semanticConfig(mode));
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tools: Tool[] = ['list', 'detail_a', 'detail_b', 'other', 'fail'].map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  }));
  const proxy = new SpeculateProxy({
    mode: 'strict',
    maxPredictionsPerTrigger: 1,
    log: 'off',
    servers: {
      upstream: {
        allowTools: tools.map((tool) => tool.name),
        rules: [{
          trigger: 'list',
          predict: [
            { tool: 'detail_a', args: { id: 'a' }, confidence: 0.9, limit: 2 },
            { tool: 'detail_b', args: { id: 'b' }, confidence: 0.2, limit: 2 },
          ],
        }],
      },
    },
  }, {
    now: () => clock.now,
    session: {
      launchId: 'launch',
      hostClient: 'claude',
      hostServerAlias: 'workspace',
      runtime,
      permissionContext: () => 'permission',
      permissionGate: { check: () => 'allowed' },
      conversationIdForCall: () => 'thread',
    },
  });
  proxy.upstreams.set('upstream', {
    connected: true,
    transport: 'http',
    tools,
    callTool: async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      calls.push({ tool, args });
      if (tool === 'fail') throw new Error('failed');
      return { content: [{ type: 'text', text: '{}' }] };
    },
  } as unknown as Upstream);
  proxy.policy.updateTools('upstream', tools);
  (proxy as unknown as { rebuildRoutes(): void }).rebuildRoutes();
  await settle();
  return { proxy, runtime, calls, clock };
}

async function call(proxy: SpeculateProxy, tool: string, args: Record<string, unknown> = {}) {
  return (proxy as unknown as {
    handleToolCall(route: unknown, args: Record<string, unknown>, opts: object): Promise<CallToolResult>;
  }).handleToolCall({ server: 'upstream', tool: { name: tool }, exposed: tool }, args, {});
}

describe('semantic proxy integration', () => {
  it('uses one source event for demand, completion, and the ranked frontier', async () => {
    const h = await harness('rank');
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;

    await call(h.proxy, 'list');
    await settle();
    expect(h.calls.map(({ tool }) => tool)).toEqual(['list']);
    const request = h.runtime.requests[0]!;
    const selected = request.candidates.find((candidate) => candidate.tool === 'detail_b')!;
    expect(selected.toolDescription).toBe('detail_b description');
    judged.resolve(reply(request, Object.fromEntries(
      request.candidates.map((candidate) => [candidate.id, candidate.id === selected.id ? 0.95 : 0.01]),
    )));
    await settle();
    await settle();

    expect(h.calls.map(({ tool }) => tool)).toEqual(['list', 'detail_b']);
    expect(h.runtime.demands).toEqual([
      expect.objectContaining({ phase: 'start', requestId: request.sourceEventId, sourceEventId: request.sourceEventId }),
      expect.objectContaining({ phase: 'complete', requestId: request.sourceEventId, sourceEventId: request.sourceEventId, success: true }),
    ]);
    expect(h.runtime.completions[0]!.eventId).toBe(request.sourceEventId);
  });

  it('submits the baseline immediately in shadow mode', async () => {
    const h = await harness('shadow');
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;

    await call(h.proxy, 'list');
    await settle();

    expect(h.calls.map(({ tool }) => tool)).toEqual(['list', 'detail_a']);
    expect(h.runtime.requests).toHaveLength(1);
  });

  it('drops a stale fallback when a newer real demand arrives during judging', async () => {
    const h = await harness('rank');
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;

    await call(h.proxy, 'list');
    await settle();
    await call(h.proxy, 'other');
    judged.resolve(null);
    await settle();
    await settle();

    expect(h.calls.map(({ tool }) => tool)).toEqual(['list', 'other']);
  });

  it('drops fallback after bridge context invalidation', async () => {
    const h = await harness('rank');
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;

    await call(h.proxy, 'list');
    await settle();
    h.runtime.revision++;
    judged.resolve(null);
    await settle();
    await settle();

    expect(h.calls.map(({ tool }) => tool)).toEqual(['list']);
  });

  it('falls back to the immutable baseline on a hostile reply', async () => {
    const h = await harness('rank');
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;

    await call(h.proxy, 'list');
    await settle();
    const request = h.runtime.requests[0]!;
    const selected = request.candidates.find((candidate) => candidate.tool === 'detail_b')!;
    judged.resolve(reply(request, { [selected.id]: 1, injected: 1 }));
    await settle();
    await settle();

    expect(h.calls).toEqual([
      { tool: 'list', args: {} },
      { tool: 'detail_a', args: { id: 'a' } },
    ]);
  });

  it('accepts partial scores and retains baseline scores for omitted candidates', async () => {
    const h = await harness('rank');
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;

    await call(h.proxy, 'list');
    await settle();
    const request = h.runtime.requests[0]!;
    const selected = request.candidates.find((candidate) => candidate.tool === 'detail_b')!;
    judged.resolve(reply(request, { [selected.id]: 0.95 }));
    await settle();
    await settle();

    expect(h.calls).toEqual([
      { tool: 'list', args: {} },
      { tool: 'detail_b', args: { id: 'b' } },
    ]);
  });

  it('bypasses judging for stream candidates', async () => {
    const h = await harness('rank');
    const route = h.runtime.routes.find((candidate) => candidate.upstreamTool === 'detail_b')!;

    h.runtime.deliver([{
      version: 1,
      launchId: 'launch',
      conversationId: 'thread',
      candidateId: 'stream-candidate',
      routeId: route.routeId,
      generation: route.generation,
      sourceEventId: 'stream-source',
      source: 'stream',
      args: { id: 'stream' },
      confidence: 0.8,
      createdAt: 100,
    }]);
    await settle();

    expect(h.runtime.requests).toEqual([]);
    expect(h.calls).toEqual([{ tool: 'detail_b', args: { id: 'stream' } }]);
  });

  it('does not revive an observer candidate that ages out while judging', async () => {
    const clock = { now: 900 };
    const h = await harness('rank', clock);
    const judged = deferred<SemanticRankingReply | null>();
    h.runtime.judge = () => judged.promise;
    const route = h.runtime.routes.find((candidate) => candidate.upstreamTool === 'detail_b')!;

    h.runtime.deliver([{
      version: 1,
      launchId: 'launch',
      conversationId: 'thread',
      candidateId: 'intent-candidate',
      routeId: route.routeId,
      generation: route.generation,
      sourceEventId: 'intent-source',
      source: 'intent',
      args: { id: 'intent' },
      confidence: 0.8,
      createdAt: 0,
    }]);
    const request = h.runtime.requests[0]!;
    clock.now = 1_100;
    judged.resolve(reply(request, Object.fromEntries(request.candidates.map((candidate) => [candidate.id, 1]))));
    await settle();
    await settle();

    expect(h.calls).toEqual([]);
  });

  it('publishes demand completion for failed real calls', async () => {
    const h = await harness('rank');

    await expect(call(h.proxy, 'fail')).rejects.toThrow('failed');

    expect(h.runtime.demands).toEqual([
      expect.objectContaining({ phase: 'start', tool: 'fail' }),
      expect.objectContaining({ phase: 'complete', success: false }),
    ]);
    expect(h.runtime.demands[0]!.requestId).toBe(h.runtime.demands[1]!.requestId);
    expect(h.runtime.completions).toEqual([
      expect.objectContaining({
        eventId: h.runtime.demands[0]!.sourceEventId,
        success: false,
      }),
    ]);
    expect(h.runtime.completions[0]).not.toHaveProperty('result');
  });
});
