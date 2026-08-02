import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../src/metrics.js';
import type { DecisionEvent, StatsReport } from '../src/types.js';
import type { UsageCounters } from '../src/usage.js';

function clock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; } };
}

/**
 * A realistic session: two real calls trigger predictions; four speculative
 * calls are issued; one completes and hits, one is joined in flight, one
 * expires, one is invalidated by a mutation; one speculative call errors;
 * one real call misses; one parser fails.
 */
const SESSION: DecisionEvent[] = [
  { type: 'real_call', server: 'gh', tool: 'get_issue' },
  { type: 'predicted', server: 'gh', tool: 'list_pull_requests', ruleId: 'r1', confidence: 0.8 },
  { type: 'predicted', server: 'gh', tool: 'issue_comments', ruleId: 'r2', confidence: 0.6 },
  { type: 'suppressed', server: 'gh', tool: 'issue_comments', ruleId: 'r2', reason: 'feedback' },
  { type: 'suppressed', server: 'gh', tool: 'list_pull_requests', ruleId: 'r1', reason: 'budget' },
  { type: 'speculated', server: 'gh', tool: 'list_pull_requests', ruleId: 'r1' },
  { type: 'hit', server: 'gh', tool: 'list_pull_requests', ruleId: 'r1', savedMs: 450 },
  { type: 'speculated', server: 'gh', tool: 'pull_request_read', ruleId: 'r1' },
  { type: 'joined', server: 'gh', tool: 'pull_request_read', ruleId: 'r1', savedMs: 120 },
  { type: 'speculated', server: 'gh', tool: 'get_file_contents', ruleId: 'r3' },
  { type: 'expired', server: 'gh', tool: 'get_file_contents', ruleId: 'r3' },
  { type: 'speculated', server: 'slack', tool: 'search', ruleId: 'r4' },
  { type: 'invalidated', server: 'slack', tool: 'search', ruleId: 'r4' },
  { type: 'spec_error', server: 'slack', tool: 'read_channel', ruleId: 'r4', reason: 'auth' },
  { type: 'miss', server: 'gh', tool: 'search_code', nearMissDistance: 1 },
  { type: 'parser_miss', server: 'gh', tool: 'get_issue' },
  { type: 'real_call', server: 'slack', tool: 'search' },
];

function recorded(events: DecisionEvent[] = SESSION): Metrics {
  const m = new Metrics({ mode: 'strict', log: 'off' });
  for (const ev of events) m.record(ev);
  return m;
}

describe('Metrics — counter accumulation', () => {
  const snap = recorded().statsSnapshot();

  it('publishes common durable counters', () => {
    const snapshots: UsageCounters[] = [];
    const m = new Metrics({
      mode: 'strict',
      log: 'off',
      onUsage: (snapshot) => snapshots.push(snapshot),
    });
    m.record({ type: 'predicted', server: 's', tool: 't' });
    expect(snapshots).toEqual([]);
    m.record({ type: 'miss', server: 's', tool: 't' });
    m.record({ type: 'speculated', server: 's', tool: 't' });
    m.record({ type: 'hit', server: 's', tool: 't', savedMs: 250 });
    expect(snapshots.at(-1)).toEqual({
      hits: 1,
      joins: 0,
      misses: 1,
      speculativeCalls: 1,
      wasted: 0,
      estimatedSavedMs: 250,
    });
  });

  it('accumulates top-level counters from the event stream', () => {
    expect(snap.realCalls).toBe(2);
    expect(snap.speculativeCalls).toBe(4);
    expect(snap.hits).toBe(1);
    expect(snap.joins).toBe(1);
    expect(snap.misses).toBe(1);
    expect(snap.expired).toBe(1);
    expect(snap.invalidated).toBe(1);
    expect(snap.parserMisses).toBe(1);
  });

  it('wasted = expired + invalidated + spec_error', () => {
    expect(snap.wasted).toBe(3);
  });

  it('estimatedSavedMs sums savedMs over hits and joins', () => {
    expect(snap.estimatedSavedMs).toBe(570);
  });

  it('treats a hit with no savedMs as saving 0', () => {
    const m = recorded([
      { type: 'hit', server: 'gh', tool: 't', ruleId: 'r1' },
      { type: 'joined', server: 'gh', tool: 't', ruleId: 'r1', savedMs: 7 },
    ]);
    expect(m.statsSnapshot().estimatedSavedMs).toBe(7);
    expect(m.statsSnapshot().hits).toBe(1);
  });

  it('keys perServer by event server', () => {
    expect(snap.perServer['gh']).toEqual({
      speculativeCalls: 3,
      hits: 2, // hit + joined
      wasted: 1, // the expired entry
      specErrors: 0,
    });
    expect(snap.perServer['slack']).toEqual({
      speculativeCalls: 1,
      hits: 0,
      wasted: 2, // invalidated + spec_error
      specErrors: 1,
    });
  });

  it('tracks per-rule stats, sorted by ruleId', () => {
    expect(snap.perRule.map((r) => r.ruleId)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(snap.perRule[0]).toEqual({
      ruleId: 'r1',
      predicted: 1,
      speculated: 2,
      hits: 2, // hit + joined
      wasted: 0,
      suppressedByFeedback: 0, // its suppression reason was 'budget', not 'feedback'
    });
    expect(snap.perRule[1]).toEqual({
      ruleId: 'r2',
      predicted: 1,
      speculated: 0,
      hits: 0,
      wasted: 0,
      suppressedByFeedback: 1,
    });
    expect(snap.perRule[2]).toEqual({
      ruleId: 'r3',
      predicted: 0,
      speculated: 1,
      hits: 0,
      wasted: 1,
      suppressedByFeedback: 0,
    });
    expect(snap.perRule[3]).toEqual({
      ruleId: 'r4',
      predicted: 0,
      speculated: 1,
      hits: 0,
      wasted: 2,
      suppressedByFeedback: 0,
    });
  });

  it('stdio_delay events increment the stdioDelays counter and nothing else', () => {
    const before = recorded().statsSnapshot();
    const m = recorded();
    m.record({ type: 'stdio_delay', server: 'fs', tool: 'read_file', latencyMs: 90 });
    const after = m.statsSnapshot();
    expect(after.stdioDelays).toBe(before.stdioDelays + 1);
    expect(after).toEqual({ ...before, stdioDelays: before.stdioDelays + 1, uptimeMs: after.uptimeMs });
  });
});

describe('Metrics — age at hit', () => {
  const hit = (ageMs: number, ttlFraction: number): DecisionEvent => ({
    type: 'hit',
    server: 'gh',
    tool: 't',
    ruleId: 'r1',
    savedMs: 10,
    ageMs,
    ttlFraction,
  });

  it('is empty, not zero, before anything has hit', () => {
    const age = recorded([]).statsSnapshot().ageAtHit;
    expect(age.count).toBe(0);
    expect(age.p50Ms).toBeNull();
    expect(age.p95Ms).toBeNull();
    expect(age.maxMs).toBeNull();
    expect(age.lastTtlQuarter).toBeNull();
    expect(age.ttlQuarters).toEqual([0, 0, 0, 0]);
  });

  it('reports the median and p95 of the ages it was given', () => {
    // 100 hits: ninety at 1 s, ten at 25 s. The median must sit in the fresh
    // mass and p95 out in the tail — if either collapsed to the mean, a small
    // population of near-expiry serves would be invisible, which is the exact
    // failure this instrument exists to prevent.
    const events: DecisionEvent[] = [];
    for (let i = 0; i < 90; i++) events.push(hit(1_000, 1_000 / 30_000));
    for (let i = 0; i < 10; i++) events.push(hit(25_000, 25_000 / 30_000));
    const age = recorded(events).statsSnapshot().ageAtHit;
    expect(age.count).toBe(100);
    expect(age.p50Ms).toBeGreaterThanOrEqual(1_000);
    expect(age.p50Ms).toBeLessThan(1_200);
    expect(age.p95Ms).toBeGreaterThan(20_000);
    expect(age.maxMs).toBe(25_000); // exact, so the tail is never rounded away
  });

  it('never reports a percentile above its own maximum', () => {
    // The percentiles are bin midpoints and `maxMs` is exact, so against a
    // fast local server, where every hit lands in the first 100 ms bin, an
    // unclamped midpoint reads p50 = 50 ms beside max = 30 ms: a median larger
    // than the largest sample, which makes the report look broken at exactly
    // the moment it has the best news.
    const age = recorded([hit(0, 0), hit(30, 0.001)]).statsSnapshot().ageAtHit;
    expect(age.maxMs).toBe(30);
    expect(age.p50Ms!).toBeLessThanOrEqual(age.maxMs!);
    expect(age.p95Ms!).toBeLessThanOrEqual(age.maxMs!);
  });

  it('moves when consumption is delayed — the property the metric rests on', () => {
    const fresh = recorded([hit(200, 0.01), hit(300, 0.01)]).statsSnapshot().ageAtHit;
    const stale = recorded([hit(20_000, 0.7), hit(21_000, 0.7)]).statsSnapshot().ageAtHit;
    expect(stale.p50Ms!).toBeGreaterThan(fresh.p50Ms!);
    expect(stale.maxMs!).toBeGreaterThan(fresh.maxMs!);
  });

  it('counts the share consumed in the last quarter of the TTL', () => {
    const age = recorded([
      hit(1_000, 0.03),
      hit(12_000, 0.4),
      hit(23_000, 0.77),
      hit(29_000, 0.97),
    ]).statsSnapshot().ageAtHit;
    // A fraction lands in the quarter it falls INSIDE: 0.4 is second-quarter,
    // and the boundary 0.75 would be last-quarter, not third.
    expect(age.ttlQuarters).toEqual([1, 1, 0, 2]);
    expect(age.lastTtlQuarter).toBe(0.5);
  });

  it('buckets by age band', () => {
    const age = recorded([
      hit(10, 0.001),
      hit(900, 0.03),
      hit(4_000, 0.13),
      hit(20_000, 0.66),
      hit(90_000, 0.5),
    ]).statsSnapshot().ageAtHit;
    expect(age.buckets['<1s']).toBe(2);
    expect(age.buckets['1-5s']).toBe(1);
    expect(age.buckets['5-15s']).toBe(0);
    expect(age.buckets['15-30s']).toBe(1);
    expect(age.buckets['60s+']).toBe(1);
    expect(Object.values(age.buckets).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('ignores hits with no measured age instead of counting them as fresh', () => {
    // A joined call never sat in the buffer, and a hit recorded without an
    // age is unknown, not zero. Counting either as 0 ms would dilute the
    // distribution towards "everything is fresh".
    const age = recorded([
      { type: 'hit', server: 'gh', tool: 't', savedMs: 1 },
      { type: 'joined', server: 'gh', tool: 't', savedMs: 1 },
      hit(5_000, 0.16),
    ]).statsSnapshot().ageAtHit;
    expect(age.count).toBe(1);
    expect(age.maxMs).toBe(5_000);
  });

  it('rejects nonsense ages rather than skewing the distribution', () => {
    const age = recorded([
      hit(Number.NaN, 0.5),
      hit(-1, 0.5),
      hit(Number.POSITIVE_INFINITY, 0.5),
      hit(7_000, 0.23),
    ]).statsSnapshot().ageAtHit;
    expect(age.count).toBe(1);
    expect(age.maxMs).toBe(7_000);
  });

  it('keeps count and the TTL quarters describing the SAME population', () => {
    // The invariant that makes every share below `count` readable: a hit
    // missing either half of the measurement is admitted to neither, so
    // `lastTtlQuarter` is never a share of a different denominator.
    const half = { type: 'hit', server: 'gh', tool: 't', ageMs: 5_000 } as DecisionEvent;
    const age = recorded([
      hit(1_000, 0.03),
      half, // an age with no fraction: half a measurement, so not a sample
      { ...half, ageMs: undefined, ttlFraction: 0.9 } as DecisionEvent,
      hit(29_000, 0.97),
    ]).statsSnapshot().ageAtHit;
    expect(age.count).toBe(2);
    expect(age.ttlQuarters.reduce((a, b) => a + b, 0)).toBe(age.count);
    expect(age.lastTtlQuarter).toBe(0.5);
  });
});

describe('Metrics — wastePerHit', () => {
  it('is wasted / (hits + joins)', () => {
    expect(recorded().statsSnapshot().wastePerHit).toBe(3 / 2);
  });

  it('is null when there are no hits or joins, even with waste', () => {
    const m = recorded([
      { type: 'speculated', server: 'gh', tool: 't', ruleId: 'r1' },
      { type: 'expired', server: 'gh', tool: 't', ruleId: 'r1' },
    ]);
    expect(m.statsSnapshot().wasted).toBe(1);
    expect(m.statsSnapshot().wastePerHit).toBeNull();
  });

  it('is null on a fresh instance', () => {
    expect(recorded([]).statsSnapshot().wastePerHit).toBeNull();
  });

  it('is 0 when there are hits but no waste', () => {
    const m = recorded([{ type: 'hit', server: 'gh', tool: 't', savedMs: 10 }]);
    expect(m.statsSnapshot().wastePerHit).toBe(0);
  });
});

describe('Metrics — ruleFeedback', () => {
  it('exposes hits / wasted / speculated for the predictor feedback loop', () => {
    const m = recorded();
    expect(m.ruleFeedback('r1')).toEqual({ hits: 2, wasted: 0, speculated: 2 });
    expect(m.ruleFeedback('r3')).toEqual({ hits: 0, wasted: 1, speculated: 1 });
    expect(m.ruleFeedback('r4')).toEqual({ hits: 0, wasted: 2, speculated: 1 });
  });

  it('returns zeros for rules never seen', () => {
    expect(recorded().ruleFeedback('never')).toEqual({
      hits: 0,
      wasted: 0,
      speculated: 0,
    });
  });
});

describe('Metrics — decision log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one JSONL line per event on stderr when log='stderr', never stdout", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    const c = clock(12_345);
    const m = new Metrics({ mode: 'annotated', log: 'stderr', now: c.now });
    m.record({ type: 'hit', server: 'gh', tool: 'get_issue', ruleId: 'r1', savedMs: 300 });
    m.record({ type: 'miss', server: 'gh', tool: 'search_code' });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(2);

    const lines = stderrSpy.mock.calls.map((call) => String(call[0]));
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trim().split('\n')).toHaveLength(1); // one event per line
    }

    const first = JSON.parse(lines[0]!) as { speculate: DecisionEvent };
    expect(first.speculate).toEqual({
      type: 'hit',
      server: 'gh',
      tool: 'get_issue',
      ruleId: 'r1',
      savedMs: 300,
      timestamp: 12_345, // stamped from the injected clock
    });
  });

  it('preserves an explicit event timestamp', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const m = new Metrics({ mode: 'strict', log: 'stderr', now: () => 99 });
    m.record({ type: 'real_call', server: 'gh', tool: 't', timestamp: 42 });
    const line = JSON.parse(String(spy.mock.calls[0]![0])) as {
      speculate: DecisionEvent;
    };
    expect(line.speculate.timestamp).toBe(42);
  });

  it("is silent when log='off'", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const m = new Metrics({ mode: 'strict', log: 'off' });
    for (const ev of SESSION) m.record(ev);
    expect(stderrSpy).not.toHaveBeenCalled();
    // Counters still work with logging off.
    expect(m.statsSnapshot().realCalls).toBe(2);
  });
});

describe('Metrics — statsSnapshot shape', () => {
  it('has exactly the StatsReport top-level fields', () => {
    // Compile-time: assignable to StatsReport.
    const snap: StatsReport = recorded().statsSnapshot();
    // Run-time: every field present, nothing extra.
    expect(Object.keys(snap).sort()).toEqual(
      [
        'mode',
        'uptimeMs',
        'realCalls',
        'speculativeCalls',
        'hits',
        'joins',
        'misses',
        'expired',
        'invalidated',
        'wasted',
        'parserMisses',
        'stdioDelays',
        'suppressed',
        'estimatedSavedMs',
        'wastePerHit',
        'ageAtHit',
        'perServer',
        'perRule',
      ].sort(),
    );
    expect(snap.mode).toBe('strict');
    expect(typeof snap.uptimeMs).toBe('number');
    expect(snap.perRule.every((r) =>
      ['ruleId', 'predicted', 'speculated', 'hits', 'wasted', 'suppressedByFeedback'].every(
        (k) => k in r,
      ),
    )).toBe(true);
  });

  it('reports uptimeMs from the injected clock', () => {
    const c = clock(1_000);
    const m = new Metrics({ mode: 'off', log: 'off', now: c.now });
    expect(m.statsSnapshot().uptimeMs).toBe(0);
    c.set(5_500);
    expect(m.statsSnapshot().uptimeMs).toBe(4_500);
    expect(m.statsSnapshot().mode).toBe('off');
  });

  it('returns copies — mutating a snapshot does not corrupt the next one', () => {
    const m = recorded();
    const a = m.statsSnapshot();
    a.perServer['gh']!.hits = 999;
    a.perRule[0]!.speculated = 999;
    const b = m.statsSnapshot();
    expect(b.perServer['gh']!.hits).toBe(2);
    expect(b.perRule[0]!.speculated).toBe(2);
  });
});
