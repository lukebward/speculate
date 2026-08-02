/**
 * TransitionLearner tests (DESIGN.md §5.3): transition chaining, argument
 * templates (arg-copy / parsed-path / const), fail-closed poisoning, gap
 * handling, server isolation, ranking/cap, decay, value-based eviction, and robustness
 * against weird parsed shapes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TransitionLearner, decayedScore } from '../src/learner.js';
import type { SerializedSource } from '../src/learner.js';
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

  it('an arg that varies with no derivable source silences the transition until a value actually recurs', () => {
    const learner = new TransitionLearner({ now });
    const token = (t: string): void =>
      observePair(learner, 'srv', { tool: 'a' }, { tool: 'b', args: { token: t } });

    token('x1');
    token('x2');
    // The const mined from the first sighting never produces x2, and nothing
    // in the trigger call does either: one derivation, one miss, no verdict.
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);

    // x2 is now a hypothesis of its own — minted when nothing else explained
    // it, and only worth anything if it recurs. It does, so the learner
    // eventually says so. (Before per-source scoring the candidate list could
    // only shrink, so a template whose constant went stale stayed silent for
    // the life of the process however consistent the traffic became.)
    token('x2');
    token('x2');
    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ token: 'x2' });
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

  it('an arg name appearing only on a later instance goes quiet while the evidence is thin', () => {
    const learner = new TransitionLearner({ now });
    observePair(learner, 'srv', { tool: 'a' }, { tool: 'b', args: { x: 1 } });
    observePair(
      learner,
      'srv',
      { tool: 'a' },
      { tool: 'b', args: { x: 1, y: 2 } },
    );
    // Two observations is not a verdict on `y`, so the learner says nothing —
    // temporarily. See the arg-set-instability cases below for what it does
    // once there is enough evidence to have an opinion.
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);
  });

  it('a previously seen arg going missing goes quiet while the evidence is thin', () => {
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

// --- arg-set instability, once there is evidence ------------------------------

/**
 * An argument the follow-up call only SOMETIMES carries. Absence is counted
 * as a miss like any other, so the same rate gate decides it — and the
 * learner has no way to say "sometimes": past the gate it emits the argument
 * on every prediction, below it emits nothing at all.
 */
describe('an optional argument', () => {
  /** Observes a→b `presence.length` times, with `opt` only where marked. */
  function observeOptional(learner: TransitionLearner, presence: boolean[]): void {
    for (const withOpt of presence) {
      observePair(
        learner,
        'srv',
        { tool: 'a' },
        { tool: 'b', args: withOpt ? { q: 'Q', opt: 'E' } : { q: 'Q' } },
      );
    }
  }

  it('present in 6 of 10 calls is emitted on EVERY prediction', () => {
    const learner = new TransitionLearner({ now });
    observeOptional(
      learner,
      [true, true, false, true, false, true, false, true, false, true],
    );
    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds).toHaveLength(1);
    // A 40% miss rate is under MAX_TEMPLATE_MISS_RATE, so `opt` is emitted
    // even for the 40% of calls that omit it: those predictions simply miss.
    expect(preds[0]!.args).toEqual({ q: 'Q', opt: 'E' });
  });

  it('present in 3 of 12 calls silences the whole transition', () => {
    const learner = new TransitionLearner({ now });
    observeOptional(learner, [
      true, false, false, false,
      true, false, false, false,
      true, false, false, false,
    ]);
    // A 75% miss rate reaches the gate, and one underivable argument still
    // drops the prediction whole — `q` is derivable and goes down with it.
    expect(learner.predict(mkCall('srv', 'a'))).toEqual([]);
  });
});

describe('MAX_TEMPLATE_MISS_RATE', () => {
  // The constant that decides how wrong a derivation may keep being before
  // the learner stops using it. Both halves observe the same shape ten times
  // and differ only in the rate, so this test owns the threshold outright.
  const derivable = (learner: TransitionLearner, id: number): void =>
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { items: [{ id }] } },
      { tool: 'get', args: { id } },
    );
  /** Same shape, but the opened id appears nowhere in the trigger call. */
  const unexplained = (learner: TransitionLearner, id: number): void =>
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { items: [{ id }] } },
      { tool: 'get', args: { id: -id } },
    );
  const trigger = mkCall('srv', 'list', {}, { items: [{ id: 42 }] });

  it('keeps a derivation that misses half the time', () => {
    const learner = new TransitionLearner({ now });
    for (let i = 1; i <= 5; i++) {
      derivable(learner, i);
      unexplained(learner, 100 + i);
    }
    const preds = learner.predict(trigger); // derived 5, missed 5
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ id: 42 });
  });

  it('drops a derivation that misses four times in five', () => {
    const learner = new TransitionLearner({ now });
    derivable(learner, 1);
    derivable(learner, 2);
    for (let i = 1; i <= 8; i++) unexplained(learner, 100 + i);
    expect(learner.predict(trigger)).toEqual([]); // derived 2, missed 8
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

// --- per-source scoring and multi-candidate emission --------------------------

/**
 * Each argument keeps SEVERAL competing hypotheses about where its value came
 * from, scores them against real traffic, and offers the strongest few as
 * separate predictions. What is pinned here: every source that could have
 * produced a value is credited (not just the first one tried), evidence beats
 * the fixed arg>parsed>const priority order, the per-argument cap evicts its
 * weakest hypothesis instead of refusing new ones, and one transition can
 * emit row 0, row 1 and row 2 as ranked candidates.
 */
describe('per-source scoring', () => {
  /** The stored sources for one argument of one transition, in stored order. */
  function sourcesOf(
    learner: TransitionLearner,
    nextTool: string,
    arg: string,
  ): SerializedSource[] {
    const t = learner.exportState().transitions.find((x) => x.nextTool === nextTool);
    if (!t) throw new Error(`no transition to ${nextTool}`);
    const tpl = t.templates.find((x) => x.name === arg);
    if (!tpl) throw new Error(`no template for ${arg}`);
    return tpl.sources;
  }

  /** `kind:key|path|repr` → stored score, so assertions read like the model. */
  function scores(
    learner: TransitionLearner,
    nextTool: string,
    arg: string,
  ): Map<string, number | undefined> {
    return new Map(
      sourcesOf(learner, nextTool, arg).map((s) => [
        `${s.kind}:${s.key ?? s.path?.join('.') ?? s.repr}`,
        s.score,
      ]),
    );
  }

  /** One `list → open` sighting where the agent opened row `row` of three. */
  function openRow(learner: TransitionLearner, i: number, row: number): void {
    const ids = [`a${i}`, `b${i}`, `c${i}`];
    observePair(
      learner,
      'srv',
      { tool: 'list', parsed: { rows: ids.map((id) => ({ id })) } },
      { tool: 'open', args: { id: ids[row] } },
    );
  }

  const threeRows = mkCall('srv', 'list', {}, { rows: [{ id: 'p' }, { id: 'q' }, { id: 'r' }] });

  it('credits every source that could have produced the observed value', () => {
    const learner = new TransitionLearner({ now });
    // The opened id is BOTH a copy of the trigger's `id` argument and the
    // second row of its parsed result: two hypotheses explain every sighting,
    // and both must be credited, not merely the first one tried.
    for (const id of ['v1', 'v2', 'v3']) {
      observePair(
        learner,
        'srv',
        { tool: 'list', args: { id }, parsed: { rows: [{ id: 'other' }, { id }] } },
        { tool: 'open', args: { id } },
      );
    }

    const byKind = scores(learner, 'open', 'id');
    expect(byKind.get('arg:id')).toBe(3);
    expect(byKind.get('parsed:rows.1.id')).toBe(3);
    // The const mined from the first sighting explained that one and no other.
    expect(byKind.get('const:"v1"')).toBe(1);
  });

  it('prefers the source that has actually been right, over priority order', () => {
    const learner = new TransitionLearner({ now });
    // First sighting: the trigger's `cursor` argument happens to equal the
    // opened id, so an arg-copy is stored beside the parsed path — and
    // arg-copies come FIRST in the fixed priority order.
    observePair(
      learner,
      'srv',
      {
        tool: 'list',
        args: { cursor: 'k0' },
        parsed: { rows: [{ id: 'x' }, { id: 'y' }, { id: 'k0' }] },
      },
      { tool: 'open', args: { id: 'k0' } },
    );
    // From then on the agent opens row 2, which is never the cursor.
    for (let i = 1; i <= 5; i++) {
      observePair(
        learner,
        'srv',
        {
          tool: 'list',
          args: { cursor: `k${i}` },
          parsed: { rows: [{ id: `a${i}` }, { id: `b${i}` }, { id: `z${i}` }] },
        },
        { tool: 'open', args: { id: `z${i}` } },
      );
    }

    // The loser is outranked, not deleted: holding both is what makes the
    // question "which one has been right?" answerable at all.
    const byKind = scores(learner, 'open', 'id');
    expect(byKind.get('arg:cursor')).toBe(1);
    expect(byKind.get('parsed:rows.2.id')).toBe(6);

    const preds = learner.predict(
      mkCall(
        'srv',
        'list',
        { cursor: 'live' },
        { rows: [{ id: 'p' }, { id: 'q' }, { id: 'r' }] },
      ),
    );
    expect(preds[0]!.args).toEqual({ id: 'r' }); // evidence, not priority order
  });

  it('emits several ranked candidates from one transition', () => {
    const learner = new TransitionLearner({ now });
    // Row 0 is opened most often, row 1 next, row 2 occasionally.
    [0, 0, 0, 1, 0, 2, 0, 1, 0, 2, 1, 0].forEach((row, i) => openRow(learner, i, row));

    const preds = learner.predict(threeRows);
    expect(preds.map((p) => p.tool)).toEqual(['open', 'open', 'open']);
    // One transition, three argument sets, ordered by how often each row has
    // actually been the one opened.
    expect(preds.map((p) => p.args)).toEqual([{ id: 'p' }, { id: 'q' }, { id: 'r' }]);
    expect(preds[0]!.confidence).toBeGreaterThan(preds[1]!.confidence);
    expect(preds[1]!.confidence).toBeGreaterThan(preds[2]!.confidence);
    // Same ruleId: they are the same learned transition, so §5.6 feedback
    // scores the transition as a whole.
    expect(new Set(preds.map((p) => p.ruleId)).size).toBe(1);
  });

  it('never exceeds maxPredictionsPerTrigger when a transition offers variants', () => {
    const learner = new TransitionLearner({ now, maxPredictionsPerTrigger: 2 });
    [0, 0, 0, 1, 0, 2, 0, 1, 0, 2, 1, 0].forEach((row, i) => openRow(learner, i, row));
    expect(learner.predict(threeRows)).toHaveLength(2);
  });

  it('evicts the weakest source at the cap instead of refusing new ones', () => {
    const learner = new TransitionLearner({ now });
    // Twelve one-off literals: every sighting mints a const nothing else
    // explains, saturating the per-argument cap with hypotheses that never
    // recur. (MAX_SOURCES_PER_ARG is 12.)
    for (let i = 0; i < 12; i++) {
      observePair(
        learner,
        'srv',
        { tool: 'a', args: { q: `q${i}` } },
        { tool: 'b', args: { v: `junk${i}` } },
      );
    }
    // Then the follow-up starts copying the trigger's `q` argument, always.
    for (let i = 0; i < 8; i++) {
      observePair(
        learner,
        'srv',
        { tool: 'a', args: { q: `w${i}` } },
        { tool: 'b', args: { v: `w${i}` } },
      );
    }

    const stored = sourcesOf(learner, 'b', 'v');
    expect(stored.length).toBeLessThanOrEqual(12);
    expect(stored.some((s) => s.kind === 'arg' && s.key === 'q')).toBe(true);
    // And the winner is used: a saturated candidate list is not a life sentence.
    const preds = learner.predict(mkCall('srv', 'a', { q: 'live' }));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ v: 'live' });
  });

  it('keeps loading sources with no score field', () => {
    const learner = new TransitionLearner({ now });
    // A state file written before per-source scoring: sources in the old
    // fixed priority order and no evidence to tell them apart.
    learner.importState({
      transitions: [
        {
          server: 's',
          prevTool: 'a',
          nextTool: 'b',
          count: 3,
          templates: [
            {
              name: 'x',
              underivable: false,
              derived: 3,
              missed: 0,
              sources: [
                { kind: 'arg', key: 'q' },
                { kind: 'const', repr: '"fallback"' },
              ],
            },
          ],
        },
      ],
    });

    const preds = learner.predict(mkCall('s', 'a', { q: 'live' }));
    // Unscored sources rank by the legacy priority order, and an alternative
    // with no evidence behind it is never offered as a second candidate.
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ x: 'live' });
  });

  it('never spends a slot on a hypothesis that has only ever agreed with a better one', () => {
    const learner = new TransitionLearner({ now });
    // The const mined from the first sighting is right whenever the board is
    // `bugs` — but only ever at the same time as the arg-copy, so it has no
    // evidence of its own and offering `bugs` here would waste a slot.
    for (const board of ['bugs', 'bugs', 'platform', 'bugs', 'platform']) {
      observePair(
        learner,
        'srv',
        { tool: 'list', args: { board } },
        { tool: 'get', args: { board } },
      );
    }
    const preds = learner.predict(mkCall('srv', 'list', { board: 'mobile' }));
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual({ board: 'mobile' });
  });

  it('does not let a crowd of tied hedges crowd out another transition best answer', () => {
    const learner = new TransitionLearner({ now });
    // `q` cycles through three literals, so the argument ends up with three
    // equally evidenced hypotheses and no idea which comes next. Ranking a
    // hedge against the LEADER would score all three as though each were the
    // answer; ranking it by its share of the argument's evidence says what is
    // true — each is worth a third — so the rarer transition keeps its slot.
    for (let i = 0; i < 9; i++) {
      observePair(learner, 'srv', { tool: 'a' }, { tool: 'b', args: { q: `v${i % 3}` } });
    }
    for (let i = 0; i < 4; i++) observePair(learner, 'srv', { tool: 'a' }, { tool: 'c' });

    const preds = learner.predict(mkCall('srv', 'a'));
    expect(preds).toHaveLength(3);
    expect(preds.map((p) => p.tool)).toEqual(['b', 'c', 'b']);
  });

  it('lets a source that is right now overtake one that was right last quarter', () => {
    const learner = new TransitionLearner({ now });
    t = 0;
    for (let i = 0; i < 6; i++) openRow(learner, i, 2);
    t = 120 * DAY_MS;
    for (let i = 6; i < 9; i++) openRow(learner, i, 0);

    // Six sightings of row 2 outweigh three of row 0 by raw count; four
    // months of silence is what makes the recent evidence worth more.
    expect(learner.predict(threeRows)[0]!.args).toEqual({ id: 'p' });
  });

  it('drops the whole prediction when one argument cannot be resolved, however many the others offer', () => {
    const learner = new TransitionLearner({ now });
    [0, 1, 0, 1, 0, 2, 1, 2].forEach((row, i) => {
      const ids = [`a${i}`, `b${i}`, `c${i}`];
      observePair(
        learner,
        'srv',
        { tool: 'list', parsed: { token: `t${i}`, rows: ids.map((id) => ({ id })) } },
        { tool: 'open', args: { id: ids[row], token: `t${i}` } },
      );
    });

    // Three ranked ids are available; the token is nowhere in this trigger,
    // so nothing is emitted — a beam never fabricates the argument it lacks.
    expect(learner.predict(threeRows)).toEqual([]);

    const preds = learner.predict(
      mkCall(
        'srv',
        'list',
        {},
        { token: 'T', rows: [{ id: 'p' }, { id: 'q' }, { id: 'r' }] },
      ),
    );
    expect(preds).toHaveLength(3);
    expect(preds.map((p) => p.args)).toEqual([
      { id: 'p', token: 'T' },
      { id: 'q', token: 'T' },
      { id: 'r', token: 'T' },
    ]);
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
