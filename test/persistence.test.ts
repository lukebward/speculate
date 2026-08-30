/**
 * Persistence layer (DESIGN.md §13.6): StateStore durability semantics,
 * learner export/import round-trip, and rule-feedback priors with decay.
 */
import { describe, expect, it } from 'vitest';
import { hasPosixFileModes } from './platform.js';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  StateStore,
  defaultStateDirectory,
  defaultStatePath,
  mergePersistedState,
} from '../src/persistence.js';
import { TransitionLearner } from '../src/learner.js';
import { LatencyModel } from '../src/latency.js';
import { Metrics } from '../src/metrics.js';
import type { ObservedCall } from '../src/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'speculate-persist-'));

function call(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  parsed: unknown,
  timestamp: number,
): ObservedCall {
  return { server, tool, args, result: { content: [] }, parsed, timestamp, latencyMs: 10 };
}

describe('StateStore', () => {
  // Platform-neutral: this must be covered on every OS in the matrix, so the
  // POSIX mode-bits assertion lives in its own skippable case below.
  it('round-trips state atomically through a nested directory', () => {
    const path = join(dir(), 'nested', 'deeper', 'state.json');
    const store = new StateStore(path, () => 1234);
    expect(store.load()).toBeNull(); // first run: cold start
    expect(store.save({ learner: { transitions: [] }, ruleFeedback: { r: { hits: 1, wasted: 0, speculated: 2 } } })).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false); // renamed, not left behind

    const loaded = store.load();
    expect(loaded?.version).toBe(1);
    expect(loaded?.savedAt).toBe(1234);
    expect(loaded?.ruleFeedback['r']).toEqual({ hits: 1, wasted: 0, speculated: 2 });
  });

  it.skipIf(!hasPosixFileModes)('writes the state file owner-only', () => {
    const path = join(dir(), 'state.json');
    const store = new StateStore(path, () => 1234);
    expect(store.save({ learner: {}, ruleFeedback: {} })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('treats corrupt and version-mismatched files as cold starts', () => {
    const path = join(dir(), 'state.json');
    const store = new StateStore(path);
    writeFileSync(path, '{not json');
    expect(store.load()).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 999, ruleFeedback: {} }));
    expect(store.load()).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1 })); // missing ruleFeedback
    expect(store.load()).toBeNull();
  });

  it('reports save failure without throwing', () => {
    const base = dir();
    // Occupy the would-be parent directory with a FILE so mkdir fails.
    const blocker = join(base, 'state.json');
    writeFileSync(blocker, 'occupied');
    const bad = new StateStore(join(blocker, 'child.json'));
    expect(bad.save({ learner: {}, ruleFeedback: {} })).toBe(false);
  });

  it('refuses current state from a different workspace/account scope', () => {
    const path = join(dir(), 'state.json');
    const a = new StateStore(path, () => 1, [], 'scope-a');
    expect(a.save({ learner: { transitions: [] }, ruleFeedback: {} })).toBe(true);
    expect(a.load()?.scope).toBe('scope-a');
    expect(new StateStore(path, () => 2, [], 'scope-b').load()).toBeNull();
  });

  it('merges disjoint concurrent learner entities instead of last-writer loss', () => {
    const transition = (nextTool: string) => ({
      server: 's',
      prevTool: 'list',
      nextTool,
      count: 2,
      templates: [],
    });
    const merged = mergePersistedState(
      {
        version: 1,
        savedAt: 1,
        learner: { transitions: [transition('get_a')] },
        ruleFeedback: { a: { hits: 1, wasted: 0, speculated: 1 } },
      },
      {
        version: 1,
        savedAt: 2,
        learner: { transitions: [transition('get_b')] },
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

  it('round-trips optional latency state without breaking legacy files', () => {
    const path = join(dir(), 'state.json');
    const latency = new LatencyModel({ now: () => 1_000 });
    latency.observe('s', 'slow', 180);
    const store = new StateStore(path, () => 1_000);
    expect(store.save({
      learner: { transitions: [] },
      ruleFeedback: {},
      latency: latency.exportState(),
    })).toBe(true);
    const loaded = store.load();
    const restored = new LatencyModel({ now: () => 1_000 });
    restored.importState(loaded?.latency);
    expect(restored.estimate('s', 'slow')).toMatchObject({ source: 'tool', expectedMs: 180 });

    writeFileSync(path, JSON.stringify({
      version: 1,
      savedAt: 2_000,
      learner: { transitions: [] },
      ruleFeedback: {},
    }));
    expect(new StateStore(path, () => 2_000).load()?.latency).toBeUndefined();
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
    const m = new Metrics({ mode: 'strict', log: 'off', now: () => 0 });
    m.importRuleFeedback({ r1: { hits: 10, wasted: 4, speculated: 20 } });
    expect(m.ruleFeedback('r1')).toEqual({ hits: 5, wasted: 2, speculated: 10 });
    // Session-only reporting stays clean: no per-rule entry until events land.
    expect(m.statsSnapshot().perRule.find((r) => r.ruleId === 'r1')).toBeUndefined();
  });

  it('exports combined prior + session counts and skips malformed priors', () => {
    const m = new Metrics({ mode: 'strict', log: 'off', now: () => 0 });
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
    const first = new Metrics({ mode: 'strict', log: 'off', now: () => 0 });
    first.importRuleFeedback({
      r1: { hits: 10, wasted: 4, speculated: 20, lastUpdated: 0 },
    });
    const persisted = first.exportRuleFeedback();

    const immediateRestart = new Metrics({ mode: 'strict', log: 'off', now: () => 0 });
    immediateRestart.importRuleFeedback(persisted);
    expect(immediateRestart.ruleFeedback('r1')).toEqual({
      hits: 10,
      wasted: 4,
      speculated: 20,
    });

    const later = new Metrics({
      mode: 'strict',
      log: 'off',
      now: () => 14 * 24 * 60 * 60_000,
    });
    later.importRuleFeedback(persisted);
    expect(later.ruleFeedback('r1').hits).toBeCloseTo(10 / Math.E, 5);
  });
});

describe('defaultStatePath', () => {
  it('is stable per config path and respects XDG_STATE_HOME', () => {
    const prev = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = `${sep}xdg-state`;
      const a = defaultStatePath('/proj/speculate.config.json');
      const b = defaultStatePath('/proj/speculate.config.json');
      const c = defaultStatePath('/other/speculate.config.json');
      expect(defaultStateDirectory()).toBe(`${sep}xdg-state${sep}speculate`);
      expect(defaultStatePath('/proj/speculate.config.json')).toMatch(/state-[0-9a-f]+\.json$/);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a.startsWith(`${sep}xdg-state${sep}speculate${sep}state-`)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });
});
