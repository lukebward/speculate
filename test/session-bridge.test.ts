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
import type {
  ProxyDemandEvent,
  SemanticRankingConfig,
  SemanticRankingReply,
  SemanticRankingRequest,
  VerifiedProxyDemandEvent,
} from '../src/semanticTypes.js';

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

const semanticConfig: SemanticRankingConfig = {
  mode: 'rank',
  model: 'jev-1.13.0',
  timeoutMs: 150,
  maxCandidates: 16,
  horizonMs: 30_000,
  maxRequestsPerMinute: 60,
  maxRequestsPerSession: 1_000,
};

function completion(route: RegisteredRoute, over: Partial<import('../src/proxy.js').ProxySessionEvent> = {}) {
  return {
    kind: 'tool-complete' as const,
    launchId: 'launch',
    hostClient: 'claude' as const,
    hostServerAlias: 'files',
    conversationId: null,
    eventId: 'source-call',
    routeId: route.routeId,
    generation: route.generation,
    exposedTool: route.exposedTool,
    upstreamServer: route.upstreamServer,
    upstreamTool: route.upstreamTool,
    args: { path: '/a' },
    result: { content: [{ type: 'text' as const, text: 'ok' }] },
    success: true,
    latencyMs: 10,
    startedAt: 90,
    completedAt: 100,
    ...over,
  };
}

function semanticRequest(route: RegisteredRoute, over: Partial<SemanticRankingRequest> = {}): SemanticRankingRequest {
  return {
    protocolVersion: 1,
    requestId: 'judge-1',
    batchId: 'batch-1',
    sourceEventId: 'source-call',
    ownerInstanceId: route.instanceId,
    launchId: 'launch',
    createdAt: 100,
    deadlineAt: 250,
    batchDigest: 'digest',
    candidates: [{
      id: 'candidate-1',
      routeId: route.routeId,
      generation: route.generation,
      server: route.upstreamServer,
      tool: route.upstreamTool,
      args: { path: '/next' },
      baselineScore: 0.8,
      conservativeLatencyMs: 20,
      effectiveTtlMs: 1_000,
    }],
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

  it('publishes resets for route replacement and owner disconnect', async () => {
    const bridge = await start(() => 100);
    const connection = await owner(bridge, 'files');
    const [oldRoute] = await connection.register([localRoute]);
    const seen: import('../src/observerTypes.js').Observation[] = [];
    bridge.subscribe((event) => seen.push(event));
    const [freshRoute] = await connection.register([localRoute]);
    await connection.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'invalidate', routeIds: [oldRoute!.routeId], reason: 'routes-replaced',
      }),
      expect.objectContaining({
        kind: 'invalidate', routeIds: [freshRoute!.routeId], reason: 'disconnect',
      }),
    ]));
  });
});

describe('SessionBridge semantic IPC', () => {
  function semanticService() {
    const judged: SemanticRankingRequest[] = [];
    const demands: VerifiedProxyDemandEvent[] = [];
    const pendingDemands: ProxyDemandEvent[] = [];
    const censoredDemands: Array<[string, string]> = [];
    let shutdowns = 0;
    return {
      judged,
      demands,
      pendingDemands,
      censoredDemands,
      get shutdowns() { return shutdowns; },
      service: {
        observePrompt: () => true,
        observeCall: () => true,
        async judgeCandidates(request: SemanticRankingRequest): Promise<SemanticRankingReply> {
          judged.push(request);
          return {
            protocolVersion: 1,
            requestId: request.requestId,
            batchId: request.batchId,
            sourceEventId: request.sourceEventId,
            ownerInstanceId: request.ownerInstanceId,
            launchId: request.launchId,
            conversationId: request.conversationId!,
            batchDigest: request.batchDigest,
            contextRevision: 1,
            model: semanticConfig.model,
            questionVersion: 'demand-v1',
            providerDurationMs: 4,
            scores: { 'candidate-1': 0.7 },
          };
        },
        async publishDemand(event: VerifiedProxyDemandEvent): Promise<boolean> {
          demands.push(event);
          return true;
        },
        notePendingDemand(event: Extract<ProxyDemandEvent, { phase: 'start' }>): boolean {
          pendingDemands.push(event);
          return true;
        },
        censorPendingDemand(ownerInstanceId: string, requestId: string): boolean {
          censoredDemands.push([ownerInstanceId, requestId]);
          return true;
        },
        report: () => ({ judged: judged.length }),
        invalidate: () => {},
        shutdown: () => { shutdowns++; },
      },
    };
  }

  it('invalidates service evaluation when verified permissions change', async () => {
    const semantic = semanticService();
    const invalidated: string[] = [];
    semantic.service.invalidate = (conversationId?: string) => { invalidated.push(conversationId!); };
    let decision: HostPermissionDecision = 'allowed';
    let permissionContext: string | null = 'target-read';
    let policyFingerprint: string | null = 'policy-1';
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      semanticConfig,
      semanticService: semantic.service,
      authorizeCandidate: () => ({ decision, permissionContext, policyFingerprint }),
    });
    bridges.push(bridge);
    const received: Candidate[][] = [];
    const connection = await owner(bridge, 'files', received);
    const [route, otherRoute] = await connection.register([
      localRoute,
      { ...localRoute, exposedTool: 'search', upstreamTool: 'search' },
    ]);
    expect(bridge.submit(candidate(route!.routeId, route!.generation))).toBe(true);
    for (let attempt = 0; attempt < 20 && received.length < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    invalidated.length = 0;
    permissionContext = 'target-search';
    expect(bridge.submit(candidate(otherRoute!.routeId, otherRoute!.generation, {
      candidateId: 'second', sourceEventId: 'second-event',
    }))).toBe(true);
    for (let attempt = 0; attempt < 20 && received.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(received).toHaveLength(2);
    expect(invalidated).toEqual([]);
    policyFingerprint = 'policy-2';
    permissionContext = 'target-read-2';
    expect(bridge.submit(candidate(route!.routeId, route!.generation, {
      candidateId: 'third', sourceEventId: 'third-event',
    }))).toBe(true);
    for (let attempt = 0; attempt < 20 && received.length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(received).toHaveLength(3);
    expect(invalidated).toEqual(['thread']);
    invalidated.length = 0;
    decision = 'denied';
    permissionContext = null;
    policyFingerprint = 'policy-3';
    expect(bridge.submit(candidate(route!.routeId, route!.generation, {
      candidateId: 'fourth', sourceEventId: 'fourth-event',
    }))).toBe(true);
    for (let attempt = 0; attempt < 20 && invalidated.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(received).toHaveLength(3);
    expect(invalidated).toEqual(['thread']);
    invalidated.length = 0;
    decision = 'unverifiable';
    policyFingerprint = null;
    expect(bridge.submit(candidate(route!.routeId, route!.generation, {
      candidateId: 'fifth', sourceEventId: 'fifth-event',
    }))).toBe(true);
    for (let attempt = 0; attempt < 20 && invalidated.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(invalidated).toEqual(['thread']);
  });

  it.each(['judge-first', 'completion-first'] as const)(
    'shares one completion correlation when %s',
    async (order) => {
      let correlations = 0;
      const semantic = semanticService();
      const bridge = await SessionBridge.start(context, {
        now: () => 100,
        correlateCompletion: async () => {
          correlations++;
          return { conversationId: 'thread', cwd: '/work' };
        },
        semanticConfig,
        semanticService: semantic.service,
      });
      bridges.push(bridge);
      const connection = await owner(bridge, 'files');
      const [route] = await connection.register([localRoute]);
      expect(connection.semanticConfig()).toEqual(semanticConfig);

      let pending: Promise<SemanticRankingReply | null>;
      if (order === 'judge-first') {
        pending = connection.judgeCandidates(semanticRequest(route!));
        await new Promise((resolve) => setImmediate(resolve));
        expect(semantic.judged).toEqual([]);
        expect(await connection.publishCompleted(completion(route!))).toBe(true);
      } else {
        expect(await connection.publishCompleted(completion(route!))).toBe(true);
        pending = connection.judgeCandidates(semanticRequest(route!));
      }

      await expect(pending).resolves.toMatchObject({
        requestId: 'judge-1',
        conversationId: 'thread',
        contextRevision: 1,
        scores: { 'candidate-1': 0.7 },
      });
      expect(semantic.judged).toHaveLength(1);
      expect(semantic.judged[0]).toMatchObject({ conversationId: 'thread' });
      expect(correlations).toBe(1);
    },
  );

  it('rejects a ranking request that claims another owner', async () => {
    const semantic = semanticService();
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      correlateCompletion: () => ({ conversationId: 'thread', cwd: '/work' }),
      semanticConfig,
      semanticService: semantic.service,
    });
    bridges.push(bridge);
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);

    await expect(connection.judgeCandidates(semanticRequest(route!, {
      ownerInstanceId: 'different-owner',
    }))).resolves.toBeNull();
    expect(semantic.judged).toEqual([]);
  });

  it('scopes identical source event IDs to their authenticated source owners', async () => {
    const semantic = semanticService();
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      correlateCompletion: (event) => ({
        conversationId: event.hostServerAlias === 'files' ? 'thread' : 'subagent',
        cwd: '/work',
      }),
      semanticConfig,
      semanticService: semantic.service,
    });
    bridges.push(bridge);
    expect(bridge.registerConversation({ ...context, conversationId: 'subagent' })).toBe(true);
    const first = await owner(bridge, 'files');
    const second = await owner(bridge, 'other-files');
    const [firstRoute] = await first.register([localRoute]);
    const [secondRoute] = await second.register([localRoute]);
    await first.publishCompleted(completion(firstRoute!));
    await second.publishCompleted(completion(secondRoute!, { hostServerAlias: 'other-files' }));

    const [firstReply, secondReply] = await Promise.all([
      first.judgeCandidates(semanticRequest(firstRoute!)),
      second.judgeCandidates(semanticRequest(secondRoute!, { requestId: 'judge-2', batchId: 'batch-2' })),
    ]);

    expect(firstReply?.conversationId).toBe('thread');
    expect(secondReply?.conversationId).toBe('subagent');
  });

  it('forwards failed demand only after verified completion correlation', async () => {
    const semantic = semanticService();
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      correlateCompletion: () => ({ conversationId: 'thread', cwd: '/work' }),
      semanticConfig,
      semanticService: semantic.service,
    });
    bridges.push(bridge);
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);
    const start: ProxyDemandEvent = {
      phase: 'start', requestId: 'source-call', sourceEventId: 'source-call',
      ownerInstanceId: connection.ownerId, routeId: route!.routeId, generation: route!.generation,
      server: route!.upstreamServer, tool: route!.upstreamTool, args: { path: '/a' }, startedAt: 90,
    };
    const complete: ProxyDemandEvent = {
      phase: 'complete', requestId: 'source-call', sourceEventId: 'source-call',
      ownerInstanceId: connection.ownerId, routeId: route!.routeId, generation: route!.generation,
      completedAt: 100, success: false,
    };

    const demandStart = connection.publishDemand(start);
    const demandComplete = connection.publishDemand(complete);
    await new Promise((resolve) => setImmediate(resolve));
    expect(semantic.demands).toEqual([]);
    await connection.publishCompleted(completion(route!));

    await expect(Promise.all([demandStart, demandComplete])).resolves.toEqual([true, true]);
    expect(semantic.demands).toEqual([
      { ...start, conversationId: 'thread' },
      { ...complete, conversationId: 'thread' },
    ]);
  });

  it('notes a slow demand before completion correlation and promotes it after verification', async () => {
    const semantic = semanticService();
    let resolveCorrelation!: (value: { conversationId: string; cwd: string }) => void;
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      correlateCompletion: () => new Promise((resolve) => { resolveCorrelation = resolve; }),
      semanticConfig,
      semanticService: semantic.service,
    });
    bridges.push(bridge);
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);
    const start: Extract<ProxyDemandEvent, { phase: 'start' }> = {
      phase: 'start', requestId: 'slow-call', sourceEventId: 'slow-call',
      ownerInstanceId: connection.ownerId, routeId: route!.routeId, generation: route!.generation,
      server: route!.upstreamServer, tool: route!.upstreamTool, args: { path: '/slow' }, startedAt: 1,
    };

    await expect(connection.publishDemand(start)).resolves.toBe(true);
    expect(semantic.pendingDemands).toEqual([start]);
    expect(semantic.demands).toEqual([]);
    await connection.publishCompleted(completion(route!, {
      eventId: 'slow-call', args: { path: '/slow' }, startedAt: 1, completedAt: 100,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(semantic.demands).toEqual([]);
    resolveCorrelation({ conversationId: 'thread', cwd: '/work' });
    for (let attempt = 0; attempt < 20 && semantic.demands.length === 0; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(semantic.demands).toEqual([{ ...start, conversationId: 'thread' }]);
    expect(semantic.censoredDemands).toEqual([]);
  });

  it('invalidates an in-flight judgment when a new prompt changes semantic context', async () => {
    const semantic = semanticService();
    let resolveReply!: (reply: SemanticRankingReply) => void;
    semantic.service.judgeCandidates = (request) => new Promise((resolve) => {
      resolveReply = resolve;
      semantic.judged.push(request);
    });
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      correlateCompletion: () => ({ conversationId: 'thread', cwd: '/work' }),
      semanticConfig,
      semanticService: semantic.service,
    });
    bridges.push(bridge);
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);
    await connection.publishCompleted(completion(route!));
    const request = semanticRequest(route!);
    const pending = connection.judgeCandidates(request);
    for (let attempt = 0; attempt < 20 && semantic.judged.length === 0; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const revision = connection.semanticRevision();

    expect(bridge.publishObservation({
      context,
      eventId: 'new-task',
      observedAt: 101,
      kind: 'prompt',
      text: 'inspect another file',
    })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(connection.semanticRevision()).toBeGreaterThan(revision);
    resolveReply({
      protocolVersion: 1,
      requestId: request.requestId,
      batchId: request.batchId,
      sourceEventId: request.sourceEventId,
      ownerInstanceId: request.ownerInstanceId,
      launchId: request.launchId,
      conversationId: 'thread',
      batchDigest: request.batchDigest,
      contextRevision: 1,
      model: semanticConfig.model,
      questionVersion: 'demand-v1',
      providerDurationMs: 10,
      scores: { 'candidate-1': 0.9 },
    });

    await expect(pending).resolves.toBeNull();
  });
});

describe('SessionBridge observer grouping', () => {
  it('delivers same-source candidates for one owner as one authorized group', async () => {
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      authorizeCandidate: async ({ candidate }) => {
        if (candidate.candidateId === 'slow') await new Promise((resolve) => setTimeout(resolve, 5));
        return { decision: 'allowed', permissionContext: `permission-${candidate.candidateId}` };
      },
    });
    bridges.push(bridge);
    const received: Array<Array<Candidate | import('../src/observerTypes.js').AuthorizedCandidate>> = [];
    const connection = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude',
      hostServerAlias: 'files',
      onCandidates: (batch) => received.push(batch),
    });
    owners.push(connection);
    const [route] = await connection.register([localRoute]);
    (bridge as unknown as { sessionPredictor: { observe(): Candidate[] } }).sessionPredictor.observe = () => [
      candidate(route!.routeId, route!.generation, { candidateId: 'slow', args: { path: '/one' } }),
      candidate(route!.routeId, route!.generation, { candidateId: 'fast', args: { path: '/two' } }),
    ];

    expect(bridge.publishObservation({
      context,
      eventId: 'group-source',
      observedAt: 100,
      kind: 'prompt',
      text: 'group fixture',
    })).toBe(true);
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(received[0]!.map((item) => 'candidate' in item ? item.candidate.candidateId : item.candidateId))
      .toEqual(['slow', 'fast']);
    const permissionContexts = received[0]!.map((item) => 'permissionContext' in item ? item.permissionContext : null);
    expect(new Set(permissionContexts).size).toBe(1);
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

  it('requires owner-bound completion ingress for wrapper tool results', async () => {
    const bridge = await start();
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);

    expect(await connection.publishObservation({
      context,
      eventId: 'unbound-completion',
      observedAt: 1,
      kind: 'tool-complete',
      routeId: route!.routeId,
      args: { path: '/a' },
      parsed: null,
      latencyMs: 4,
      ordered: true,
    })).toBe(false);
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

  it('clears predictor state on close and rejects later observations', async () => {
    const bridge = await start();
    const connection = await owner(bridge, 'files');
    const [route] = await connection.register([localRoute]);
    const observation = {
      context,
      eventId: 'before-close',
      observedAt: 1,
      kind: 'tool-complete' as const,
      routeId: route!.routeId,
      args: { path: '/a' },
      parsed: null,
      latencyMs: 4,
      ordered: true,
    };
    expect(bridge.publishObservation(observation)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    const predictor = (bridge as unknown as {
      sessionPredictor: { conversations: Map<string, unknown> };
    }).sessionPredictor;
    expect(predictor.conversations.size).toBe(1);

    await bridge.close();

    expect(predictor.conversations.size).toBe(0);
    expect(bridge.publishObservation({ ...observation, eventId: 'after-close' })).toBe(false);
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
  completions: import('../src/proxy.js').ProxySessionEvent[] = [];

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

  async publishCompleted(event: import('../src/proxy.js').ProxySessionEvent): Promise<boolean> {
    this.completions.push(event);
    return true;
  }
  async close(): Promise<void> {}
}

function proxyHarness(
  hostClient: 'claude' | 'codex',
  decision: () => HostPermissionDecision,
  mode: 'strict' | 'annotated' | 'off' = 'strict',
  now: () => number = () => 100,
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
    now,
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
  it('does not treat a launch permission grant as read-only evidence', async () => {
    const runtime = new FakeRuntime('claude', 'files');
    const proxy = new SpeculateProxy({
      mode: 'annotated', maxPredictionsPerTrigger: 3, log: 'off', servers: { upstream: {} },
    }, {
      session: {
        launchId: 'launch', hostClient: 'claude', hostServerAlias: 'files', runtime,
        predictionPolicy: { enabled: true, allowTools: ['write_file'], denyTools: [] },
      },
    });
    const tool = {
      name: 'write_file', inputSchema: localRoute.inputSchema, annotations: { readOnlyHint: false },
    };
    proxy.upstreams.set('upstream', {
      connected: true, transport: 'http', tools: [tool], callTool: async () => ({ content: [] }),
    } as unknown as Upstream);
    proxy.policy.updateTools('upstream', [tool]);
    (proxy as any).rebuildRoutes();

    const route = await readyRuntime(runtime);
    expect(route.readOnly).toBe(false);
    expect(proxy.policy.isAffirmativelyReadOnly('upstream', 'write_file')).toBe(false);
  });

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

  it('revokes queued, in-flight, and ready owner work after a tracking gap', async () => {
    const bridge = await start(() => 100);
    const runtime = await owner(bridge, 'files');
    const proxy = new SpeculateProxy({
      mode: 'strict', maxPredictionsPerTrigger: 3, log: 'off',
      servers: {
        queued: { allowTools: ['queued_read'] },
        inflight: { allowTools: ['inflight_read'] },
        ready: { allowTools: ['ready_read'] },
      },
    }, {
      now: () => 100,
      session: {
        launchId: 'launch', hostClient: 'claude', hostServerAlias: 'files', runtime,
        permissionContext: () => 'context', permissionGate: { check: () => 'allowed' },
      },
    });
    const calls = { queued: 0, inflight: 0, ready: 0 };
    let resolveInflight!: (result: { content: Array<{ type: 'text'; text: string }> }) => void;
    const pendingInflight = new Promise<{ content: Array<{ type: 'text'; text: string }> }>((resolve) => {
      resolveInflight = resolve;
    });
    for (const server of ['queued', 'inflight', 'ready'] as const) {
      const tool = {
        name: `${server}_read`,
        inputSchema: localRoute.inputSchema,
        annotations: { readOnlyHint: true },
      };
      proxy.upstreams.set(server, {
        connected: true,
        transport: 'http',
        tools: [tool],
        callTool: async () => {
          calls[server]++;
          if (server === 'inflight' && calls.inflight === 1) return pendingInflight;
          return { content: [{ type: 'text', text: `${server}-result-${calls[server]}` }] };
        },
      } as unknown as Upstream);
      proxy.policy.updateTools(server, [tool]);
    }
    (proxy as any).rebuildRoutes();
    for (let attempt = 0; attempt < 30 && (proxy as any).observedRoutes.size < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const registered = new Map(bridge.listRoutes().map((item) => [item.upstreamServer, item]));
    expect(proxy.budget.tryAcquire('queued')).toEqual({ ok: true });
    for (const server of ['queued', 'inflight', 'ready'] as const) {
      const route = registered.get(server)!;
      expect(bridge.submit(candidate(route.routeId, route.generation, {
        candidateId: `${server}-candidate`,
        sourceEventId: `${server}-event`,
        args: { path: `/${server}` },
      }))).toBe(true);
    }
    for (let attempt = 0; attempt < 30 && (calls.inflight < 1 || calls.ready < 1); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let attempt = 0; attempt < 30 && proxy.cache.size().ready < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(calls).toEqual({ queued: 0, inflight: 1, ready: 1 });
    expect(proxy.cache.size()).toEqual({ ready: 1, inFlight: 1 });

    expect(bridge.publishObservation({
      context,
      eventId: 'tracking-gap',
      observedAt: 100,
      kind: 'invalidate',
      routeIds: [],
      reason: 'observer-tracking-gap',
    })).toBe(true);
    for (let attempt = 0; attempt < 30 && (
      bridge.listRoutes().length > 0 ||
      proxy.cache.size().ready > 0 ||
      proxy.cache.size().inFlight > 0
    ); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(bridge.listRoutes()).toEqual([]);
    expect(proxy.cache.size()).toEqual({ ready: 0, inFlight: 0 });
    proxy.budget.release('queued');
    proxy.executor.drainServer('queued');
    expect(calls.queued).toBe(0);
    resolveInflight({ content: [{ type: 'text', text: 'stale-inflight' }] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxy.cache.lookup(canonicalKey('inflight', 'inflight_read', { path: '/inflight' })).outcome).toBe('miss');
    const readyResult = await (proxy as any).handleToolCall(
      { server: 'ready', tool: { name: 'ready_read', annotations: { readOnlyHint: true } }, exposed: 'ready_read' },
      { path: '/ready' },
      {},
    );
    expect(readyResult).toEqual({ content: [{ type: 'text', text: 'ready-result-2' }] });
    expect(calls.ready).toBe(2);
    expect(proxy.metrics.statsSnapshot().hits).toBe(0);
  });

  it('suspends routes and revokes ordinary queued, in-flight, and ready work around a native mutation', async () => {
    const bridge = await start(() => 100);
    const runtime = await owner(bridge, 'files');
    const proxy = new SpeculateProxy({
      mode: 'strict', maxPredictionsPerTrigger: 3, log: 'off',
      servers: {
        queued: { allowTools: ['queued_read'] },
        inflight: { allowTools: ['inflight_read'] },
        ready: { allowTools: ['ready_read'] },
      },
    }, {
      now: () => 100,
      session: {
        launchId: 'launch', hostClient: 'claude', hostServerAlias: 'files', runtime,
        permissionContext: () => 'context', permissionGate: { check: () => 'allowed' },
      },
    });
    const calls = { queued: 0, inflight: 0, ready: 0 };
    let resolveInflight!: (result: { content: Array<{ type: 'text'; text: string }> }) => void;
    const pendingInflight = new Promise<{ content: Array<{ type: 'text'; text: string }> }>((resolve) => {
      resolveInflight = resolve;
    });
    for (const server of ['queued', 'inflight', 'ready'] as const) {
      const tool = {
        name: `${server}_read`, inputSchema: localRoute.inputSchema, annotations: { readOnlyHint: true },
      };
      proxy.upstreams.set(server, {
        connected: true, transport: 'http', tools: [tool],
        callTool: async () => {
          calls[server]++;
          if (server === 'inflight' && calls.inflight === 1) return pendingInflight;
          return { content: [{ type: 'text', text: `${server}-result-${calls[server]}` }] };
        },
      } as unknown as Upstream);
      proxy.policy.updateTools(server, [tool]);
    }
    (proxy as any).rebuildRoutes();
    for (let attempt = 0; attempt < 30 && bridge.listRoutes().length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(proxy.budget.tryAcquire('queued')).toEqual({ ok: true });
    proxy.executor.submit((['queued', 'inflight', 'ready'] as const).map((server) => ({
      server, tool: `${server}_read`, args: { path: `/${server}` }, confidence: 1,
      ruleId: `baseline:${server}`, horizon: 'next' as const,
    })));
    for (let attempt = 0; attempt < 30 && (calls.inflight < 1 || calls.ready < 1); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let attempt = 0; attempt < 30 && proxy.cache.size().ready < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(calls).toEqual({ queued: 0, inflight: 1, ready: 1 });
    expect(proxy.cache.size()).toEqual({ ready: 1, inFlight: 1 });

    expect(bridge.publishObservation({
      context, eventId: 'native-write-start', observedAt: 100, kind: 'invalidate', routeIds: [],
      reason: 'native-mutation-start',
    })).toBe(true);
    for (let attempt = 0; attempt < 30 && (bridge.listRoutes().length > 0 || proxy.cache.size().ready > 0); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(bridge.listRoutes()).toEqual([]);
    expect(proxy.cache.size()).toEqual({ ready: 0, inFlight: 0 });
    proxy.budget.release('queued');
    proxy.executor.drainServer('queued');
    expect(calls.queued).toBe(0);
    resolveInflight({ content: [{ type: 'text', text: 'stale-inflight' }] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxy.cache.lookup(canonicalKey('inflight', 'inflight_read', { path: '/inflight' })).outcome).toBe('miss');

    expect(bridge.publishObservation({
      context, eventId: 'native-write-settle', observedAt: 100, kind: 'invalidate', routeIds: [],
      reason: 'native-mutation-settle',
    })).toBe(true);
    for (let attempt = 0; attempt < 30 && bridge.listRoutes().length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(bridge.listRoutes()).toHaveLength(3);
    const readyResult = await (proxy as any).handleToolCall(
      { server: 'ready', tool: { name: 'ready_read', annotations: { readOnlyHint: true } }, exposed: 'ready_read' },
      { path: '/ready' },
      {},
    );
    expect(readyResult).toEqual({ content: [{ type: 'text', text: 'ready-result-2' }] });
    expect(calls.ready).toBe(2);
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

  it('timestamps a cache-hit completion from the actual host call interval', async () => {
    let clock = 100;
    const h = proxyHarness('claude', () => 'allowed', 'strict', () => clock);
    const route = await readyRuntime(h.runtime);
    h.proxy.upstreams.get('upstream')!.callTool = async () => {
      clock = 500;
      return { content: [{ type: 'text', text: 'cached' }] };
    };
    h.runtime.deliver(candidate(route.routeId, route.generation));
    await new Promise((resolve) => setImmediate(resolve));
    clock = 1_000;

    await (h.proxy as any).handleToolCall(
      { server: 'upstream', tool: { name: 'read' }, exposed: 'read' },
      { path: '/a' },
      {},
    );

    expect(h.runtime.completions.at(-1)).toMatchObject({
      routeId: route.routeId,
      generation: route.generation,
      latencyMs: 400,
      startedAt: 1_000,
      completedAt: 1_000,
    });
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
