/**
 * Tests for declarative config-authored prediction rules (src/configRules.ts):
 * schema validation of the selector language, compilation to Rule objects,
 * and fail-closed/never-throw runtime behavior (DESIGN.md §5.1, §5.2).
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  compileConfigRules,
  configRuleSpecSchema,
  type ConfigRuleSpec,
} from '../src/configRules.js';
import type { ObservedCall, Prediction, Rule } from '../src/types.js';

// --- fixtures ---------------------------------------------------------------

const SERVER = 'gh';
const EMPTY_RESULT: CallToolResult = { content: [] };

function observed(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return {
    server: SERVER,
    tool: 'list_pull_requests',
    args: {},
    result: EMPTY_RESULT,
    parsed: null,
    timestamp: 0,
    latencyMs: 0,
    ...overrides,
  };
}

/** Parse raw JSON through the public schema (as config.ts will), then compile. */
function compile(raw: unknown): Rule[] {
  const spec: ConfigRuleSpec = configRuleSpecSchema.parse(raw);
  return compileConfigRules(SERVER, [spec]);
}

/** Compile a single-entry spec and run its one rule against an observed call. */
function run(raw: unknown, call: Partial<ObservedCall> = {}): Prediction[] {
  const rules = compile(raw);
  expect(rules).toHaveLength(1);
  return rules[0].predict(observed(call));
}

/** Wrap one predict entry in a spec triggered by list_pull_requests. */
function entrySpec(entry: Record<string, unknown>): unknown {
  return { trigger: 'list_pull_requests', predict: [entry] };
}

/** safeParse a raw spec, assert it fails, return "<path>: <message>" lines. */
function rejection(raw: unknown): string {
  const result = configRuleSpecSchema.safeParse(raw);
  expect(result.success).toBe(false);
  if (result.success) return '';
  return result.error.issues
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join('\n');
}

// --- schema -----------------------------------------------------------------

describe('configRuleSpecSchema', () => {
  it('accepts the documented example and keeps explicit values', () => {
    const spec = configRuleSpecSchema.parse({
      trigger: 'list_pull_requests',
      predict: [
        {
          tool: 'get_pull_request',
          args: { owner: '$args.owner', repo: '$args.repo', pull_number: '$item.number' },
          confidence: 0.5,
          forEach: '$parsed',
          limit: 2,
        },
      ],
    });
    expect(spec.trigger).toBe('list_pull_requests');
    expect(spec.predict[0].tool).toBe('get_pull_request');
    expect(spec.predict[0].confidence).toBe(0.5);
    expect(spec.predict[0].forEach).toBe('$parsed');
    expect(spec.predict[0].limit).toBe(2);
  });

  it('defaults confidence to 0.4 and limit to 2', () => {
    const spec = configRuleSpecSchema.parse(entrySpec({ tool: 't', args: {} }));
    expect(spec.predict[0].confidence).toBe(0.4);
    expect(spec.predict[0].limit).toBe(2);
  });

  it('clamps confidence into [0, 1]', () => {
    const high = configRuleSpecSchema.parse(entrySpec({ tool: 't', args: {}, confidence: 3 }));
    const low = configRuleSpecSchema.parse(entrySpec({ tool: 't', args: {}, confidence: -2 }));
    expect(high.predict[0].confidence).toBe(1);
    expect(low.predict[0].confidence).toBe(0);
  });

  it('rejects out-of-range or non-integer limit', () => {
    for (const limit of [0, 5, 1.5]) {
      const raw = entrySpec({ tool: 't', args: {}, forEach: '$parsed', limit });
      expect(configRuleSpecSchema.safeParse(raw).success).toBe(false);
    }
    const ok = entrySpec({ tool: 't', args: {}, forEach: '$parsed', limit: 4 });
    expect(configRuleSpecSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects "$item" in args when forEach is absent', () => {
    const message = rejection(entrySpec({ tool: 't', args: { n: '$item.number' } }));
    expect(message).toContain('forEach');
    expect(message).toContain('predict.0.args.n');
    // Bare "$item" is rejected the same way.
    expect(rejection(entrySpec({ tool: 't', args: { n: '$item' } }))).toContain('forEach');
  });

  it('accepts "$item" in args when forEach is present', () => {
    const raw = entrySpec({ tool: 't', args: { n: '$item.number' }, forEach: '$parsed' });
    expect(configRuleSpecSchema.safeParse(raw).success).toBe(true);
  });

  it('rejects unknown $ directives with a helpful message', () => {
    const message = rejection(entrySpec({ tool: 't', args: { a: '$foo.bar' } }));
    expect(message).toContain('"$foo.bar"');
    expect(message).toContain('$args');
    expect(message).toContain('$$');
    for (const bad of ['$', '$argsx', '$parsedx.number', '$args.', '$parsed..number']) {
      expect(configRuleSpecSchema.safeParse(entrySpec({ tool: 't', args: { a: bad } })).success).toBe(false);
    }
  });

  it('accepts "$$"-escaped and plain literal strings', () => {
    const raw = entrySpec({ tool: 't', args: { a: '$$100', b: 'plain literal' } });
    expect(configRuleSpecSchema.safeParse(raw).success).toBe(true);
  });

  it('treats strings nested inside object/array literals as literals (no deep validation)', () => {
    // "$bogus" and "$item.x" would be invalid at top level, but nested
    // values are literal JSON passed through as-is — so this must parse.
    const raw = entrySpec({
      tool: 't',
      args: { meta: { inner: '$bogus', item: '$item.x' }, list: ['$nope'] },
    });
    expect(configRuleSpecSchema.safeParse(raw).success).toBe(true);
  });

  it('rejects forEach values that are not $args/$parsed selectors', () => {
    for (const bad of ['items', '$$parsed', '$item.children', '$foo']) {
      const raw = entrySpec({ tool: 't', args: {}, forEach: bad });
      expect(configRuleSpecSchema.safeParse(raw).success).toBe(false);
    }
    for (const ok of ['$parsed', '$parsed.items', '$args.ids']) {
      const raw = entrySpec({ tool: 't', args: {}, forEach: ok });
      expect(configRuleSpecSchema.safeParse(raw).success).toBe(true);
    }
  });

  it('rejects an empty predict array and an empty trigger', () => {
    expect(configRuleSpecSchema.safeParse({ trigger: 'x', predict: [] }).success).toBe(false);
    expect(
      configRuleSpecSchema.safeParse({ trigger: '', predict: [{ tool: 't', args: {} }] }).success,
    ).toBe(false);
  });
});

// --- compilation ------------------------------------------------------------

describe('compileConfigRules', () => {
  it('emits one rule per (spec, predict entry) with stable, unique ids', () => {
    const specs = [
      configRuleSpecSchema.parse({
        trigger: 'list_pull_requests',
        predict: [
          { tool: 'get_pull_request', args: {} },
          { tool: 'get_pull_request', args: { detail: true } },
          { tool: 'list_issues', args: {} },
        ],
      }),
      configRuleSpecSchema.parse({
        trigger: 'get_issue',
        predict: [{ tool: 'get_issue_comments', args: {} }],
      }),
    ];
    const rules = compileConfigRules(SERVER, specs);
    expect(rules.map((r) => r.id)).toEqual([
      'config:list_pull_requests→get_pull_request#0',
      'config:list_pull_requests→get_pull_request#1',
      'config:list_pull_requests→list_issues#2',
      'config:get_issue→get_issue_comments#0',
    ]);
    expect(new Set(rules.map((r) => r.id)).size).toBe(4);
    expect(rules.map((r) => r.trigger)).toEqual([
      'list_pull_requests',
      'list_pull_requests',
      'list_pull_requests',
      'get_issue',
    ]);
    // Recompiling yields the same ids (stability across runs).
    expect(compileConfigRules(SERVER, specs).map((r) => r.id)).toEqual(rules.map((r) => r.id));
  });
});

// --- predict: no forEach ----------------------------------------------------

describe('predict without forEach', () => {
  it('passes literals through: string, number, boolean, null, nested object/array', () => {
    const preds = run(
      entrySpec({
        tool: 'search',
        args: {
          q: 'is:open',
          page: 1,
          verbose: true,
          cursor: null,
          filter: { labels: ['bug', 'p1'], nested: { untouched: '$args.owner' } },
        },
        confidence: 0.9,
      }),
      { args: { owner: 'me' } },
    );
    expect(preds).toHaveLength(1);
    expect(preds[0].server).toBe(SERVER);
    expect(preds[0].tool).toBe('search');
    expect(preds[0].confidence).toBe(0.9);
    expect(preds[0].ruleId).toBe('config:list_pull_requests→search#0');
    expect(preds[0].args).toEqual({
      q: 'is:open',
      page: 1,
      verbose: true,
      cursor: null,
      // Nested strings are literals: no deep interpolation inside objects.
      filter: { labels: ['bug', 'p1'], nested: { untouched: '$args.owner' } },
    });
    expect(preds[0].key).toBeUndefined(); // the predictor stamps keys, not rules
  });

  it('returns fresh arg objects on every call', () => {
    const rules = compile(
      entrySpec({ tool: 't', args: { filter: { tags: ['a'] }, owner: '$args.owner' } }),
    );
    const call = observed({ args: { owner: 'me' } });
    const first = rules[0].predict(call)[0];
    const second = rules[0].predict(call)[0];
    expect(first.args).toEqual(second.args);
    expect(first.args).not.toBe(second.args);
    expect(first.args['filter']).not.toBe(second.args['filter']);
    // Mutating one call's output must not leak into later calls.
    (first.args['filter'] as { tags: string[] }).tags.push('mutated');
    expect(rules[0].predict(call)[0].args).toEqual(second.args);
  });

  it('copies $args whole and via dot paths', () => {
    const callArgs = { owner: 'me', repo: 'speculate', opts: { state: 'open' } };
    const preds = run(
      entrySpec({ tool: 't', args: { echo: '$args', owner: '$args.owner', state: '$args.opts.state' } }),
      { args: callArgs },
    );
    expect(preds[0].args).toEqual({ echo: callArgs, owner: 'me', state: 'open' });
    expect(preds[0].args['echo']).not.toBe(callArgs); // fresh copy, not an alias
  });

  it('reads $parsed through array-index dot paths', () => {
    const preds = run(
      entrySpec({ tool: 'get_pull_request', args: { pull_number: '$parsed.items.0.number', total: '$parsed.total' } }),
      { parsed: { total: 2, items: [{ number: 42 }, { number: 7 }] } },
    );
    expect(preds[0].args).toEqual({ pull_number: 42, total: 2 });
  });

  it('drops the whole prediction when any $args path is missing', () => {
    const preds = run(
      entrySpec({ tool: 't', args: { ok: '$args.owner', bad: '$args.missing.deep' } }),
      { args: { owner: 'me' } },
    );
    expect(preds).toEqual([]);
  });

  it('resolves null values but treats undefined as missing', () => {
    const raw = entrySpec({ tool: 't', args: { a: '$args.x' } });
    expect(run(raw, { args: { x: null } })[0].args).toEqual({ a: null });
    expect(run(raw, { args: { x: undefined } })).toEqual([]);
  });

  it('unescapes "$$" to a literal "$"', () => {
    const preds = run(entrySpec({ tool: 't', args: { price: '$$100', raw: '$$args.owner' } }));
    expect(preds[0].args).toEqual({ price: '$100', raw: '$args.owner' });
  });

  it('fails closed on $parsed when parsed is null, while $args-only entries still fire', () => {
    const spec = configRuleSpecSchema.parse({
      trigger: 'list_pull_requests',
      predict: [
        { tool: 'needs_result', args: { n: '$parsed.0.number' } },
        { tool: 'whole_result', args: { all: '$parsed' } },
        { tool: 'args_only', args: { owner: '$args.owner', fixed: 1 } },
      ],
    });
    const rules = compileConfigRules(SERVER, [spec]);
    const call = observed({ args: { owner: 'me' }, parsed: null });
    expect(rules[0].predict(call)).toEqual([]);
    expect(rules[1].predict(call)).toEqual([]); // bare "$parsed" also fails closed
    const preds = rules[2].predict(call); // other entries in the spec still evaluate
    expect(preds).toHaveLength(1);
    expect(preds[0].args).toEqual({ owner: 'me', fixed: 1 });
  });

  it('never resolves prototype members through hostile path segments', () => {
    const hostile = [
      '$args.constructor',
      '$args.toString',
      '$args.__proto__',
      '$parsed.constructor.prototype',
      '$parsed.items.__proto__.length',
      '$parsed.items.push',
    ];
    for (const selector of hostile) {
      const preds = run(entrySpec({ tool: 't', args: { v: selector } }), {
        args: { owner: 'me' },
        parsed: { items: [1] },
      });
      expect(preds).toEqual([]);
    }
  });
});

// --- predict: forEach -------------------------------------------------------

describe('predict with forEach', () => {
  const listSpec = (overrides: Record<string, unknown> = {}): unknown =>
    entrySpec({
      tool: 'get_pull_request',
      args: { owner: '$args.owner', repo: '$args.repo', pull_number: '$item.number' },
      confidence: 0.5,
      forEach: '$parsed',
      limit: 3,
      ...overrides,
    });

  const listCall: Partial<ObservedCall> = {
    args: { owner: 'me', repo: 'speculate' },
    parsed: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }],
  };

  it('fans out over whole $parsed with limit and 0.7^k confidence decay', () => {
    const preds = run(listSpec(), listCall);
    expect(preds).toHaveLength(3); // limit 3 beats the 4 available elements
    expect(preds.map((p) => p.args)).toEqual([
      { owner: 'me', repo: 'speculate', pull_number: 1 },
      { owner: 'me', repo: 'speculate', pull_number: 2 },
      { owner: 'me', repo: 'speculate', pull_number: 3 },
    ]);
    expect(preds.map((p) => p.confidence)).toEqual([0.5, 0.35, 0.245]); // rounded to 4 decimals
    for (const p of preds) {
      expect(p.server).toBe(SERVER);
      expect(p.ruleId).toBe('config:list_pull_requests→get_pull_request#0');
      expect(p.key).toBeUndefined();
    }
  });

  it('defaults limit to 2 and decays the default 0.4 confidence', () => {
    const preds = run(
      entrySpec({ tool: 't', args: { n: '$item.number' }, forEach: '$parsed' }),
      listCall,
    );
    expect(preds).toHaveLength(2);
    expect(preds.map((p) => p.confidence)).toEqual([0.4, 0.28]);
  });

  it('emits everything when limit exceeds the array length', () => {
    const preds = run(listSpec({ limit: 4 }), { ...listCall, parsed: [{ number: 9 }] });
    expect(preds).toHaveLength(1);
    expect(preds[0].args['pull_number']).toBe(9);
  });

  it('drops elements that fail to resolve; survivors keep position-based decay', () => {
    const preds = run(listSpec(), {
      ...listCall,
      parsed: [{ number: 1 }, { id: 'no-number-field' }, { number: 3 }],
    });
    expect(preds.map((p) => p.args['pull_number'])).toEqual([1, 3]);
    expect(preds.map((p) => p.confidence)).toEqual([0.5, 0.245]); // k = 0 and k = 2
  });

  it('supports dot-path forEach targets, primitive items, and $args-rooted arrays', () => {
    const nested = run(
      entrySpec({ tool: 't', args: { n: '$item' }, forEach: '$parsed.items', limit: 4 }),
      { parsed: { items: [7, 8] } },
    );
    expect(nested.map((p) => p.args)).toEqual([{ n: 7 }, { n: 8 }]);

    const fromArgs = run(
      entrySpec({ tool: 't', args: { id: '$item' }, forEach: '$args.ids', limit: 4 }),
      { args: { ids: [10, 11, 12] } },
    );
    expect(fromArgs.map((p) => p.args['id'])).toEqual([10, 11, 12]);
  });

  it('emits nothing when forEach resolves to a non-array (or nothing at all)', () => {
    const cases: Array<[string, unknown]> = [
      ['$parsed.items', { items: 7 }], // number
      ['$parsed.items', { items: { 0: 'a' } }], // plain object
      ['$parsed', 'not-an-array'], // string result
      ['$parsed.missing', {}], // unresolved path
      ['$parsed', null], // no result access (§5.1)
    ];
    for (const [forEach, parsed] of cases) {
      const preds = run(entrySpec({ tool: 't', args: { n: '$item' }, forEach }), { parsed });
      expect(preds).toEqual([]);
    }
  });
});

// --- robustness -------------------------------------------------------------

describe('predict robustness', () => {
  it('never throws on garbage parsed values', () => {
    const plain = entrySpec({ tool: 't', args: { v: '$parsed.a.b.c' } });
    const fanout = entrySpec({ tool: 't', args: { v: '$item.x' }, forEach: '$parsed.0' });
    const hostileGetter = Object.defineProperty({}, 'a', {
      enumerable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    const garbage: unknown[] = [
      'just text',
      42,
      true,
      [[[1, 2], [3]], []],
      { a: 'shallow' },
      Object.create(null),
      hostileGetter,
    ];
    for (const parsed of garbage) {
      for (const raw of [plain, fanout]) {
        const rules = compile(raw);
        expect(() => rules[0].predict(observed({ parsed }))).not.toThrow();
        expect(Array.isArray(rules[0].predict(observed({ parsed })))).toBe(true);
      }
    }
  });

  it('fails closed instead of throwing when materializing cyclic values', () => {
    const cyc: { self?: unknown } = {};
    cyc.self = cyc;
    const preds = run(entrySpec({ tool: 't', args: { v: '$parsed.self' } }), { parsed: cyc });
    expect(preds).toEqual([]);
  });

  it('does not traverse into strings or other primitives', () => {
    expect(run(entrySpec({ tool: 't', args: { c: '$parsed.0' } }), { parsed: 'abc' })).toEqual([]);
    expect(run(entrySpec({ tool: 't', args: { c: '$parsed.length' } }), { parsed: 'abc' })).toEqual(
      [],
    );
    expect(run(entrySpec({ tool: 't', args: { c: '$args.n.0' } }), { args: { n: 5 } })).toEqual([]);
  });
});
