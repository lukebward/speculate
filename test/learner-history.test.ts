import { describe, expect, it } from 'vitest';
import { TransitionLearner } from '../src/learner.js';
import type { ObservedCall } from '../src/types.js';

function call(
  tool: string,
  args: Record<string, unknown>,
  parsed: unknown,
  timestamp: number,
  server = 'sample',
): ObservedCall {
  return { server, tool, args, parsed, timestamp, latencyMs: 5, result: { content: [] } };
}

function repetition(learner: TransitionLearner, n: number, target = 'fetch'): void {
  const t = n * 1_000_000;
  learner.observe(call('enumerate', { scope: `group-${n}` }, { items: [{ id: n }] }, t));
  learner.observe(call('inspect', { id: n }, { revision: n + 100 }, t + 1));
  learner.observe(call('metadata', {}, { ready: true }, t + 2));
  learner.observe(call(target, { scope: `group-${n}`, id: n, revision: n + 100 }, {}, t + 3));
}

function trained(cap = 3): TransitionLearner {
  const learner = new TransitionLearner({ now: () => 1, maxPredictionsPerTrigger: cap });
  for (let n = 1; n <= 10; n++) repetition(learner, n);
  return learner;
}

function targetArgs(learner: TransitionLearner, trigger: ObservedCall, tool = 'fetch') {
  return learner.predict(trigger).find((prediction) => prediction.tool === tool)?.args;
}

describe('recent-call argument bindings', () => {
  it('predicts new exact arguments from two older calls before observing the target', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'group-new' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001));
    const trigger = call('metadata', {}, { ready: true }, 20_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toEqual({ scope: 'group-new', id: 501, revision: 701 });
  });

  it('keeps bindings across reordered sources and optional intervening tools', () => {
    const learner = trained();
    learner.observe(call('inspect', { id: 601 }, { revision: 801 }, 20_000_000));
    learner.observe(call('extra', {}, { id: 'irrelevant' }, 20_000_001));
    learner.observe(call('enumerate', { scope: 'group-other' }, { items: [{ id: 601 }] }, 20_000_002));
    learner.observe(call('another', {}, null, 20_000_003));
    const trigger = call('metadata', {}, { ready: true }, 20_000_004);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toEqual({ scope: 'group-other', id: 601, revision: 801 });
  });

  it('uses the latest occurrence of a source tool', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'group-latest' }, { items: [{ id: 901 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 401 }, { revision: 402 }, 20_000_001));
    learner.observe(call('inspect', { id: 901 }, { revision: 902 }, 20_000_002));
    const trigger = call('metadata', {}, { ready: true }, 20_000_003);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toEqual({ scope: 'group-latest', id: 901, revision: 902 });
  });

  it('does not fall back to an older occurrence when the latest source lacks a field', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'group-latest' }, { items: [{ id: 901 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 901 }, { revision: 902 }, 20_000_001));
    learner.observe(call('inspect', { id: 903 }, {}, 20_000_002));
    const trigger = call('metadata', {}, { ready: true }, 20_000_003);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it('does not borrow values from another server', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'foreign' }, { items: [{ id: 501 }] }, 20_000_000, 'other'));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001, 'other'));
    const trigger = call('metadata', {}, { ready: true }, 20_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it.each([20_200_000, 19_999_999])('clears history when a timestamp breaks the chain: %i', (timestamp) => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'stale' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001));
    const trigger = call('metadata', {}, { ready: true }, timestamp);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it('bounds history even when every adjacent call is recent', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'old' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001));
    for (let i = 0; i < 32; i++) learner.observe(call('extra', {}, null, 20_000_002 + i));
    const trigger = call('metadata', {}, { ready: true }, 20_000_100);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it('restores descriptors without restoring result payloads or a live history', () => {
    const learner = trained();
    learner.observe(call('unrelated', {}, { privatePayload: 'never-export-this-result' }, 20_000_000));
    const snapshot = learner.exportState();
    expect(JSON.stringify(snapshot)).not.toContain('never-export-this-result');
    const restored = new TransitionLearner({ now: () => 1 });
    restored.importState(snapshot);
    const alone = call('metadata', {}, { ready: true }, 30_000_000);
    restored.observe(alone);
    expect(targetArgs(restored, alone)).toBeUndefined();
    restored.observe(call('enumerate', { scope: 'restored-new' }, { items: [{ id: 777 }] }, 40_000_000));
    restored.observe(call('inspect', { id: 777 }, { revision: 888 }, 40_000_001));
    const trigger = call('metadata', {}, { ready: true }, 40_000_002);
    restored.observe(trigger);
    expect(targetArgs(restored, trigger)).toEqual({ scope: 'restored-new', id: 777, revision: 888 });
  });

  it('keeps the same emitted prefix at different prediction caps', () => {
    const source = trained(5);
    for (let n = 11; n <= 30; n++) repetition(source, n, n % 2 ? 'fetch_more' : 'fetch_extra');
    const snapshot = source.exportState();
    const outputs = [1, 3, 5].map((cap) => {
      const learner = new TransitionLearner({ now: () => 1, maxPredictionsPerTrigger: cap });
      learner.importState(snapshot);
      learner.observe(call('enumerate', { scope: 'prefix' }, { items: [{ id: 55 }] }, 50_000_000));
      learner.observe(call('inspect', { id: 55 }, { revision: 66 }, 50_000_001));
      const trigger = call('metadata', {}, { ready: true }, 50_000_002);
      learner.observe(trigger);
      return learner.predict(trigger);
    });
    expect(outputs[2]).toHaveLength(3);
    expect(outputs[0]).toEqual(outputs[2]!.slice(0, 1));
    expect(outputs[1]).toEqual(outputs[2]!.slice(0, 3));
  });

  it('learns and restores transforms of values from older calls', () => {
    const learner = new TransitionLearner({ now: () => 1 });
    for (let n = 1; n <= 10; n++) {
      const t = n * 1_000_000;
      learner.observe(call('source', {}, { value: n + 100 }, t));
      learner.observe(call('marker', {}, null, t + 1));
      learner.observe(call('consume', { key: String(n + 100) }, {}, t + 2));
    }
    const restored = new TransitionLearner({ now: () => 1 });
    restored.importState(learner.exportState());
    restored.observe(call('source', {}, { value: 777 }, 20_000_000));
    const trigger = call('marker', {}, null, 20_000_001);
    restored.observe(trigger);
    expect(targetArgs(restored, trigger, 'consume')).toEqual({ key: '777' });
  });

  it('never learns the target observation as its own historical argument source', () => {
    const learner = new TransitionLearner({ now: () => 1 });
    for (let n = 1; n <= 10; n++) {
      const t = n * 1_000_000;
      learner.observe(call('marker', {}, null, t));
      learner.observe(call('consume', { key: `only-in-target-${n}` }, {}, t + 1));
    }
    const trigger = call('marker', {}, null, 10_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger, 'consume')).toBeUndefined();
  });

  it('skips oversized historical results and never revives an older same-tool value', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'bounded' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001));
    learner.observe(call('inspect', { id: 501 }, { revision: 702, huge: 'x'.repeat(1_100_000) }, 20_000_002));
    const trigger = call('metadata', {}, { ready: true }, 20_000_003);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
    learner.observe(call('inspect', { id: 501 }, { revision: 703 }, 20_000_004));
    const recovered = call('metadata', {}, { ready: true }, 20_000_005);
    learner.observe(recovered);
    expect(targetArgs(learner, recovered)).toEqual({ scope: 'bounded', id: 501, revision: 703 });
  });

  it('limits aggregate retained size across several individually small results', () => {
    const learner = trained();
    learner.observe(call('enumerate', { scope: 'bounded' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001));
    for (let i = 0; i < 4; i++) {
      learner.observe(call(`large_${i}`, {}, { padding: 'x'.repeat(300_000) }, 20_000_002 + i));
    }
    const trigger = call('metadata', {}, { ready: true }, 20_000_006);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it('learns identical behavior after unrelated tool and argument names replace every label', () => {
    const learner = new TransitionLearner({ now: () => 1 });
    for (let n = 1; n <= 10; n++) {
      const t = n * 1_000_000;
      learner.observe(call('alpha', { x: `group-${n}` }, { rows: [{ y: n }] }, t));
      learner.observe(call('beta', { y: n }, { z: n + 100 }, t + 1));
      learner.observe(call('gamma', {}, { flag: true }, t + 2));
      learner.observe(call('delta', { x: `group-${n}`, y: n, z: n + 100 }, {}, t + 3));
    }
    learner.observe(call('beta', { y: 501 }, { z: 701 }, 20_000_000));
    learner.observe(call('alpha', { x: 'group-new' }, { rows: [{ y: 501 }] }, 20_000_001));
    const trigger = call('gamma', {}, { flag: true }, 20_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger, 'delta')).toEqual({ x: 'group-new', y: 501, z: 701 });
  });

  it('detaches retained values from caller-owned arguments and results', () => {
    const learner = trained();
    const args = { scope: 'original' };
    const parsed = { revision: 701 };
    learner.observe(call('enumerate', args, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, parsed, 20_000_001));
    args.scope = 'changed';
    const trigger = call('metadata', {}, { ready: true }, 20_000_002);
    learner.observe(trigger);
    parsed.revision = 999;
    expect(targetArgs(learner, trigger)).toEqual({ scope: 'original', id: 501, revision: 701 });
  });

  it('declines historical payloads containing accessors', () => {
    const learner = trained();
    const parsed = Object.defineProperty({ revision: 701 }, 'extra', {
      enumerable: true,
      get: () => 'computed',
    });
    learner.observe(call('enumerate', { scope: 'bounded' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, parsed, 20_000_001));
    const trigger = call('metadata', {}, { ready: true }, 20_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it('keeps immediate prediction usable when a result exceeds the history size bound', () => {
    const learner = new TransitionLearner({ now: () => 1 });
    for (let n = 1; n <= 10; n++) {
      learner.observe(call('inspect', {}, { revision: n }, n * 1_000_000));
      learner.observe(call('consume', { id: n }, {}, n * 1_000_000 + 1));
    }
    const trigger = call('inspect', {}, { revision: 701, huge: 'x'.repeat(1_100_000) }, 20_000_000);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger, 'consume')).toEqual({ id: 701 });
  });

  it.each(['', 42, 'x'.repeat(513)])('rejects malformed persisted history origins (%s)', (sourceTool) => {
    const snapshot = trained().exportState();
    for (const transition of snapshot.transitions) {
      for (const template of transition.templates) {
        for (const source of template.sources) {
          if (source.kind !== 'const') Object.assign(source, { sourceTool });
        }
      }
    }
    const learner = new TransitionLearner({ now: () => 1 });
    learner.importState(snapshot);
    learner.observe(call('enumerate', { scope: 'new' }, { items: [{ id: 501 }] }, 20_000_000));
    learner.observe(call('inspect', { id: 501 }, { revision: 701 }, 20_000_001));
    const trigger = call('metadata', {}, { ready: true }, 20_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });

  it('does not treat a dropped historical payload as a real null result', () => {
    const learner = new TransitionLearner({ now: () => 1 });
    learner.importState({ transitions: [{
      server: 'sample', prevTool: 'metadata', nextTool: 'fetch', count: 10,
      templates: [{ name: 'revision', derived: 10, missed: 0, underivable: false,
        sources: [{ kind: 'parsed', sourceTool: 'inspect', path: [], score: 10, solo: 10 }],
      }],
    }] });
    learner.observe(call('inspect', { id: 501 }, { revision: 701, huge: 'x'.repeat(1_100_000) }, 20_000_001));
    const trigger = call('metadata', {}, { ready: true }, 20_000_002);
    learner.observe(trigger);
    expect(targetArgs(learner, trigger)).toBeUndefined();
  });
});
