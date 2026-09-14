import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/agentAdapters/codex.js';
import type {
  AgentAdapterConnection,
  AgentAdapterRequestObserver,
  AgentAdapterWebSocketObserver,
  Observation,
  RegisteredRoute,
  SessionContext,
} from '../src/observerTypes.js';

const context: SessionContext = {
  launchId: 'launch',
  conversationId: 'thread_fixture_codex',
  agent: 'codex',
  cwd: '/work',
};

const routes: RegisteredRoute[] = [
  {
    routeId: 'workspace-read',
    generation: 1,
    instanceId: 'workspace-owner',
    hostClient: 'codex',
    hostServerAlias: 'workspace',
    exposedTool: 'read_file',
    upstreamServer: 'upstream',
    upstreamTool: 'read_file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    routeId: 'issue-comments',
    generation: 1,
    instanceId: 'issues-owner',
    hostClient: 'codex',
    hostServerAlias: 'issues',
    exposedTool: 'get_comments',
    upstreamServer: 'upstream',
    upstreamTool: 'get_comments',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer' } },
      required: ['number'],
    },
  },
];

function makeAdapter(routeList: () => readonly RegisteredRoute[] = () => routes) {
  let sequence = 0;
  return codexAdapter({
    contextForConversation: (conversationId) => conversationId === context.conversationId ? context : null,
    routes: routeList,
    now: () => 50,
    eventId: (kind, stableId) => `${kind}:${stableId}:${++sequence}`,
  });
}

function fixture() {
  const path = fileURLToPath(new URL('fixtures/observer/codex.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as {
    cases: Array<{
      id: string;
      request?: { body?: Record<string, unknown> };
      response?: { body?: unknown; chunks?: string[] };
    }>;
  };
}

function connection(adapter = makeAdapter()): AgentAdapterConnection {
  return adapter.createConnection();
}

function requestObserver(conn = connection(), headers: Record<string, string | undefined> = {
  'thread-id': context.conversationId,
  'content-type': 'application/json',
}): AgentAdapterRequestObserver {
  const observer = conn.startRequest({
    transport: 'http',
    method: 'POST',
    path: '/v1/responses?fixture=true',
    headers,
  });
  if (!observer) throw new Error('expected request observer');
  return observer;
}

function webSocketObserver(conn = connection()): AgentAdapterWebSocketObserver {
  const observer = conn.startWebSocket?.({
    transport: 'websocket',
    method: 'GET',
    path: '/responses',
    headers: { 'thread-id': context.conversationId },
  });
  if (!observer) throw new Error('expected WebSocket observer');
  observer.observeResponseStart({ status: 101, headers: { upgrade: 'websocket' } });
  return observer;
}

function functionTool(name: string, parameters: Record<string, unknown>) {
  return { type: 'function', name, parameters };
}

function observeJson(observer: AgentAdapterRequestObserver, body: unknown): Observation[] {
  observer.observeResponseStart({ status: 200, headers: { 'content-type': 'application/json' } });
  observer.observeResponseChunk(Buffer.from(JSON.stringify(body)));
  return [...observer.observeResponseEnd()];
}

describe('Codex Responses adapter', () => {
  it('normalizes the current prompt and a completed JSON function call', () => {
    const testCase = fixture().cases.find((entry) => entry.id === 'responses-full-tool-definition')!;
    const observer = requestObserver(connection(makeAdapter(() => [{
      ...routes[0]!,
      inputSchema: { ...routes[0]!.inputSchema, additionalProperties: false },
    }])));

    const prompt = observer.observeRequestBody(Buffer.from(JSON.stringify(testCase.request!.body)));
    const calls = observeJson(observer, testCase.response!.body);

    expect(prompt).toEqual([
      expect.objectContaining({ kind: 'prompt', context, observedAt: 50, text: 'Read /workspace/notes.txt' }),
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        kind: 'stream-call',
        context,
        routeId: 'workspace-read',
        callId: 'call_fixture_001',
        args: { path: '/workspace/notes.txt' },
      }),
    ]);
  });

  it('emits each SSE call once at its completed item boundary across UTF-8 splits', () => {
    const testCase = fixture().cases.find((entry) => entry.id === 'responses-continuation-sse-split')!;
    const observer = requestObserver();
    observer.observeRequestBody(Buffer.from(JSON.stringify(testCase.request!.body)));
    observer.observeResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } });
    const source = Buffer.from(testCase.response!.chunks!.join(''));
    const cafe = Buffer.from('café');
    const splitAt = source.indexOf(cafe) + 4;
    const chunks = [source.subarray(0, splitAt), source.subarray(splitAt, splitAt + 1), source.subarray(splitAt + 1)];
    const observations: Observation[] = [];

    for (const chunk of chunks) observations.push(...observer.observeResponseChunk(chunk));
    observations.push(...observer.observeResponseEnd());

    expect(observations).toEqual([
      expect.objectContaining({
        kind: 'stream-call', routeId: 'workspace-read', callId: 'call_fixture_002',
        args: { path: '/workspace/café.txt' },
      }),
      expect.objectContaining({
        kind: 'stream-call', routeId: 'issue-comments', callId: 'call_fixture_003', args: { number: 7 },
      }),
    ]);
  });

  it('reconstructs bounded function arguments from deltas when the completed item omits them', () => {
    const observer = requestObserver();
    observer.observeRequestBody(Buffer.from(JSON.stringify({
      input: 'read it',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })));
    observer.observeResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } });
    const events = [
      { type: 'response.output_item.added', item: { id: 'item-delta', type: 'function_call', call_id: 'call-delta', name: 'mcp__workspace__read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'item-delta', delta: '{"path":"/work/' },
      { type: 'response.function_call_arguments.delta', item_id: 'item-delta', delta: 'delta.txt"}' },
      { type: 'response.output_item.done', item: { id: 'item-delta', type: 'function_call', call_id: 'call-delta', name: 'mcp__workspace__read_file' } },
    ];
    const observations = events.flatMap((event) => observer.observeResponseChunk(Buffer.from(`data: ${JSON.stringify(event)}\n\n`)));

    expect(observations).toEqual([
      expect.objectContaining({
        kind: 'stream-call', routeId: 'workspace-read', callId: 'call-delta', args: { path: '/work/delta.txt' },
      }),
    ]);
  });

  it('reuses bounded route context only for a known previous response', () => {
    const conn = connection();
    const first = requestObserver(conn);
    first.observeRequestBody(Buffer.from(JSON.stringify({
      input: 'Inspect issue 7.',
      tools: [functionTool('mcp__issues__get_comments', routes[1]!.inputSchema)],
    })));
    observeJson(first, {
      id: 'resp-known',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [] }],
    });
    const continuation = requestObserver(conn);
    expect(continuation.observeRequestBody(Buffer.from(JSON.stringify({
      previous_response_id: 'resp-known',
      input: [{ type: 'function_call_output', call_id: 'earlier', output: '{"number":7}' }],
    })))).toEqual([]);

    expect(observeJson(continuation, {
      id: 'resp-next',
      status: 'completed',
      output: [{
        type: 'function_call', call_id: 'next-call', name: 'mcp__issues__get_comments',
        arguments: '{"number":7}', status: 'completed',
      }],
    })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'issue-comments', callId: 'next-call', args: { number: 7 } }),
    ]);

    const missing = requestObserver(conn);
    missing.observeRequestBody(Buffer.from(JSON.stringify({ previous_response_id: 'resp-missing', input: [] })));
    expect(observeJson(missing, {
      id: 'resp-unbound', status: 'completed',
      output: [{
        type: 'function_call', call_id: 'unknown-call', name: 'mcp__issues__get_comments',
        arguments: '{"number":8}', status: 'completed',
      }],
    })).toEqual([]);
  });

  it('requires one exact live alias and exact non-deferred flat schema', () => {
    const response = {
      id: 'resp', status: 'completed',
      output: [{
        type: 'function_call', call_id: 'call', name: 'mcp__workspace__read_file',
        arguments: '{"path":"/work/a"}', status: 'completed',
      }],
    };
    const changedSchema = [{ ...routes[0]!, inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }];
    const ambiguous = [routes[0]!, { ...routes[0]!, routeId: 'duplicate', instanceId: 'duplicate-owner' }];

    for (const routeList of [changedSchema, ambiguous, []]) {
      const observer = requestObserver(connection(makeAdapter(() => routeList)));
      observer.observeRequestBody(Buffer.from(JSON.stringify({
        input: 'read it', tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
      })));
      expect(observeJson(observer, response)).toEqual([]);
    }

    const deferred = requestObserver();
    deferred.observeRequestBody(Buffer.from(JSON.stringify({
      input: 'read it',
      tools: [{ ...functionTool('mcp__workspace__read_file', routes[0]!.inputSchema), defer_loading: true }],
    })));
    expect(observeJson(deferred, response)).toEqual([]);
  });

  it('passes opaque reasoning, native namespaces, and free-form code without interpreting them', () => {
    const observer = requestObserver();
    observer.observeRequestBody(Buffer.from(JSON.stringify({
      input: 'Inspect it.',
      tools: [{
        type: 'namespace', name: 'functions', tools: [
          { type: 'custom', name: 'exec', format: 'opaque grammar' },
          { type: 'function', name: 'wait', parameters: {} },
        ],
      }],
    })));

    expect(observeJson(observer, {
      id: 'resp-opaque', status: 'completed', output: [
        { type: 'reasoning', encrypted_content: 'opaque' },
        { type: 'custom_tool_call', call_id: 'exec-call', name: 'exec', input: 'tools.mcp__workspace__read_file({path:"/secret"})' },
      ],
    })).toEqual([]);
  });

  it('abstains for malformed, encoded, error, binary, and oversized payloads', () => {
    const encoded = requestObserver(connection(), {
      'thread-id': context.conversationId,
      'content-encoding': 'gzip',
    });
    expect(encoded.observeRequestBody(Buffer.from('{"input":"secret"}'))).toEqual([]);

    const malformed = requestObserver();
    expect(malformed.observeRequestBody(Buffer.from('{'))).toEqual([]);

    const error = requestObserver();
    error.observeRequestBody(Buffer.from('{"input":"test"}'));
    error.observeResponseStart({ status: 429, headers: { 'content-type': 'application/json' } });
    expect(error.observeResponseChunk(Buffer.from('{"error":"rate"}'))).toEqual([]);

    const oversized = requestObserver();
    expect(oversized.observeRequestBody(Buffer.alloc(2 * 1024 * 1024 + 1, 120))).toEqual([]);

    const ws = webSocketObserver();
    expect(ws.observeClientMessage({ data: Buffer.from('{"type":"response.create"}'), binary: true })).toEqual([]);
    expect(ws.observeServerMessage({ data: Buffer.from('{"type":"response.completed"}'), binary: true })).toEqual([]);
  });

  it('correlates interleaved WebSocket stream IDs and incremental continuations', () => {
    const ws = webSocketObserver();
    expect(ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: 'lane-a', input: 'Read a.',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Read a.' }),
    ]);
    expect(ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: 'lane-b', input: 'Read b.',
      tools: [functionTool('mcp__issues__get_comments', routes[1]!.inputSchema)],
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Read b.' }),
    ]);

    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","stream_id":"lane-b","response":{"id":"resp-b"}}'), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","stream_id":"lane-a","response":{"id":"resp-a"}}'), binary: false });
    const a = ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: 'lane-a', response_id: 'resp-a',
      item: { type: 'function_call', call_id: 'call-a', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/a"}' },
    })), binary: false });
    const b = ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: 'lane-b', response_id: 'resp-b',
      item: { type: 'function_call', call_id: 'call-b', name: 'mcp__issues__get_comments', arguments: '{"number":7}' },
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.completed","stream_id":"lane-a","response":{"id":"resp-a"}}'), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.completed","stream_id":"lane-b","response":{"id":"resp-b"}}'), binary: false });

    expect([...a, ...b]).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read', callId: 'call-a' }),
      expect.objectContaining({ kind: 'stream-call', routeId: 'issue-comments', callId: 'call-b' }),
    ]);

    expect(ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: 'lane-c', previous_response_id: 'resp-b',
      input: [{ type: 'function_call_output', call_id: 'call-b', output: '{"number":7}' }],
    })), binary: false })).toEqual([]);
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","stream_id":"lane-c","response":{"id":"resp-c"}}'), binary: false });
    expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: 'lane-c', response_id: 'resp-c',
      item: { type: 'function_call', call_id: 'call-c', name: 'mcp__issues__get_comments', arguments: '{"number":8}' },
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'issue-comments', callId: 'call-c', args: { number: 8 } }),
    ]);
  });

  it('reclaims every non-success terminal response before observing later continuations', () => {
    const ws = webSocketObserver();
    for (let index = 0; index < 68; index++) {
      const lane = `failed-lane-${index}`;
      const responseId = `failed-response-${index}`;
      ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
        type: 'response.create', stream_id: lane, input: `attempt ${index}`,
        tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
      })), binary: false });
      if (index % 2 === 0) {
        ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
          type: 'response.created', stream_id: lane, response: { id: responseId },
        })), binary: false });
        ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
          type: 'response.output_item.added', stream_id: lane, response_id: responseId,
          item: { id: `failed-item-${index}`, type: 'function_call', call_id: `failed-call-${index}`, name: 'mcp__workspace__read_file', arguments: '' },
        })), binary: false });
        ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
          type: 'response.function_call_arguments.delta', stream_id: lane, response_id: responseId,
          item_id: `failed-item-${index}`, delta: '{"path":"partial',
        })), binary: false });
      }
      const terminal = [
        { type: 'response.failed', stream_id: lane, response: { id: responseId } },
        { type: 'response.incomplete', stream_id: lane, response: { id: responseId } },
        { type: 'response.cancelled', stream_id: lane, response_id: responseId },
        { type: 'error', stream_id: lane, response_id: responseId, error: { message: 'synthetic' } },
      ][index % 4]!;
      expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify(terminal)), binary: false })).toEqual([]);
    }

    ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: 'failed-continuation', previous_response_id: 'failed-response-0', input: [],
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","stream_id":"failed-continuation","response":{"id":"failed-context-probe"}}'), binary: false });
    expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: 'failed-continuation', response_id: 'failed-context-probe',
      item: { type: 'function_call', call_id: 'failed-context-call', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/rejected"}' },
    })), binary: false })).toEqual([]);
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.completed","stream_id":"failed-continuation","response":{"id":"failed-context-probe"}}'), binary: false });

    const lane = 'valid-after-failures';
    ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: lane, input: 'read valid',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.created', stream_id: lane, response: { id: 'valid-response' },
    })), binary: false });
    expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: lane, response_id: 'valid-response',
      item: { type: 'function_call', call_id: 'valid-call', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/valid"}' },
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read', callId: 'valid-call' }),
    ]);
    ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.completed', stream_id: lane, response: { id: 'valid-response' },
    })), binary: false });

    ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: 'valid-continuation', previous_response_id: 'valid-response', input: [],
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","stream_id":"valid-continuation","response":{"id":"continued-response"}}'), binary: false });
    expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: 'valid-continuation', response_id: 'continued-response',
      item: { type: 'function_call', call_id: 'continued-call', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/continued"}' },
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read', callId: 'continued-call' }),
    ]);
  });

  it('drops analysis at the aggregate byte budget and releases it for a fresh socket observer', () => {
    const conn = connection();
    const ws = webSocketObserver(conn);
    ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', stream_id: 'budget-lane', input: 'read many',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","stream_id":"budget-lane","response":{"id":"budget-response"}}'), binary: false });
    for (let index = 0; index < 140; index++) {
      ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
        type: 'response.output_item.added', stream_id: 'budget-lane', response_id: 'budget-response',
        item: { id: `budget-item-${index}`, type: 'function_call', call_id: `budget-call-${index}`, name: 'mcp__workspace__read_file', arguments: '' },
      })), binary: false });
      ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
        type: 'response.function_call_arguments.delta', stream_id: 'budget-lane', response_id: 'budget-response',
        item_id: `budget-item-${index}`, delta: 'x'.repeat(64 * 1024),
      })), binary: false });
    }
    expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', stream_id: 'budget-lane', response_id: 'budget-response',
      item: { id: 'budget-final', type: 'function_call', call_id: 'budget-final', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/leaked"}' },
    })), binary: false })).toEqual([]);

    const fresh = webSocketObserver(conn);
    fresh.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', input: 'fresh',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false });
    fresh.observeServerMessage({ data: Buffer.from('{"type":"response.created","response":{"id":"fresh-response"}}'), binary: false });
    expect(fresh.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', response_id: 'fresh-response',
      item: { type: 'function_call', call_id: 'fresh-budget-call', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/fresh"}' },
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read', callId: 'fresh-budget-call' }),
    ]);
  });

  it('rejects oversized call names before retention without poisoning later calls', () => {
    const ws = webSocketObserver();
    ws.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', input: 'names',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from('{"type":"response.created","response":{"id":"name-response"}}'), binary: false });
    for (let index = 0; index < 256; index++) {
      ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
        type: 'response.output_item.added', response_id: 'name-response',
        item: { id: `name-item-${index}`, type: 'function_call', call_id: `name-call-${index}`, name: 'x'.repeat(2048), arguments: '' },
      })), binary: false });
    }

    ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.added', response_id: 'name-response',
      item: { id: 'bounded-item', type: 'function_call', call_id: 'bounded-name-call', name: 'mcp__workspace__read_file', arguments: '' },
    })), binary: false });
    ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.delta', response_id: 'name-response',
      item_id: 'bounded-item', delta: '{"path":"/work/name"}',
    })), binary: false });
    expect(ws.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', response_id: 'name-response',
      item: { id: 'bounded-item', type: 'function_call', call_id: 'bounded-name-call', name: 'mcp__workspace__read_file' },
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read', callId: 'bounded-name-call' }),
    ]);
  });

  it('does not reuse response context or route generations after reconnect', () => {
    let liveRoutes: readonly RegisteredRoute[] = routes;
    const adapter = makeAdapter(() => liveRoutes);
    const firstConnection = adapter.createConnection();
    const first = webSocketObserver(firstConnection);
    first.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', input: 'read',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false });
    first.observeServerMessage({ data: Buffer.from('{"type":"response.created","response":{"id":"old-response"}}'), binary: false });
    first.observeServerMessage({ data: Buffer.from('{"type":"response.completed","response":{"id":"old-response"}}'), binary: false });
    firstConnection.close();

    liveRoutes = [{ ...routes[0]!, routeId: 'workspace-read-new', generation: 2, instanceId: 'workspace-owner-new' }];
    const second = webSocketObserver(adapter.createConnection());
    second.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', previous_response_id: 'old-response', input: [],
    })), binary: false });
    second.observeServerMessage({ data: Buffer.from('{"type":"response.created","response":{"id":"new-unbound"}}'), binary: false });
    expect(second.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', response_id: 'new-unbound',
      item: { type: 'function_call', call_id: 'stale', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/a"}' },
    })), binary: false })).toEqual([]);

    second.observeClientMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.create', input: 'read again',
      tools: [functionTool('mcp__workspace__read_file', routes[0]!.inputSchema)],
    })), binary: false });
    second.observeServerMessage({ data: Buffer.from('{"type":"response.created","response":{"id":"new-bound"}}'), binary: false });
    expect(second.observeServerMessage({ data: Buffer.from(JSON.stringify({
      type: 'response.output_item.done', response_id: 'new-bound',
      item: { type: 'function_call', call_id: 'fresh', name: 'mcp__workspace__read_file', arguments: '{"path":"/work/a"}' },
    })), binary: false })).toEqual([
      expect.objectContaining({ kind: 'stream-call', routeId: 'workspace-read-new', callId: 'fresh' }),
    ]);
  });

  it('does not synthesize wrapper completions from Codex hook history', () => {
    const hookCase = fixture().cases.find((entry) => entry.id === 'codex-hook-subagent') as unknown as { events: unknown[] };
    const adapter = makeAdapter();

    expect(hookCase.events.flatMap((event) => adapter.normalizeHook(event))).toEqual([]);
  });
});
