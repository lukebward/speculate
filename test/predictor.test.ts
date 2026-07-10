/**
 * Predictor pipeline tests (DESIGN.md §5, §5.1, §5.6) against a small fake
 * profile and an in-memory metrics recorder.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseResult, Predictor } from '../src/predictor.js';
import type {
  DecisionEvent,
  Prediction,
  ResultParser,
  Rule,
  ServerProfile,
} from '../src/types.js';

// --- fixtures ---------------------------------------------------------------

/** Server label (the config name) — deliberately distinct from profile.name. */
const SERVER = 'srv';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value));
}

/** JSON-in-first-text-block parser, null on failure (like real profiles). */
const jsonTextParser: ResultParser = (result) => {
  const block = result.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return null;
  try {
    return JSON.parse(block.text) as unknown;
  } catch {
    return null;
  }
};

function makeProfile(overrides: Partial<ServerProfile>): ServerProfile {
  return {
    name: 'fakeprof',
    validatedAgainst: 'test fixture',
    readOnlyAllowlist: [],
    defaultTtlMs: 1_000,
    ttlMsByTool: {},
    parsers: {},
    canonicalizers: {},
    rules: [],
    ...overrides,
  };
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
  profile: ServerProfile,
  opts: { maxPerTrigger?: number; feedback?: Record<string, Feedback> } = {},
) {
  const metrics = makeMetrics(opts.feedback);
  const predictor = new Predictor({
    profiles: { [SERVER]: profile },
    maxPerTrigger: opts.maxPerTrigger ?? 3,
    metrics,
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
      parsers: { list: jsonTextParser },
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

  it('fails closed on parser failure: result rules silent, arg rules fire, one parser_miss', () => {
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
      parsers: { list: jsonTextParser },
      rules: [resultRule, argRule('r-alt', 'list', 'meta', 0.5)],
    });
    const { observe, metrics } = setup(profile);

    const out = observe('list', { scope: 'x' }, textResult('{not-json'));

    expect(out).toEqual([pred('meta', { scope: 'x' }, 0.5, 'r-alt')]);
    const misses = metrics.events.filter((e) => e.type === 'parser_miss');
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ server: SERVER, tool: 'list' });
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

    expect(seen).toEqual([null]);
    expect(metrics.events).toHaveLength(0);
  });

  it('prefers structuredContent over the text parser and skips parser_miss', () => {
    const echoRule: Rule = {
      id: 'r-echo',
      trigger: 'list',
      predict: (call) => [pred('echo', { seen: call.parsed }, 0.7, 'r-echo')],
    };
    const profile = makeProfile({
      parsers: { list: jsonTextParser },
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
    expect(out).toEqual([pred('good', { ok: true }, 0.6, 'r-bad')]);
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
    const profile = makeProfile({
      canonicalizers: {
        get: (args) => ({ ...args, mode: args.mode ?? 'full' }),
      },
      rules: [
        {
          id: 'r-one',
          trigger: 'list',
          predict: () => [pred('get', { id: 'X' }, 0.3, 'r-one'), pred('get', { id: 'Y' }, 0.9, 'r-one')],
        },
        {
          id: 'r-two',
          trigger: 'list',
          // {id:'X', mode:'full'} canonicalizes to the same key as {id:'X'}.
          predict: () => [
            pred('get', { id: 'X', mode: 'full' }, 0.8, 'r-two'),
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
    expect(metrics.events.filter((e) => e.type === 'suppressed')).toHaveLength(0);
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

// --- parseResult helper -------------------------------------------------------

describe('parseResult', () => {
  const profile = makeProfile({
    parsers: {
      list: jsonTextParser,
      boom: () => {
        throw new Error('parser exploded');
      },
    },
  });

  it('returns structuredContent when present and non-null', () => {
    const r: CallToolResult = { content: [], structuredContent: { a: 1 } };
    expect(parseResult(profile, 'list', r)).toEqual({ a: 1 });
  });

  it('falls back to the parser when structuredContent is null', () => {
    const r = {
      content: [{ type: 'text', text: '{"b":2}' }],
      structuredContent: null,
    } as unknown as CallToolResult;
    expect(parseResult(profile, 'list', r)).toEqual({ b: 2 });
  });

  it('uses the parser when structuredContent is absent', () => {
    expect(parseResult(profile, 'list', jsonResult([1, 2]))).toEqual([1, 2]);
  });

  it('returns null when the parser throws', () => {
    expect(parseResult(profile, 'boom', textResult('anything'))).toBeNull();
  });

  it('returns null when the parser fails to parse', () => {
    expect(parseResult(profile, 'list', textResult('{nope'))).toBeNull();
  });

  it('returns null with no parser and no structuredContent', () => {
    expect(parseResult(profile, 'unknown_tool', textResult('{"a":1}'))).toBeNull();
  });
});
