/**
 * Predictor pipeline tests (DESIGN.md §5, §5.1, §5.6) against a small fake
 * rule set and an in-memory metrics recorder.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseResult, Predictor } from '../src/predictor.js';
import { LatencyModel } from '../src/latency.js';
import { CandidateCalibrator } from '../src/calibration.js';
import type {
  DecisionEvent,
  Prediction,
  Rule,
} from '../src/types.js';

// --- fixtures ---------------------------------------------------------------

/** Server label from the config. */
const SERVER = 'srv';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value));
}

/**
 * Rules for one server. A rule list is the whole fixture.
 */
function makeProfile(overrides: { rules?: Rule[] }): Rule[] {
  return overrides.rules ?? [];
}

interface Feedback {
  hits: number;
  wasted: number;
  speculated: number;
}

function makeMetrics(feedback: Record<string, Feedback> = {}) {
  const events: DecisionEvent[] = [];
  return {
    events,
    record(ev: DecisionEvent): void {
      events.push(ev);
    },
    ruleFeedback(ruleId: string): Feedback {
      return feedback[ruleId] ?? { hits: 0, wasted: 0, speculated: 0 };
    },
  };
}

function setup(
  rules: Rule[],
  opts: { maxPerTrigger?: number; feedback?: Record<string, Feedback> } = {},
) {
  const metrics = makeMetrics(opts.feedback);
  const predictor = new Predictor({
    maxPerTrigger: opts.maxPerTrigger ?? 3,
    metrics,
    extraRules: { [SERVER]: rules },
  });
  const observe = (tool: string, args: Record<string, unknown>, result: CallToolResult) =>
    predictor
      .observe({ server: SERVER, tool, args, result, latencyMs: 25, timestamp: 1_000 })
      // The stamped canonical `key` is an executor-facing detail; these tests
      // assert pipeline semantics, so compare without it.
      .map(({ key: _key, ...rest }) => rest);
  return { predictor, metrics, observe };
}

function pred(
  tool: string,
  args: Record<string, unknown>,
  confidence: number,
  ruleId: string,
): Prediction {
  return { server: SERVER, tool, args, confidence, ruleId };
}

/** Arg-only rule: fires regardless of `parsed`, deriving args from the trigger. */
function argRule(id: string, trigger: string, tool: string, confidence: number): Rule {
  return {
    id,
    trigger,
    predict: (call) => [
      {
        server: call.server,
        tool,
        args: { scope: call.args.scope ?? 'all' },
        confidence,
        ruleId: id,
      },
    ],
  };
}

// --- observe pipeline ---------------------------------------------------------

describe('Predictor.observe', () => {
  it('runs result-derived rules on parsed output and skips non-matching triggers', () => {
    const resultRule: Rule = {
      id: 'r-items',
      trigger: 'list',
      predict: (call) => {
        if (!Array.isArray(call.parsed)) return [];
        return (call.parsed as Array<{ id: string }>).map((entry, i) =>
          pred('get', { id: entry.id }, 0.9 - i * 0.2, 'r-items'),
        );
      },
    };
    const otherTrigger: Rule = {
      id: 'r-other',
      trigger: 'different_tool',
      predict: () => [pred('never', {}, 1, 'r-other')],
    };
    const profile = makeProfile({
      rules: [resultRule, otherTrigger, argRule('r-alt', 'list', 'meta', 0.5)],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', { scope: 's' }, jsonResult([{ id: 'a' }, { id: 'b' }]));

    expect(out.map((p) => [p.tool, p.args])).toEqual([
      ['get', { id: 'a' }],
      ['get', { id: 'b' }],
      ['meta', { scope: 's' }],
    ]);
    expect(metrics.events.filter((e) => e.type === 'parser_miss')).toHaveLength(0);
    expect(metrics.events.filter((e) => e.type === 'predicted')).toHaveLength(3);
  });

  it('fails closed on unparseable output: result rules silent, arg rules still fire', () => {
    // With per-server parsers gone, a non-JSON body is ORDINARY rather than a
    // parser failure, so it produces no `parser_miss`. What must not change is
    // the containment: a rule that needs `parsed` sees null and stays quiet
    // while a rule reading only trigger args is unaffected.
    const resultRule: Rule = {
      id: 'r-items',
      trigger: 'list',
      predict: (call) => {
        if (!Array.isArray(call.parsed)) return [];
        return (call.parsed as Array<{ id: string }>).map((entry) =>
          pred('get', { id: entry.id }, 0.9, 'r-items'),
        );
      },
    };
    const profile = makeProfile({
      rules: [resultRule, argRule('r-alt', 'list', 'meta', 0.5)],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', { scope: 'x' }, textResult('{not-json'));

    expect(out).toEqual([{ ...pred('meta', { scope: 'x' }, 0.5, 'r-alt'), horizon: 'next' }]);
    expect(metrics.events.filter((e) => e.type === 'parser_miss')).toHaveLength(0);
    expect(metrics.events.filter((e) => e.type === 'predicted')).toHaveLength(1);
  });

  it('records no parser_miss when the tool has no parser and no structuredContent', () => {
    const seen: unknown[] = [];
    const spyRule: Rule = {
      id: 'r-spy',
      trigger: 'list',
      predict: (call) => {
        seen.push(call.parsed);
        return [];
      },
    };
    const profile = makeProfile({ rules: [spyRule] });
    const { observe, metrics } = setup(profile);

    observe('list', {}, textResult('{"valid":"json"}'));

    expect(seen).toEqual([{ valid: 'json' }]);
    expect(metrics.events).toHaveLength(0);
  });

  it('prefers structuredContent over the text parser and skips parser_miss', () => {
    const echoRule: Rule = {
      id: 'r-echo',
      trigger: 'list',
      predict: (call) => [pred('echo', { seen: call.parsed }, 0.7, 'r-echo')],
    };
    const profile = makeProfile({
      rules: [echoRule],
    });
    const { observe, metrics } = setup(profile);

    const result: CallToolResult = {
      content: [{ type: 'text', text: '{definitely-not-json' }],
      structuredContent: { marker: 'sc' },
    };
    const out = observe('list', {}, result);

    expect(out).toHaveLength(1);
    expect(out[0].args).toEqual({ seen: { marker: 'sc' } });
    expect(metrics.events.filter((e) => e.type === 'parser_miss')).toHaveLength(0);
  });

  it('contains a throwing rule, records suppressed/rule-error, and runs other rules', () => {
    const profile = makeProfile({
      rules: [
        {
          id: 'r-throw',
          trigger: 'list',
          predict: () => {
            throw new Error('bad rule');
          },
        },
        argRule('r-alt', 'list', 'meta', 0.5),
      ],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', {}, jsonResult({}));

    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe('r-alt');
    expect(metrics.events.filter((e) => e.type === 'suppressed')).toEqual([
      expect.objectContaining({
        ruleId: 'r-throw',
        reason: 'rule-error',
        server: SERVER,
        tool: 'list',
      }),
    ]);
  });

  it('drops malformed predictions silently and forces the trigger server', () => {
    const emitted = [
      { server: SERVER, tool: '', args: {}, confidence: 0.9, ruleId: 'r-bad' },
      { server: SERVER, tool: 7, args: {}, confidence: 0.9, ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', args: 'not-an-object', confidence: 0.9, ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', args: null, confidence: 0.9, ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', args: [1], confidence: 0.9, ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', confidence: 0.9, ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', args: {}, confidence: 'high', ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', args: {}, confidence: Number.NaN, ruleId: 'r-bad' },
      { server: SERVER, tool: 'x', args: {}, ruleId: 'r-bad' },
      null,
      { server: 'elsewhere', tool: 'good', args: { ok: true }, confidence: 0.6, ruleId: 'r-bad' },
    ];
    const profile = makeProfile({
      rules: [{ id: 'r-bad', trigger: 'list', predict: () => emitted as unknown as Prediction[] }],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', {}, jsonResult({}));

    // Only the well-formed one survives, with server forced back to the trigger's.
    expect(out).toEqual([{ ...pred('good', { ok: true }, 0.6, 'r-bad'), horizon: 'next' }]);
    expect(metrics.events.filter((e) => e.type === 'suppressed')).toHaveLength(0);
    expect(metrics.events.filter((e) => e.type === 'predicted')).toHaveLength(1);
  });

  it('clamps confidence into [0,1] on predictions and predicted events', () => {
    const profile = makeProfile({
      rules: [
        {
          id: 'r-wild',
          trigger: 'list',
          predict: () => [pred('p', {}, 3, 'r-wild'), pred('q', {}, -2, 'r-wild')],
        },
      ],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', {}, jsonResult({}));

    expect(out.map((p) => [p.tool, p.confidence])).toEqual([
      ['p', 1],
      ['q', 0],
    ]);
    const predicted = metrics.events.filter((e) => e.type === 'predicted');
    expect(predicted.map((e) => e.confidence)).toEqual([1, 0]);
  });

  it('dedupes within a batch on canonical key, keeping the higher-scored prediction', () => {
    // Args are compared as-is now. Per-tool canonicalizers used to fold a
    // missing argument into a server default so two spellings shared a key;
    // they went with profiles, because guessing a default wrong serves one
    // query's answer for another. Identical args still collapse.
    const profile = makeProfile({
      rules: [
        {
          id: 'r-one',
          trigger: 'list',
          predict: () => [pred('get', { id: 'X' }, 0.3, 'r-one'), pred('get', { id: 'Y' }, 0.9, 'r-one')],
        },
        {
          id: 'r-two',
          trigger: 'list',
          predict: () => [
            pred('get', { id: 'X' }, 0.8, 'r-two'),
            pred('get', { id: 'Y' }, 0.2, 'r-two'),
          ],
        },
      ],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', {}, jsonResult({}));

    // Key X: r-two's 0.8 replaces r-one's 0.3; key Y: r-one's 0.9 beats r-two's 0.2.
    expect(out.map((p) => [p.args.id, p.confidence, p.ruleId])).toEqual([
      ['Y', 0.9, 'r-one'],
      ['X', 0.8, 'r-two'],
    ]);
    expect(metrics.events.filter((e) => e.type === 'predicted')).toHaveLength(2);
    expect(metrics.events.filter((e) => e.type === 'suppressed').map((event) => [event.ruleId, event.reason]))
      .toEqual([['r-one', 'dedup'], ['r-two', 'dedup']]);
  });

  it('ranks by confidence × effectiveness and applies the per-trigger cap', () => {
    const profile = makeProfile({
      rules: [
        { id: 'r-mid', trigger: 'list', predict: () => [pred('b', {}, 0.9, 'r-mid')] },
        { id: 'r-hi', trigger: 'list', predict: () => [pred('a', {}, 0.6, 'r-hi')] },
        { id: 'r-lo', trigger: 'list', predict: () => [pred('c', {}, 0.5, 'r-lo')] },
      ],
    });
    const { observe, metrics } = setup(profile, {
      maxPerTrigger: 2,
      // effectiveness(r-hi) = (8+1)/(8+0+2) = 0.9; others Laplace-neutral 0.5.
      feedback: { 'r-hi': { hits: 8, wasted: 0, speculated: 8 } },
    });

    const out = observe('list', {}, jsonResult({}));

    // Scores: r-hi 0.6×0.9=0.54 > r-mid 0.9×0.5=0.45 > r-lo 0.5×0.5=0.25.
    expect(out.map((p) => p.ruleId)).toEqual(['r-hi', 'r-mid']);
    expect(metrics.events.filter((e) => e.type === 'suppressed')).toEqual([
      expect.objectContaining({ ruleId: 'r-lo', reason: 'per-trigger-cap', tool: 'c' }),
    ]);
    expect(
      metrics.events.filter((e) => e.type === 'predicted').map((e) => e.ruleId),
    ).toEqual(['r-hi', 'r-mid']);
  });

  it('suppresses every prediction of a rule with speculated>=8 and effectiveness<0.15', () => {
    const profile = makeProfile({
      rules: [
        {
          id: 'r-dead',
          trigger: 'list',
          predict: () => [pred('d1', {}, 0.9, 'r-dead'), pred('d2', {}, 0.8, 'r-dead')],
        },
        { id: 'r-live', trigger: 'list', predict: () => [pred('ok', {}, 0.4, 'r-live')] },
      ],
    });
    const { observe, metrics } = setup(profile, {
      // effectiveness = (0+1)/(0+8+2) = 0.1 < 0.15 with speculated 8.
      feedback: { 'r-dead': { hits: 0, wasted: 8, speculated: 8 } },
    });

    const out = observe('list', {}, jsonResult({}));

    expect(out.map((p) => p.ruleId)).toEqual(['r-live']);
    const suppressed = metrics.events.filter(
      (e) => e.type === 'suppressed' && e.reason === 'feedback',
    );
    expect(suppressed.map((e) => [e.ruleId, e.tool])).toEqual([
      ['r-dead', 'd1'],
      ['r-dead', 'd2'],
    ]);
    expect(
      metrics.events.filter((e) => e.type === 'predicted').map((e) => e.ruleId),
    ).toEqual(['r-live']);
  });

  it('does not feedback-suppress below the speculated>=8 threshold', () => {
    const profile = makeProfile({
      rules: [{ id: 'r-dead', trigger: 'list', predict: () => [pred('d', {}, 0.9, 'r-dead')] }],
    });
    const { observe } = setup(profile, {
      feedback: { 'r-dead': { hits: 0, wasted: 8, speculated: 7 } },
    });

    expect(observe('list', {}, jsonResult({})).map((p) => p.ruleId)).toEqual(['r-dead']);
  });

  it('does not feedback-suppress a rule at or above the effectiveness floor', () => {
    const profile = makeProfile({
      rules: [{ id: 'r-meh', trigger: 'list', predict: () => [pred('m', {}, 0.9, 'r-meh')] }],
    });
    const { observe } = setup(profile, {
      // effectiveness = (1+1)/(1+9+2) ≈ 0.167 >= 0.15 despite speculated 10.
      feedback: { 'r-meh': { hits: 1, wasted: 9, speculated: 10 } },
    });

    expect(observe('list', {}, jsonResult({})).map((p) => p.ruleId)).toEqual(['r-meh']);
  });

  it('returns [] and records no events for a server with no profile', () => {
    const profile = makeProfile({ rules: [argRule('r-alt', 'list', 'meta', 0.5)] });
    const metrics = makeMetrics();
    const predictor = new Predictor({
      profiles: { [SERVER]: profile },
      maxPerTrigger: 3,
      metrics,
    });

    const out = predictor.observe({
      server: 'unknown-server',
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 1,
    });

    expect(out).toEqual([]);
    expect(metrics.events).toEqual([]);
  });
});

describe('Predictor.admitResolved', () => {
  it('uses the existing feedback cutoff and assigns canonical keys locally', () => {
    const metrics = makeMetrics({
      'observer:claude:intent': { hits: 0, wasted: 8, speculated: 8 },
    });
    const predictor = new Predictor({ maxPerTrigger: 3, metrics });
    const admitted = predictor.admitResolved(SERVER, [
      { tool: 'read', args: { path: '/a' }, confidence: 0.9, candidateId: 'good', ruleId: 'observer:codex:intent' },
      { tool: 'read', args: { path: '/b' }, confidence: 0.9, candidateId: 'muted', ruleId: 'observer:claude:intent' },
    ], { timestamp: 10, trackNextCall: false });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ server: SERVER, tool: 'read', args: { path: '/a' }, ruleId: 'observer:codex:intent' });
    expect(admitted[0]!.key).toEqual(expect.any(String));
    expect(metrics.events).toContainEqual(expect.objectContaining({ type: 'suppressed', reason: 'feedback', ruleId: 'observer:claude:intent' }));
  });

  it('does not overwrite the ordinary next-call evaluation batch when tracking is disabled', () => {
    const calibration = new CandidateCalibrator({ now: () => 1 });
    const metrics = makeMetrics();
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      calibration,
      extraRules: { [SERVER]: [argRule('ordinary', 'list', 'detail', 0.8)] },
    });
    predictor.observe({ server: SERVER, tool: 'list', args: { scope: 'x' }, result: jsonResult({}), latencyMs: 5, timestamp: 1 });
    predictor.admitResolved(SERVER, [
      { tool: 'other', args: {}, confidence: 0.8, candidateId: 'external', ruleId: 'observer:codex:stream' },
    ], { timestamp: 2, trackNextCall: false });
    predictor.observe({ server: SERVER, tool: 'detail', args: { scope: 'x' }, result: jsonResult({}), latencyMs: 5, timestamp: 3 });

    expect(metrics.events).toContainEqual(expect.objectContaining({ type: 'candidate_evaluated', candidateId: 'ordinary', correct: true }));
    expect(metrics.events).not.toContainEqual(expect.objectContaining({ type: 'candidate_evaluated', candidateId: 'external' }));
  });

  it('uses operational outcomes to suppress only the low-value resolved rule', () => {
    const poor = 'observer:claude:intent:poor';
    const useful = 'observer:claude:intent:useful';
    const metrics = makeMetrics({
      [poor]: { hits: 0, wasted: 5, speculated: 5 },
    });
    const latency = new LatencyModel({ now: () => 10 });
    latency.observe(SERVER, 'poor', 100);
    latency.observe(SERVER, 'useful', 100);
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      latency,
      calibration: new CandidateCalibrator({ now: () => 10 }),
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 15 } },
    });

    const admitted = predictor.admitResolved(SERVER, [
      {
        tool: 'poor', args: {}, confidence: 0.95, candidateId: poor, ruleId: poor,
        observerAttribution: { client: 'claude', source: 'intent', routeId: 'poor', generation: 1, candidateCreatedAt: 1 },
      },
      {
        tool: 'useful', args: {}, confidence: 0.95, candidateId: useful, ruleId: useful,
        observerAttribution: { client: 'claude', source: 'intent', routeId: 'useful', generation: 1, candidateCreatedAt: 1 },
      },
    ], { timestamp: 10, trackNextCall: false });

    expect(admitted.map((prediction) => prediction.ruleId)).toEqual([useful]);
    expect(metrics.events).toContainEqual(expect.objectContaining({
      type: 'suppressed', ruleId: poor, reason: 'low-utility',
    }));
  });

  it('keeps the calibrated prior until observer feedback has a terminal outcome', () => {
    const ruleId = 'observer:claude:intent:fresh';
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics: makeMetrics({
        [ruleId]: { hits: 0, wasted: 0, speculated: 3 },
      }),
      calibration: new CandidateCalibrator({ now: () => 10 }),
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 15 } },
    });

    expect(predictor.admitResolved(SERVER, [{
      tool: 'read', args: {}, confidence: 0.95, expectedLatencyMs: 30,
      candidateId: ruleId, ruleId,
      observerAttribution: { client: 'claude', source: 'intent', routeId: 'read', generation: 1, candidateCreatedAt: 1 },
    }], { timestamp: 10, trackNextCall: false })).toHaveLength(1);
  });

  it('applies resolved operational effectiveness only once without a calibrator', () => {
    const ruleId = 'observer:codex:transition:stable';
    const metrics = makeMetrics({
      [ruleId]: { hits: 3, wasted: 1, speculated: 4 },
    });
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 50 } },
    });

    expect(predictor.admitResolved(SERVER, [{
      tool: 'read', args: {}, confidence: 0.9, expectedLatencyMs: 100,
      candidateId: ruleId, ruleId,
      observerAttribution: { client: 'codex', source: 'transition', routeId: 'read', generation: 1, candidateCreatedAt: 1 },
    }], { timestamp: 10, trackNextCall: false })).toHaveLength(1);
  });
});

// --- parseResult helper -------------------------------------------------------

// --- freshness classification (§6.2) -----------------------------------------

describe('prediction horizon follows the entrypoint', () => {
  const profile = makeProfile({});

  function withLearner(predictions: Prediction[], openers: Prediction[] = []) {
    const metrics = makeMetrics();
    const predictor = new Predictor({
      profiles: { [SERVER]: profile },
      maxPerTrigger: 3,
      metrics,
      learner: {
        observe: () => {},
        predict: () => predictions,
        openerPredictions: () => openers,
      },
    });
    return predictor;
  }

  it('classifies a trigger prediction as next even if its source says standing', () => {
    const p = predictor(withLearner([{ ...pred('t', {}, 0.5, 'learned:x'), horizon: 'standing' }]));
    expect(p[0]!.horizon).toBe('next');
  });

  it('carries a next-call classification through unchanged', () => {
    const p = predictor(withLearner([{ ...pred('t', {}, 0.5, 'learned:x'), horizon: 'next' }]));
    expect(p[0]!.horizon).toBe('next');
  });

  it('classifies a trigger prediction with no supplied horizon as next', () => {
    const p = predictor(withLearner([pred('t', {}, 0.5, 'learned:x')]));
    expect(p[0]!.horizon).toBe('next');
  });

  it('classifies a trigger prediction with an invalid supplied horizon as next', () => {
    const raw = { ...pred('t', {}, 0.5, 'learned:x'), horizon: 'forever' } as unknown as Prediction;
    const p = predictor(withLearner([raw]));
    expect(p[0]!.horizon).toBe('next');
  });

  it('classifies session openers as standing bets', () => {
    const p = withLearner([], [pred('o', {}, 0.4, 'opener:srv:o')]);
    expect(p.sessionStart(SERVER)[0]!.horizon).toBe('standing');
  });

  /** One observe() round against a predictor wired with a fake learner. */
  function predictor(p: Predictor): Prediction[] {
    return p.observe({
      server: SERVER,
      tool: 'trigger',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 1_000,
    });
  }
});

describe('parseResult', () => {
  it('returns structuredContent when present and non-null', () => {
    const r: CallToolResult = { content: [], structuredContent: { a: 1 } };
    expect(parseResult(r)).toEqual({ a: 1 });
  });

  it('falls back to text sniffing when structuredContent is null', () => {
    const r = {
      content: [{ type: 'text', text: '{"b":2}' }],
      structuredContent: null,
    } as unknown as CallToolResult;
    expect(parseResult(r)).toEqual({ b: 2 });
  });

  it('sniffs JSON out of a text block when structuredContent is absent', () => {
    expect(parseResult(jsonResult([1, 2]))).toEqual([1, 2]);
  });

  it('returns null for a body that is not JSON', () => {
    expect(parseResult(textResult('{nope'))).toBeNull();
    expect(parseResult(textResult('plain prose'))).toBeNull();
  });

  it('parses any tool, since nothing is per-tool any more', () => {
    // Previously a tool with no vetted parser fell to a generic path; now
    // there is only the generic path, so every tool behaves identically.
    expect(parseResult(textResult('{"a":1}'))).toEqual({ a: 1 });
  });

  it('continues past prose blocks and understands fenced JSON', () => {
    const result = {
      content: [
        { type: 'text', text: 'Here are the results:' },
        { type: 'text', text: '```json\n{"items":[{"id":7}]}\n```' },
      ],
    } as CallToolResult;
    expect(parseResult(result)).toEqual({ items: [{ id: 7 }] });
  });
});

describe('prediction telemetry and adaptive admission', () => {
  it('records the exact rank of the next eligible real call', () => {
    const metrics = makeMetrics();
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      extraRules: {
        [SERVER]: [{
          id: 'next',
          trigger: 'list',
          predict: () => [pred('get', { id: 7 }, 0.9, 'next')],
        }],
      },
    });
    predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 20,
      timestamp: 1,
    });
    predictor.observe({
      server: SERVER,
      tool: 'get',
      args: { id: 7 },
      result: jsonResult({}),
      latencyMs: 20,
      timestamp: 2,
      eligibleTarget: true,
    });
    expect(metrics.events).toContainEqual(expect.objectContaining({
      type: 'prediction_evaluated',
      rank: 1,
      candidateCount: 1,
    }));
  });

  it('suppresses low-value fast calls while retaining slow valuable ones', () => {
    const metrics = makeMetrics();
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 20 } },
      extraRules: {
        [SERVER]: [{
          id: 'utility',
          trigger: 'list',
          predict: () => [
            { ...pred('fast', {}, 0.8, 'utility'), expectedLatencyMs: 10 },
            { ...pred('slow', {}, 0.8, 'utility'), expectedLatencyMs: 200 },
          ],
        }],
      },
    });
    const out = predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 20,
      timestamp: 1,
    });
    expect(out.map((prediction) => prediction.tool)).toEqual(['slow']);
    expect(metrics.events).toContainEqual(expect.objectContaining({
      type: 'suppressed',
      tool: 'fast',
      reason: 'low-utility',
    }));
    predictor.observe({
      server: SERVER,
      tool: 'fast',
      args: {},
      result: jsonResult({}),
      latencyMs: 10,
      timestamp: 2,
      eligibleTarget: true,
    });
    expect(metrics.events).toContainEqual(expect.objectContaining({
      type: 'prediction_evaluated',
      rank: 2,
      candidateCount: 2,
    }));
  });

  it('does not apply resolved operational weighting to ordinary calibrated rules', () => {
    const metrics = makeMetrics({
      ordinary: { hits: 0, wasted: 5, speculated: 5 },
    });
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      calibration: new CandidateCalibrator({ now: () => 1 }),
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 50 } },
      extraRules: {
        [SERVER]: [{
          id: 'ordinary',
          trigger: 'list',
          predict: () => [{ ...pred('detail', {}, 0.9, 'ordinary'), expectedLatencyMs: 100 }],
        }],
      },
    });

    expect(predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 10,
      timestamp: 1,
    })).toHaveLength(1);
  });

  it('uses persisted tool latency ahead of a legacy prediction hint', () => {
    const metrics = makeMetrics();
    const latency = new LatencyModel({ now: () => 1 });
    latency.observe(SERVER, 'detail', 200);
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      latency,
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 20 } },
      extraRules: {
        [SERVER]: [{
          id: 'persisted-latency',
          trigger: 'list',
          predict: () => [{
            ...pred('detail', {}, 0.5, 'persisted-latency'),
            expectedLatencyMs: 5,
          }],
        }],
      },
    });
    const out = predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 1,
      eligibleTarget: true,
    });
    expect(out.map((prediction) => prediction.tool)).toEqual(['detail']);
  });

  it('does not let ineligible mutation latency contaminate the server fallback', () => {
    const metrics = makeMetrics();
    const latency = new LatencyModel({ now: () => 1 });
    const predictor = new Predictor({ maxPerTrigger: 3, metrics, latency });
    predictor.observe({
      server: SERVER,
      tool: 'mutate',
      args: {},
      result: jsonResult({}),
      latencyMs: 500,
      timestamp: 1,
      eligibleTarget: false,
    });
    expect(latency.revision).toBe(0);
    expect(latency.estimate(SERVER, 'read').source).toBe('unknown');
  });

  it('credits a correct candidate even when latency admission suppresses it', () => {
    const metrics = makeMetrics();
    const latency = new LatencyModel({ now: () => 1 });
    latency.observe(SERVER, 'detail', 5);
    const calibration = new CandidateCalibrator({ now: () => 1 });
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      latency,
      calibration,
      admission: { [SERVER]: { enabled: true, minExpectedSavedMs: 20 } },
      extraRules: {
        [SERVER]: [{
          id: 'shadow',
          trigger: 'list',
          predict: () => [pred('detail', { id: 7 }, 0.8, 'shadow')],
        }],
      },
    });
    expect(predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 1,
      eligibleTarget: true,
    })).toEqual([]);
    predictor.observe({
      server: SERVER,
      tool: 'detail',
      args: { id: 7 },
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 2,
      eligibleTarget: true,
    });
    expect(calibration.probability('shadow', 0.8).probability).toBeCloseTo(0.84);
    expect(metrics.events).toContainEqual(expect.objectContaining({
      type: 'candidate_evaluated',
      candidateId: 'shadow',
      correct: true,
      admitted: false,
    }));
  });

  it('clears shadow candidates across a mutation without inventing negatives', () => {
    const metrics = makeMetrics();
    const calibration = new CandidateCalibrator({ now: () => 1 });
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      calibration,
      extraRules: {
        [SERVER]: [{
          id: 'shadow',
          trigger: 'list',
          predict: () => [pred('detail', { id: 7 }, 0.8, 'shadow')],
        }],
      },
    });
    predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 1,
      eligibleTarget: true,
    });
    predictor.observe({
      server: SERVER,
      tool: 'mutate',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 2,
      eligibleTarget: false,
    });
    predictor.observe({
      server: SERVER,
      tool: 'detail',
      args: { id: 7 },
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 3,
      eligibleTarget: true,
    });
    expect(calibration.revision).toBe(0);
    expect(metrics.events.filter((event) => event.type === 'candidate_evaluated')).toEqual([]);
  });

  it('ranks alternatives by calibrated next-call probability', () => {
    const metrics = makeMetrics();
    const calibration = new CandidateCalibrator({ now: () => 1 });
    for (let i = 0; i < 12; i++) {
      calibration.observe('ranked', false);
      calibration.observe('ranked#2', true);
    }
    const predictor = new Predictor({
      maxPerTrigger: 3,
      metrics,
      calibration,
      extraRules: {
        [SERVER]: [{
          id: 'ranked',
          trigger: 'list',
          predict: () => [
            pred('detail', { id: 'historically-wrong' }, 0.5, 'ranked'),
            pred('detail', { id: 'historically-right' }, 0.5, 'ranked'),
          ],
        }],
      },
    });
    const out = predictor.observe({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 100,
      timestamp: 1,
      eligibleTarget: true,
    });
    expect(out.map((prediction) => prediction.args['id'])).toEqual([
      'historically-right',
      'historically-wrong',
    ]);
  });
});

describe('prepared prediction batches', () => {
  it('snapshots the full deduplicated frontier before the baseline cap', () => {
    const emitted = [
      pred('detail', { nested: { id: 'a' } }, 0.9, 'frontier'),
      pred('detail', { nested: { id: 'b' } }, 0.8, 'frontier'),
      pred('detail', { nested: { id: 'c' } }, 0.7, 'frontier'),
    ];
    const predictor = new Predictor({
      maxPerTrigger: 1,
      metrics: makeMetrics(),
      extraRules: {
        [SERVER]: [{ id: 'frontier', trigger: 'list', predict: () => emitted }],
      },
    });

    const batch = predictor.prepareObserved({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 25,
      timestamp: 100,
    });
    (emitted[0]!.args.nested as { id: string }).id = 'mutated';

    expect(batch.candidates).toHaveLength(3);
    expect(batch.baselineSelection).toHaveLength(1);
    expect(batch.candidates[0]!.prediction.args).toEqual({ nested: { id: 'a' } });
    expect(Object.isFrozen(batch.candidates[0]!.prediction.args)).toBe(true);
    expect(Object.isFrozen(batch.candidates[0]!.prediction.args.nested as object)).toBe(true);
  });

  it('uses semantic probability only for selection and preserves prediction identity', () => {
    const predictor = new Predictor({
      maxPerTrigger: 1,
      metrics: makeMetrics(),
      extraRules: {
        [SERVER]: [{
          id: 'semantic',
          trigger: 'list',
          predict: () => [
            pred('detail', { id: 'baseline' }, 0.9, 'semantic'),
            pred('detail', { id: 'semantic' }, 0.2, 'semantic'),
          ],
        }],
      },
    });
    const batch = predictor.prepareObserved({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 25,
      timestamp: 100,
    });
    const [baseline, semantic] = batch.candidates;

    const selected = predictor.selectPrepared(batch, {
      semanticScores: { [baseline!.id]: 0.01, [semantic!.id]: 0.95 },
      remainingWindowMs: { [baseline!.id]: 1_000, [semantic!.id]: 1_000 },
    });

    expect(selected).toEqual([
      expect.objectContaining({
        args: { id: 'semantic' },
        confidence: 0.2,
        ruleId: 'semantic',
        schedulingPriorityMs: 95,
      }),
    ]);
  });

  it('adds baseline utility only when rank-mode queueing requests it', () => {
    const predictor = new Predictor({
      maxPerTrigger: 1,
      metrics: makeMetrics(),
      extraRules: {
        [SERVER]: [{
          id: 'fallback',
          trigger: 'list',
          predict: () => [pred('detail', { id: 1 }, 0.8, 'fallback')],
        }],
      },
    });
    const makeBatch = () => predictor.prepareObserved({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 25,
      timestamp: 100,
    });

    expect(predictor.selectPrepared(makeBatch())[0]).not.toHaveProperty('schedulingPriorityMs');
    expect(predictor.selectPrepared(makeBatch(), { queueByUtility: true })[0])
      .toMatchObject({ schedulingPriorityMs: 40, confidence: 0.8 });
  });

  it('installs baseline next-call calibration before semantic selection can await', () => {
    const metrics = makeMetrics();
    const calibration = new CandidateCalibrator({ now: () => 1 });
    const predictor = new Predictor({
      maxPerTrigger: 1,
      metrics,
      calibration,
      extraRules: {
        [SERVER]: [{
          id: 'sync-baseline',
          trigger: 'list',
          predict: () => [pred('detail', { id: 7 }, 0.8, 'sync-baseline')],
        }],
      },
    });

    predictor.prepareObserved({
      server: SERVER,
      tool: 'list',
      args: {},
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 1,
      eligibleTarget: true,
    });
    predictor.prepareObserved({
      server: SERVER,
      tool: 'detail',
      args: { id: 7 },
      result: jsonResult({}),
      latencyMs: 5,
      timestamp: 2,
      eligibleTarget: true,
    });

    expect(calibration.revision).toBe(1);
    expect(metrics.events).toContainEqual(expect.objectContaining({
      type: 'candidate_evaluated',
      candidateId: 'sync-baseline',
      correct: true,
    }));
  });
});
