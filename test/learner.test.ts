/**
 * TransitionLearner tests (DESIGN.md §5.3): transition chaining, argument
 * templates (arg-copy / parsed-path / const), fail-closed poisoning, gap
 * handling, server isolation, ranking/cap, decay, value-based eviction, and robustness
 * against weird parsed shapes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TransitionLearner, decayedScore } from '../src/learner.js';
import type { ObservedCall } from '../src/types.js';

const DAY_MS = 24 * 3600_000;

// --- fixtures ---------------------------------------------------------------

/** Fake clock for decay/recency. Gap decisions must use call timestamps. */
let t = 0;
const now = () => t;

/** Monotonic base for isolated observation pairs (resets chains between). */
let base = 0;

beforeEach(() => {
  t = 0;
  base = 0;
});

function mkCall(
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
  parsed: unknown = null,
  timestamp = 0,
): ObservedCall {
  return {
    server,
    tool,
    args,
    result: { content: [] },
    parsed,
    timestamp,
    latencyMs: 5,
  };
}

interface CallSpec {
  tool: string;
  args?: Record<string, unknown>;
  parsed?: unknown;
}

/**
 * Observe prev→next with closely spaced timestamps, isolated from earlier
 * chains by a 1,000,000 ms jump (well past any maxGapMs used here), so
 * cross-pair transitions (e.g. next→prev of the following pair) never form.
 */
function observePair(
  learner: TransitionLearner,
  server: string,
  prev: CallSpec,
  next: CallSpec,
): void {
  base += 1_000_000;
  learner.observe(
    mkCall(server, prev.tool, prev.args ?? {}, prev.parsed ?? null, base),
  );
  learner.observe(
    mkCall(server, next.tool, next.args ?? {}, next.parsed ?? null, base + 10),
  );
}

// --- minObservations gate -----------------------------------------------------

describe('minObservations gate', () => {
  it('emits nothing before minObservations and predicts at exactly minObservations (default 2)', () => {
    const learner = new TransitionLearner({ now });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);

    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds).toHaveLength(1);
    expect(preds[0]).toMatchObject({ server: 'srv', tool: 'b', args: {} });
  });

  it('honors a custom minObservations', () => {
    const learner = new TransitionLearner({ now, minObservations: 3 });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);

    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    expect(learner.predict(mkCall('srv', 'a'))).toHaveLength(1);
  });
});

// --- argument templates -------------------------------------------------------

describe('arg-copy templates', () => {
  it('generalizes: predicted values track the current call, not history', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'gh',
      { tool: 'get_issue', args: { owner: 'a', repo: 'r', issue_number: 42 } },
      { tool: 'get_comments', args: { owner: 'a', repo: 'r', issue_number: 42 } },
    );
    observePair(
      learner,
      'gh',
      { tool: 'get_issue', args: { owner: 'a', repo: 'r', issue_number: 41 } },
      { tool: 'get_comments', args: { owner: 'a', repo: 'r', issue_number: 41 } },
    );

    const preds = learner.predict(
      mkCall('gh', 'get_issue', { owner: 'a', repo: 'r', issue_number: 7 }),
    );
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('get_comments');
    expect(preds[0]!.args).toEqual({ owner: 'a', repo: 'r', issue_number: 7 });
    expect(preds[0]!.server).toBe('gh');
    expect(preds[0]!.ruleId).toBe('learned:gh:get_issue→get_comments');
    expect(preds[0]!.confidence).toBeCloseTo(0.45); // 0.25 + 0.1 * 2
    expect(preds[0]!.key).toBeUndefined(); // predictor stamps keys, not the learner
  });

  it('caps confidence at 0.55', () => {
    const learner = new TransitionLearner({ now });
    for (let i = 0; i < 4; i++) {
      observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    }
    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds[0]!.confidence).toBe(0.55); // 0.25 + 0.1 * 4 = 0.65, capped
  });
});

describe('parsed-path templates', () => {
  it('resolves ids from the current call parsed result', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'gh',
      {
        tool: 'list_issues',
        args: { state: 'open' },
        parsed: { items: [{ number: 101, title: 'x' }, { number: 9 }] },
      },
      { tool: 'get_issue', args: { issue_number: 101 } },
    );
    observePair(
      learner,
      'gh',
      {
        tool: 'list_issues',
        args: { state: 'open' },
        parsed: { items: [{ number: 202, title: 'y' }] },
      },
      { tool: 'get_issue', args: { issue_number: 202 } },
    );

    const preds = learner.predict(
      mkCall(
        'gh',
        'list_issues',
        { state: 'open' },
        { items: [{ number: 303, title: 'z' }] },
      ),
    );
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('get_issue');
    expect(preds[0]!.args).toEqual({ issue_number: 303 });
  });

  it('supports paths when parsed itself is an array of primitives (0.id-style)', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'srv',
      { tool: 'list', args: {}, parsed: [7, 8] },
      { tool: 'get', args: { id: 7 } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'list', args: {}, parsed: [9, 10] },
      { tool: 'get', args: { id: 9 } },
    );

    const preds = learner.predict(mkCall('srv', 'list', {}, [42, 5]));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ id: 42 });
  });

  it('fails closed when the parsed path does not resolve on the current call', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { items: [{ id: 1 }] } },
      { tool: 'get', args: { id: 1 } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { items: [{ id: 2 }] } },
      { tool: 'get', args: { id: 2 } },
    );

    // Current call's parsed has no items[0].id → no partial-args prediction.
    expect(learner.predict(mkCall('srv', 'list', {}, { items: [] }))).toEqual([]);
    expect(learner.predict(mkCall('srv', 'list', {}, null))).toEqual([]);
  });
});

describe('const templates and poisoning', () => {
  it('reproduces an arg constant across observations', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'srv',
      { tool: 'search', args: { q: 'foo' } },
      { tool: 'list_prs', args: { state: 'open' } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'search', args: { q: 'bar' } },
      { tool: 'list_prs', args: { state: 'open' } },
    );

    const preds = learner.predict(mkCall('srv', 'search', { q: 'baz' }));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ state: 'open' });
  });

  it('an arg that varies with no derivable source poisons the transition — and the evidence keeps it poisoned', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { token: 'x1' } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { token: 'x2' } },
    );
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);

    // A consistent VALUE is not a derivation: the only candidate source is
    // the const mined from the first sighting, and it never produces x2. Each
    // further sighting is another miss, so the template stays silent.
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { token: 'x2' } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { token: 'x2' } },
    );
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);
  });

  it('recovers after a single underivable observation', () => {
    const learner = new TransitionLearner({ now });
    const derivable = (id: number): void =>
      observePair(
        learner,
        'srv',
        { tool: 'list', parsed: { items: [{ id }] } },
        { tool: 'get', args: { id } },
      );

    derivable(1);
    derivable(2); // items.0.id is the surviving source
    // The odd one out: the agent opened something that is nowhere in the
    // trigger call. One such observation must not disable the transition.
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { items: [{ id: 3 }] } },
      { tool: 'get', args: { id: 999 } },
    );
    // Thin evidence stays quiet: 2 derivations against 1 miss is not yet a
    // verdict, so the learner waits rather than guessing.
    expect(learner.predict(mkCall('srv', 'list', {}, { items: [{ id: 42 }] }))).toEqual(
      [],
    );

    derivable(4);
    derivable(5);

    const preds = learner.predict(
      mkCall('srv', 'list', {}, { items: [{ id: 42 }] }),
    );
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('get');
    expect(preds[0]!.args).toEqual({ id: 42 }); // still the learned derivation
  });

  it('still refuses to guess an argument it has never derived', () => {
    const learner = new TransitionLearner({ now });
    // `token` is a fresh value every time and appears nowhere in the trigger
    // call, so the const from the first sighting is the only candidate and it
    // never reproduces a later value. No amount of repetition may fabricate it.
    for (let i = 0; i < 8; i++) {
      observePair(
        learner,
        'srv',
        { tool: 'a' },
        { tool: 'b', args: { token: `t${i}` } },
      );
    }
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);

    // An arg with no representation at all never even gets a candidate
    // source, so it is never derived and never emitted — however consistent.
    for (let i = 0; i < 8; i++) {
      observePair(
        learner,
        'srv',
        { tool: 'c' },
        { tool: 'd', args: { token: undefined } },
      );
    }
    expect(learner.predict(mkCall('srv', 'c'))).toEqual([]);
  });

  it('an arg name appearing only on a later instance poisons the transition', () => {
    const learner = new TransitionLearner({ now });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b', args: { x: 1 } });
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { x: 1, y: 2 } },
    );
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);
  });

  it('a previously seen arg going missing poisons the transition', () => {
    const learner = new TransitionLearner({ now });
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { x: 1, y: 2 } },
    );
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b', args: { x: 1 } });
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);
  });
});

describe('source priority', () => {
  it('arg-copy wins over const when both survive (divergence on the third call)', () => {
    const learner = new TransitionLearner({ now });
    // n=5 both times: candidates {arg:n, const 5} both survive.
    observePair(
      learner,
      'srv',
      { tool: 'get_issue', args: { n: 5 } },
      { tool: 'get_comments', args: { n: 5 } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'get_issue', args: { n: 5 } },
      { tool: 'get_comments', args: { n: 5 } },
    );

    // Third call diverges from the historical constant: arg-copy must win.
    const preds = learner.predict(mkCall('srv', 'get_issue', { n: 9 }));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ n: 9 });
  });
});

// --- gap handling ---------------------------------------------------------------

describe('maxGapMs', () => {
  it('uses call timestamps, not the injected clock: far-apart timestamps never form a transition', () => {
    // Clock frozen at 0 the whole time — only timestamps can separate calls.
    const learner = new TransitionLearner({ now: () => 0 });
    learner.observe(mkCall('srv', 'a', {}, null, 0));
    learner.observe(mkCall('srv', 'b', {}, null, 999_999));
    learner.observe(mkCall('srv', 'a', {}, null, 2_000_000));
    learner.observe(mkCall('srv', 'b', {}, null, 3_000_000));
    // a→b "occurred" twice but never within maxGapMs of the previous call.
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);
  });

  it('close timestamps form a transition even when the injected clock jumps wildly', () => {
    let wall = 0;
    const jumpyClock = () => (wall += 10_000_000);
    const learner = new TransitionLearner({ now: jumpyClock });
    learner.observe(mkCall('srv', 'a', {}, null, 1_000));
    learner.observe(mkCall('srv', 'b', {}, null, 1_010));
    learner.observe(mkCall('srv', 'a', {}, null, 2_000_000));
    learner.observe(mkCall('srv', 'b', {}, null, 2_000_010));
    expect(learner.predict(mkCall('srv', 'a'))).toHaveLength(1);
  });

  it('a gap resets the chain but still stores the new call as previous', () => {
    const learner = new TransitionLearner({ now });
    // a --gap--> b -> c : only b→c counts.
    learner.observe(mkCall('srv', 'a', {}, null, 0));
    learner.observe(mkCall('srv', 'b', {}, null, 500_000));
    learner.observe(mkCall('srv', 'c', {}, null, 500_100));
    // Again, with fresh gaps isolating each step.
    learner.observe(mkCall('srv', 'a', {}, null, 1_000_000));
    learner.observe(mkCall('srv', 'b', {}, null, 1_500_000));
    learner.observe(mkCall('srv', 'c', {}, null, 1_500_100));

    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]); // a→b never formed
    const preds = learner.predict(mkCall('srv', 'b'));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('c'); // b→c formed twice after resets
  });

  it('honors a custom maxGapMs', () => {
    const learner = new TransitionLearner({ now, maxGapMs: 50 });
    learner.observe(mkCall('srv', 'a', {}, null, 0));
    learner.observe(mkCall('srv', 'b', {}, null, 100)); // 100 > 50: no transition
    learner.observe(mkCall('srv', 'a', {}, null, 10_000));
    learner.observe(mkCall('srv', 'b', {}, null, 10_040)); // within 50: counts
    learner.observe(mkCall('srv', 'a', {}, null, 20_000));
    learner.observe(mkCall('srv', 'b', {}, null, 20_040));
    expect(learner.predict(mkCall('srv', 'a'))).toHaveLength(1);
  });
});

// --- isolation, ranking, capacity ------------------------------------------------

describe('server isolation', () => {
  it('transitions learned on server A never predict for server B', () => {
    const learner = new TransitionLearner({ now });
    observePair(learner, 'alpha', { tool: 'a' }, { tool: 'b' });
    observePair(learner, 'alpha', { tool: 'a' }, { tool: 'b' });
    expect(learner.predict(mkCall('alpha', 'a'))).toHaveLength(1);
    expect(learner.predict(mkCall('beta', 'a'))).toEqual([]);
  });

  it('chains do not cross servers: interleaved calls on another server do not link', () => {
    const learner = new TransitionLearner({ now });
    // On server alpha: a then (b on beta) then c — alpha's chain is a→c.
    for (let i = 0; i < 2; i++) {
      base += 1_000_000;
      learner.observe(mkCall('alpha', 'a', {}, null, base));
      learner.observe(mkCall('beta', 'b', {}, null, base + 5));
      learner.observe(mkCall('alpha', 'c', {}, null, base + 10));
    }
    const preds = learner.predict(mkCall('alpha', 'a'));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('c');
    expect(learner.predict(mkCall('beta', 'a'))).toEqual([]);
  });
});

describe('ranking and cap', () => {
  it('caps at maxPredictionsPerTrigger, highest observation counts first', () => {
    const learner = new TransitionLearner({
      now,
      minObservations: 1,
      maxPredictionsPerTrigger: 2,
    });
    for (let i = 0; i < 3; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    for (let i = 0; i < 2; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'c' });
    for (let i = 0; i < 4; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'd' });

    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds.map((p) => p.tool)).toEqual(['d', 'b']);
  });

  it('breaks count ties by ruleId for determinism', () => {
    const learner = new TransitionLearner({ now });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'c' });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'c' });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });

    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds.map((p) => p.ruleId)).toEqual(['learned:srv:a→b', 'learned:srv:a→c']);
  });
});

describe('time decay', () => {
  it('decays a score toward zero as time passes', () => {
    const fresh = decayedScore(4, 0, 0);
    const aged = decayedScore(4, 0, 14 * DAY_MS);
    expect(fresh).toBe(4);
    expect(aged).toBeLessThan(4);
    expect(aged).toBeGreaterThan(0);
    // Monotonic: more elapsed time is never worth more evidence.
    expect(decayedScore(4, 0, 28 * DAY_MS)).toBeLessThan(aged);
  });

  it('fails toward less evidence on degenerate inputs, never more', () => {
    // An unreadable stamp must read as maximally stale. Failing open here
    // would let an infinitely old entry outrank a genuinely recent one.
    expect(decayedScore(4, -Infinity, 0)).toBe(0);
    expect(decayedScore(4, 0, Infinity)).toBe(0);
    expect(decayedScore(4, NaN, 0)).toBe(0);
    // A stamp from the future is clamped to "no decay", never amplified.
    expect(decayedScore(4, 100, 0)).toBe(4);
    // A disabled tau is a no-op, not a wipe.
    expect(decayedScore(4, 0, 14 * DAY_MS, 0)).toBe(4);
  });

  it('ranks a recently used transition above an equally frequent stale one', () => {
    const learner = new TransitionLearner({ now });
    t = 0;
    for (let i = 0; i < 2; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    t = 60 * DAY_MS;
    for (let i = 0; i < 2; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'z' });

    // Equal counts (2 each). Ordering by raw count leaves a ruleId tie-break,
    // which would put the stale 'b' first; decayed score must invert that.
    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds.map((p) => p.tool)).toEqual(['z', 'b']);
  });

  it('keeps count gating minObservations even when the score has decayed away', () => {
    const learner = new TransitionLearner({ now });
    t = 0;
    for (let i = 0; i < 2; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    t = 3650 * DAY_MS; // a decade later: score is ~0, count is still 2
    expect(learner.predict(mkCall('srv', 'a'))).toHaveLength(1);
  });
});

describe('value-based eviction', () => {
  it('evicts the lowest-scoring transition, not the oldest inserted', () => {
    const learner = new TransitionLearner({
      now,
      minObservations: 1,
      maxTransitions: 3,
    });
    t = 1;
    // The hot transition is inserted FIRST and never touched again.
    for (let i = 0; i < 5; i++) observePair(learner, 'srv', { tool: 'hot' }, { tool: 'x' });
    // Then enough one-shot transitions to push well past the cap.
    for (const cold of ['c1', 'c2', 'c3', 'c4']) {
      observePair(learner, 'srv', { tool: cold }, { tool: 'y' });
    }

    // FIFO drops the oldest insertion, which is the most valuable entry here.
    expect(learner.predict(mkCall('srv', 'hot'))).toHaveLength(1);
    expect(learner.predict(mkCall('srv', 'c1'))).toEqual([]); // weakest and stalest
    expect(learner.predict(mkCall('srv', 'c4'))).toHaveLength(1);
  });

  it('still admits a brand-new transition once the cap is full', () => {
    // DEFAULT minObservations (2) on purpose: a newcomer needs to SURVIVE
    // its first sighting to ever reach the threshold. Ranking eviction by
    // value without exempting the entry just written makes the newcomer its
    // own victim — score 1 against incumbents sitting just under 2 — so it
    // is deleted by the same observe() that created it, forever.
    const learner = new TransitionLearner({ now, maxTransitions: 5 });
    t = 1;
    for (const incumbent of ['i1', 'i2', 'i3', 'i4', 'i5']) {
      for (let i = 0; i < 2; i++) {
        observePair(learner, 'srv', { tool: incumbent }, { tool: 'x' });
      }
    }
    for (let i = 0; i < 2; i++) observePair(learner, 'srv', { tool: 'new' }, { tool: 'y' });

    expect(learner.predict(mkCall('srv', 'new'))).toHaveLength(1);
    // The cap still holds, and it is paid for by the weakest incumbent.
    expect(learner.predict(mkCall('srv', 'i1'))).toEqual([]);
  });

  it('still admits a brand-new opener once the per-server cap is full', () => {
    const learner = new TransitionLearner({ now });
    t = 1;
    for (let n = 0; n < 8; n++) {
      for (let i = 0; i < 3; i++) learner.recordOpener('srv', `incumbent_${n}`, {});
    }
    for (let i = 0; i < 2; i++) learner.recordOpener('srv', 'newcomer', { a: 1 });

    // Admission, not ranking: the newcomer must still be TRACKED. Whether it
    // makes the 3-prediction output cap against stronger incumbents is a
    // separate question; being deleted by its own recordOpener is not.
    const tracked = learner.exportState().openers ?? [];
    expect(tracked).toHaveLength(8); // cap held, paid for by an incumbent
    expect(tracked.find((o) => o.tool === 'newcomer')?.count).toBe(2);
  });

  it('evicts the least-recently-updated transition at maxTransitions', () => {
    const learner = new TransitionLearner({
      now,
      minObservations: 1,
      maxTransitions: 2,
    });
    t = 1;
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' });
    t = 2;
    observePair(learner, 'srv', { tool: 'c' }, { tool: 'd' });
    t = 3;
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b' }); // refresh a→b
    t = 4;
    observePair(learner, 'srv', { tool: 'e' }, { tool: 'f' }); // evicts c→d

    expect(learner.predict(mkCall('srv', 'c'))).toEqual([]); // evicted
    expect(learner.predict(mkCall('srv', 'a'))).toHaveLength(1); // survived (recent)
    expect(learner.predict(mkCall('srv', 'e'))).toHaveLength(1);

    // Evicted transitions restart from scratch (count resets).
    observePair(learner, 'srv', { tool: 'c' }, { tool: 'd' });
    const preds = learner.predict(mkCall('srv', 'c'));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.confidence).toBeCloseTo(0.35); // count 1, not 3
  });
});

// --- robustness and self-transitions ----------------------------------------------

describe('robustness', () => {
  const weirdShapes: Array<[string, unknown]> = [
    ['null', null],
    ['string', 'just some text'],
    ['number', 42],
    ['array of primitives', [1, 2, 3]],
    ['4-deep nesting', { a: { b: { c: { d: { e: 1 } } } } }],
    ['huge array', Array.from({ length: 5_000 }, (_, i) => ({ id: i }))],
    ['array of arrays', [[1], [2], [3]]],
  ];

  for (const [label, parsed] of weirdShapes) {
    it(`observe/predict never throw for parsed = ${label}`, () => {
      const learner = new TransitionLearner({ now });
      expect(() => {
        observePair(
          learner,
          'srv',
          { tool: 'list', args: { q: 1 }, parsed },
          { tool: 'get', args: { id: 1 } },
        );
        observePair(
          learner,
          'srv',
          { tool: 'list', args: { q: 1 }, parsed },
          { tool: 'get', args: { id: 2 } },
        );
        learner.predict(mkCall('srv', 'list', { q: 1 }, parsed));
      }).not.toThrow();
    });
  }

  it('deep nesting degrades to no candidates (no partial prediction)', () => {
    const learner = new TransitionLearner({ now });
    // The only source of the value is 4 levels deep — beyond the search.
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { a: { b: { c: { d: 1 } } } } },
      { tool: 'get', args: { id: 1 } },
    );
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { a: { b: { c: { d: 2 } } } } },
      { tool: 'get', args: { id: 2 } },
    );
    expect(
      learner.predict(mkCall('srv', 'list', {}, { a: { b: { c: { d: 3 } } } })),
    ).toEqual([]);
  });
});

describe('self-transitions', () => {
  it('list → list is learnable', () => {
    const learner = new TransitionLearner({ now });
    base += 1_000_000;
    // Three consecutive identical lists → two list→list observations.
    learner.observe(mkCall('srv', 'list', { q: 'x' }, null, base));
    learner.observe(mkCall('srv', 'list', { q: 'x' }, null, base + 10));
    learner.observe(mkCall('srv', 'list', { q: 'x' }, null, base + 20));

    const preds = learner.predict(mkCall('srv', 'list', { q: 'y' }));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('list');
    expect(preds[0]!.ruleId).toBe('learned:srv:list→list');
    expect(preds[0]!.args).toEqual({ q: 'y' }); // arg-copy tracks the current call
  });
});
