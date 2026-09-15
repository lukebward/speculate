import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import {
  MAX_OBSERVATION_BYTES,
  observationSchema,
  type AgentAdapter,
  type AgentAdapterConnection,
  type AgentAdapterRequestObserver,
  type AgentAdapterWebSocketObserver,
  type LlmHeaders,
  type Observation,
} from './observerTypes.js';

const MAX_OBSERVATION_QUEUE_ITEMS = 256;
const MAX_OBSERVATION_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_OBSERVER_CALLBACKS = 32;
const ALWAYS_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  'host',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
]);

export interface LlmProxy {
  baseUrl: string;
  close(): Promise<void>;
  debugObservationState(): {
    connections: number;
    pendingJobs: number;
    partialRequests: number;
    totalRequests: number;
    failures: number;
  };
}

export interface LlmProxyOptions {
  upstreamBaseUrl: string;
  adapter: AgentAdapter;
  onObservation?: (observation: Observation) => void | Promise<void>;
  onObservationLoss?: (observedAt: number) => void;
}

interface ObservationJob {
  bytes: number;
  run(): readonly Observation[];
}

interface CallbackBudget {
  callbacks: number;
  bytes: number;
  closed: boolean;
}

interface ConnectionState {
  adapter: AgentAdapterConnection | null;
  closed: boolean;
  socketClosed: boolean;
  webSocket: boolean;
  webSocketFinished: boolean;
  pendingObservationJobs: number;
  partialRequests: Set<() => void>;
}

function closeConnection(state: ConnectionState, force = false): void {
  if (state.closed || (!force && state.pendingObservationJobs > 0)) return;
  state.closed = true;
  try {
    state.adapter?.close();
  } catch {}
}

function releaseConnectionJob(state: ConnectionState): void {
  state.pendingObservationJobs = Math.max(0, state.pendingObservationJobs - 1);
  if (state.socketClosed) closeConnection(state);
}

function releaseCallback(budget: CallbackBudget, bytes: number): void {
  if (budget.closed) return;
  budget.callbacks = Math.max(0, budget.callbacks - 1);
  budget.bytes = Math.max(0, budget.bytes - bytes);
}

class ObservationQueue {
  private readonly jobs: ObservationJob[] = [];
  private bytes = 0;
  private scheduled = false;
  private closed = false;
  private immediate: NodeJS.Immediate | null = null;
  private readonly callbackBudget: CallbackBudget = { callbacks: 0, bytes: 0, closed: false };

  constructor(private readonly callback: ((observation: Observation) => void | Promise<void>) | undefined) {}

  push(job: ObservationJob): boolean {
    if (this.closed || !this.callback) return false;
    if (job.bytes > MAX_OBSERVATION_BYTES || this.jobs.length >= MAX_OBSERVATION_QUEUE_ITEMS ||
      this.bytes + job.bytes > MAX_OBSERVATION_QUEUE_BYTES) return false;
    this.jobs.push(job);
    this.bytes += job.bytes;
    if (!this.scheduled) {
      this.scheduled = true;
      this.immediate = setImmediate(() => this.drainOne());
    }
    return true;
  }

  close(): void {
    this.closed = true;
    this.jobs.length = 0;
    this.bytes = 0;
    if (this.immediate) clearImmediate(this.immediate);
    this.immediate = null;
    this.scheduled = false;
    this.callbackBudget.closed = true;
    this.callbackBudget.callbacks = 0;
    this.callbackBudget.bytes = 0;
  }

  private drainOne(): void {
    this.immediate = null;
    const job = this.jobs.shift();
    if (!job || this.closed) {
      this.scheduled = false;
      return;
    }
    this.bytes -= job.bytes;
    let values: readonly Observation[] = [];
    try {
      values = job.run();
    } catch {
      values = [];
    }
    for (const value of values) {
      const parsed = observationSchema.safeParse(value);
      if (!parsed.success) continue;
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
      } catch {
        continue;
      }
      if (bytes > MAX_OBSERVATION_QUEUE_BYTES || this.callbackBudget.callbacks >= MAX_PENDING_OBSERVER_CALLBACKS ||
        this.callbackBudget.bytes + bytes > MAX_OBSERVATION_QUEUE_BYTES) continue;
      let result: void | Promise<void>;
      try {
        result = this.callback!(parsed.data);
      } catch {
        continue;
      }
      if (!result || typeof (result as Promise<void>).then !== 'function') continue;
      const budget = this.callbackBudget;
      budget.callbacks++;
      budget.bytes += bytes;
      void Promise.resolve(result).then(
        () => releaseCallback(budget, bytes),
        () => releaseCallback(budget, bytes),
      );
    }
    if (this.jobs.length > 0) this.immediate = setImmediate(() => this.drainOne());
    else this.scheduled = false;
  }

}

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const values = Array.isArray(headers.connection) ? headers.connection : [headers.connection];
  return new Set(values.flatMap((value) => value?.split(',') ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function forwardHeaders(rawHeaders: readonly string[], parsedHeaders: IncomingHttpHeaders, upstreamHost?: string): string[] {
  const removed = connectionTokens(parsedHeaders);
  const out: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (lower === 'host' || ALWAYS_HOP_BY_HOP.has(lower) || removed.has(lower)) continue;
    out.push(name, rawHeaders[index + 1]!);
  }
  if (upstreamHost !== undefined) out.push('Host', upstreamHost);
  return out;
}

function webSocketRequestHeaders(rawHeaders: readonly string[], parsedHeaders: IncomingHttpHeaders, upstreamHost: string): Record<string, string> {
  const removed = connectionTokens(parsedHeaders);
  const out: Record<string, string> = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (ALWAYS_HOP_BY_HOP.has(lower) || WEBSOCKET_HANDSHAKE_HEADERS.has(lower) || removed.has(lower)) continue;
    const value = rawHeaders[index + 1]!;
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  out.Host = upstreamHost;
  return out;
}

function webSocketProtocols(headers: IncomingHttpHeaders): string[] {
  const value = headers['sec-websocket-protocol'];
  const joined = Array.isArray(value) ? value.join(',') : value ?? '';
  return joined.split(',').map((protocol) => protocol.trim()).filter(Boolean);
}

function providerUpgradeHeaders(response: IncomingMessage): string[] {
  const removed = connectionTokens(response.headers);
  const out: string[] = [];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (ALWAYS_HOP_BY_HOP.has(lower) || WEBSOCKET_HANDSHAKE_HEADERS.has(lower) || removed.has(lower)) continue;
    out.push(`${name}: ${response.rawHeaders[index + 1]!}`);
  }
  return out;
}

function rawData(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function normalizedHeaders(headers: IncomingHttpHeaders): LlmHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function upstreamPath(base: URL, requestTarget: string): string | null {
  if (!requestTarget.startsWith('/') || requestTarget.startsWith('//') || /^\/https?:\/\//i.test(requestTarget)) return null;
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return `${basePath}${requestTarget}` || '/';
}

function validUpstream(input: string): URL {
  const url = new URL(input);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('upstreamBaseUrl must be a fixed HTTP(S) origin and optional base path');
  }
  return url;
}

export async function startLlmProxy(options: LlmProxyOptions): Promise<LlmProxy> {
  const upstream = validUpstream(options.upstreamBaseUrl);
  const observations = new ObservationQueue(options.onObservation);
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<ClientRequest>();
  const webSockets = new Set<WebSocket>();
  const connections = new Map<Duplex, ConnectionState>();
  const selectedProtocols = new WeakMap<IncomingMessage, string>();
  const upgradeHeaders = new WeakMap<IncomingMessage, string[]>();
  let totalRequests = 0;
  let failures = 0;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    allowSynchronousEvents: false,
    autoPong: false,
    clientTracking: false,
    perMessageDeflate: true,
    handleProtocols(_protocols, request) {
      return selectedProtocols.get(request) ?? false;
    },
  });
  webSocketServer.on('headers', (headers, request) => headers.push(...(upgradeHeaders.get(request) ?? [])));

  const server = createServer((request, response) => {
    totalRequests++;
    response.once('finish', () => { if (response.statusCode >= 400) failures++; });
    const path = upstreamPath(upstream, request.url ?? '/');
    if (path === null) {
      request.resume();
      response.writeHead(400).end();
      return;
    }
    const connectionState = connections.get(request.socket) ?? null;
    const connection = connectionState?.adapter ?? null;
    let observer: AgentAdapterRequestObserver | null = null;
    if (options.onObservation && connection) {
      try {
        observer = connection.startRequest({
          transport: 'http',
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          headers: normalizedHeaders(request.headers),
        });
      } catch {}
    }
    relayRequest({ request, response, upstream, path, observer, observations, upstreamRequests, connectionState,
      onObservationLoss: options.onObservationLoss, onFailure: () => { failures++; } });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    let connection: AgentAdapterConnection | null = null;
    try {
      connection = options.adapter.createConnection();
    } catch {}
    const state: ConnectionState = {
      adapter: connection,
      closed: false,
      socketClosed: false,
      webSocket: false,
      webSocketFinished: false,
      pendingObservationJobs: 0,
      partialRequests: new Set(),
    };
    connections.set(socket, state);
    socket.once('close', () => {
      sockets.delete(socket);
      connections.delete(socket);
      state.socketClosed = true;
      if (!state.webSocket) {
        for (const abort of state.partialRequests) abort();
        state.partialRequests.clear();
        closeConnection(state);
      } else if (state.webSocketFinished) closeConnection(state);
    });
  });
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (request, socket, head) => {
    totalRequests++;
    const path = upstreamPath(upstream, request.url ?? '/');
    if (path === null) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const state = connections.get(socket) ?? null;
    if (state) state.webSocket = true;
    relayWebSocket({
      request,
      socket,
      head,
      upstream,
      path,
      state,
      observations,
      onObservation: options.onObservation !== undefined,
      webSocketServer,
      selectedProtocols,
      upgradeHeaders,
      webSockets,
      onObservationLoss: options.onObservationLoss,
      onFailure: () => { failures++; },
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('LLM relay did not bind a TCP port');

  let closePromise: Promise<void> | null = null;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    debugObservationState() {
      const states = [...connections.values()];
      return {
        connections: states.length,
        pendingJobs: states.reduce((sum, state) => sum + state.pendingObservationJobs, 0),
        partialRequests: states.reduce((sum, state) => sum + state.partialRequests.size, 0),
        totalRequests,
        failures,
      };
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      observations.close();
      for (const request of upstreamRequests) request.destroy();
      for (const webSocket of webSockets) webSocket.terminate();
      webSockets.clear();
      for (const connection of connections.values()) closeConnection(connection, true);
      connections.clear();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
      return closePromise;
    },
  };
}

function relayRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  upstream: URL;
  path: string;
  observer: AgentAdapterRequestObserver | null;
  observations: ObservationQueue;
  upstreamRequests: Set<ClientRequest>;
  connectionState: ConnectionState | null;
  onObservationLoss?: (observedAt: number) => void;
  onFailure?: () => void;
}): void {
  const { request, response, upstream, observer, observations, upstreamRequests, connectionState, onObservationLoss } = input;
  let observationActive = observer !== null;
  let observedRequestBytes = 0;
  let requestChunks: Buffer[] = [];
  let upstreamResponse: IncomingMessage | null = null;
  let settled = false;
  let uploadPaused = false;
  let uploadWritable = true;

  const settleUploadBackpressure = () => {
    if (!uploadPaused) return;
    uploadPaused = false;
    request.resume();
  };

  const enqueue = (bytes: number, run: () => readonly Observation[]): boolean => {
    if (!observationActive) return false;
    const activeAtRun = () => observationActive ? run() : [];
    if (connectionState) connectionState.pendingObservationJobs++;
    const accepted = observations.push({
      bytes,
      run() {
        try {
          return activeAtRun();
        } finally {
          if (connectionState) releaseConnectionJob(connectionState);
        }
      },
    });
    if (accepted) return true;
    if (connectionState) releaseConnectionJob(connectionState);
    abortObservation();
    return false;
  };

  const abortObservation = () => {
    connectionState?.partialRequests.delete(abortObservation);
    if (!observationActive) return;
    observationActive = false;
    requestChunks = [];
    try { onObservationLoss?.(Date.now()); } catch {}
    try {
      observer?.abort();
    } catch {}
  };
  if (observationActive) connectionState?.partialRequests.add(abortObservation);

  const fail = () => {
    if (settled) return;
    settled = true;
    input.onFailure?.();
    settleUploadBackpressure();
    abortObservation();
    if (!response.headersSent) response.writeHead(502).end();
    else response.destroy(new Error('upstream disconnected'));
  };

  const requester = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreamRequest = requester({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || undefined,
    method: request.method,
    path: input.path,
    headers: forwardHeaders(request.rawHeaders, request.headers, upstream.host),
    setHost: false,
  });
  upstreamRequests.add(upstreamRequest);
  upstreamRequest.once('close', () => {
    upstreamRequests.delete(upstreamRequest);
    uploadWritable = false;
    settleUploadBackpressure();
    if (!request.complete) abortObservation();
  });
  upstreamRequest.once('error', fail);
  upstreamRequest.once('response', (received) => {
    upstreamResponse = received;
    if (settled) {
      received.destroy();
      return;
    }
    response.writeHead(received.statusCode ?? 502, received.statusMessage ?? '', forwardHeaders(received.rawHeaders, received.headers));
    const responseObservedAt = Date.now();
    enqueue(0, () => observer!.observeResponseStart({
      status: received.statusCode ?? 502,
      headers: normalizedHeaders(received.headers),
    }, responseObservedAt));
    received.on('data', (chunk: Buffer) => {
      if (settled) return;
      const forwarded = response.write(chunk);
      if (observationActive) {
        const copy = Buffer.from(chunk);
        const observedAt = Date.now();
        enqueue(copy.byteLength, () => observer!.observeResponseChunk(copy, observedAt));
      }
      if (!forwarded) {
        received.pause();
        response.once('drain', () => received.resume());
      }
    });
    received.once('end', () => {
      if (settled) return;
      settled = true;
      connectionState?.partialRequests.delete(abortObservation);
      response.end();
      const observedAt = Date.now();
      enqueue(0, () => observer!.observeResponseEnd(observedAt));
    });
    received.once('aborted', fail);
    received.once('error', fail);
  });

  request.on('data', (chunk: Buffer) => {
    if (settled || !uploadWritable) return;
    const forwarded = upstreamRequest.write(chunk);
    if (observationActive) {
      observedRequestBytes += chunk.byteLength;
      if (observedRequestBytes <= MAX_OBSERVATION_BYTES) requestChunks.push(Buffer.from(chunk));
      else abortObservation();
    }
    if (!forwarded) {
      uploadPaused = true;
      request.pause();
      upstreamRequest.once('drain', settleUploadBackpressure);
    }
  });
  request.once('end', () => {
    if (uploadWritable) upstreamRequest.end();
    if (observationActive) {
      const body = Buffer.concat(requestChunks, observedRequestBytes);
      requestChunks = [];
      const observedAt = Date.now();
      enqueue(body.byteLength, () => observer!.observeRequestBody(body, observedAt));
    }
  });
  request.once('aborted', () => {
    abortObservation();
    upstreamRequest.destroy();
    upstreamResponse?.destroy();
  });
  response.once('close', () => {
    if (response.writableEnded) return;
    abortObservation();
    upstreamRequest.destroy();
    upstreamResponse?.destroy();
  });
}

function relayWebSocket(input: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  upstream: URL;
  path: string;
  state: ConnectionState | null;
  observations: ObservationQueue;
  onObservation: boolean;
  webSocketServer: WebSocketServer;
  selectedProtocols: WeakMap<IncomingMessage, string>;
  upgradeHeaders: WeakMap<IncomingMessage, string[]>;
  webSockets: Set<WebSocket>;
  onObservationLoss?: (observedAt: number) => void;
  onFailure?: () => void;
}): void {
  const {
    request,
    socket,
    head,
    upstream,
    state,
    observations,
    webSocketServer,
    selectedProtocols,
    upgradeHeaders,
    webSockets,
  } = input;
  let observer: AgentAdapterWebSocketObserver | null = null;
  if (input.onObservation && state?.adapter?.startWebSocket) {
    try {
      observer = state.adapter.startWebSocket({
        transport: 'websocket',
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: normalizedHeaders(request.headers),
      });
    } catch {}
  }
  let observationActive = observer !== null;
  let observationFinished = false;
  let transportFinished = false;

  const abortObservation = () => {
    state?.partialRequests.delete(abortObservation);
    if (!observationActive) return;
    observationActive = false;
    try { input.onObservationLoss?.(Date.now()); } catch {}
    try {
      observer?.abort();
    } catch {}
  };

  const enqueue = (bytes: number, run: () => readonly Observation[]): boolean => {
    if (!observationActive || bytes > MAX_OBSERVATION_BYTES) return false;
    if (state) state.pendingObservationJobs++;
    const accepted = observations.push({
      bytes,
      run() {
        try {
          return observationActive ? run() : [];
        } finally {
          if (state) releaseConnectionJob(state);
        }
      },
    });
    if (accepted) return true;
    if (state) releaseConnectionJob(state);
    abortObservation();
    return false;
  };

  const finishObservation = () => {
    if (observationFinished) return;
    observationFinished = true;
    state?.partialRequests.delete(abortObservation);
    if (!observationActive) return;
    if (state) state.pendingObservationJobs++;
    const accepted = observations.push({
      bytes: 0,
      run() {
        try {
          if (observationActive) {
            observationActive = false;
            observer?.abort();
          }
          return [];
        } finally {
          if (state) releaseConnectionJob(state);
        }
      },
    });
    if (!accepted) {
      if (state) releaseConnectionJob(state);
      abortObservation();
    }
  };

  const finishTransport = (drainObservation: boolean) => {
    if (transportFinished) return;
    transportFinished = true;
    if (drainObservation) finishObservation();
    else abortObservation();
    if (state) {
      state.webSocketFinished = true;
      if (state.socketClosed) closeConnection(state);
    }
  };

  if (observationActive) state?.partialRequests.add(abortObservation);

  const wsUrl = new URL(upstream.toString());
  wsUrl.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = input.path.split('?', 1)[0] ?? '/';
  const query = input.path.includes('?') ? input.path.slice(input.path.indexOf('?')) : '';
  wsUrl.search = query;
  const requestedProtocols = webSocketProtocols(request.headers);
  let upgradeResponse: IncomingMessage | null = null;
  let downstream: WebSocket | null = null;
  let failureResponse = false;
  let failureReported = false;
  let upstreamSocket: WebSocket;
  try {
    upstreamSocket = new WebSocket(wsUrl, requestedProtocols, {
      allowSynchronousEvents: false,
      autoPong: false,
      followRedirects: false,
      headers: webSocketRequestHeaders(request.rawHeaders, request.headers, upstream.host),
      perMessageDeflate: request.headers['sec-websocket-extensions']?.includes('permessage-deflate') ?? false,
    });
  } catch {
    finishTransport(false);
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  webSockets.add(upstreamSocket);

  const failBeforeUpgrade = () => {
    if (!failureReported) {
      failureReported = true;
      input.onFailure?.();
    }
    if (downstream || failureResponse || socket.destroyed) return;
    finishTransport(false);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };

  upstreamSocket.once('upgrade', (response) => {
    upgradeResponse = response;
    upstreamSocket.pause();
  });
  upstreamSocket.once('unexpected-response', (_upstreamRequest, response) => {
    failureResponse = true;
    finishTransport(false);
    relayUpgradeFailure(socket, response, () => {
      webSockets.delete(upstreamSocket);
      upstreamSocket.terminate();
    });
  });
  upstreamSocket.once('open', () => {
    if (!upgradeResponse || socket.destroyed) {
      upstreamSocket.terminate();
      failBeforeUpgrade();
      return;
    }
    if (upstreamSocket.protocol) selectedProtocols.set(request, upstreamSocket.protocol);
    upgradeHeaders.set(request, providerUpgradeHeaders(upgradeResponse));
    try {
      webSocketServer.handleUpgrade(request, socket, head, (accepted) => {
        downstream = accepted;
        webSockets.add(accepted);
        accepted.once('close', () => webSockets.delete(accepted));
        const responseObservedAt = Date.now();
        enqueue(0, () => observer!.observeResponseStart({
          status: 101,
          headers: normalizedHeaders(upgradeResponse!.headers),
        }, responseObservedAt));
        bridgeWebSockets(accepted, upstreamSocket, {
          clientMessage(message) {
            if (message.data.byteLength <= MAX_OBSERVATION_BYTES) {
              const observedAt = Date.now();
              enqueue(message.data.byteLength, () => observer!.observeClientMessage(message, observedAt));
            } else abortObservation();
          },
          serverMessage(message) {
            if (message.data.byteLength <= MAX_OBSERVATION_BYTES) {
              const observedAt = Date.now();
              enqueue(message.data.byteLength, () => observer!.observeServerMessage(message, observedAt));
            } else abortObservation();
          },
          error() {
            finishTransport(false);
          },
          close() {
            finishTransport(true);
          },
        });
        upstreamSocket.resume();
      });
    } catch {
      upstreamSocket.terminate();
      failBeforeUpgrade();
    }
  });
  upstreamSocket.once('error', () => {
    if (!downstream) failBeforeUpgrade();
  });
  upstreamSocket.once('close', () => webSockets.delete(upstreamSocket));
  socket.once('close', () => {
    if (!downstream) {
      upstreamSocket.terminate();
      finishTransport(false);
    }
  });
}

function relayUpgradeFailure(socket: Duplex, response: IncomingMessage, finished: () => void): void {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    finished();
  };
  const status = response.statusCode ?? 502;
  const message = response.statusMessage ?? '';
  const headers = forwardHeaders(response.rawHeaders, response.headers)
    .reduce<string[]>((lines, value, index, values) => index % 2 === 0 ? [...lines, `${value}: ${values[index + 1] ?? ''}`] : lines, []);
  socket.write([`HTTP/1.1 ${status}${message ? ` ${message}` : ''}`, ...headers, 'Connection: close', '', ''].join('\r\n'));
  response.on('data', (chunk: Buffer) => {
    if (!socket.write(chunk)) {
      response.pause();
      socket.once('drain', () => response.resume());
    }
  });
  response.once('end', () => {
    settle();
    socket.end();
  });
  response.once('aborted', () => {
    settle();
    socket.destroy();
  });
  response.once('error', () => {
    settle();
    socket.destroy();
  });
  socket.once('close', () => response.destroy());
}

function bridgeWebSockets(
  client: WebSocket,
  provider: WebSocket,
  lifecycle: {
    clientMessage(message: { data: Uint8Array; binary: boolean }): void;
    serverMessage(message: { data: Uint8Array; binary: boolean }): void;
    error(): void;
    close(): void;
  },
): void {
  let closed = false;
  let errors = false;

  const fail = () => {
    errors = true;
    client.terminate();
    provider.terminate();
    lifecycle.error();
  };

  const relay = (source: WebSocket, target: WebSocket, observe: (message: { data: Uint8Array; binary: boolean }) => void) => {
    source.on('message', (value, binary) => {
      const data = rawData(value);
      observe({ data, binary });
      if (target.readyState !== WebSocket.OPEN) return;
      source.pause();
      target.send(data, { binary }, (error) => {
        if (error) {
          fail();
          return;
        }
        source.resume();
      });
    });
    source.on('ping', (data) => {
      if (target.readyState === WebSocket.OPEN) target.ping(data, undefined, (error) => {
        if (error) fail();
      });
    });
    source.on('pong', (data) => {
      if (target.readyState === WebSocket.OPEN) target.pong(data, undefined, (error) => {
        if (error) fail();
      });
    });
  };

  const closePeer = (source: WebSocket, target: WebSocket, code: number, reason: Buffer) => {
    if (target.readyState === WebSocket.OPEN) {
      if (code === 1006) target.terminate();
      else if (code === 1005) target.close();
      else target.close(code, reason);
    } else if (target.readyState === WebSocket.CONNECTING) target.terminate();
    if (!closed) {
      closed = true;
      if (errors || code === 1006) lifecycle.error();
      else lifecycle.close();
    }
    source.removeAllListeners('message');
  };

  relay(client, provider, lifecycle.clientMessage);
  relay(provider, client, lifecycle.serverMessage);
  client.once('error', () => {
    errors = true;
    provider.terminate();
  });
  provider.once('error', () => {
    errors = true;
    client.terminate();
  });
  client.once('close', (code, reason) => closePeer(client, provider, code, reason));
  provider.once('close', (code, reason) => closePeer(provider, client, code, reason));
}
