/**
 * Per-(server, tool) upstream latency model (DESIGN.md §5.6, Task 5c):
 * a decayed mean, the same evidence-decay shape the learner uses, read as
 * the "time saved" term of the expected-value ranking.
 */
import { describe, expect, it } from 'vitest';
import { LATENCY_TAU_MS, LatencyModel } from '../src/latency.js';

function makeModel(): { model: LatencyModel; advance: (ms: number) => void } {
  let t = 1_000_000;
  const model = new LatencyModel({ now: () => t });
  return { model, advance: (ms) => { t += ms; } };
}

describe('LatencyModel', () => {
  it('reports nothing before it has seen anything (cold start)', () => {
    const { model } = makeModel();
    expect(model.expected('gh', 'get_issue')).toBeUndefined();
  });

  it('reports a single observation as itself', () => {
    const { model } = makeModel();
    model.record('gh', 'get_issue', 250);
    expect(model.expected('gh', 'get_issue')).toBe(250);
  });

  it('averages repeated observations of the same tool', () => {
    const { model } = makeModel();
    model.record('gh', 'get_issue', 100);
    model.record('gh', 'get_issue', 300);
    expect(model.expected('gh', 'get_issue')).toBeCloseTo(200, 6);
  });

  it('keeps tools separate', () => {
    const { model } = makeModel();
    model.record('gh', 'get_issue', 100);
    model.record('gh', 'get_pull_request_diff', 2_000);
    expect(model.expected('gh', 'get_issue')).toBe(100);
    expect(model.expected('gh', 'get_pull_request_diff')).toBe(2_000);
  });

  it('keeps servers separate', () => {
    const { model } = makeModel();
    model.record('gh', 'read', 100);
    model.record('fs', 'read', 5);
    expect(model.expected('gh', 'read')).toBe(100);
    expect(model.expected('fs', 'read')).toBe(5);
  });

  // -- decay (the Task 2 helper, reused) --------------------------------------

  it('weights a recent observation above an old one', () => {
    const { model, advance } = makeModel();
    model.record('gh', 'x', 100); // old and fast
    advance(LATENCY_TAU_MS * 4); // ~e^-4 ≈ 1.8% of its weight left
    model.record('gh', 'x', 1_000); // recent and slow
    const mean = model.expected('gh', 'x')!;
    expect(mean).toBeGreaterThan(980); // dominated by the recent sample
    expect(mean).toBeLessThan(1_000);
  });

  it('lets a tool that recently got slower read as slow', () => {
    const { model, advance } = makeModel();
    for (let i = 0; i < 10; i++) {
      model.record('gh', 'x', 50);
      advance(LATENCY_TAU_MS / 4);
    }
    expect(model.expected('gh', 'x')).toBeCloseTo(50, 3);
    for (let i = 0; i < 3; i++) {
      model.record('gh', 'x', 2_000);
      advance(1_000);
    }
    // The undecayed lifetime average of those 13 samples is ~500 ms. The
    // decayed one has to read materially slower than that, or the decay is
    // cosmetic.
    const lifetimeMean = (10 * 50 + 3 * 2_000) / 13;
    const mean = model.expected('gh', 'x')!;
    expect(mean).toBeGreaterThan(lifetimeMean * 1.5);
    expect(mean).toBeLessThan(2_000);
  });

  it('does not amplify evidence when the clock goes backwards', () => {
    let t = 1_000;
    const model = new LatencyModel({ now: () => t });
    model.record('gh', 'x', 100);
    t -= 60_000; // state file from a machine set to the future / NTP step
    model.record('gh', 'x', 100);
    expect(model.expected('gh', 'x')).toBeCloseTo(100, 6);
  });

  // -- the server-level prior -------------------------------------------------

  it('falls back to the server mean for a tool it has never seen', () => {
    const { model } = makeModel();
    model.record('gh', 'a', 100);
    model.record('gh', 'b', 300);
    expect(model.expected('gh', 'never_called')).toBeCloseTo(200, 6);
  });

  it('answers for every tool of a server, or for none of them', () => {
    // The ranking relies on this: a batch is single-server by construction,
    // so it can never be half-priced.
    const { model } = makeModel();
    expect(model.expected('gh', 'a')).toBeUndefined();
    expect(model.expected('gh', 'b')).toBeUndefined();
    model.record('gh', 'a', 100);
    expect(model.expected('gh', 'a')).toBeDefined();
    expect(model.expected('gh', 'b')).toBeDefined();
    expect(model.expected('other', 'a')).toBeUndefined();
  });

  // -- hostile / degenerate input --------------------------------------------

  it('ignores unusable observations', () => {
    const { model } = makeModel();
    model.record('gh', 'x', Number.NaN);
    model.record('gh', 'x', Number.POSITIVE_INFINITY);
    model.record('gh', 'x', -5);
    expect(model.expected('gh', 'x')).toBeUndefined();
  });

  it('reports nothing when every observation was instantaneous', () => {
    // Zero expected saving must not collapse the ranking to insertion order:
    // it reads as "no latency to prioritize", i.e. the fallback.
    const { model } = makeModel();
    model.record('gh', 'x', 0);
    model.record('gh', 'x', 0);
    expect(model.expected('gh', 'x')).toBeUndefined();
  });

  it('clamps an absurd observation rather than letting it pin the ranking', () => {
    const { model } = makeModel();
    model.record('gh', 'x', 10 ** 12);
    expect(model.expected('gh', 'x')!).toBeLessThanOrEqual(600_000);
  });

  it('bounds how many tools it tracks', () => {
    const { model } = makeModel();
    for (let i = 0; i < 2_000; i++) model.record('gh', `t${i}`, 100 + i);
    expect(model.size).toBeLessThanOrEqual(512);
    // The most recent tool is never its own eviction victim.
    expect(model.expected('gh', 't1999')).toBe(2_099);
  });

  it('never throws on a malformed key', () => {
    const { model } = makeModel();
    expect(() => model.record('', '', 100)).not.toThrow();
    expect(model.expected('', '')).toBeUndefined();
  });
});
