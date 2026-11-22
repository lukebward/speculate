/**
 * The arithmetic behind the live benchmark (bench/measure.ts) and the
 * prompts it sends (bench/scenarios.ts). The benchmark itself calls real
 * servers and never runs here.
 */
import { describe, expect, it } from 'vitest';
import {
  markdownHitTable,
  markdownSessionTable,
  markdownTable,
  measureSession,
  median,
  readUsage,
  serializeResults,
  summarize,
  summarizeAll,
  unionLength,
  usageDelta,
  type SessionRow,
  type StreamLine,
  type Usage,
} from '../bench/measure.js';
import {
  extractContentUrls,
  extractLibraryIds,
  extractRepoIds,
  resultText,
  SCENARIOS,
  scriptedPrompt,
  WORKLOADS,
} from '../bench/scenarios.js';

const T0 = Date.parse('2026-11-21T16:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const use = (ms: number, id: string, name: string, input: unknown = {}, extra: object = {}): StreamLine => ({
  at: T0 + ms + 5,
  line: JSON.stringify({
    type: 'assistant',
    timestamp: at(ms),
    message: { content: [{ type: 'tool_use', id, name, input }] },
    ...extra,
  }),
});

const result = (ms: number, id: string, isError = false, extra: object = {}): StreamLine => ({
  at: T0 + ms + 5,
  line: JSON.stringify({
    type: 'user',
    timestamp: at(ms),
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] },
    ...extra,
  }),
});

const done = (ms: number, fields: object = {}): StreamLine => ({
  at: T0 + ms,
  line: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: ms,
    duration_api_ms: 400,
    num_turns: 3,
    total_cost_usd: 0.02,
    ...fields,
  }),
});

describe('measureSession', () => {
  it('takes each wait from the host timestamps of the call and its result', () => {
    const measured = measureSession([
      { at: T0, line: JSON.stringify({ type: 'system', subtype: 'init', timestamp: at(0), model: 'model-1-2' }) },
      use(100, 'a', 'mcp__docs__search', { query: 'q' }),
      result(900, 'a'),
      use(1_500, 'b', 'mcp__docs__fetch', { url: 'u' }),
      result(1_520, 'b'),
      done(2_000),
    ]);
    expect(measured.calls.map(call => [call.tool, call.waitMs, call.startMs])).toEqual([
      ['mcp__docs__search', 800, 100],
      ['mcp__docs__fetch', 20, 1_500],
    ]);
    expect(measured.calls[0]!.args).toBe('{"query":"q"}');
    expect(measured).toMatchObject({
      mcpCalls: 2,
      mcpErrors: 0,
      toolWaitMs: 820,
      toolWallMs: 820,
      durationMs: 2_000,
      apiMs: 400,
      turns: 3,
      costUsd: 0.02,
      servedModel: 'model-1-2',
      ok: true,
    });
  });

  it('counts parallel calls once each in the sum and once together on the wall', () => {
    const measured = measureSession([
      {
        at: T0,
        line: JSON.stringify({
          type: 'assistant',
          timestamp: at(0),
          message: {
            content: [
              { type: 'tool_use', id: 'a', name: 'mcp__docs__fetch', input: {} },
              { type: 'tool_use', id: 'b', name: 'mcp__docs__fetch', input: {} },
            ],
          },
        }),
      },
      result(600, 'a'),
      result(1_000, 'b'),
    ]);
    expect(measured.toolWaitMs).toBe(1_600);
    expect(measured.toolWallMs).toBe(1_000);
  });

  it('keeps built-in calls out of the MCP totals and flags a tool error', () => {
    const measured = measureSession([
      use(0, 'a', 'ToolSearch'),
      result(30, 'a'),
      use(100, 'b', 'mcp__docs__search'),
      result(400, 'b', true),
      done(500),
    ]);
    expect(measured.calls).toHaveLength(2);
    expect(measured).toMatchObject({ mcpCalls: 1, mcpErrors: 1, toolWaitMs: 300 });
  });

  it('skips what is not an event, a subagent, or a result without a call', () => {
    const measured = measureSession([
      { at: T0, line: 'Warning: not json' },
      { at: T0, line: '[1, 2]' },
      use(0, 'sub', 'mcp__docs__search', {}, { parent_tool_use_id: 'task-1' }),
      result(900, 'sub', false, { parent_tool_use_id: 'task-1' }),
      result(950, 'never-called'),
    ]);
    expect(measured.calls).toEqual([]);
    expect(measured.ok).toBe(false);
    expect(measured.durationMs).toBeNull();
  });

  it('falls back to when a line arrived if an event carries no timestamp', () => {
    const measured = measureSession([
      { at: 1_000, line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__s__t' }] } }) },
      { at: 1_250, line: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }) },
    ]);
    expect(measured.toolWaitMs).toBe(250);
  });

  it('reports a session that ended in an error as not ok', () => {
    expect(measureSession([done(100, { subtype: 'error_max_budget_usd', is_error: true })]).ok).toBe(false);
  });
});

describe('unionLength', () => {
  it('counts overlaps once and ignores empty intervals', () => {
    expect(unionLength([[0, 10], [5, 20], [30, 40], [7, 7], [35, 36]])).toBe(30);
    expect(unionLength([])).toBe(0);
  });
});

describe('usage', () => {
  it('reads the counters it knows and treats anything else as zero', () => {
    const usage = readUsage({ hits: 2, joins: 1, speculativeCalls: 5, wasted: -3, misses: 'many', other: 9 });
    expect(usage).toEqual({
      hits: 2, joins: 1, misses: 0, speculativeCalls: 5, wasted: 0, estimatedSavedMs: 0, estimatedAddedWaitMs: 0,
      predictionOpportunities: 0, predictionHitsAt1: 0, predictionHitsAt3: 0,
    });
    expect(readUsage(null).hits).toBe(0);
  });

  it('subtracts one snapshot from the next', () => {
    const before = readUsage({ hits: 2, speculativeCalls: 5, estimatedSavedMs: 1_000 });
    const after = readUsage({ hits: 3, joins: 1, speculativeCalls: 8, estimatedSavedMs: 2_500 });
    expect(usageDelta(before, after)).toMatchObject({ hits: 1, joins: 1, speculativeCalls: 3, estimatedSavedMs: 1_500 });
  });
});

function row(pair: number, arm: 'off' | 'on', waits: number[], extra: Partial<SessionRow> = {}): SessionRow {
  const mod: Usage | null = arm === 'on' ? readUsage(extra.mod ?? {}) : null;
  return {
    scenario: 'docs',
    workload: 'scripted',
    model: 'm',
    pair,
    arm,
    order: 1,
    calls: waits.map((waitMs, i) => ({ tool: 'mcp__docs__t', mcp: true, args: '{}', startMs: i * 1_000, waitMs, isError: false })),
    mcpCalls: waits.length,
    mcpErrors: 0,
    toolWaitMs: waits.reduce((sum, wait) => sum + wait, 0),
    toolWallMs: waits.reduce((sum, wait) => sum + wait, 0),
    durationMs: 10_000,
    apiMs: 4_000,
    turns: 3,
    costUsd: 0.01,
    servedModel: 'm-1',
    ok: true,
    ...extra,
    mod,
  };
}

describe('summarize', () => {
  const rows = [
    row(1, 'off', [1_000, 1_000]),
    row(1, 'on', [1_000, 1_000], { mod: readUsage({ misses: 2 }) }),
    row(2, 'off', [1_000, 1_000], { durationMs: 12_000 }),
    row(2, 'on', [1_000, 20], { durationMs: 9_000, mod: readUsage({ hits: 1, speculativeCalls: 3, estimatedSavedMs: 950 }) }),
    row(3, 'off', [800, 1_200], { durationMs: 12_000 }),
    row(3, 'on', [400, 20], { durationMs: 9_000, mod: readUsage({ hits: 1, joins: 1, speculativeCalls: 2, estimatedSavedMs: 1_500 }) }),
  ];

  it('reports the learning pairs apart from the warm ones', () => {
    const summary = summarize(rows, 1);
    expect(summary).toMatchObject({ scenario: 'docs', workload: 'scripted', model: 'm', warmupPairs: 1 });
    expect(summary.cold).toMatchObject({ pairs: 1, served: 0, prefetches: 0, callWaitReduction: 0 });
    expect(summary.warm.pairs).toBe(2);
    expect(summary.warm.off).toMatchObject({ sessions: 2, calls: 4, meanCallWaitMs: 1_000 });
    expect(summary.warm.on).toMatchObject({ sessions: 2, calls: 4, meanCallWaitMs: 360 });
    expect(summary.warm.callWaitReduction).toBeCloseTo(0.64);
    expect(summary.warm.durationReduction).toBeCloseTo(0.25);
    expect(summary.warm).toMatchObject({
      pairsWithLessToolWait: 2, served: 3, hits: 2, joins: 1, prefetches: 5, unused: 2, estimatedSavedMs: 2_450,
    });
  });

  it('leaves out a pair with a failed session or no answered MCP call', () => {
    const refused = row(5, 'off', [60]);
    refused.calls[0]!.isError = true;
    refused.mcpErrors = 1;
    const summary = summarize(
      [
        ...rows,
        row(4, 'off', [900]),
        row(4, 'on', [10], { ok: false }),
        refused,
        row(5, 'on', [10]),
        row(6, 'off', []),
        row(6, 'on', [10]),
        row(7, 'off', [900]),
      ],
      1,
    );
    expect(summary.warm.pairs).toBe(2);
    expect(summary.warm.excludedPairs).toBe(4);
    expect(summary.warm.on.calls).toBe(4);
  });

  it('counts a call that errored apart from the waits, and keeps its pair', () => {
    const retried = row(2, 'off', [60, 60, 900]);
    retried.calls[0]!.isError = true;
    retried.calls[1]!.isError = true;
    retried.mcpErrors = 2;
    const summary = summarize([retried, row(2, 'on', [300])], 0);
    expect(summary.warm.pairs).toBe(1);
    expect(summary.warm.off).toMatchObject({ calls: 1, errors: 2, meanCallWaitMs: 900, medianSessionToolWaitMs: 1_020 });
    expect(summary.warm.callWaitReduction).toBeCloseTo(2 / 3);
  });

  it('summarizes each scenario, workload and model on its own', () => {
    const all = summarizeAll([...rows, row(1, 'off', [500], { workload: 'varied' }), row(1, 'on', [400], { workload: 'varied' })], 1);
    expect(all.map(summary => [summary.workload, summary.cold.pairs, summary.warm.pairs])).toEqual([
      ['scripted', 1, 2],
      ['varied', 1, 0],
    ]);
  });

  it('has no reduction to report when an arm is empty', () => {
    const summary = summarize([row(1, 'off', [500])], 0);
    expect(summary.warm).toMatchObject({ pairs: 0, excludedPairs: 1, callWaitReduction: null });
    expect(median([])).toBeNull();
  });

  it('reports hit rate over every call the model made, and how many prefetches were used', () => {
    const summary = summarize(rows, 1);
    // Warm: 4 calls, 3 served, 5 prefetches. Learning: 2 calls, none served, none started.
    expect(summary.warm.hitRate).toBeCloseTo(0.75);
    expect(summary.warm.prefetchUse).toBeCloseTo(0.6);
    expect(summary.cold).toMatchObject({ hitRate: 0, prefetchUse: null });

    const refused = row(2, 'on', [60, 20], { mod: readUsage({ hits: 1, speculativeCalls: 1 }) });
    refused.calls[0]!.isError = true;
    refused.mcpErrors = 1;
    expect(summarize([row(2, 'off', [900, 900]), refused], 0).warm.hitRate).toBeCloseTo(0.5);
  });

  it('reports the predictor\'s recall only where its counters were recorded', () => {
    expect(summarize(rows, 1).warm).toMatchObject({ recallAt1: null, recallAt3: null });
    const counted = summarize(
      [
        row(1, 'off', [900, 900]),
        row(1, 'on', [900, 20], {
          mod: readUsage({ hits: 1, speculativeCalls: 2, predictionOpportunities: 4, predictionHitsAt1: 1, predictionHitsAt3: 3 }),
        }),
      ],
      0,
    );
    expect(counted.warm.recallAt1).toBeCloseTo(0.25);
    expect(counted.warm.recallAt3).toBeCloseTo(0.75);
    expect(markdownHitTable([counted])).toContain('| docs | scripted | 2 | 1 | 50% | 2 | 50% | 1 | 25% | 75% |');
    expect(markdownHitTable([summarize(rows, 1)])).toContain('| docs | scripted | 4 | 3 | 75% | 5 | 60% | 2 | n/a | n/a |');
  });

  it('writes a result file that parses back, one session to a line', () => {
    const file = { meta: { scenario: 'docs', pairs: 3 }, sessions: rows, summaries: [summarize(rows, 1)] };
    const text = serializeResults(file);
    expect(JSON.parse(text)).toEqual(file);
    expect(text.split('\n').filter(line => line.startsWith('{"scenario"'))).toHaveLength(rows.length);
    expect(serializeResults({ meta: {}, sessions: [], summaries: [] })).toBe('{"meta":{},\n"sessions":[\n\n],\n"summaries":[]}\n');
  });

  it('renders a phase as table rows, a shorter wait as a negative change', () => {
    const summary = summarize(rows, 1);
    const table = markdownTable([summary]);
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('| docs | scripted | 4 / 4 | 0 / 0 | 3 (2 ready, 1 joined) | 5 | 2 | 1000 ms | 360 ms | -64% |');
    expect(markdownTable([summary], 'cold')).toContain('| docs | scripted | 2 / 2 | 0 / 0 | 0 (0 ready, 0 joined) | 0 | 0 | 1000 ms | 1000 ms | 0% |');
    expect(markdownSessionTable([summary])).toContain('| docs | scripted | 2 | 2000 ms | 720 ms | -64% | 2 of 2 | 12000 ms | 9000 ms | -25% |');
    expect(markdownSessionTable([summary], 'cold')).toContain('| docs | scripted | 1 | 2000 ms | 2000 ms | 0% | 0 of 1 | 10000 ms | 10000 ms | 0% |');
  });
});

describe('scenarios', () => {
  it('dictates a scripted session call by call', () => {
    const prompt = scriptedPrompt('docs', [
      { tool: 'search', args: { query: 'a b' } },
      { tool: 'fetch', args: { url: 'https://example.test/x' } },
    ]);
    expect(prompt).toContain('1. search with arguments {"query":"a b"}');
    expect(prompt).toContain('2. fetch with arguments {"url":"https://example.test/x"}');
    expect(prompt).toContain('one at a time');
  });

  it('reads identifiers out of each server\'s result format', () => {
    expect(extractContentUrls(JSON.stringify({ results: [{ contentUrl: 'https://a' }, { title: 't' }, { contentUrl: 'https://b' }] })))
      .toEqual(['https://a', 'https://b']);
    expect(extractContentUrls('not json')).toEqual([]);
    expect(extractRepoIds('intro\n### org/model-a\ntext\n### org/model-b  \n### not an id')).toEqual(['org/model-a', 'org/model-b']);
    expect(extractLibraryIds('- Context7-compatible library ID: /org/lib\n- Context7-compatible library ID: /o/l2')).toEqual(['/org/lib', '/o/l2']);
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\n\nb');
  });

  it('gives both arms of a pair one prompt, and the varied workload a new one each pair', () => {
    const contexts: Record<string, Record<string, unknown>> = {
      mslearn: { queries: ['q1', 'q2'], picked: [['https://a', 'https://b'], ['https://c', 'https://d']] },
      huggingface: { queries: ['q1', 'q2'], picked: [['o/a', 'o/b'], ['o/c', 'o/d']] },
      context7: { libs: ['x', 'y'], ids: ['/o/x', '/o/y'] },
      mockgithub: { issues: [41, 42], pull: 5 },
    };
    for (const scenario of Object.values(SCENARIOS)) {
      const ctx = contexts[scenario.key]!;
      for (const workload of WORKLOADS) {
        const first = scenario.prompt(workload, ctx, 1);
        expect(first).toContain(`${scenario.key} MCP tools`);
        expect(scenario.prompt(workload, ctx, 1)).toBe(first);
        const second = scenario.prompt(workload, ctx, 2);
        if (workload === 'varied') expect(second).not.toBe(first);
        else expect(second).toBe(first);
      }
      const scripted = scenario.prompt('scripted', ctx, 1);
      for (const tool of scenario.needTools) expect(scripted).toContain(tool);
      // The mock repository has six things to read; the hosted servers have a subject per pair.
      const varied = new Set(Array.from({ length: 12 }, (_, i) => scenario.prompt('varied', ctx, i + 1)));
      expect(varied.size).toBe(scenario.key === 'mockgithub' ? 6 : 12);
    }
  });
});
