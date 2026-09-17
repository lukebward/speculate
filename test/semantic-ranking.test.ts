import { describe, expect, it, vi } from 'vitest';
import { JevProvider, JevProviderError } from '../src/semanticProvider.js';
import { SemanticRankingService } from '../src/semanticService.js';
import type {
  SemanticCandidateProjection,
  SemanticRankingConfig,
  SemanticRankingRequest,
  VerifiedSemanticContext,
} from '../src/semanticTypes.js';

const context: VerifiedSemanticContext = {
  launchId: 'launch',
  conversationId: 'conversation',
  revision: 3,
  task: 'Explain why authentication failed.',
  workspace: '<workspace>',
  recentCalls: [],
};

function candidate(id: string, args: Record<string, unknown>): SemanticCandidateProjection {
  return {
    id,
    routeId: `route-${id}`,
    generation: 1,
    server: 'workspace',
    tool: 'read_file',
    args,
    baselineScore: 50,
    conservativeLatencyMs: 100,
    effectiveTtlMs: 10_000,
  };
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('JevProvider', () => {
  it('batches one explicit Noul question per candidate against the fixed endpoint', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return response({
        model: 'jev-1.13.0',
        answers: {
          q0: { type: 'noul', noul: 0.8 },
          q1: { type: 'noul', noul: 0.2 },
        },
        usage: { input_tokens: 20, output_tokens: 4 },
      });
    });
    const provider = new JevProvider({ apiKey: 'bridge-only-key', model: 'jev-1.13.0', fetch });

    const result = await provider.judge({
      context,
      candidates: [candidate('opaque-a', { path: 'src/auth.ts' }), candidate('opaque-b', { path: 'README.md' })],
      windowsMs: [10_000, 5_000],
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(requestUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual({
      Authorization: 'Bearer bridge-only-key',
      'Content-Type': 'application/json',
    });
    const payload = JSON.parse(String(requestInit?.body)) as Record<string, any>;
    expect(payload.model).toBe('jev-1.13.0');
    expect(payload.state).toEqual({
      task: context.task,
      workspace: '<workspace>',
      recentCalls: [],
      candidates: {
        c0: { server: 'workspace', tool: 'read_file', args: { path: 'src/auth.ts' }, windowMs: 10_000 },
        c1: { server: 'workspace', tool: 'read_file', args: { path: 'README.md' }, windowMs: 5_000 },
      },
    });
    expect(payload.questions.q0).toMatchObject({
      type: 'noul',
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
    expect(payload.questions.q0.instructions).toContain('`candidates.c0`');
    expect(payload.questions.q1.instructions).toContain('`candidates.c1`');
    expect(result).toEqual({
      model: 'jev-1.13.0',
      scores: { 'opaque-a': 0.8, 'opaque-b': 0.2 },
      tokenUsage: { input: 20, output: 4 },
      durationMs: expect.any(Number),
    });
  });

  it.each([
    [{ model: 'other', answers: { q0: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }, 'model'],
    [{ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }, 'question'],
    [{ model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: 0.5 }, q1: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }, 'question'],
    [{ model: 'jev-1.13.0', answers: { q0: { type: 'choice', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }, 'answer'],
    [{ model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: Number.NaN } }, usage: { input_tokens: 1, output_tokens: 1 } }, 'answer'],
    [{ model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: 1.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }, 'answer'],
  ])('rejects an invalid complete response (%s)', async (body, reason) => {
    const provider = new JevProvider({
      apiKey: 'key',
      model: 'jev-1.13.0',
      fetch: async () => response(body),
    });
    await expect(provider.judge({
      context,
      candidates: [candidate('opaque-a', {})],
      windowsMs: [1_000],
    })).rejects.toThrow(reason);
  });

  it('bounds the response while streaming and never includes provider error bodies', async () => {
    const oversized = new JevProvider({
      apiKey: 'key',
      model: 'jev-1.13.0',
      fetch: async () => response('x'.repeat(32 * 1024 + 1)),
    });
    await expect(oversized.judge({
      context,
      candidates: [candidate('opaque-a', {})],
      windowsMs: [1_000],
    })).rejects.toThrow(/response exceeds/i);

    const failed = new JevProvider({
      apiKey: 'key',
      model: 'jev-1.13.0',
      fetch: async () => response('provider-secret-detail', { status: 401 }),
    });
    let message = '';
    try {
      await failed.judge({ context, candidates: [candidate('opaque-a', {})], windowsMs: [1_000] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('401');
    expect(message).not.toContain('provider-secret-detail');
  });

  it('dispatches once and propagates cancellation without retrying', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const provider = new JevProvider({ apiKey: 'key', model: 'jev-1.13.0', fetch });
    const controller = new AbortController();
    const pending = provider.judge({
      context,
      candidates: [candidate('opaque-a', {})],
      windowsMs: [1_000],
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honors delta and HTTP-date Retry-After values without reading the error body', async () => {
    for (const [header, expected] of [
      ['400', 300_000],
      ['Thu, 01 Jan 1970 00:02:00 GMT', 20_000],
    ] as const) {
      const provider = new JevProvider({
        apiKey: 'key',
        model: 'jev-1.13.0',
        now: () => 100_000,
        fetch: async () => response('private-error', {
          status: 429,
          headers: { 'retry-after': header },
        }),
      });
      let caught: unknown;
      try {
        await provider.judge({ context, candidates: [candidate('opaque-a', {})], windowsMs: [1_000] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(JevProviderError);
      expect((caught as JevProviderError).retryAfterMs).toBe(expected);
    }
  });

  it('safely returns an opaque candidate ID that names an object prototype property', async () => {
    const provider = new JevProvider({
      apiKey: 'key',
      model: 'jev-1.13.0',
      fetch: async () => response({
        model: 'jev-1.13.0',
        answers: { q0: { type: 'noul', noul: 0.7 } },
      }),
    });
    const result = await provider.judge({
      context,
      candidates: [candidate('__proto__', {})],
      windowsMs: [1_000],
    });
    expect(Object.hasOwn(result.scores, '__proto__')).toBe(true);
    expect(result.scores['__proto__']).toBe(0.7);
  });

  it('rejects an unpinned model alias before dispatch', () => {
    expect(() => new JevProvider({
      apiKey: 'key',
      model: 'jev-latest',
      fetch: vi.fn(),
    })).toThrow(/pinned model/i);
  });

  it('rejects duplicate response keys before JSON parsing can hide them', async () => {
    const provider = new JevProvider({
      apiKey: 'key',
      model: 'jev-1.13.0',
      fetch: async () => response(
        '{"model":"jev-1.13.0","answers":{"q0":{"type":"noul","noul":0.1},"q0":{"type":"noul","noul":0.9}}}',
      ),
    });
    await expect(provider.judge({
      context,
      candidates: [candidate('a', {})],
      windowsMs: [1_000],
    })).rejects.toThrow(/duplicate/i);
  });
});

const rankingConfig: SemanticRankingConfig = {
  mode: 'rank',
  model: 'jev-1.13.0',
  timeoutMs: 150,
  maxCandidates: 16,
  horizonMs: 30_000,
  maxRequestsPerMinute: 60,
  maxRequestsPerSession: 1_000,
};

function rankingRequest(overrides: Partial<SemanticRankingRequest> = {}): SemanticRankingRequest {
  return {
    protocolVersion: 1,
    requestId: 'request',
    batchId: 'batch',
    sourceEventId: 'source',
    ownerInstanceId: 'owner',
    launchId: 'launch',
    conversationId: 'conversation',
    createdAt: 1_000,
    deadlineAt: 1_150,
    batchDigest: 'digest',
    candidates: [candidate('a', { path: 'a' })],
    ...overrides,
  };
}

function readyService(fetch: typeof globalThis.fetch, options: {
  config?: SemanticRankingConfig;
  now?: () => number;
  apiKey?: string;
} = {}): SemanticRankingService {
  const service = new SemanticRankingService({
    config: options.config ?? rankingConfig,
    apiKey: options.apiKey ?? 'key',
    launchId: 'launch',
    fetch,
    now: options.now ?? (() => 1_000),
  });
  service.observePrompt({
    launchId: 'launch', conversationId: 'conversation', task: 'read the relevant file',
    workspace: '/workspace', revision: 1,
  });
  return service;
}

describe('SemanticRankingService', () => {
  it('makes no provider request or semantic state in off mode or without a bridge key', async () => {
    const fetch = vi.fn();
    const off = new SemanticRankingService({
      config: { ...rankingConfig, mode: 'off' }, apiKey: 'key', launchId: 'launch', fetch,
    });
    expect(off.observePrompt({
      launchId: 'launch', conversationId: 'conversation', task: 'task', revision: 1,
    })).toBe(false);
    await expect(off.judgeCandidates(rankingRequest())).resolves.toBeNull();

    const missingKey = readyService(fetch as typeof globalThis.fetch, { apiKey: '' });
    await expect(missingKey.judgeCandidates(rankingRequest())).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds a validated reply to immutable request and verified context identity', async () => {
    let payload: Record<string, any> | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return response({
        model: 'jev-1.13.0',
        answers: { q0: { type: 'noul', noul: 0.75 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    });
    const service = readyService(fetch as typeof globalThis.fetch);
    const mutableArgs = { path: '/workspace/a' };
    const mutableRequest = rankingRequest({
      candidates: [
        { ...candidate('a', mutableArgs), toolDescription: 'Read one workspace file' },
        candidate('secret', { token: 'private-value' }),
      ],
    });
    const pending = service.judgeCandidates(mutableRequest);
    mutableArgs.path = '/workspace/changed';
    (mutableRequest as { sourceEventId: string }).sourceEventId = 'changed-source';
    (mutableRequest as { batchDigest: string }).batchDigest = 'changed-digest';

    await expect(pending).resolves.toEqual({
      protocolVersion: 1,
      requestId: 'request',
      batchId: 'batch',
      sourceEventId: 'source',
      ownerInstanceId: 'owner',
      launchId: 'launch',
      conversationId: 'conversation',
      batchDigest: 'digest',
      contextRevision: 1,
      model: 'jev-1.13.0',
      questionVersion: 'exact-demand-v1',
      providerDurationMs: 0,
      tokenUsage: { input: 10, output: 2 },
      scores: { a: 0.75 },
    });
    expect(payload?.state.candidates).toEqual({
      c0: {
        server: 'workspace', tool: 'read_file', description: 'Read one workspace file',
        args: { path: '<workspace>/a' }, windowMs: 10_000,
      },
    });
    expect(service.report()).toMatchObject({
      requestsDispatched: 1, successes: 1, failures: 0, inputTokens: 10, outputTokens: 2,
      model: 'jev-1.13.0', questionVersion: 'exact-demand-v1',
      candidatesJudged: 1, candidatesBypassed: 1,
    });
  });

  it('omits candidates whose server or tool label contains credential material', async () => {
    let payload: Record<string, any> | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return response({
        model: 'jev-1.13.0',
        answers: { q0: { type: 'noul', noul: 0.6 } },
      });
    });
    const service = readyService(fetch as typeof globalThis.fetch, { apiKey: 'bridge-only-key' });
    const unsafeServer = { ...candidate('server-secret', {}), server: 'bridge-only-key' };
    const unsafeTool = { ...candidate('tool-secret', {}), tool: 'Bearer abcdefghijklmnop' };
    const reply = await service.judgeCandidates(rankingRequest({
      candidates: [candidate('safe', { path: 'safe' }), unsafeServer, unsafeTool],
    }));

    expect(reply?.scores).toEqual({ safe: 0.6 });
    expect(JSON.stringify(payload)).not.toContain('bridge-only-key');
    expect(JSON.stringify(payload)).not.toContain('abcdefghijklmnop');
    expect(service.report()).toMatchObject({ candidatesJudged: 1, candidatesBypassed: 2 });
  });

  it('falls back for missing context, wrong launch, expired deadline and exhausted budgets', async () => {
    const fetch = vi.fn(async () => response({
      model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: 0.5 } },
    }));
    const service = readyService(fetch as typeof globalThis.fetch, {
      config: { ...rankingConfig, maxRequestsPerSession: 1 },
    });
    await expect(service.judgeCandidates(rankingRequest({ conversationId: 'missing' }))).resolves.toBeNull();
    await expect(service.judgeCandidates(rankingRequest({ launchId: 'other' }))).resolves.toBeNull();
    await expect(service.judgeCandidates(rankingRequest({ deadlineAt: 999 }))).resolves.toBeNull();
    await expect(service.judgeCandidates(rankingRequest())).resolves.not.toBeNull();
    await expect(service.judgeCandidates(rankingRequest({ requestId: 'two', batchId: 'two' }))).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(service.report().fallbacks).toMatchObject({
      'no-context': 1, 'wrong-launch': 1, deadline: 1, budget: 1,
    });
  });

  it('trims oversized requests by baseline utility while preserving stable order', async () => {
    let payload: Record<string, any> | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return response({
        model: 'jev-1.13.0',
        answers: { q0: { type: 'noul', noul: 0.5 } },
      });
    });
    const service = readyService(fetch as typeof globalThis.fetch);
    const lowUtility = {
      ...candidate('high-score', { text: 'a'.repeat(28_000) }),
      baselineScore: 0.9,
      conservativeLatencyMs: 10,
    };
    const highUtility = {
      ...candidate('high-utility', { text: 'b'.repeat(28_000) }),
      baselineScore: 0.2,
      conservativeLatencyMs: 1_000,
    };

    const reply = await service.judgeCandidates(rankingRequest({ candidates: [lowUtility, highUtility] }));

    expect(Object.values(payload?.state.candidates ?? {})).toEqual([
      expect.objectContaining({ args: { text: 'b'.repeat(28_000) } }),
    ]);
    expect(reply?.scores).toEqual({ 'high-utility': 0.5 });
  });

  it('uses one deadline, aborts the request and never retries', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const service = readyService(fetch as typeof globalThis.fetch, { now: Date.now });
    const now = Date.now();
    await expect(service.judgeCandidates(rankingRequest({ createdAt: now, deadlineAt: now + 5 })))
      .resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(service.report()).toMatchObject({ requestsDispatched: 1, failures: 1 });
  });

  it('opens a shared cooldown after three failures and honors Retry-After', async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => response('unavailable', { status: 500 }));
    const service = readyService(fetch as typeof globalThis.fetch, { now: () => now });
    for (let index = 0; index < 3; index++) {
      await service.judgeCandidates(rankingRequest({
        requestId: `request-${index}`, batchId: `batch-${index}`, deadlineAt: now + 100,
      }));
    }
    await expect(service.judgeCandidates(rankingRequest({ requestId: 'blocked', deadlineAt: now + 100 })))
      .resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    now += 30_001;
    await service.judgeCandidates(rankingRequest({ requestId: 'after', deadlineAt: now + 100 }));
    expect(fetch).toHaveBeenCalledTimes(4);

    const limitedFetch = vi.fn(async () => response('', {
      status: 429,
      headers: { 'retry-after': '120' },
    }));
    const limited = readyService(limitedFetch as typeof globalThis.fetch, { now: () => now });
    await limited.judgeCandidates(rankingRequest({ deadlineAt: now + 100 }));
    await limited.judgeCandidates(rankingRequest({ requestId: 'blocked', deadlineAt: now + 100 }));
    expect(limitedFetch).toHaveBeenCalledOnce();
  });

  it('supersedes active rank work per conversation while shadow bypasses overlap', async () => {
    const signals: AbortSignal[] = [];
    const rankFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init!.signal!);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const rank = readyService(rankFetch as typeof globalThis.fetch);
    const first = rank.judgeCandidates(rankingRequest());
    const second = rank.judgeCandidates(rankingRequest({ requestId: 'new', batchId: 'new' }));
    await expect(first).resolves.toBeNull();
    expect(signals[0]?.aborted).toBe(true);
    rank.shutdown();
    await expect(second).resolves.toBeNull();

    const shadowFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const shadow = readyService(shadowFetch as typeof globalThis.fetch, {
      config: { ...rankingConfig, mode: 'shadow' },
    });
    const shadowFirst = shadow.judgeCandidates(rankingRequest());
    await expect(shadow.judgeCandidates(rankingRequest({ requestId: 'new' }))).resolves.toBeNull();
    expect(shadowFetch).toHaveBeenCalledOnce();
    shadow.shutdown();
    await expect(shadowFirst).resolves.toBeNull();
  });

  it('labels demand that arrives during provider inference against the original horizon', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(async () => await new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const service = readyService(fetch as typeof globalThis.fetch, {
      config: { ...rankingConfig, mode: 'shadow' },
    });
    const pending = service.judgeCandidates(rankingRequest({
      candidates: [candidate('a', { path: '/workspace/a' })],
    }));
    await service.publishDemand({
      phase: 'start', requestId: 'real', sourceEventId: 'real-source', ownerInstanceId: 'owner',
      routeId: 'route-a', generation: 1, server: 'workspace', tool: 'read_file', args: { path: '/workspace/a' },
      startedAt: 1_050, conversationId: 'conversation',
    });
    resolveFetch(response({
      model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: 0.9 } },
    }));
    await pending;
    expect(service.report().evaluation).toMatchObject({ judged: 1, positives: 1 });
  });
});
