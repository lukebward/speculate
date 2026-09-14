import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createObserverHarness } from './helpers/observerHarness.js';

const harnesses: ReturnType<typeof createObserverHarness>[] = [];
const repo = { owner: 'acme', repo: 'api' };

function fixture(name: 'claude' | 'codex'): unknown {
  const path = fileURLToPath(new URL(`fixtures/observer/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function textPayload(result: CallToolResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected text tool result');
  return JSON.parse(block.text) as unknown;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
});

describe('observer compatibility fixtures', () => {
  it('provides versioned Claude and Codex transport cases', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const value = fixture(agent) as {
        version: number;
        agent: string;
        cases: Array<{
          id: string;
          features: string[];
          response?: { utf8_split_chunks_base64?: string[] };
        }>;
      };
      expect(value.version).toBe(1);
      expect(value.agent).toBe(agent);
      expect(value.cases.flatMap((entry) => entry.features)).toEqual(
        expect.arrayContaining([
          'full_request',
          'incremental_request',
          'tool_definitions',
          'partial_arguments',
          'multiple_calls',
          'subagent',
          'error',
          'cancellation',
          'hooks',
        ]),
      );
      const split = value.cases.find((entry) => entry.features.includes('sse_byte_splits'))
        ?.response?.utf8_split_chunks_base64;
      expect(Buffer.concat(split!.map((part) => Buffer.from(part, 'base64'))).toString()).toBe(
        'event: delta\ndata: {"text":"café"}\n\n',
      );
    }
  });
});

describe('observer provider harness', () => {
  it('preserves request and SSE response bytes and records their order', async () => {
    const harness = createObserverHarness();
    harnesses.push(harness);
    const provider = await harness.startProvider({ transport: 'sse' });
    const body = Buffer.from('{"model":"synthetic","input":"caf\u00e9"}');
    const chunks = [
      Buffer.from('event: response.output_item.added\ndata: {"id":"call_'),
      Buffer.from('caf\u00e9"}\n\n'),
      Buffer.from('event: response.completed\ndata: {"ok":true}\n\n'),
    ];

    const result = await harness.exchange({
      request: {
        url: `${provider.baseUrl}/v1/responses?trace=fixture`,
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-token', 'x-fixture': 'preserve-me' },
        body,
      },
      chunks,
    });

    expect(result.originalPayload.equals(Buffer.concat(chunks))).toBe(true);
    expect(result.receivedPayload.equals(Buffer.concat(chunks))).toBe(true);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.body.equals(body)).toBe(true);
    expect(result.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/responses?trace=fixture',
      headers: expect.objectContaining({
        authorization: 'Bearer synthetic-token',
        'x-fixture': 'preserve-me',
      }),
    });
    expect(result.timestamps.responseChunks).toHaveLength(3);
    expect(result.timestamps.started).toBeLessThanOrEqual(result.timestamps.requestReceived);
    expect(result.timestamps.requestReceived).toBeLessThanOrEqual(result.timestamps.responseChunks[0]!);
    expect(result.timestamps.responseChunks[2]!).toBeLessThanOrEqual(result.timestamps.completed);
  });

  it('records downstream cancellation before later provider chunks are written', async () => {
    const harness = createObserverHarness();
    harnesses.push(harness);
    const provider = await harness.startProvider({ transport: 'sse' });

    const result = await harness.exchange({
      request: {
        url: `${provider.baseUrl}/v1/messages`,
        body: '{}',
        abortAfterChunks: 1,
      },
      chunks: [Buffer.from('first'), { body: Buffer.from('second'), delayMs: 25 }],
    });

    expect(result.cancelled).toBe(true);
    expect(result.receivedPayload.equals(Buffer.from('first'))).toBe(true);
    expect(result.timestamps.clientAbort).toBeDefined();
    expect(result.timestamps.providerAbort).toBeDefined();
    expect(result.timestamps.responseChunks).toHaveLength(1);
  });
});

describe('existing MCP proxy baseline', () => {
  it('preserves results, serves ready and in-flight predictions, and invalidates on mutation', async () => {
    const readyHarness = createObserverHarness();
    harnesses.push(readyHarness);
    const ready = await readyHarness.startToolServer({ alias: 'fixture', latencyMs: 120 });

    const issue = await ready.callTool('get_issue', { ...repo, issue_number: 42 });
    expect(textPayload(issue.result)).toEqual({
      number: 42,
      title: 'Rate limiter drops burst traffic',
      state: 'open',
      body: 'Token bucket refill is off by one; see PR #7.',
      labels: ['bug', 'p1'],
      comments_count: 2,
    });
    await ready.waitForCalls(3);
    const readyHit = await ready.callTool('get_issue_comments', { ...repo, issue_number: 42 });
    expect(textPayload(readyHit.result)).toEqual([
      { id: 3201, user: 'mara', body: 'Repro: 100 rps for 10s, ~3% dropped' },
      { id: 3202, user: 'devon', body: 'Fix in flight on fix/rate-limiter' },
    ]);
    expect(readyHit.elapsedMs).toBeLessThan(60);
    expect((await ready.stats()).hits).toBeGreaterThanOrEqual(1);

    const joinHarness = createObserverHarness();
    harnesses.push(joinHarness);
    const joining = await joinHarness.startToolServer({ alias: 'fixture', latencyMs: 180 });
    await joining.callTool('get_issue', { ...repo, issue_number: 42 });
    await joining.waitForCalls(2);
    const joined = await joining.callTool('get_issue_comments', { ...repo, issue_number: 42 });
    expect(textPayload(joined.result)).toEqual(textPayload(readyHit.result));
    expect((await joining.stats()).joins).toBeGreaterThanOrEqual(1);

    const invalidationHarness = createObserverHarness();
    harnesses.push(invalidationHarness);
    const invalidation = await invalidationHarness.startToolServer({ alias: 'fixture', latencyMs: 120 });
    await invalidation.callTool('get_issue', { ...repo, issue_number: 42 });
    await invalidation.waitForCalls(3);
    await invalidation.callTool('create_issue', { ...repo, title: 'Synthetic change' });
    const afterMutation = await invalidation.callTool('get_issue_comments', {
      ...repo,
      issue_number: 42,
    });
    expect(afterMutation.elapsedMs).toBeGreaterThanOrEqual(90);
    expect((await invalidation.stats()).invalidated).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
