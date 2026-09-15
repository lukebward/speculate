import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { AddressInfo, createConnection, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startLlmProxy, type LlmProxy } from '../src/llmProxy.js';
import { claudeAdapter } from '../src/agentAdapters/claude.js';
import { codexAdapter } from '../src/agentAdapters/codex.js';
import { ObservationBudget } from '../src/observationBudget.js';
import type {
  AgentAdapter,
  AgentAdapterConnection,
  AgentAdapterRequestObserver,
  Observation,
} from '../src/observerTypes.js';

interface Call {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  aborted: boolean;
}

interface Upstream {
  baseUrl: string;
  calls: Call[];
  server: Server;
}

const proxies: LlmProxy[] = [];
const upstreams: Upstream[] = [];
const netServers: NetServer[] = [];

afterEach(async () => {
  await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.allSettled(upstreams.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.allSettled(netServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function prompt(id: string): Observation {
  return {
    kind: 'prompt',
    context: { launchId: 'launch', conversationId: 'thread', agent: 'claude', cwd: '/work' },
    eventId: id,
    observedAt: 1,
    text: id,
  };
}

function adapter(overrides: Partial<AgentAdapterRequestObserver> = {}): AgentAdapter {
  return {
    agent: 'claude',
    createConnection(): AgentAdapterConnection {
      return {
        startRequest() {
          return {
            observeRequestBody: () => [],
            observeResponseStart: () => [],
            observeResponseChunk: () => [],
            observeResponseEnd: () => [],
            abort: () => {},
            ...overrides,
          };
        },
        close() {},
      };
    },
    normalizeHook: () => [],
  };
}

async function listen(handler: Parameters<typeof createServer>[0], basePath = ''): Promise<Upstream> {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    const call: Call = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: Buffer.alloc(0),
      aborted: false,
    };
    calls.push(call);
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('aborted', () => { call.aborted = true; });
    request.on('end', () => { call.body = Buffer.concat(chunks); });
    handler?.(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const upstream = { baseUrl: `http://127.0.0.1:${port}${basePath}`, calls, server };
  upstreams.push(upstream);
  return upstream;
}

async function exchange(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  pauseMs?: number;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(input.url, {
      method: input.method ?? 'POST',
      headers: input.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
        if (input.pauseMs) {
          response.pause();
          setTimeout(() => response.resume(), input.pauseMs);
        }
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(input.body);
  });
}

describe('LLM HTTP relay', () => {
  it('bounds analysis across concurrent connections without changing forwarded traffic', async () => {
    const responseBody = Buffer.from('{"content":[],"stop_reason":"end_turn"}');
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(responseBody);
      }, 20));
    });
    const losses: number[] = [];
    const budget = new ObservationBudget(8 * 1024 * 1024 + 24 * 1024, (observedAt) => losses.push(observedAt));
    const analysisAdapter = claudeAdapter({
      contextForConversation: (conversationId) => ({
        launchId: 'launch', conversationId, agent: 'claude', cwd: '/work',
      }),
      routes: () => [],
      analysisBudget: budget,
    });
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: analysisAdapter,
      analysisBudget: budget,
      onObservation: () => {},
    });
    proxies.push(proxy);
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4_096) }], tools: [] }));
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => exchange({
      url: `${proxy.baseUrl}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': `thread-${index}`,
      },
      body,
    })));

    expect(results.every((result) => result.status === 200 && result.body.equals(responseBody))).toBe(true);
    expect(losses).toHaveLength(1);
    expect(budget.usedBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 24 * 1024);
    await proxy.close();
    analysisAdapter.close?.();
    expect(budget.usedBytes).toBe(0);
  });

  it('charges retained Codex HTTP responses to the shared connection aggregate', async () => {
    const responseBody = Buffer.from(JSON.stringify({ id: 'response', status: 'completed', output: [], padding: 'x'.repeat(4_096) }));
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(responseBody);
      }, 20));
    });
    const losses: number[] = [];
    const budget = new ObservationBudget(8 * 1024 * 1024 + 24 * 1024, (observedAt) => losses.push(observedAt));
    const analysisAdapter = codexAdapter({
      contextForConversation: (conversationId) => ({
        launchId: 'launch', conversationId, agent: 'codex', cwd: '/work',
      }),
      routes: () => [],
      analysisBudget: budget,
    });
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: analysisAdapter,
      analysisBudget: budget,
      onObservation: () => {},
    });
    proxies.push(proxy);
    const body = Buffer.from(JSON.stringify({ input: 'inspect', tools: [] }));
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => exchange({
      url: `${proxy.baseUrl}/v1/responses`,
      headers: { 'content-type': 'application/json', 'thread-id': `thread-${index}` },
      body,
    })));

    expect(results.every((result) => result.status === 200 && result.body.equals(responseBody))).toBe(true);
    expect(losses).toHaveLength(1);
    expect(budget.usedBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 24 * 1024);
    await proxy.close();
    analysisAdapter.close?.();
    expect(budget.usedBytes).toBe(0);
  });

  it('marks observer tracking lost when a response aborts before its boundary is observed', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('partial');
        response.destroy();
      });
    });
    const losses: number[] = [];
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: adapter(),
      onObservation: () => {},
      onObservationLoss: (observedAt) => losses.push(observedAt),
    });
    proxies.push(proxy);
    expect((await exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') })).status).toBe(502);
    await new Promise((resolve) => setImmediate(resolve));
    expect(losses.length).toBeGreaterThan(0);
  });

  it('preserves body bytes and end-to-end headers on a fixed base path', async () => {
    const responseBody = Buffer.from([0, 255, 1, 2, 3, 128]);
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(207, {
          'content-type': 'application/octet-stream',
          'x-provider-field': 'preserved',
          connection: 'x-remove',
          'x-remove': 'hop-by-hop',
        });
        response.end(responseBody);
      });
    }, '/gateway');
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);
    const requestBody = Buffer.from('{ "unknown" : [1,2], "text":"caf\u00e9" }');

    const result = await exchange({
      url: `${proxy.baseUrl}/v1/messages?beta=true`,
      headers: {
        authorization: 'Bearer synthetic-token',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fixture-beta',
        'x-unknown-field': 'preserved',
        connection: 'x-remove-request',
        'x-remove-request': 'hop-by-hop',
        'content-type': 'application/json',
      },
      body: requestBody,
    });

    expect(result.status).toBe(207);
    expect(result.body.equals(responseBody)).toBe(true);
    expect(result.headers['x-provider-field']).toBe('preserved');
    expect(result.headers['x-remove']).toBeUndefined();
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.path).toBe('/gateway/v1/messages?beta=true');
    expect(upstream.calls[0]!.body.equals(requestBody)).toBe(true);
    expect(upstream.calls[0]!.headers).toMatchObject({
      authorization: 'Bearer synthetic-token',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'fixture-beta',
      'x-unknown-field': 'preserved',
    });
    expect(upstream.calls[0]!.headers['x-remove-request']).toBeUndefined();
    expect(upstream.calls[0]!.headers.host).toBe(new URL(upstream.baseUrl).host);
  });

  it.each([
    ['HEAD', '/api/hello', 204],
    ['POST', '/v1/messages/count_tokens', 200],
    ['GET', '/v1/models?limit=5', 200],
    ['POST', '/provider/auxiliary/path?opaque=1', 200],
  ])('passes through %s %s without a route allowlist', async (method, path, status) => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(status, { 'x-path': request.url ?? '' }).end(method === 'HEAD' ? undefined : 'ok'));
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);

    const result = await exchange({ url: `${proxy.baseUrl}${path}`, method });

    expect(result.status).toBe(status);
    expect(result.headers['x-path']).toBe(path);
    expect(upstream.calls[0]?.path).toBe(path);
  });

  it.each([401, 429, 503])('forwards provider status %s and its response bytes', async (status) => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(status, { 'retry-after': '1' }).end(`error-${status}`));
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);

    const result = await exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') });

    expect(result).toMatchObject({ status, body: Buffer.from(`error-${status}`) });
    expect(result.headers['retry-after']).toBe('1');
  });

  it('does not let an absolute-form request target select another origin', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.end('unexpected'));
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);

    const result = await exchange({ url: `${proxy.baseUrl}/http://example.invalid/v1/messages`, body: Buffer.from('{}') });

    expect(result.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('does not follow provider redirects or forward credentials to their target', async () => {
    const redirectTarget = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.end('credential leak'));
    });
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(307, { location: `${redirectTarget.baseUrl}/elsewhere` }).end('redirect'));
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);

    const result = await exchange({
      url: `${proxy.baseUrl}/v1/messages`,
      headers: { authorization: 'Bearer synthetic-token' },
      body: Buffer.from('{}'),
    });

    expect(result.status).toBe(307);
    expect(result.body.toString()).toBe('redirect');
    expect(redirectTarget.calls).toHaveLength(0);
  });

  it('forwards available bytes while observer callbacks throw or never settle', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('first');
        setTimeout(() => response.write('second'), 10);
        setTimeout(() => response.end('third'), 20);
      });
    });
    const seen: string[] = [];
    let callbacks = 0;
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: adapter({
        observeResponseChunk(chunk) {
          return [prompt(Buffer.from(chunk).toString())];
        },
      }),
      onObservation(observation) {
        callbacks++;
        seen.push(observation.eventId);
        if (callbacks === 1) throw new Error('observer failed');
        if (callbacks === 2) return Promise.reject(new Error('async observer failed'));
        return new Promise<void>(() => {});
      },
    });
    proxies.push(proxy);

    const result = await Promise.race([
      exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay was delayed')), 500)),
    ]);

    expect(result.body.toString()).toBe('firstsecondthird');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual(['first', 'second', 'third']);
  });

  it('drains completed observation jobs after a normal non-keep-alive response', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(200, { 'content-type': 'text/event-stream' }).end('complete'));
    });
    let connectionClosed = false;
    const base = adapter({
      observeResponseEnd: () => connectionClosed ? [] : [prompt('completed-before-close')],
    });
    const lifecycleAdapter: AgentAdapter = {
      ...base,
      createConnection() {
        const connection = base.createConnection();
        return {
          ...connection,
          close() {
            connectionClosed = true;
            connection.close();
          },
        };
      },
    };
    const seen: string[] = [];
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: lifecycleAdapter,
      onObservation: (observation) => { seen.push(observation.eventId); },
    });
    proxies.push(proxy);

    const result = await exchange({
      url: `${proxy.baseUrl}/v1/messages`,
      headers: { connection: 'close' },
      body: Buffer.from('{}'),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.body.toString()).toBe('complete');
    expect(seen).toContain('completed-before-close');
    expect(connectionClosed).toBe(true);
  });

  it('bounds unresolved observer callbacks by count', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    });
    let callbacks = 0;
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: adapter({ observeResponseEnd: () => Array.from({ length: 100 }, (_, index) => prompt(`event-${index}`)) }),
      onObservation() {
        callbacks++;
        return new Promise<void>(() => {});
      },
    });
    proxies.push(proxy);

    expect((await exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') })).body.toString()).toBe('{}');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(callbacks).toBe(32);
  });

  it('bounds unresolved observer callbacks by retained bytes', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    });
    let callbacks = 0;
    const large = 'x'.repeat(1024 * 1024);
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: adapter({ observeResponseEnd: () => Array.from({ length: 16 }, (_, index) => ({ ...prompt(`event-${index}`), text: large })) }),
      onObservation() {
        callbacks++;
        return new Promise<void>(() => {});
      },
    });
    proxies.push(proxy);

    await exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(callbacks).toBeGreaterThan(0);
    expect(callbacks).toBeLessThanOrEqual(8);
  });

  it('releases rejected observation requests on a persistent connection', async () => {
    const requestCount = 3;
    let forwardedCount = 0;
    let resolveForwarded = (): void => {};
    const forwarded = new Promise<void>((resolve) => { resolveForwarded = resolve; });
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.end('{}');
        forwardedCount++;
        if (forwardedCount === requestCount) resolveForwarded();
      });
    });
    const aborted = new Set<number>();
    let resolveRejected = (): void => {};
    const rejected = new Promise<void>((resolve) => { resolveRejected = resolve; });
    const base = adapter();
    const trackingAdapter: AgentAdapter = {
      ...base,
      createConnection() {
        const connection = base.createConnection();
        return {
          ...connection,
          startRequest(request) {
            const observer = connection.startRequest(request);
            if (!observer) return null;
            const id = Number(new URL(request.path, 'http://relay').searchParams.get('request'));
            return {
              ...observer,
              abort() {
                aborted.add(id);
                if (aborted.size === requestCount) resolveRejected();
                observer.abort();
              },
            };
          },
        };
      },
    };
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: trackingAdapter,
      onObservation: () => {},
      analysisBudget: new ObservationBudget(600),
    });
    proxies.push(proxy);
    const { port } = new URL(proxy.baseUrl);
    const socket = createConnection(Number(port), '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.resume();
    const requests = Array.from({ length: requestCount }, (_, index) =>
      `POST /v1/messages?request=${index} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}`
    ).join('');
    await new Promise<void>((resolve, reject) => socket.write(requests, (error) => error ? reject(error) : resolve()));
    await Promise.all([forwarded, rejected]);

    expect(upstream.calls).toHaveLength(requestCount);
    expect([...aborted].sort((left, right) => left - right)).toEqual([0, 1, 2]);
    expect(proxy.debugObservationState().partialRequests).toBe(0);
    socket.destroy();
  });

  it('drops malformed adapter output without affecting the response', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.end('ok'));
    });
    const seen: Observation[] = [];
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: adapter({
        observeResponseEnd: () => [
          { kind: 'prompt', text: 'missing envelope' } as Observation,
          prompt('valid'),
        ],
      }),
      onObservation: (observation) => { seen.push(observation); },
    });
    proxies.push(proxy);

    const result = await exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.body.toString()).toBe('ok');
    expect(seen.map((observation) => observation.eventId)).toEqual(['valid']);
  });

  it('drops oversized observation copies while forwarding the complete request', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.end('ok'));
    });
    let observed = false;
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      adapter: adapter({ observeRequestBody: () => { observed = true; return []; } }),
    });
    proxies.push(proxy);
    const body = Buffer.alloc(2 * 1024 * 1024 + 1, 120);

    const result = await exchange({ url: `${proxy.baseUrl}/v1/messages`, body });

    expect(result.body.toString()).toBe('ok');
    expect(upstream.calls[0]!.body.equals(body)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed).toBe(false);
  });

  it('preserves a large response for a slow downstream reader', async () => {
    const body = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.end(body));
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);

    const result = await exchange({
      url: `${proxy.baseUrl}/v1/messages`,
      body: Buffer.from('{}'),
      pauseMs: 1,
    });

    expect(result.body.equals(body)).toBe(true);
  });

  it('propagates downstream cancellation to the active provider request', async () => {
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('first');
        response.on('close', () => {
          if (!response.writableEnded) resolveAborted();
        });
        setTimeout(() => { if (!response.destroyed) response.end('late'); }, 200);
      });
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${proxy.baseUrl}/v1/messages`, { method: 'POST' }, (response) => {
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
      request.end('{}');
    });

    await expect(Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('provider request remained active')), 500)),
    ])).resolves.toBeUndefined();
  });

  it('settles a paused upload when the provider disconnects before drain', async () => {
    const provider = createNetServer((socket) => {
      socket.pause();
      setTimeout(() => socket.destroy(), 30);
    });
    netServers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const { port: providerPort } = provider.address() as AddressInfo;
    const proxy = await startLlmProxy({
      upstreamBaseUrl: `http://127.0.0.1:${providerPort}`,
      adapter: adapter(),
    });
    proxies.push(proxy);
    const { port: proxyPort } = new URL(proxy.baseUrl);

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(Number(proxyPort), '127.0.0.1');
      const total = 32 * 1024 * 1024;
      const chunk = Buffer.alloc(64 * 1024, 120);
      let sent = 0;
      let response = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`upload remained paused after ${sent} of ${total} bytes`));
      }, 2_000);
      const finish = () => {
        if (sent !== total || !response.includes('502 Bad Gateway')) return;
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      };
      const write = () => {
        while (sent < total) {
          const size = Math.min(chunk.byteLength, total - sent);
          sent += size;
          if (!socket.write(size === chunk.byteLength ? chunk : chunk.subarray(0, size))) {
            socket.once('drain', write);
            return;
          }
        }
        finish();
      };
      socket.on('connect', () => {
        socket.write(`POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${total}\r\nConnection: keep-alive\r\n\r\n`);
        write();
      });
      socket.on('data', (data) => {
        response += data.toString('latin1');
        finish();
      });
      socket.on('error', reject);
    });
  }, 5_000);

  it('surfaces an abrupt provider disconnect and closes active connections', async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('partial');
        setTimeout(() => response.socket!.destroy(), 10);
      });
    });
    let closed = 0;
    const base = adapter();
    const tracking: AgentAdapter = {
      ...base,
      createConnection() {
        const connection = base.createConnection();
        return { ...connection, close() { closed++; connection.close(); } };
      },
    };
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: tracking });
    proxies.push(proxy);

    await expect(exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') })).rejects.toThrow();
    await proxy.close();
    proxies.splice(proxies.indexOf(proxy), 1);

    expect(closed).toBe(1);
  });

  it('closes a request that is active during relay shutdown', async () => {
    const upstream = await listen((request) => request.resume());
    const proxy = await startLlmProxy({ upstreamBaseUrl: upstream.baseUrl, adapter: adapter() });
    proxies.push(proxy);
    const pending = exchange({ url: `${proxy.baseUrl}/v1/messages`, body: Buffer.from('{}') }).catch(() => null);
    while (upstream.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(Promise.race([
      proxy.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('relay close timed out')), 500)),
    ])).resolves.toBeUndefined();
    proxies.splice(proxies.indexOf(proxy), 1);
    await pending;
  });
});
