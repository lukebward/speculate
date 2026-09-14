import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/agentAdapters/claude.js';
import type {
  AgentAdapterRequestObserver,
  Observation,
  RegisteredRoute,
  SessionContext,
} from '../src/observerTypes.js';

const context: SessionContext = {
  launchId: 'launch',
  conversationId: 'session_fixture_claude',
  agent: 'claude',
  cwd: '/work',
};

const routes: RegisteredRoute[] = [
  {
    routeId: 'workspace-read',
    generation: 1,
    instanceId: 'workspace-owner',
    hostClient: 'claude',
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
    hostClient: 'claude',
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
  return claudeAdapter({
    contextForConversation: (conversationId) => conversationId === context.conversationId ? context : null,
    routes: routeList,
    now: () => 50,
    eventId: (kind, stableId) => `${kind}:${stableId}:${++sequence}`,
  });
}

function requestObserver(
  adapter = makeAdapter(),
  headers: Record<string, string | string[] | undefined> = {
    'x-claude-code-session-id': context.conversationId,
    'content-type': 'application/json',
  },
): AgentAdapterRequestObserver {
  const connection = adapter.createConnection();
  const observer = connection.startRequest({
    transport: 'http',
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers,
  });
  if (!observer) throw new Error('expected request observer');
  return observer;
}

function fixture() {
  const path = fileURLToPath(new URL('fixtures/observer/claude.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as {
    cases: Array<{
      id: string;
      request?: { body?: unknown };
      response?: { chunks?: string[]; utf8_split_chunks_base64?: string[] };
      events?: unknown[];
    }>;
  };
}

function streamEvents(observer: AgentAdapterRequestObserver, chunks: readonly Buffer[]): Observation[] {
  const observations: Observation[] = [];
  observations.push(...observer.observeResponseStart({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }));
  for (const chunk of chunks) observations.push(...observer.observeResponseChunk(chunk));
  observations.push(...observer.observeResponseEnd());
  return observations;
}

describe('Claude adapter', () => {
  it('normalizes only the current user prompt from a Messages request', () => {
    const data = fixture();
    const body = data.cases.find((entry) => entry.id === 'messages-full-tool-definition')!.request!.body!;
    const observer = requestObserver();

    const observations = observer.observeRequestBody(Buffer.from(JSON.stringify(body)));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: 'prompt',
      context,
      observedAt: 50,
      text: 'Read /workspace/notes.txt',
    });
  });

  it('finds the current human prompt before trailing tool results', () => {
    const observer = requestObserver();
    const observations = observer.observeRequestBody(Buffer.from(JSON.stringify({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect the current files.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'mcp__workspace__read_file', input: { path: '/work/a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] },
      ],
    })));

    expect(observations).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Inspect the current files.' }),
    ]);
  });

  it('emits tool calls only at completed SSE block boundaries across UTF-8 and JSON splits', () => {
    const data = fixture();
    const testCase = data.cases.find((entry) => entry.id === 'messages-continuation-sse-split')!;
    const observer = requestObserver();
    observer.observeRequestBody(Buffer.from(JSON.stringify(testCase.request!.body)));
    const source = Buffer.from(testCase.response!.chunks!.join(''));
    const cafe = Buffer.from('café');
    const splitAt = source.indexOf(cafe) + 4;
    const chunks = [source.subarray(0, splitAt), source.subarray(splitAt, splitAt + 1), source.subarray(splitAt + 1)];

    expect(observer.observeResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })).toEqual([]);
    expect(observer.observeResponseChunk(chunks[0]!)).toEqual([]);
    expect(observer.observeResponseChunk(chunks[1]!)).toEqual([]);
    const completed = observer.observeResponseChunk(chunks[2]!);
    expect(observer.observeResponseEnd()).toEqual([]);

    expect(completed).toEqual([
      expect.objectContaining({
        kind: 'stream-call',
        context,
        routeId: 'workspace-read',
        callId: 'toolu_fixture_002',
        args: { path: '/workspace/café.txt' },
      }),
      expect.objectContaining({
        kind: 'stream-call',
        context,
        routeId: 'issue-comments',
        callId: 'toolu_fixture_003',
        args: { number: 7 },
      }),
    ]);
  });

  it('normalizes complete non-streaming tool-use blocks', () => {
    const data = fixture();
    const testCase = data.cases.find((entry) => entry.id === 'messages-full-tool-definition')!;
    const observer = requestObserver(makeAdapter(() => [{
      ...routes[0]!,
      inputSchema: { ...routes[0]!.inputSchema, additionalProperties: false },
    }]));
    observer.observeRequestBody(Buffer.from(JSON.stringify(testCase.request!.body)));
    observer.observeResponseStart({ status: 200, headers: { 'content-type': 'application/json' } });
    observer.observeResponseChunk(Buffer.from(JSON.stringify((testCase as { response?: { body?: unknown } }).response!.body)));

    expect(observer.observeResponseEnd()).toEqual([
      expect.objectContaining({
        kind: 'stream-call',
        routeId: 'workspace-read',
        callId: 'toolu_fixture_001',
        args: { path: '/workspace/notes.txt' },
      }),
    ]);
  });

  it('requires one exact live alias and the exact advertised schema', () => {
    const changedSchema = [{ ...routes[0]!, inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }];
    const ambiguous = [routes[0]!, { ...routes[0]!, routeId: 'duplicate', instanceId: 'duplicate-owner' }];
    const response = Buffer.from([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"known","name":"mcp__workspace__read_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/work/a\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    ].join(''));
    const request = {
      messages: [{ role: 'user', content: 'read it' }],
      tools: [{ name: 'mcp__workspace__read_file', input_schema: routes[0]!.inputSchema }],
    };

    for (const liveRoutes of [changedSchema, ambiguous, []]) {
      const observer = requestObserver(makeAdapter(() => liveRoutes));
      observer.observeRequestBody(Buffer.from(JSON.stringify(request)));
      expect(streamEvents(observer, [response])).toEqual([]);
    }
  });

  it('ignores deferred, provider-owned, unknown and reasoning blocks', () => {
    const observer = requestObserver();
    observer.observeRequestBody(Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [
        { name: 'mcp__workspace__read_file', defer_loading: true, input_schema: routes[0]!.inputSchema },
        { type: 'computer_20250124', name: 'computer' },
      ],
    })));
    const events = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"secret","signature":"opaque"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"deferred","name":"mcp__workspace__read_file","input":{"path":"/work/a"}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"provider","name":"web_search","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
    ];

    expect(streamEvents(observer, events.map((event) => Buffer.from(event)))).toEqual([]);
  });

  it.each([
    [{ 'content-type': 'text/event-stream', 'content-encoding': 'br' }, 200],
    [{ 'content-type': 'application/x-unknown' }, 200],
    [{ 'content-type': 'text/event-stream' }, 429],
  ])('abstains for encoded, unsupported, or error responses', (headers, status) => {
    const observer = requestObserver();
    observer.observeRequestBody(Buffer.from(JSON.stringify({ messages: [], tools: [] })));
    observer.observeResponseStart({ status, headers });

    expect(observer.observeResponseChunk(Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n'))).toEqual([]);
    expect(observer.observeResponseEnd()).toEqual([]);
  });

  it('abstains from request inspection for unknown content encoding and oversized bodies', () => {
    const encoded = requestObserver(makeAdapter(), {
      'x-claude-code-session-id': context.conversationId,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    expect(encoded.observeRequestBody(Buffer.from('{"messages":[{"role":"user","content":"secret"}]}'))).toEqual([]);

    const oversized = requestObserver();
    expect(oversized.observeRequestBody(Buffer.alloc(2 * 1024 * 1024 + 1, 120))).toEqual([]);

    const oversizedResponse = requestObserver();
    oversizedResponse.observeRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
    oversizedResponse.observeResponseStart({ status: 200, headers: { 'content-type': 'application/json' } });
    expect(oversizedResponse.observeResponseChunk(Buffer.alloc(2 * 1024 * 1024 + 1, 120))).toEqual([]);
    expect(oversizedResponse.observeResponseEnd()).toEqual([]);
  });

  it('normalizes prompt hooks and does not duplicate wrapper-authoritative completions', () => {
    const data = fixture();
    const adapter = makeAdapter();
    const promptEvents = adapter.normalizeHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: context.conversationId,
      prompt: 'Inspect the current files.',
    });
    const postToolUse = data.cases.find((entry) => entry.id === 'claude-hook-subagent')!.events![1];

    expect(promptEvents).toEqual([
      expect.objectContaining({ kind: 'prompt', context, text: 'Inspect the current files.' }),
    ]);
    expect(adapter.normalizeHook(postToolUse)).toEqual([]);
  });

  it('discards partial state after abort and connection teardown', () => {
    const adapter = makeAdapter();
    const connection = adapter.createConnection();
    const observer = connection.startRequest({
      transport: 'http',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': context.conversationId },
    })!;
    observer.observeRequestBody(Buffer.from(JSON.stringify({
      messages: [],
      tools: [{ name: 'mcp__workspace__read_file', input_schema: routes[0]!.inputSchema }],
    })));
    observer.observeResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } });
    observer.observeResponseChunk(Buffer.from('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"partial","name":"mcp__workspace__read_file","input":{}}}\n\n'));
    observer.abort();
    connection.close();

    expect(observer.observeResponseChunk(Buffer.from('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'))).toEqual([]);
    expect(observer.observeResponseEnd()).toEqual([]);
  });
});
