import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as sendHttpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GITHUB_ALLOW, GITHUB_RULES } from '../../mock/rules.js';
import type { StatsReport } from '../../src/types.js';

export type ProviderTransport = 'http' | 'sse' | 'websocket';
export type ProviderChunk = Buffer | string | { body: Buffer | string; delayMs?: number };

export interface ProviderCallRecord {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  receivedAt: number;
  abortedAt?: number;
}

export interface ProviderHandle {
  transport: ProviderTransport;
  baseUrl: string;
}

export interface ExchangeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  abortAfterChunks?: number;
}

export interface ExchangeResult {
  status: number;
  headers: IncomingHttpHeaders;
  originalPayload: Buffer;
  receivedPayload: Buffer;
  calls: ProviderCallRecord[];
  cancelled: boolean;
  timestamps: {
    started: number;
    requestReceived: number;
    responseChunks: number[];
    receivedChunks: number[];
    completed: number;
    clientAbort?: number;
    providerAbort?: number;
  };
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  t: number;
}

export interface ToolServerHandle {
  alias: string;
  callTool(tool: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; elapsedMs: number }>;
  calls(): ToolCallRecord[];
  waitForCalls(count: number, timeoutMs?: number): Promise<ToolCallRecord[]>;
  stats(): Promise<StatsReport>;
}

interface ResponsePlan {
  status: number;
  headers: Record<string, string>;
  chunks: Array<{ body: Buffer; delayMs: number }>;
  requestReceived?: number;
  responseChunks: number[];
  providerAbort?: number;
  finished: Promise<void>;
  finish(): void;
}

interface ProviderState {
  handle: ProviderHandle;
  server: Server;
  calls: ProviderCallRecord[];
  plans: ResponsePlan[];
}

interface ToolState {
  client: Client;
  directory: string;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChunk(chunk: ProviderChunk): { body: Buffer; delayMs: number } {
  const source = typeof chunk === 'object' && !Buffer.isBuffer(chunk) && 'body' in chunk
    ? chunk
    : { body: chunk, delayMs: 0 };
  return {
    body: Buffer.isBuffer(source.body) ? source.body : Buffer.from(source.body),
    delayMs: source.delayMs ?? 0,
  };
}

function readToolCalls(path: string): ToolCallRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ToolCallRecord);
}

export class ObserverHarness {
  private readonly providers: ProviderState[] = [];
  private readonly tools: ToolState[] = [];

  async startProvider(options: { transport: ProviderTransport }): Promise<ProviderHandle> {
    if (options.transport === 'websocket') {
      throw new Error('WebSocket provider fixtures are implemented with the Task 5 transport dependency');
    }

    const state = {} as ProviderState;
    const server = createServer(async (request, response) => {
      const receivedAt = performance.now();
      const bodyChunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => bodyChunks.push(Buffer.from(chunk)));
      await new Promise<void>((resolve) => request.on('end', resolve));

      const call: ProviderCallRecord = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(bodyChunks),
        receivedAt,
      };
      state.calls.push(call);
      const plan = state.plans.shift();
      if (!plan) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"missing response plan"}');
        return;
      }
      plan.requestReceived = receivedAt;
      request.once('aborted', () => {
        call.abortedAt = performance.now();
        plan.providerAbort = call.abortedAt;
      });
      response.once('close', () => {
        plan.finish();
        if (response.writableEnded) return;
        call.abortedAt = performance.now();
        plan.providerAbort = call.abortedAt;
      });
      response.writeHead(plan.status, {
        'content-type': options.transport === 'sse' ? 'text/event-stream' : 'application/json',
        'cache-control': 'no-cache',
        ...plan.headers,
      });
      for (const chunk of plan.chunks) {
        if (chunk.delayMs > 0) await delay(chunk.delayMs);
        if (response.destroyed) {
          plan.finish();
          return;
        }
        plan.responseChunks.push(performance.now());
        if (!response.write(chunk.body)) await new Promise<void>((resolve) => {
          const settle = () => {
            response.off('drain', settle);
            response.off('close', settle);
            response.off('error', settle);
            resolve();
          };
          response.once('drain', settle);
          response.once('close', settle);
          response.once('error', settle);
        });
      }
      response.end();
      plan.finish();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('provider did not bind a TCP port');
    state.handle = { transport: options.transport, baseUrl: `http://127.0.0.1:${address.port}` };
    state.server = server;
    state.calls = [];
    state.plans = [];
    this.providers.push(state);
    return state.handle;
  }

  async startToolServer(options: { alias: string; latencyMs: number }): Promise<ToolServerHandle> {
    const directory = mkdtempSync(join(tmpdir(), 'speculate-observer-'));
    const callLogPath = join(directory, 'calls.jsonl');
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mode: 'strict',
      log: 'off',
      persistence: { enabled: false },
      servers: {
        [options.alias]: {
          command: process.execPath,
          args: [tsxCli, join(root, 'mock', 'mock-github.ts')],
          env: {
            SPECULATE_MOCK_LATENCY_MS: String(options.latencyMs),
            SPECULATE_MOCK_CALL_LOG: callLogPath,
          },
          rules: GITHUB_RULES,
          allowTools: GITHUB_ALLOW,
        },
      },
    }));

    const client = new Client({ name: 'observer-harness', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, join(root, 'src', 'cli.ts'), '--config', configPath],
      env: { ...process.env, XDG_STATE_HOME: directory } as Record<string, string>,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    this.tools.push({ client, directory });

    const callTool = async (tool: string, args: Record<string, unknown>) => {
      const started = performance.now();
      const result = await client.callTool({ name: tool, arguments: args }) as CallToolResult;
      return { result, elapsedMs: performance.now() - started };
    };
    return {
      alias: options.alias,
      callTool,
      calls: () => readToolCalls(callLogPath),
      waitForCalls: async (count: number, timeoutMs = 5_000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          const calls = readToolCalls(callLogPath);
          if (calls.length >= count) return calls;
          await delay(10);
        }
        throw new Error(`timed out waiting for ${count} tool calls`);
      },
      stats: async () => {
        const { result } = await callTool('speculate__stats', {});
        const block = result.content[0];
        if (!block || block.type !== 'text') throw new Error('stats result did not contain text');
        return JSON.parse(block.text) as StatsReport;
      },
    };
  }

  async exchange(options: {
    request: ExchangeRequest;
    chunks: ProviderChunk[];
    status?: number;
    headers?: Record<string, string>;
    provider?: ProviderHandle;
  }): Promise<ExchangeResult> {
    const origin = options.provider?.baseUrl ?? new URL(options.request.url).origin;
    const provider = this.providers.find((entry) => entry.handle.baseUrl === origin)
      ?? (options.provider === undefined && this.providers.length === 1 ? this.providers[0] : undefined);
    if (!provider) throw new Error('exchange requires an unambiguous provider');
    const chunks = options.chunks.map(normalizeChunk);
    let finishPlan = (): void => {};
    const finished = new Promise<void>((resolve) => {
      finishPlan = resolve;
    });
    const plan: ResponsePlan = {
      status: options.status ?? 200,
      headers: options.headers ?? {},
      chunks, responseChunks: [], finished, finish: finishPlan,
    };
    provider.plans.push(plan);
    const originalPayload = Buffer.concat(chunks.map((chunk) => chunk.body));
    const receivedChunks: Buffer[] = [];
    const receivedChunkTimes: number[] = [];
    const started = performance.now();
    let cancelled = false;
    let clientAbort: number | undefined;
    let status = 0;
    let headers: IncomingHttpHeaders = {};

    await new Promise<void>((resolve, reject) => {
      const url = new URL(options.request.url);
      const request = sendHttpRequest(url, {
        method: options.request.method ?? 'POST',
        headers: options.request.headers,
      });
      request.once('error', (error) => cancelled ? resolve() : reject(error));
      request.once('response', (response) => {
        status = response.statusCode ?? 0;
        headers = response.headers;
        response.on('data', (chunk: Buffer) => {
          receivedChunks.push(Buffer.from(chunk));
          receivedChunkTimes.push(performance.now());
          if (options.request.abortAfterChunks === receivedChunks.length) {
            cancelled = true;
            clientAbort = performance.now();
            response.destroy();
            request.destroy();
          }
        });
        response.once('end', resolve);
        response.once('close', resolve);
        response.once('error', (error) => cancelled ? resolve() : reject(error));
      });
      request.end(options.request.body);
    });
    await plan.finished;

    const call = provider.calls.at(-1);
    if (!call || plan.requestReceived === undefined) throw new Error('provider did not record the exchange');
    return {
      status,
      headers,
      originalPayload,
      receivedPayload: Buffer.concat(receivedChunks),
      calls: [...provider.calls],
      cancelled,
      timestamps: {
        started,
        requestReceived: plan.requestReceived,
        responseChunks: [...plan.responseChunks],
        receivedChunks: receivedChunkTimes,
        completed: performance.now(),
        ...(clientAbort === undefined ? {} : { clientAbort }),
        ...(plan.providerAbort === undefined ? {} : { providerAbort: plan.providerAbort }),
      },
    };
  }

  async close(): Promise<void> {
    const toolStates = this.tools.splice(0);
    await Promise.all(toolStates.map(async ({ client, directory }) => {
      await client.close().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }));
    const providerStates = this.providers.splice(0);
    await Promise.all(providerStates.map(({ server }) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
  }
}

export function createObserverHarness(): ObserverHarness {
  return new ObserverHarness();
}
