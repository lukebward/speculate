import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../src/metrics.js';
import type { DecisionEvent, StatsReport } from '../src/types.js';

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
