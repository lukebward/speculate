/**
 * Recorded sessions and their offline replay (bench/trace.ts): what a kept
 * event stream is read as, and that the replay drives the core the way the
 * hooks do.
 */
import { describe, expect, it } from 'vitest';
import { extractTrace, replayTraces, type Trace, type TraceCall } from '../bench/trace.js';
import type { StreamLine } from '../bench/measure.js';

const T0 = Date.parse('2026-11-21T16:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (event: object): StreamLine => ({ at: 0, line: JSON.stringify(event) });
const use = (ms: number, id: string, name: string, input: object): StreamLine =>
  line({ type: 'assistant', timestamp: at(ms), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (ms: number, id: string, content: unknown, isError = false): StreamLine =>
  line({ type: 'user', timestamp: at(ms), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

describe('extractTrace', () => {
  it('reads each MCP call with its result, its form, and its place in the session', () => {
    const trace = extractTrace(
      [
        line({ type: 'system', subtype: 'init' }), // no timestamp: read back from a file
        line({ type: 'system', subtype: 'status', timestamp: at(0) }),
        use(1_000, 'a', 'ToolSearch', { query: 'x' }),
        result(1_020, 'a', [{ type: 'tool_reference' }]),
        use(2_000, 'b', 'mcp__docs__search', { query: 'q' }),
        result(2_500, 'b', '{"results":[]}'),
        use(4_000, 'c', 'mcp__docs__fetch', { url: 'u' }),
        result(4_300, 'c', [{ type: 'text', text: 'page' }, { type: 'text', text: 'two' }]),
        use(5_000, 'd', 'mcp__docs__fetch', { url: 'bad' }),
        result(5_050, 'd', 'no such page', true),
      ],
      'one',
    );
    expect(trace.label).toBe('one');
    expect(trace.calls).toEqual<TraceCall[]>([
      { server: 'docs', tool: 'search', args: { query: 'q' }, text: '{"results":[]}', form: 'text', isError: false, startMs: 2_000, latencyMs: 500 },
      { server: 'docs', tool: 'fetch', args: { url: 'u' }, text: 'page\ntwo', form: 'blocks', isError: false, startMs: 4_000, latencyMs: 300 },
      { server: 'docs', tool: 'fetch', args: { url: 'bad' }, text: 'no such page', form: 'text', isError: true, startMs: 5_000, latencyMs: 50 },
    ]);
  });

  it('orders calls by when the model made them and skips a subagent and noise', () => {
    const trace = extractTrace(
      [
        line({ type: 'system', timestamp: at(0) }),
        { at: 0, line: 'not json' },
        use(900, 'b', 'mcp__s__second', {}),
        use(800, 'a', 'mcp__s__first', {}),
        { at: 0, line: JSON.stringify({ type: 'assistant', timestamp: at(850), parent_tool_use_id: 't', message: { content: [{ type: 'tool_use', id: 'sub', name: 'mcp__s__inner', input: {} }] } }) },
        result(1_000, 'a', 'x'),
        result(1_100, 'b', 'y'),
        result(1_200, 'never-called', 'z'),
      ],
      'two',
    );
    expect(trace.calls.map(call => [call.tool, call.startMs])).toEqual([['first', 800], ['second', 900]]);
  });
});

/** A session that lists, thinks a second, then reads the item the list named. */
function session(label: string, id: number): Trace {
  return {
    label,
    calls: [
      { server: 's', tool: 'list_items', args: { state: 'open' }, text: JSON.stringify({ items: [{ id }] }), form: 'blocks', isError: false, startMs: 1_000, latencyMs: 400 },
      { server: 's', tool: 'get_item', args: { id }, text: JSON.stringify({ id, body: 'b' }), form: 'blocks', isError: false, startMs: 2_400, latencyMs: 400 },
    ],
  };
}

describe('replayTraces', () => {
  it('serves what the core learned from earlier sessions, memory carried between them', async () => {
    const report = await replayTraces([session('s1', 11), session('s2', 22), session('s3', 33), session('s4', 44)], { warmup: 2 });
    expect(report.sessions.map(s => s.label)).toEqual(['s3', 's4']);
    // By the third session the list predicts the read of its item, a new id each time.
    for (const replayed of report.sessions) {
      expect(replayed.calls.find(call => call.tool === 'get_item')).toMatchObject({ served: true });
      expect(replayed.prefetched.some(call => call.tool === 'get_item')).toBe(true);
    }
    expect(report.calls).toBe(4);
    expect(report.served).toBeGreaterThanOrEqual(2);
    expect(report.prefetches).toBeGreaterThanOrEqual(report.served);
    expect(report.recallAt3).not.toBeNull();
  });

  it('serves nothing from nothing learned', async () => {
    const report = await replayTraces([session('only', 1)]);
    expect(report).toMatchObject({ calls: 2, served: 0, prefetches: 0 });
    expect(report.sessions[0]!.calls.every(call => !call.served)).toBe(true);
  });

  it('runs together the calls the model made together', async () => {
    const pair = (label: string, a: number, b: number): Trace => ({
      label,
      calls: [
        { server: 's', tool: 'list_items', args: {}, text: JSON.stringify({ items: [{ id: a }, { id: b }] }), form: 'blocks', isError: false, startMs: 1_000, latencyMs: 300 },
        // Both reads start before either ends: one step of the model.
        { server: 's', tool: 'get_item', args: { id: a }, text: '{}', form: 'blocks', isError: false, startMs: 2_500, latencyMs: 500 },
        { server: 's', tool: 'get_item', args: { id: b }, text: '{}', form: 'blocks', isError: false, startMs: 2_550, latencyMs: 500 },
      ],
    });
    const report = await replayTraces([pair('a', 1, 2), pair('b', 3, 4), pair('c', 5, 6), pair('d', 7, 8)], { warmup: 3 });
    expect(report.calls).toBe(3);
    expect(report.sessions[0]!.calls).toHaveLength(3);
  });

  it('keeps an errored call out of what is served or learned as servable', async () => {
    const failing: Trace = {
      label: 'f',
      calls: [{ server: 's', tool: 'get_item', args: { id: 1 }, text: 'boom', form: 'text', isError: true, startMs: 500, latencyMs: 50 }],
    };
    const report = await replayTraces([failing, failing, failing]);
    expect(report.served).toBe(0);
    expect(report.sessions.flatMap(s => s.calls).every(call => call.isError)).toBe(true);
  });
});
