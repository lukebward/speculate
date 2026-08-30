import { describe, expect, it } from 'vitest';
import { LatencyModel, mergeLatencySnapshots, type LatencySnapshot } from '../src/latency.js';

const DAY = 24 * 60 * 60_000;

describe('LatencyModel', () => {
  it('computes a stable mean, deviation, and conservative estimate', () => {
    let now = 0;
    const model = new LatencyModel({ now: () => now });
    model.observe('s', 't', 100);
    model.observe('s', 't', 200);
    const estimate = model.estimate('s', 't');
    expect(estimate.source).toBe('tool');
    expect(estimate.expectedMs).toBeCloseTo(150);
    expect(estimate.deviationMs).toBeCloseTo(50);
    expect(estimate.conservativeMs).toBeCloseTo(125);
    expect(estimate.effectiveSamples).toBeCloseTo(2);
  });

  it('decays effective confidence with a 30-day half-life', () => {
    let now = 0;
    const model = new LatencyModel({ now: () => now });
    model.observe('s', 't', 80);
    now = 30 * DAY;
    expect(model.estimate('s', 't')).toMatchObject({ source: 'tool', effectiveSamples: 0.5 });
    now++;
    expect(model.estimate('s', 't').source).toBe('unknown');
  });

  it('falls back from tool to sufficiently sampled server, hint, then unknown', () => {
    const model = new LatencyModel({ now: () => 0 });
    model.observe('s', 'a', 40);
    expect(model.estimate('s', 'b', 70).source).toBe('prediction-hint');
    model.observe('s', 'a', 60);
    expect(model.estimate('s', 'b', 70)).toMatchObject({ source: 'server', expectedMs: 50 });
    expect(model.estimate('other', 'x', 70)).toMatchObject({
      source: 'prediction-hint',
      expectedMs: 70,
    });
    expect(model.estimate('other', 'x')).toMatchObject({ source: 'unknown', expectedMs: 100 });
  });

  it('clamps large observations and ignores invalid ones', () => {
    const model = new LatencyModel({ now: () => 0 });
    model.observe('s', 't', Number.NaN);
    model.observe('s', 't', -1);
    expect(model.revision).toBe(0);
    model.observe('s', 't', 900_000);
    expect(model.estimate('s', 't').expectedMs).toBe(600_000);
  });

  it('round-trips deterministically and import does not dirty the model', () => {
    const first = new LatencyModel({ now: () => 10 });
    first.observe('z', 'b', 20);
    first.observe('a', 'c', 30);
    const snapshot = JSON.parse(JSON.stringify(first.exportState()));
    const second = new LatencyModel({ now: () => 10 });
    second.importState(snapshot);
    expect(second.revision).toBe(0);
    expect(second.exportState()).toEqual(first.exportState());
    expect(second.exportState().tools.map((entry) => `${entry.server}/${entry.tool}`)).toEqual([
      'a/c',
      'z/b',
    ]);
  });

  it('skips hostile and malformed imported entries', () => {
    const model = new LatencyModel({ now: () => 100 });
    model.importState({
      version: 1,
      tools: [
        { server: 's', tool: 'good', weight: 2, meanMs: 40, m2Ms2: 0, observations: 2, lastUpdated: 99 },
        { server: 's', tool: 'bad', weight: -1, meanMs: 40, m2Ms2: 0, observations: 2, lastUpdated: 99 },
        { server: 's', tool: 'nan', weight: 2, meanMs: Number.NaN, m2Ms2: 0, observations: 2, lastUpdated: 99 },
      ],
      servers: [],
    });
    expect(model.estimate('s', 'good').source).toBe('tool');
    expect(model.estimate('s', 'bad').source).toBe('unknown');
    expect(() => model.importState({ nope: true })).not.toThrow();
  });

  it('keeps near-identical large durations numerically stable', () => {
    const model = new LatencyModel({ now: () => 0 });
    model.observe('s', 't', 500_000);
    model.observe('s', 't', 500_000.001);
    expect(model.estimate('s', 't').deviationMs).toBeCloseTo(0.0005, 7);
  });
});

describe('mergeLatencySnapshots', () => {
  const observe = (values: Array<[string, string, number]>): LatencySnapshot => {
    const model = new LatencyModel({ now: () => 0 });
    for (const [server, tool, latency] of values) model.observe(server, tool, latency);
    return model.exportState();
  };

  it('unions disjoint estimates', () => {
    const merged = mergeLatencySnapshots(
      observe([['s', 'a', 10]]),
      observe([['s', 'b', 20]]),
      undefined,
      0,
    );
    expect(merged.tools.map((entry) => entry.tool)).toEqual(['a', 'b']);
  });

  it('adds only a process delta to a shared baseline', () => {
    const baseline = observe([['s', 't', 100]]);
    const existingModel = new LatencyModel({ now: () => 0 });
    existingModel.importState(baseline);
    existingModel.observe('s', 't', 200);
    const incomingModel = new LatencyModel({ now: () => 0 });
    incomingModel.importState(baseline);
    incomingModel.observe('s', 't', 300);

    const merged = mergeLatencySnapshots(
      existingModel.exportState(),
      incomingModel.exportState(),
      baseline,
      0,
    );
    const loaded = new LatencyModel({ now: () => 0 });
    loaded.importState(merged);
    expect(loaded.estimate('s', 't').expectedMs).toBeCloseTo(200);
    expect(merged.tools[0]!.observations).toBe(3);
  });

  it('ages baseline and deltas to the same merge instant', () => {
    let now = 0;
    const baselineModel = new LatencyModel({ now: () => now });
    baselineModel.observe('s', 't', 100);
    const baseline = baselineModel.exportState();
    now = 30 * DAY;
    const incoming = new LatencyModel({ now: () => now });
    incoming.importState(baseline);
    incoming.observe('s', 't', 200);
    const merged = mergeLatencySnapshots(baseline, incoming.exportState(), baseline, now);
    const entry = merged.tools[0]!;
    expect(entry.weight).toBeCloseTo(1.5);
    expect(entry.meanMs).toBeCloseTo((50 + 200) / 1.5);
  });
});
