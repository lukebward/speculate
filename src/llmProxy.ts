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
import {
  MAX_OBSERVATION_BYTES,
  observationSchema,
  type AgentAdapter,
  type AgentAdapterConnection,
  type AgentAdapterRequestObserver,
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

export interface LlmProxy {
  baseUrl: string;
  close(): Promise<void>;
}

export interface LlmProxyOptions {
  upstreamBaseUrl: string;
  adapter: AgentAdapter;
  onObservation?: (observation: Observation) => void | Promise<void>;
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
}

function closeConnection(state: ConnectionState): void {
  if (state.closed) return;
  state.closed = true;
  try {
    state.adapter?.close();
  } catch {}
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
  const connections = new Map<Socket, ConnectionState>();

  const server = createServer((request, response) => {
    const path = upstreamPath(upstream, request.url ?? '/');
    if (path === null) {
      request.resume();
      response.writeHead(400).end();
      return;
    }
    const connection = connections.get(request.socket)?.adapter ?? null;
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
    relayRequest({ request, response, upstream, path, observer, observations, upstreamRequests });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    let connection: AgentAdapterConnection | null = null;
    try {
      connection = options.adapter.createConnection();
    } catch {}
    const state = { adapter: connection, closed: false };
    connections.set(socket, state);
    socket.once('close', () => {
      sockets.delete(socket);
      connections.delete(socket);
      closeConnection(state);
    });
  });
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
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
    close(): Promise<void> {
      if (closePromise) return closePromise;
      observations.close();
      for (const request of upstreamRequests) request.destroy();
      for (const connection of connections.values()) closeConnection(connection);
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
}): void {
  const { request, response, upstream, observer, observations, upstreamRequests } = input;
  let observationActive = observer !== null;
  let observedRequestBytes = 0;
  let requestChunks: Buffer[] = [];
  let upstreamResponse: IncomingMessage | null = null;
  let settled = false;

  const enqueue = (bytes: number, run: () => readonly Observation[]): boolean => {
    if (!observationActive) return false;
    const activeAtRun = () => observationActive ? run() : [];
    if (observations.push({ bytes, run: activeAtRun })) return true;
    observationActive = false;
    requestChunks = [];
    try {
      observer?.abort();
    } catch {}
    return false;
  };

  const abortObservation = () => {
    if (!observationActive) return;
    observationActive = false;
    try {
      observer?.abort();
    } catch {}
  };

  const fail = () => {
    if (settled) return;
    settled = true;
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
  upstreamRequest.once('close', () => upstreamRequests.delete(upstreamRequest));
  upstreamRequest.once('error', fail);
  upstreamRequest.once('response', (received) => {
    upstreamResponse = received;
    if (settled) {
      received.destroy();
      return;
    }
    response.writeHead(received.statusCode ?? 502, received.statusMessage ?? '', forwardHeaders(received.rawHeaders, received.headers));
    enqueue(0, () => observer!.observeResponseStart({
      status: received.statusCode ?? 502,
      headers: normalizedHeaders(received.headers),
    }));
    received.on('data', (chunk: Buffer) => {
      if (settled) return;
      const forwarded = response.write(chunk);
      if (observationActive) {
        const copy = Buffer.from(chunk);
        enqueue(copy.byteLength, () => observer!.observeResponseChunk(copy));
      }
      if (!forwarded) {
        received.pause();
        response.once('drain', () => received.resume());
      }
    });
    received.once('end', () => {
      if (settled) return;
      settled = true;
      response.end();
      enqueue(0, () => observer!.observeResponseEnd());
    });
    received.once('aborted', fail);
    received.once('error', fail);
  });

  request.on('data', (chunk: Buffer) => {
    if (settled) return;
    const forwarded = upstreamRequest.write(chunk);
    if (observationActive) {
      observedRequestBytes += chunk.byteLength;
      if (observedRequestBytes <= MAX_OBSERVATION_BYTES) requestChunks.push(Buffer.from(chunk));
      else abortObservation();
    }
    if (!forwarded) {
      request.pause();
      upstreamRequest.once('drain', () => request.resume());
    }
  });
  request.once('end', () => {
    upstreamRequest.end();
    if (observationActive) {
      const body = Buffer.concat(requestChunks, observedRequestBytes);
      requestChunks = [];
      enqueue(body.byteLength, () => observer!.observeRequestBody(body));
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
