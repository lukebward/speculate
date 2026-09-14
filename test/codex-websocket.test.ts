import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { codexAdapter } from '../src/agentAdapters/codex.js';
import { startLlmProxy, type LlmProxy } from '../src/llmProxy.js';
import type {
  AgentAdapter,
  AgentAdapterConnection,
  AgentAdapterWebSocketObserver,
  Observation,
  WebSocketMessage,
} from '../src/observerTypes.js';

interface Provider {
  baseUrl: string;
  server: Server;
  wss: WebSocketServer;
  upgrades: Array<{ path: string; headers: IncomingHttpHeaders }>;
  connections: WebSocket[];
}

const proxies: LlmProxy[] = [];
const providers: Provider[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.allSettled(providers.splice(0).map(async ({ server, wss, connections }) => {
    for (const socket of connections) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function emptyAdapter(webSocket?: AgentAdapterWebSocketObserver): AgentAdapter {
  return {
    agent: 'codex',
    createConnection(): AgentAdapterConnection {
      return {
        startRequest: () => null,
        ...(webSocket ? { startWebSocket: () => webSocket } : {}),
        close() {},
      };
    },
    normalizeHook: () => [],
  };
}

async function listenProvider(options: {
  basePath?: string;
  protocols?: string[];
  upgradeHeaders?: Record<string, string>;
  autoPong?: boolean;
} = {}): Promise<Provider> {
  const upgrades: Provider['upgrades'] = [];
  const connections: WebSocket[] = [];
  const protocols = options.protocols ?? [];
  const wss = new WebSocketServer({
    noServer: true,
    autoPong: options.autoPong ?? false,
    perMessageDeflate: false,
    handleProtocols(offered) {
      return protocols.find((protocol) => offered.has(protocol)) ?? false;
    },
  });
  wss.on('headers', (headers) => {
    for (const [name, value] of Object.entries(options.upgradeHeaders ?? {})) headers.push(`${name}: ${value}`);
  });
  wss.on('connection', (socket) => connections.push(socket));
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ path: request.url ?? '/', headers: request.headers });
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit('connection', webSocket, request));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const provider = {
    baseUrl: `http://127.0.0.1:${port}${options.basePath ?? ''}`,
    server,
    wss,
    upgrades,
    connections,
  };
  providers.push(provider);
  return provider;
}

async function openClient(url: string, protocols?: string[], headers?: Record<string, string>): Promise<WebSocket> {
  const socket = new WebSocket(url, protocols ?? [], {
    autoPong: false,
    perMessageDeflate: false,
    headers,
  });
  clients.push(socket);
  await once(socket, 'open');
  return socket;
}

function once<T extends unknown[]>(emitter: WebSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      emitter.off(event, onEvent);
      emitter.off('error', onError);
    };
    const onEvent = (...args: unknown[]) => {
      cleanup();
      resolve(args as T);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    emitter.once(event, onEvent);
    if (event !== 'error') emitter.once('error', onError);
  });
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

describe('LLM WebSocket relay', () => {
  it('preserves Codex HTTP model request and response bytes with custom-provider auth', async () => {
    const requestBody = Buffer.from('{ "model" : "gpt-synthetic-1", "input" : "café", "stream" : false }');
    const responseBody = Buffer.from([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125]);
    let providerBody = Buffer.alloc(0);
    let providerHeaders: IncomingHttpHeaders = {};
    let providerPath = '';
    const server = createServer((request, response) => {
      providerPath = request.url ?? '';
      providerHeaders = request.headers;
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        providerBody = Buffer.concat(chunks);
        response.writeHead(200, { 'content-type': 'application/json', 'x-provider-id': 'synthetic' });
        response.end(responseBody);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const providerPort = (server.address() as AddressInfo).port;
    const wss = new WebSocketServer({ noServer: true });
    providers.push({ baseUrl: '', server, wss, upgrades: [], connections: [] });
    const proxy = await startLlmProxy({
      upstreamBaseUrl: `http://127.0.0.1:${providerPort}/custom/openai`,
      adapter: emptyAdapter(),
    });
    proxies.push(proxy);

    const received = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = httpRequest(`${proxy.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-api-key',
          'content-type': 'application/json',
          'content-length': requestBody.byteLength,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      request.on('error', reject);
      request.end(requestBody);
    });

    expect(providerBody.equals(requestBody)).toBe(true);
    expect(providerPath).toBe('/custom/openai/v1/responses');
    expect(providerHeaders.authorization).toBe('Bearer synthetic-api-key');
    expect(providerHeaders['chatgpt-account-id']).toBeUndefined();
    expect(received).toEqual(expect.objectContaining({ status: 200, body: responseBody }));
    expect(received.headers['x-provider-id']).toBe('synthetic');
  });

  it('preserves native account routing, custom base paths, subprotocols, and ordered message payloads', async () => {
    const provider = await listenProvider({
      basePath: '/backend-api/codex',
      protocols: ['responses-v1'],
      upgradeHeaders: { 'x-provider-upgrade': 'preserved' },
    });
    const providerMessages: Array<{ data: Buffer; binary: boolean }> = [];
    provider.wss.on('connection', (socket) => {
      socket.on('message', (data, binary) => {
        providerMessages.push({ data: toBuffer(data), binary });
        if (providerMessages.length === 2) {
          socket.send(Buffer.from('server-text'), { binary: false });
          socket.send(Buffer.from([0, 255, 1, 128]), { binary: true });
        }
      });
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter() });
    proxies.push(proxy);
    const headersPromise = new Promise<IncomingMessage>((resolve) => {
      const socket = new WebSocket(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses?mode=fixture`, ['responses-v1', 'unused'], {
        autoPong: false,
        perMessageDeflate: false,
        headers: {
          authorization: 'Bearer synthetic-session-token',
          'chatgpt-account-id': 'acct_synthetic',
          'openai-beta': 'responses_websockets=fixture',
          'session-id': 'session_synthetic',
          'thread-id': 'thread_synthetic',
        },
      });
      clients.push(socket);
      socket.once('upgrade', resolve);
    });
    const client = clients.at(-1)!;
    await once(client, 'open');
    const upgrade = await headersPromise;
    const received: Array<{ data: Buffer; binary: boolean }> = [];
    client.on('message', (data, binary) => received.push({ data: toBuffer(data), binary }));

    client.send(Buffer.from('{"type":"response.create","model":"gpt-synthetic-1"}'), { binary: false });
    client.send(Buffer.from([4, 3, 2, 1]), { binary: true });
    const deadline = Date.now() + 1_000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(provider.upgrades).toHaveLength(1);
    expect(provider.upgrades[0]).toMatchObject({ path: '/backend-api/codex/responses?mode=fixture' });
    expect(provider.upgrades[0]!.headers).toMatchObject({
      authorization: 'Bearer synthetic-session-token',
      'chatgpt-account-id': 'acct_synthetic',
      'openai-beta': 'responses_websockets=fixture',
      'session-id': 'session_synthetic',
      'thread-id': 'thread_synthetic',
    });
    expect(provider.upgrades[0]!.headers.host).toBe(new URL(provider.baseUrl).host);
    expect(client.protocol).toBe('responses-v1');
    expect(upgrade.headers['x-provider-upgrade']).toBe('preserved');
    expect(providerMessages).toEqual([
      { data: Buffer.from('{"type":"response.create","model":"gpt-synthetic-1"}'), binary: false },
      { data: Buffer.from([4, 3, 2, 1]), binary: true },
    ]);
    expect(received).toEqual([
      { data: Buffer.from('server-text'), binary: false },
      { data: Buffer.from([0, 255, 1, 128]), binary: true },
    ]);
  });

  it('preserves a custom-provider API key without adding account routing', async () => {
    const provider = await listenProvider({ basePath: '/custom/openai' });
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter() });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`, [], {
      authorization: 'Bearer synthetic-api-key',
      'x-custom-provider': 'preserved',
    });

    expect(provider.upgrades).toHaveLength(1);
    expect(provider.upgrades[0]).toMatchObject({ path: '/custom/openai/responses' });
    expect(provider.upgrades[0]!.headers).toMatchObject({
      authorization: 'Bearer synthetic-api-key',
      'x-custom-provider': 'preserved',
    });
    expect(provider.upgrades[0]!.headers['chatgpt-account-id']).toBeUndefined();
    client.close();
  });

  it('keeps one upstream connection across continuation messages and forwards payloads larger than observation limits', async () => {
    const provider = await listenProvider();
    const received: Buffer[] = [];
    provider.wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        received.push(toBuffer(data));
        socket.send('ack');
      });
    });
    let observedMessages = 0;
    let aborted = 0;
    const observer: AgentAdapterWebSocketObserver = {
      observeResponseStart: () => [],
      observeClientMessage: () => { observedMessages++; return []; },
      observeServerMessage: () => [],
      abort: () => { aborted++; },
    };
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter(observer), onObservation: () => {} });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const acknowledgements: Buffer[] = [];
    client.on('message', (data) => acknowledgements.push(toBuffer(data)));
    const initial = Buffer.from('{"type":"response.create","input":"first"}');
    const continuation = Buffer.from('{"type":"response.create","previous_response_id":"resp-1","input":[]}');
    const large = Buffer.alloc(2 * 1024 * 1024 + 1, 120);

    client.send(initial);
    client.send(continuation);
    client.send(large);
    const deadline = Date.now() + 2_000;
    while (acknowledgements.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(provider.upgrades).toHaveLength(1);
    expect(received.map((body) => body.equals(initial) || body.equals(continuation) || body.equals(large))).toEqual([true, true, true]);
    expect(observedMessages).toBeLessThanOrEqual(2);
    expect(aborted).toBe(1);
  });

  it('continues the persistent transport after Codex analysis exhausts its retained-state budget', async () => {
    const provider = await listenProvider();
    const providerMessages: string[] = [];
    provider.wss.on('connection', (socket) => {
      socket.on('message', async (data) => {
        const message = toBuffer(data).toString();
        providerMessages.push(message);
        const request = JSON.parse(message) as { input?: string };
        if (request.input === 'saturate') {
          socket.send('{"type":"response.created","stream_id":"budget","response":{"id":"budget-response"}}');
          for (let index = 0; index < 70; index++) {
            socket.send(JSON.stringify({
              type: 'response.output_item.added', stream_id: 'budget', response_id: 'budget-response',
              item: { id: `item-${index}`, type: 'function_call', call_id: `call-${index}`, name: 'mcp__workspace__read_file', arguments: '' },
            }));
            socket.send(JSON.stringify({
              type: 'response.function_call_arguments.delta', stream_id: 'budget', response_id: 'budget-response',
              item_id: `item-${index}`, delta: 'x'.repeat(64 * 1024),
            }));
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          socket.send('{"type":"provider.marker","value":"budget-forwarded"}');
        } else {
          socket.send('{"type":"response.created","stream_id":"continued","response":{"id":"continued-response"}}');
          socket.send('{"type":"response.output_item.done","stream_id":"continued","response_id":"continued-response","item":{"type":"function_call","call_id":"continued-call","name":"mcp__workspace__read_file","arguments":"{\\"path\\":\\"/work/continued\\"}"}}');
          socket.send('{"type":"response.completed","stream_id":"continued","response":{"id":"continued-response","status":"completed"}}');
          socket.send('{"type":"provider.marker","value":"continuation-forwarded"}');
        }
      });
    });
    const observations: Observation[] = [];
    const inputSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    const adapter = codexAdapter({
      contextForConversation: (conversationId) => conversationId === 'thread-budget'
        ? { launchId: 'launch', conversationId, agent: 'codex', cwd: '/work' }
        : null,
      routes: () => [{
        routeId: 'workspace-read', generation: 1, instanceId: 'workspace-owner', hostClient: 'codex',
        hostServerAlias: 'workspace', exposedTool: 'read_file', upstreamServer: 'upstream', upstreamTool: 'read_file', inputSchema,
      }],
    });
    const proxy = await startLlmProxy({
      upstreamBaseUrl: provider.baseUrl,
      adapter,
      onObservation: (observation) => { observations.push(observation); },
    });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`, [], { 'thread-id': 'thread-budget' });
    const serverMessages: string[] = [];
    client.on('message', (data) => serverMessages.push(toBuffer(data).toString()));
    const tool = { type: 'function', name: 'mcp__workspace__read_file', parameters: inputSchema };

    client.send(JSON.stringify({ type: 'response.create', stream_id: 'budget', input: 'saturate', tools: [tool] }));
    let deadline = Date.now() + 2_000;
    while (!serverMessages.some((message) => message.includes('budget-forwarded')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    client.send(JSON.stringify({
      type: 'response.create', stream_id: 'continued', previous_response_id: 'budget-response', input: 'continue', tools: [tool],
    }));
    deadline = Date.now() + 2_000;
    while ((!serverMessages.some((message) => message.includes('continuation-forwarded')) ||
      !observations.some((observation) => observation.kind === 'stream-call' && observation.callId === 'continued-call')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(provider.connections).toHaveLength(1);
    expect(providerMessages).toHaveLength(2);
    expect(serverMessages.some((message) => message.includes('budget-forwarded'))).toBe(true);
    expect(serverMessages.some((message) => message.includes('continuation-forwarded'))).toBe(true);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read', callId: 'continued-call' }),
    ]));
  });

  it('preserves message order and completeness while the provider reader is paused', async () => {
    const provider = await listenProvider();
    const indexes: number[] = [];
    provider.wss.on('connection', (socket) => {
      socket.pause();
      setTimeout(() => socket.resume(), 40);
      socket.on('message', (data) => {
        indexes.push(toBuffer(data).readUInt32BE(0));
        if (indexes.length === 64) socket.send('complete');
      });
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter() });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const completed = once(client, 'message');

    for (let index = 0; index < 64; index++) {
      const message = Buffer.alloc(128 * 1024, index % 251);
      message.writeUInt32BE(index, 0);
      client.send(message, { binary: true });
    }
    await completed;

    expect(indexes).toEqual(Array.from({ length: 64 }, (_, index) => index));
  });

  it('forwards ping and pong control payloads without automatic duplicate replies', async () => {
    const provider = await listenProvider({ autoPong: false });
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter() });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const upstream = provider.connections[0]!;

    const upstreamPing = once<[Buffer]>(upstream, 'ping');
    client.ping('client-ping');
    expect((await upstreamPing)[0].toString()).toBe('client-ping');
    const clientPong = once<[Buffer]>(client, 'pong');
    upstream.pong('server-pong');
    expect((await clientPong)[0].toString()).toBe('server-pong');

    const clientPing = once<[Buffer]>(client, 'ping');
    upstream.ping('server-ping');
    expect((await clientPing)[0].toString()).toBe('server-ping');
    const upstreamPong = once<[Buffer]>(upstream, 'pong');
    client.pong('client-pong');
    expect((await upstreamPong)[0].toString()).toBe('client-pong');

    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('propagates provider close and abrupt error semantics', async () => {
    const provider = await listenProvider();
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter() });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const cleanClose = once<[number, Buffer]>(client, 'close');
    provider.connections[0]!.close(4001, 'provider-finished');
    const [code, reason] = await cleanClose;
    expect([code, reason.toString()]).toEqual([4001, 'provider-finished']);

    const second = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const abruptClose = once<[number]>(second, 'close');
    provider.connections[1]!.terminate();
    expect((await abruptClose)[0]).toBe(1006);
  });

  it('propagates client cancellation and releases its WebSocket observer', async () => {
    const provider = await listenProvider();
    let aborted = 0;
    const observer: AgentAdapterWebSocketObserver = {
      observeResponseStart: () => [],
      observeClientMessage: () => [],
      observeServerMessage: () => [],
      abort: () => { aborted++; },
    };
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter(observer), onObservation: () => {} });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const upstreamClose = once<[number, Buffer]>(provider.connections[0]!, 'close');

    client.close(4000, 'cancelled');

    const [code, reason] = await upstreamClose;
    expect([code, reason.toString()]).toEqual([4000, 'cancelled']);
    const deadline = Date.now() + 1_000;
    while (aborted === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(aborted).toBe(1);
  });

  it('settles a cancelled generation while the provider reader is backpressured', async () => {
    const provider = await listenProvider();
    provider.wss.on('connection', (socket) => {
      socket.pause();
      setTimeout(() => socket.resume(), 100);
    });
    const proxy = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter: emptyAdapter() });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    const upstreamClose = once<[number]>(provider.connections[0]!, 'close');

    for (let index = 0; index < 128; index++) client.send(Buffer.alloc(256 * 1024, index % 251), { binary: true });
    client.terminate();

    expect((await Promise.race([
      upstreamClose,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('provider connection stayed open')), 1_000)),
    ]))[0]).toBe(1006);
  });

  it('drains a completed observation message before normal socket teardown', async () => {
    const provider = await listenProvider();
    provider.wss.on('connection', (socket) => {
      socket.send('{"type":"response.completed","response":{"id":"resp-complete"}}');
      socket.close(1000, 'done');
    });
    let stopped = false;
    const observation: Observation = {
      kind: 'prompt',
      context: { launchId: 'launch', conversationId: 'thread', agent: 'codex', cwd: '/work' },
      eventId: 'completed-before-close',
      observedAt: 1,
      text: 'complete',
    };
    const observer: AgentAdapterWebSocketObserver = {
      observeResponseStart: () => [],
      observeClientMessage: () => [],
      observeServerMessage: () => stopped ? [] : [observation],
      abort: () => { stopped = true; },
    };
    const seen: Observation[] = [];
    const proxy = await startLlmProxy({
      upstreamBaseUrl: provider.baseUrl,
      adapter: emptyAdapter(observer),
      onObservation: (value) => { seen.push(value); },
    });
    proxies.push(proxy);
    const client = await openClient(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`);
    await once(client, 'close');
    const deadline = Date.now() + 1_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(seen.map((value) => value.eventId)).toEqual(['completed-before-close']);
    expect(stopped).toBe(true);
  });

  it('forwards failed upgrade status, headers, and payload without following redirects', async () => {
    const body = Buffer.from('{"error":"synthetic upgrade rejection"}');
    const targetCalls: string[] = [];
    const target = createServer((request, response) => {
      targetCalls.push(request.url ?? '/');
      response.end('unexpected');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as AddressInfo).port;
    providers.push({ baseUrl: '', server: target, wss: new WebSocketServer({ noServer: true }), upgrades: [], connections: [] });
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (_request, socket) => {
      socket.end([
        'HTTP/1.1 307 Temporary Redirect',
        `Location: http://127.0.0.1:${targetPort}/credential-target`,
        'X-Provider-Error: preserved',
        `Content-Length: ${body.byteLength}`,
        'Connection: close',
        '',
        body.toString(),
      ].join('\r\n'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const providerPort = (server.address() as AddressInfo).port;
    providers.push({ baseUrl: '', server, wss, upgrades: [], connections: [] });
    const proxy = await startLlmProxy({ upstreamBaseUrl: `http://127.0.0.1:${providerPort}`, adapter: emptyAdapter() });
    proxies.push(proxy);

    const result = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const client = new WebSocket(`${proxy.baseUrl.replace(/^http/, 'ws')}/responses`, {
        headers: { authorization: 'Bearer synthetic-api-key' },
      });
      clients.push(client);
      client.on('unexpected-response', (_request, response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      client.on('open', () => reject(new Error('upgrade unexpectedly succeeded')));
      client.on('error', () => {});
    });

    expect(result.status).toBe(307);
    expect(result.headers['x-provider-error']).toBe('preserved');
    expect(result.body.equals(body)).toBe(true);
    expect(targetCalls).toEqual([]);
  });
});
