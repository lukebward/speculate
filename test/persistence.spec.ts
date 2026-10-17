/**
 * Persistence layer (DESIGN.md §13.6): MemoryCodec decode/encode semantics
 * over a simulated plugin-store value, concurrent-session merge, learner
 * export/import round-trip, and rule-feedback priors with decay.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_STATE_BYTES,
  MemoryCodec,
  byteLength,
  mergePersistedState,
  type PersistedState,
} from '../src/persistence.js';
import { TransitionLearner } from '../src/learner.js';
import { LatencyModel } from '../src/latency.js';
import { Metrics } from '../src/metrics.js';
import { ToolKnowledge } from '../src/tools.js';
import type { ObservedCall } from '../src/types.js';

function call(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  parsed: unknown,
  timestamp: number,
): ObservedCall {
  return { server, tool, args, result: { content: [] }, parsed, timestamp, latencyMs: 10 };
}

/** What `$.store.set` would keep: the value survives a JSON round trip. */
const stored = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const DAY = 24 * 60 * 60_000;

/** A shape-detectable credential (the guard has no runtime secret values). */
const BEARER = 'Bearer canaryToken0123456789abcdef';

function transition(nextTool: string, lastUpdated: number, extra: Record<string, unknown> = {}) {
  return { server: 's', prevTool: 'list', nextTool, count: 2, lastUpdated, templates: [], ...extra };
}

describe('MemoryCodec', () => {
  it('filters credential-shaped values and names before encoding', () => {
    const codec = new MemoryCodec(() => 100);
    const encoded = codec.encode({
      learner: {
        transitions: [{
          server: 's', prevTool: 'a', nextTool: 'b', count: 2, lastUpdated: 100,
          templates: [{ name: 'id', underivable: false, derived: 2, missed: 0, sources: [
            { kind: 'parsed', sourceTool: 'a', path: ['id'], score: 2, lastUpdated: 100 },
            { kind: 'const', repr: JSON.stringify(BEARER), score: 1, lastUpdated: 100 },
          ] }],
          contexts: [],
        }],
        openers: [{ server: 's', tool: 'b', argsRepr: JSON.stringify({ password: 'hunter2-canary' }), count: 2, lastUpdated: 100 }],
      },
      ruleFeedback: {},
    }, null);
    const bytes = JSON.stringify(encoded);
    expect(bytes).not.toContain('canaryToken');
    expect(bytes).not.toContain('hunter2-canary');
    expect(bytes).toContain('sourceTool');
    expect(codec.diagnostics.removedSensitive).toBeGreaterThanOrEqual(2);
    expect(encoded.memory?.removedSensitive).toBeGreaterThanOrEqual(2);
  });

  it('sanitizes legacy stored state before the merge can copy it forward', () => {
    const legacy = {
      version: 1, savedAt: 100, learner: { transitions: [{
        server: 's', prevTool: 'a', nextTool: 'b', count: 2, lastUpdated: 100,
        templates: [{ name: 'id', underivable: false, derived: 2, missed: 0,
          sources: [{ kind: 'const', repr: JSON.stringify(BEARER), score: 2, lastUpdated: 100 }] }],
      }] }, ruleFeedback: {},
    };
    const codec = new MemoryCodec(() => 101);
    expect(codec.load(stored(legacy))?.learner).toMatchObject({ transitions: [] });
    const encoded = codec.encode({ learner: { transitions: [] }, ruleFeedback: {} }, stored(legacy));
    expect(JSON.stringify(encoded)).not.toContain('canaryToken');
    // Even without a prior load, the latest value is sanitized before merging.
    const fresh = new MemoryCodec(() => 101);
    expect(JSON.stringify(fresh.encode({ learner: { transitions: [] }, ruleFeedback: {} }, stored(legacy))))
      .not.toContain('canaryToken');
  });

  it('allowlists aggregate snapshots instead of retaining unknown legacy payload fields', () => {
    const canary = 'unknown-field-canary-0123456789';
    const codec = new MemoryCodec(() => 100);
    const encoded = codec.encode({
      learner: { transitions: [], extra: canary } as never,
      ruleFeedback: { r: { hits: 1, wasted: 0, speculated: 1, payload: canary } as never },
      candidateFeedback: { c: { correct: 1, evaluated: 1, lastUpdated: 100, payload: canary } as never },
      latency: {
        version: 1,
        tools: [{ server: 's', tool: 't', weight: 1, meanMs: 1, m2Ms2: 0, observations: 1, lastUpdated: 100, payload: canary }],
        servers: [],
      } as never,
      tools: { s: { t: { readOnly: true, servable: true, shapes: [], lastSeen: 100, payload: canary } } } as never,
    }, { version: 1, savedAt: 50, learner: { transitions: [] }, ruleFeedback: {}, unknown: canary });
    const bytes = JSON.stringify(encoded);
    expect(bytes).not.toContain(canary);
    expect(bytes).not.toContain('payload');
    expect(bytes).not.toContain('unknown');
    expect(encoded.ruleFeedback['r']).toEqual({ hits: 1, wasted: 0, speculated: 1 });
    expect(encoded.latency?.tools).toHaveLength(1);
    expect(encoded.tools?.['s']?.['t']).toEqual({ readOnly: true, servable: true, shapes: [], lastSeen: 100 });
  });

  it('drops credential-shaped rule and candidate feedback keys', () => {
    const codec = new MemoryCodec(() => 100);
    const encoded = codec.encode({
      learner: { transitions: [] },
      ruleFeedback: { [BEARER]: { hits: 1, wasted: 0, speculated: 1 }, ok: { hits: 1, wasted: 0, speculated: 1 } },
      candidateFeedback: { [BEARER]: { correct: 1, evaluated: 1, lastUpdated: 100 } },
    }, null);
    expect(Object.keys(encoded.ruleFeedback)).toEqual(['ok']);
    expect(encoded.candidateFeedback).toBeUndefined();
    expect(JSON.stringify(encoded)).not.toContain('canaryToken');
  });

  it('expires old entries and uses savedAt for legacy timestamps', () => {
    const legacy = {
      version: 1, savedAt: DAY, learner: { transitions: [{
        server: 's', prevTool: 'old', nextTool: 'gone', count: 2, templates: [],
      }] }, ruleFeedback: { old: { hits: 1, wasted: 0, speculated: 1 } },
    };
    const codec = new MemoryCodec(() => 40 * DAY, { retentionDays: 30 });
    const loaded = codec.load(stored(legacy))!;
    expect(loaded.learner).toMatchObject({ transitions: [] });
    expect(loaded.ruleFeedback).toEqual({});
    expect(codec.diagnostics.removedExpired).toBeGreaterThanOrEqual(2);
  });

  it('stamps undated legacy entries with savedAt when they are within retention', () => {
    const legacy = {
      version: 1, savedAt: 35 * DAY, learner: { transitions: [{
        server: 's', prevTool: 'a', nextTool: 'b', count: 2, templates: [],
      }] }, ruleFeedback: { r: { hits: 1, wasted: 0, speculated: 1 } },
    };
    const codec = new MemoryCodec(() => 40 * DAY, { retentionDays: 30 });
    const loaded = codec.load(stored(legacy))!;
    expect((loaded.learner as { transitions: Array<{ lastUpdated: number }> }).transitions)
      .toEqual([expect.objectContaining({ nextTool: 'b', lastUpdated: 35 * DAY })]);
    // Feedback keeps its legacy (undated) form so Metrics applies its one compatibility decay.
    expect(loaded.ruleFeedback['r']).toEqual({ hits: 1, wasted: 0, speculated: 1 });
    expect(codec.diagnostics.removedExpired).toBe(0);
  });

  it('measures size in UTF-8 bytes of the JSON text', () => {
    expect(byteLength('a')).toBe(3);
    expect(byteLength('é')).toBe(4);
    expect(byteLength('€')).toBe(5);
    expect(byteLength('😀')).toBe(6);
    expect(byteLength({ k: 'é' })).toBe(new TextEncoder().encode(JSON.stringify({ k: 'é' })).length);
  });

  it('trims weak entries to the configured UTF-8 byte cap', () => {
    // Multi-byte filler: the JSON text is ~half the UTF-8 size, so a cap that
    // counted UTF-16 code units would let this through untrimmed.
    const transitions = Array.from({ length: 40 }, (_, i) => ({
      server: 's', prevTool: `a${i}`, nextTool: `b${i}`, count: 2, score: i + 1, lastUpdated: i + 1,
      templates: [{ name: 'query', underivable: false, derived: 2, missed: 0,
        sources: [{ kind: 'const', repr: JSON.stringify(`ordinary-${i}-${'é'.repeat(1000)}`), score: 1, lastUpdated: i + 1 }] }],
    }));
    expect(JSON.stringify({ transitions }).length).toBeLessThan(65_536);
    const codec = new MemoryCodec(() => 101, { maxBytes: 65_536 });
    const encoded = codec.encode({ learner: { transitions }, ruleFeedback: {} }, null);
    expect(byteLength(encoded)).toBeLessThanOrEqual(65_536);
    expect(codec.diagnostics.trimmedForSize).toBeGreaterThan(0);
    expect(encoded.memory?.trimmedForSize).toBe(codec.diagnostics.trimmedForSize);
    // The weakest (lowest score) go first; the strongest survive.
    const kept = (encoded.learner as { transitions: Array<{ prevTool: string }> }).transitions.map((t) => t.prevTool);
    expect(kept).toContain('a39');
    expect(kept).not.toContain('a0');
  });

  it('trims tool facts, least recently seen first, so encode stays under the cap', () => {
    const codec = new MemoryCodec(() => 10 * DAY, { maxBytes: 65_536 });
    const tools: Record<string, Record<string, unknown>> = { s: {} };
    for (let i = 0; i < 2_000; i++) {
      tools.s![`tool_${i}`] = {
        readOnly: true,
        servable: true,
        shapes: Array.from({ length: 8 }, (_, j) => `a${j},b${i}`),
        lastSeen: 9 * DAY + i,
      };
    }
    const out = codec.encode({ learner: { transitions: [], openers: [] }, ruleFeedback: {}, tools: tools as never }, undefined);
    expect(byteLength(out)).toBeLessThanOrEqual(65_536);
    const kept = Object.keys(out.tools?.s ?? {});
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toContain('tool_1999');
    expect(kept).not.toContain('tool_0');
    expect(out.memory?.trimmedForSize).toBeGreaterThan(0);
  });

  it('counts every credential-shaped removal in the stored memory aggregate', () => {
    const codec = new MemoryCodec(() => DAY);
    const out = codec.encode({
      learner: { transitions: [], openers: [] },
      ruleFeedback: { [BEARER]: { hits: 1, wasted: 0, speculated: 1, lastUpdated: DAY } },
    }, undefined);
    expect(out.ruleFeedback).toEqual({});
    expect(out.memory?.removedSensitive).toBe(1);
  });

  it('counts expired tool facts as expired', () => {
    const codec = new MemoryCodec(() => 100 * DAY, { retentionDays: 30 });
    const out = codec.encode({
      learner: { transitions: [], openers: [] },
      ruleFeedback: {},
      tools: { s: { old: { readOnly: true, servable: true, shapes: [], lastSeen: DAY } } },
    }, undefined);
    expect(out.tools).toBeUndefined();
    expect(out.memory?.removedExpired).toBe(1);
  });

  it('refuses an oversized stored value instead of decoding it', () => {
    const huge = {
      version: 1, savedAt: 100, ruleFeedback: {},
      learner: { transitions: [transition('b', 100, { pad: 'x'.repeat(2 * 65_536) })] },
    };
    const codec = new MemoryCodec(() => 100, { maxBytes: 65_536 });
    expect(codec.load(huge)).toBeNull();
    expect(codec.diagnostics.oversizedReads).toBe(1);
    // An oversized latest value is treated as absent rather than merged.
    const encoded = codec.encode({ learner: { transitions: [transition('c', 100)] }, ruleFeedback: {} }, huge);
    expect(codec.diagnostics.oversizedReads).toBe(2);
    expect((encoded.learner as { transitions: Array<{ nextTool: string }> }).transitions.map((t) => t.nextTool))
      .toEqual(['c']);
  });

  it('decodes corrupt and version-mismatched values as cold starts', () => {
    const codec = new MemoryCodec();
    for (const raw of [undefined, null, '{not json', 42, [], { version: 999, ruleFeedback: {} },
      { version: 1 }, { version: 1, ruleFeedback: [] }, { version: 1, ruleFeedback: null }]) {
      expect(codec.load(raw)).toBeNull();
    }
    const encoded = codec.encode({ learner: { transitions: [] }, ruleFeedback: { r: { hits: 1, wasted: 0, speculated: 1 } } }, '{not json');
    expect(encoded.ruleFeedback['r']).toMatchObject({ hits: 1 });
  });

  it('clamps the policy to supported retention and byte bounds', () => {
    const memory = (policy: ConstructorParameters<typeof MemoryCodec>[1]) =>
      new MemoryCodec(() => 0, policy).encode({ learner: { transitions: [] }, ruleFeedback: {} }, null).memory;
    expect(memory({ maxBytes: 65_536, retentionDays: 7 })).toMatchObject({ maxBytes: 65_536, retentionDays: 7 });
    expect(memory({ maxBytes: 65_535 })?.maxBytes).toBe(DEFAULT_MAX_STATE_BYTES);
    expect(memory({ maxBytes: DEFAULT_MAX_STATE_BYTES + 1 })?.maxBytes).toBe(DEFAULT_MAX_STATE_BYTES);
    expect(memory({ retentionDays: 0 })?.retentionDays).toBe(30);
    expect(memory({ retentionDays: 1.5 })?.retentionDays).toBe(30);
    expect(DEFAULT_MAX_STATE_BYTES).toBe(3 * 1024 * 1024);
  });

  it('round-trips state through the store', () => {
    const codec = new MemoryCodec(() => 1234);
    expect(codec.load(undefined)).toBeNull(); // first run: cold start
    const value = stored(codec.encode({
      learner: { transitions: [] },
      ruleFeedback: { r: { hits: 1, wasted: 0, speculated: 2 } },
    }, undefined));
    const loaded = new MemoryCodec(() => 1234).load(value);
    expect(loaded?.version).toBe(1);
    expect(loaded?.savedAt).toBe(1234);
    expect(loaded?.ruleFeedback['r']).toEqual({ hits: 1, wasted: 0, speculated: 2 });
    expect(loaded).not.toHaveProperty('scope');
  });

  it('round-trips optional latency state without breaking legacy values', () => {
    const latency = new LatencyModel({ now: () => 1_000 });
    latency.observe('s', 'slow', 180);
    const value = stored(new MemoryCodec(() => 1_000).encode({
      learner: { transitions: [] },
      ruleFeedback: {},
      latency: latency.exportState(),
    }, null));
    const loaded = new MemoryCodec(() => 1_000).load(value);
    const restored = new LatencyModel({ now: () => 1_000 });
    restored.importState(loaded?.latency);
    expect(restored.estimate('s', 'slow')).toMatchObject({ source: 'tool', expectedMs: 180 });

    expect(new MemoryCodec(() => 2_000).load({
      version: 1, savedAt: 2_000, learner: { transitions: [] }, ruleFeedback: {},
    })?.latency).toBeUndefined();
  });

  it('round-trips tool facts so a known read is eligible before its first call', () => {
    const knowledge = new ToolKnowledge(() => 500);
    knowledge.record('s', 'read', { readOnly: true, servable: true, args: { path: 'a', depth: 1 } });
    knowledge.record('s', 'write', { readOnly: false, servable: true, args: { path: 'a' } });
    const value = stored(new MemoryCodec(() => 500).encode({
      learner: { transitions: [] }, ruleFeedback: {}, tools: knowledge.exportState(),
    }, null));
    const loaded = new MemoryCodec(() => 600).load(value);
    const restored = new ToolKnowledge(() => 600);
    restored.importState(loaded?.tools);
    expect(restored.eligibility('s', 'read')).toEqual({ eligible: true, reason: 'read-only' });
    expect(restored.eligibility('s', 'write')).toMatchObject({ eligible: false, reason: 'not-read-only' });
    expect(restored.hasShape('s', 'read', ['path', 'depth'])).toBe(true);
    expect(JSON.stringify(value)).not.toContain('"a"'); // keys only, never argument values
  });

  it('drops expired and credential-shaped tool facts at encode and load', () => {
    const codec = new MemoryCodec(() => 40 * DAY, { retentionDays: 30 });
    const encoded = codec.encode({
      learner: { transitions: [] },
      ruleFeedback: {},
      tools: {
        s: {
          old: { readOnly: true, servable: true, shapes: ['id'], lastSeen: DAY },
          fresh: { readOnly: true, servable: true, shapes: ['id', BEARER], lastSeen: 39 * DAY },
          [BEARER]: { readOnly: true, servable: true, shapes: [], lastSeen: 39 * DAY },
        },
      },
    }, null);
    expect(encoded.tools).toEqual({ s: { fresh: { readOnly: true, servable: true, shapes: ['id'], lastSeen: 39 * DAY } } });
    expect(encoded.memory?.removedSensitive).toBeGreaterThanOrEqual(2);
  });

  it('two sessions sharing one store value do not erase each other', () => {
    // A simulated plugin store: one value, read before and written after each save.
    let store: unknown = stored({
      version: 1, savedAt: 1_000,
      learner: { transitions: [] },
      ruleFeedback: { r: { hits: 10, wasted: 0, speculated: 10, lastUpdated: 1_000 } },
    } satisfies PersistedState);
    const a = new MemoryCodec(() => 1_000);
    const b = new MemoryCodec(() => 1_000);
    a.load(store);
    b.load(store);
    const feedback = (hits: number) => ({ r: { hits, wasted: 0, speculated: hits, lastUpdated: 1_000 } });

    // Each session learned one extra hit and one new transition since load.
    store = stored(a.encode({ learner: { transitions: [transition('get_a', 1_000)] }, ruleFeedback: feedback(11) }, store));
    store = stored(b.encode({ learner: { transitions: [transition('get_b', 1_000)] }, ruleFeedback: feedback(11) }, store));
    const nextTools = (value: unknown) => ((value as PersistedState).learner as { transitions: Array<{ nextTool: string }> })
      .transitions.map((t) => t.nextTool).sort();
    expect(nextTools(store)).toEqual(['get_a', 'get_b']);
    expect((store as PersistedState).ruleFeedback['r']).toMatchObject({ hits: 12, speculated: 12 });

    // A saves again with nothing new: its delta was already counted once.
    store = stored(a.encode({ learner: { transitions: [transition('get_a', 1_000)] }, ruleFeedback: feedback(11) }, store));
    expect(nextTools(store)).toEqual(['get_a', 'get_b']);
    expect((store as PersistedState).ruleFeedback['r']).toMatchObject({ hits: 12, speculated: 12 });
  });

  it('merges concurrent tool facts newest-wins with shapes unioned', () => {
    let store: unknown = null;
    const a = new MemoryCodec(() => 100);
    const b = new MemoryCodec(() => 200);
    a.load(store);
    b.load(store);
    store = stored(a.encode({
      learner: { transitions: [] }, ruleFeedback: {},
      tools: { s: {
        t: { readOnly: true, servable: true, shapes: ['a'], lastSeen: 100 },
        onlyA: { readOnly: true, servable: true, shapes: [], lastSeen: 100 },
      } },
    }, store));
    store = stored(b.encode({
      learner: { transitions: [] }, ruleFeedback: {},
      tools: { s: { t: { readOnly: false, servable: true, shapes: ['b'], lastSeen: 200 } } },
    }, store));
    expect((store as PersistedState).tools).toEqual({ s: {
      t: { readOnly: false, servable: true, shapes: ['b', 'a'], lastSeen: 200 },
      onlyA: { readOnly: true, servable: true, shapes: [], lastSeen: 100 },
    } });
  });
});

describe('mergePersistedState', () => {
  it('merges disjoint concurrent learner entities instead of last-writer loss', () => {
    const merged = mergePersistedState(
      {
        version: 1,
        savedAt: 1,
        learner: { transitions: [transition('get_a', 1)] },
        ruleFeedback: { a: { hits: 1, wasted: 0, speculated: 1 } },
      },
      {
        version: 1,
        savedAt: 2,
        learner: { transitions: [transition('get_b', 2)] },
        ruleFeedback: { b: { hits: 0, wasted: 1, speculated: 1 } },
      },
    );
    expect((merged.learner as { transitions: Array<{ nextTool: string }> }).transitions
      .map((item) => item.nextTool)
      .sort()).toEqual(['get_a', 'get_b']);
    expect(Object.keys(merged.ruleFeedback).sort()).toEqual(['a', 'b']);
  });

  it('adds same-rule feedback deltas without double-counting the shared baseline', () => {
    const state = (hits: number, savedAt: number) => ({
      version: 1 as const,
      savedAt,
      learner: { transitions: [] },
      ruleFeedback: {
        r: { hits, wasted: 0, speculated: hits, lastUpdated: savedAt },
      },
    });
    const merged = mergePersistedState(state(12, 0), state(11, 0), state(10, 0));
    expect(merged.ruleFeedback['r']).toMatchObject({ hits: 13, speculated: 13 });
  });

  it('merges concurrent latency deltas without counting the baseline twice', () => {
    const model = (values: number[]) => {
      const latency = new LatencyModel({ now: () => 0 });
      for (const value of values) latency.observe('s', 't', value);
      return latency.exportState();
    };
    const state = (latency: ReturnType<LatencyModel['exportState']>, savedAt: number) => ({
      version: 1 as const,
      savedAt,
      learner: { transitions: [] },
      ruleFeedback: {},
      latency,
    });
    const baseline = state(model([100]), 0);
    const merged = mergePersistedState(
      state(model([100, 200]), 0),
      state(model([100, 300]), 0),
      baseline,
    );
    const restored = new LatencyModel({ now: () => 0 });
    restored.importState(merged.latency);
    expect(restored.estimate('s', 't').expectedMs).toBeCloseTo(200);
    expect(merged.latency?.tools[0]?.observations).toBe(3);
  });

  it('merges concurrent shadow-candidate feedback deltas', () => {
    const state = (correct: number, evaluated: number) => ({
      version: 1 as const,
      savedAt: 0,
      learner: { transitions: [] },
      ruleFeedback: {},
      candidateFeedback: { r: { correct, evaluated, lastUpdated: 0 } },
    });
    const merged = mergePersistedState(state(4, 6), state(3, 7), state(3, 5));
    expect(merged.candidateFeedback?.['r']).toMatchObject({ correct: 4, evaluated: 8 });
  });

  it('carries tool facts from either side and omits the field when neither has any', () => {
    const base = { version: 1 as const, savedAt: 0, learner: { transitions: [] }, ruleFeedback: {} };
    const fact = { readOnly: true, servable: true, shapes: ['x'], lastSeen: 5 };
    expect(mergePersistedState(base, base)).not.toHaveProperty('tools');
    expect(mergePersistedState({ ...base, tools: { s: { t: fact } } }, base).tools).toEqual({ s: { t: fact } });
    expect(mergePersistedState(base, { ...base, tools: { s: { t: fact } } }).tools).toEqual({ s: { t: fact } });
  });
});

describe('TransitionLearner export/import', () => {
  it('a fresh learner with imported state predicts immediately', () => {
    const a = new TransitionLearner({ now: () => 0 });
    a.observe(call('srv', 'list', { q: 'x' }, [{ id: 7 }], 0));
    a.observe(call('srv', 'get', { id: 7, q: 'x' }, null, 100));
    a.observe(call('srv', 'list', { q: 'y' }, [{ id: 9 }], 200));
    a.observe(call('srv', 'get', { id: 9, q: 'y' }, null, 300));

    const exported = a.exportState();
    // Simulate a real restart: state travels through JSON.
    const b = new TransitionLearner({ now: () => 0 });
    b.importState(JSON.parse(JSON.stringify(exported)));

    const out = b.predict(call('srv', 'list', { q: 'z' }, [{ id: 42 }], 400));
    expect(out).toHaveLength(1);
    expect(out[0]!.tool).toBe('get');
    expect(out[0]!.args).toEqual({ id: 42, q: 'z' }); // parsed-path + arg-copy survive the trip
    expect(out[0]!.ruleId).toBe('learned:srv:list→get');
  });

  it('carries per-template evidence across a restart', () => {
    const a = new TransitionLearner({ now: () => 0 });
    const pair = (listed: number, opened: number, t: number): void => {
      a.observe(call('srv', 'list', {}, { items: [{ id: listed }] }, t));
      a.observe(call('srv', 'get', { id: opened }, null, t + 100));
    };
    pair(1, 1, 0);
    pair(2, 2, 1_000);
    pair(3, 999, 2_000); // the one instance no source explains
    pair(4, 4, 3_000);
    pair(5, 5, 4_000);

    const exported = JSON.parse(JSON.stringify(a.exportState())) as {
      transitions: Array<{
        nextTool: string;
        templates: Array<{ name: string; underivable: boolean; derived?: number; missed?: number }>;
      }>;
    };
    const tpl = exported.transitions
      .find((x) => x.nextTool === 'get')!
      .templates.find((x) => x.name === 'id')!;
    expect({ derived: tpl.derived, missed: tpl.missed }).toEqual({ derived: 4, missed: 1 });
    expect(tpl.underivable).toBe(false);

    // The miss must not re-poison the template on the way back in.
    const b = new TransitionLearner({ now: () => 0 });
    b.importState(exported);
    const out = b.predict(call('srv', 'list', {}, { items: [{ id: 42 }] }, 5_000));
    expect(out.some((p) => p.tool === 'get' && p.args['id'] === 42)).toBe(true);
  });

  it('keeps a pre-v0.13 underivable template silent, evidence fields or not', () => {
    const l = new TransitionLearner({ now: () => 0 });
    l.importState({
      transitions: [
        {
          server: 's',
          prevTool: 'a',
          nextTool: 'b',
          count: 9,
          // Old files carry the sticky boolean alone, and never with sources.
          templates: [{ name: 'x', underivable: true, sources: [] }],
        },
      ],
    });
    expect(l.predict(call('s', 'a', {}, null, 0))).toEqual([]);
  });

  it('revision changes when transitions change (dirty tracking)', () => {
    const l = new TransitionLearner({ now: () => 0 });
    const r0 = l.revision;
    l.observe(call('srv', 'a', {}, null, 0));
    expect(l.revision).toBe(r0); // chain head only — nothing learned yet
    l.observe(call('srv', 'b', {}, null, 50));
    expect(l.revision).toBeGreaterThan(r0); // transition recorded
  });

  it('skips malformed transitions without failing the import', () => {
    const l = new TransitionLearner({ now: () => 0 });
    l.importState({
      transitions: [
        'garbage',
        { server: 'has space', prevTool: 'a', nextTool: 'b', count: 2, templates: [] },
        { server: 's', prevTool: 'a', nextTool: 'b', count: -1, templates: [] },
        {
          server: 's',
          prevTool: 'a',
          nextTool: 'b',
          count: 3,
          templates: [{ name: 'x', underivable: false, sources: [{ kind: 'const', repr: '"v"' }] }],
        },
      ],
    });
    const out = l.predict(call('s', 'a', {}, null, 0));
    expect(out).toHaveLength(1); // only the one valid transition survived
    expect(out[0]!.args).toEqual({ x: 'v' });
  });

  it('persists lastUpdated so decay survives a reload', () => {
    const DAY_MS = 24 * 3600_000;
    let t = 0;
    const a = new TransitionLearner({ now: () => t });
    // Same prev tool, same count (2 each), 60 days apart.
    a.observe(call('srv', 'a', {}, null, 0));
    a.observe(call('srv', 'b', {}, null, 100));
    a.observe(call('srv', 'a', {}, null, 200));
    a.observe(call('srv', 'b', {}, null, 300));
    t = 60 * DAY_MS;
    a.observe(call('srv', 'a', {}, null, t));
    a.observe(call('srv', 'z', {}, null, t + 100));
    a.observe(call('srv', 'a', {}, null, t + 200));
    a.observe(call('srv', 'z', {}, null, t + 300));

    const exported = JSON.parse(JSON.stringify(a.exportState())) as {
      transitions: Array<{ nextTool: string; count: number; score?: number; lastUpdated?: number }>;
    };
    const stale = exported.transitions.find((x) => x.nextTool === 'b')!;
    const fresh = exported.transitions.find((x) => x.nextTool === 'z')!;
    expect(stale.count).toBe(2);
    expect(stale.lastUpdated).toBe(0); // recency travels with the snapshot
    expect(fresh.lastUpdated).toBe(60 * DAY_MS);
    expect(stale.score).toBeCloseTo(2);

    // Reload "at" the same instant the fresh transition was last seen: the
    // stale one must still read as stale, not be restamped to now().
    const b = new TransitionLearner({ now: () => 60 * DAY_MS });
    b.importState(exported);
    const preds = b.predict(call('srv', 'a', {}, null, 0));
    expect(preds.map((p) => p.tool)).toEqual(['z', 'b']);
  });

  it('loads a pre-existing state file with no score/lastUpdated fields', () => {
    const l = new TransitionLearner({ now: () => 5_000 });
    expect(() =>
      l.importState({
        transitions: [
          {
            server: 's',
            prevTool: 'a',
            nextTool: 'b',
            count: 2,
            templates: [
              { name: 'x', underivable: false, sources: [{ kind: 'const', repr: '"v"' }] },
            ],
          },
          {
            server: 's',
            prevTool: 'a',
            nextTool: 'z',
            count: 5,
            templates: [
              { name: 'x', underivable: false, sources: [{ kind: 'const', repr: '"v"' }] },
            ],
          },
        ],
        openers: [{ server: 's', tool: 'o', argsRepr: '{"a":1}', count: 4 }],
      }),
    ).not.toThrow();

    const out = l.predict(call('s', 'a', {}, null, 0));
    expect(out).toHaveLength(2);
    expect(out[0]!.args).toEqual({ x: 'v' });
    // Score defaults to count, so the pre-existing ordering is preserved.
    expect(out.map((p) => p.tool)).toEqual(['z', 'b']);
    expect(out[1]!.confidence).toBeCloseTo(0.45); // count 2 survived the load
    expect(l.openerPredictions('s')).toHaveLength(1);
  });

  it('an oversized snapshot keeps its most valuable transitions', () => {
    const sources = [{ kind: 'const', repr: '"v"' }];
    const l = new TransitionLearner({ now: () => 0, maxTransitions: 2 });
    l.importState({
      transitions: ['hot', 'mid', 'cold'].map((prevTool, i) => ({
        server: 's',
        prevTool,
        nextTool: 'b',
        count: [9, 5, 2][i],
        templates: [{ name: 'x', underivable: false, sources }],
      })),
    });
    // FIFO drops the first entry listed, which is the strongest one here.
    expect(l.predict(call('s', 'hot', {}, null, 0))).toHaveLength(1);
    expect(l.predict(call('s', 'mid', {}, null, 0))).toHaveLength(1);
    expect(l.predict(call('s', 'cold', {}, null, 0))).toEqual([]);
  });

  it('trims an oversized opener list to the live per-server cap', () => {
    const l = new TransitionLearner({ now: () => 0 });
    l.importState({
      transitions: [],
      openers: Array.from({ length: 40 }, (_, i) => ({
        server: 's',
        tool: `t${i}`,
        argsRepr: '{}',
        count: i + 2,
      })),
    });
    const kept = l.exportState().openers ?? [];
    expect(kept).toHaveLength(8); // MAX_OPENERS_PER_SERVER, enforced on load
    expect(Math.min(...kept.map((o) => o.count))).toBe(34); // the strongest 8
  });

  it('ignores hostile score and lastUpdated values without dropping the entry', () => {
    const l = new TransitionLearner({ now: () => 5_000 });
    l.importState({
      transitions: [
        {
          server: 's',
          prevTool: 'a',
          nextTool: 'b',
          count: 2,
          score: 'lots',
          lastUpdated: NaN,
          templates: [
            { name: 'x', underivable: false, sources: [{ kind: 'const', repr: '"v"' }] },
          ],
        },
      ],
    });
    const out = l.predict(call('s', 'a', {}, null, 0));
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeCloseTo(0.45); // count still gates and scores
  });

  it('importState never throws on hostile input', () => {
    const l = new TransitionLearner();
    for (const junk of [null, 42, 'x', { transitions: 'no' }, { transitions: [{}] }]) {
      expect(() => l.importState(junk)).not.toThrow();
    }
  });
});

describe('Metrics feedback priors', () => {
  it('halves imported counts and folds them into ruleFeedback only', () => {
    const m = new Metrics({ mode: 'on', now: () => 0 });
    m.importRuleFeedback({ r1: { hits: 10, wasted: 4, speculated: 20 } });
    expect(m.ruleFeedback('r1')).toEqual({ hits: 5, wasted: 2, speculated: 10 });
    // Session-only reporting stays clean: no per-rule entry until events land.
    expect(m.statsSnapshot().perRule.find((r) => r.ruleId === 'r1')).toBeUndefined();
  });

  it('exports combined prior + session counts and skips malformed priors', () => {
    const m = new Metrics({ mode: 'on', now: () => 0 });
    m.importRuleFeedback({
      r1: { hits: 4, wasted: 0, speculated: 8 },
      bad: 'nope',
      alsoBad: { hits: Infinity, wasted: -3, speculated: 'x' },
    });
    m.record({ type: 'speculated', server: 's', tool: 't', ruleId: 'r1' });
    m.record({ type: 'hit', server: 's', tool: 't', ruleId: 'r1', savedMs: 100 });
    const out = m.exportRuleFeedback();
    expect(out['r1']).toEqual({ hits: 3, wasted: 0, speculated: 5, lastUpdated: 0 }); // 2+1, 4+1
    expect(out['bad']).toBeUndefined();
    expect(out['alsoBad']).toBeUndefined();
  });

  it('decays by elapsed time instead of restart count', () => {
    const first = new Metrics({ mode: 'on', now: () => 0 });
    first.importRuleFeedback({
      r1: { hits: 10, wasted: 4, speculated: 20, lastUpdated: 0 },
    });
    const persisted = first.exportRuleFeedback();

    const immediateRestart = new Metrics({ mode: 'on', now: () => 0 });
    immediateRestart.importRuleFeedback(persisted);
    expect(immediateRestart.ruleFeedback('r1')).toEqual({
      hits: 10,
      wasted: 4,
      speculated: 20,
    });

    const later = new Metrics({
      mode: 'on',
      now: () => 14 * 24 * 60 * 60_000,
    });
    later.importRuleFeedback(persisted);
    expect(later.ruleFeedback('r1').hits).toBeCloseTo(10 / Math.E, 5);
  });
});

