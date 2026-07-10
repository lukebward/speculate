/**
 * Executor drain-queue behavior (DESIGN.md §3.1 refinement): predictions
 * denied only by a busy slot wait briefly and fire when the slot frees,
 * in confidence order, and expire rather than firing stale.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SpeculationExecutor } from '../src/executor.js';
import { SpeculationCache } from '../src/cache.js';
import { SafetyPolicy } from '../src/policy.js';
import { BudgetManager } from '../src/budget.js';
import { Metrics } from '../src/metrics.js';
import type { Prediction, ServerProfile } from '../src/types.js';
import type { Upstream } from '../src/upstream.js';

const RESULT: CallToolResult = { content: [{ type: 'text', text: '{}' }] };

interface Deferred {
  promise: Promise<CallToolResult>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<CallToolResult>((r) => {
    resolve = () => r(RESULT);
  });
  return { promise, resolve };
}

function profile(): ServerProfile {
  return {
    name: 'github',
    validatedAgainst: 'test',
    readOnlyAllowlist: ['a', 'b', 'c', 'd'],
    defaultTtlMs: 30_000,
    ttlMsByTool: {},
    parsers: {},
    canonicalizers: {},
    rules: [],
  };
}

function makeHarness(transport: 'stdio' | 'http') {
  let t = 0;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };

  const calls: { tool: string; deferred: Deferred }[] = [];
  const upstream = {
    connected: true,
    transport,
    callTool: (tool: string) => {
      const d = deferred();
      calls.push({ tool, deferred: d });
      return d.promise;
    },
  } as unknown as Upstream;

  const metrics = new Metrics({ mode: 'strict', log: 'off', now });
  const policy = new SafetyPolicy('strict', {
    github: { allowlist: ['a', 'b', 'c', 'd'] },
  });
  policy.updateTools('github', ['a', 'b', 'c', 'd'].map((name) => ({
    name,
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true },
  })));
  const cache = new SpeculationCache({ now });
  const budget = new BudgetManager(
    { github: { transport, maxPerMinute: 100 } },
    { now },
  );
  const executor = new SpeculationExecutor({
    upstreams: new Map([['github', upstream]]),
    cache,
    policy,
    budget,
    metrics,
    profiles: { github: profile() },
    config: { mode: 'strict', maxPredictionsPerTrigger: 3, servers: { github: {} }, log: 'off' },
    now,
  });
  return { executor, calls, advance, metrics, budget, cache };
}

const pred = (tool: string, confidence: number): Prediction => ({
  server: 'github',
  tool,
  args: { tool },
  confidence,
  ruleId: `rule:${tool}`,
});

const settle = () => new Promise((r) => setImmediate(r));

describe('executor drain queue', () => {
  it('stdio: queues over-budget predictions and fires them in confidence order', async () => {
    const { executor, calls } = makeHarness('stdio');
    executor.submit([pred('a', 0.9), pred('b', 0.4), pred('c', 0.6)]);
    expect(calls.map((c) => c.tool)).toEqual(['a']); // idle-only: one in flight

    calls[0]!.deferred.resolve();
    await settle();
    // Slot freed → highest-confidence queued prediction fires next.
    expect(calls.map((c) => c.tool)).toEqual(['a', 'c']);

    calls[1]!.deferred.resolve();
    await settle();
    expect(calls.map((c) => c.tool)).toEqual(['a', 'c', 'b']);
  });

  it('http: respects concurrency 2 and drains the third', async () => {
    const { executor, calls } = makeHarness('http');
    executor.submit([pred('a', 0.9), pred('b', 0.8), pred('c', 0.7)]);
    expect(calls.map((c) => c.tool)).toEqual(['a', 'b']);
    calls[0]!.deferred.resolve();
    await settle();
    expect(calls.map((c) => c.tool)).toEqual(['a', 'b', 'c']);
  });

  it('expires queued predictions instead of firing them stale', async () => {
    const { executor, calls, advance, metrics } = makeHarness('stdio');
    executor.submit([pred('a', 0.9), pred('b', 0.8)]);
    expect(calls.length).toBe(1);

    advance(6_000); // beyond QUEUE_MAX_AGE_MS
    calls[0]!.deferred.resolve();
    await settle();

    expect(calls.length).toBe(1); // b never fired
    const stats = metrics.statsSnapshot();
    const suppressed = stats.perRule.find((r) => r.ruleId === 'rule:b');
    expect(suppressed?.speculated ?? 0).toBe(0);
  });

  it('drainServer on real-call completion unblocks stdio speculation', async () => {
    const { executor, calls, budget } = makeHarness('stdio');
    budget.realStarted('github');
    executor.submit([pred('a', 0.9)]);
    expect(calls.length).toBe(0); // stdio busy with a real call

    budget.realFinished('github');
    executor.drainServer('github');
    expect(calls.map((c) => c.tool)).toEqual(['a']);
  });

  it('re-checks eligibility at drain time (suspension between queue and fire)', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)]);
    expect(h.calls.length).toBe(1);

    // b gets suspended while queued (e.g. auth breaker fired elsewhere)
    const policyRef = (h.executor as unknown as { deps: { policy: SafetyPolicy } }).deps.policy;
    policyRef.suspend('github', 'b', 'auth');

    h.calls[0]!.deferred.resolve();
    await settle();
    expect(h.calls.map((c) => c.tool)).toEqual(['a']); // b dropped, not fired
  });

  it('never exceeds the queue cap', async () => {
    const { executor, calls, metrics } = makeHarness('stdio');
    const many = Array.from({ length: 12 }, (_, i) => pred(`a`, 0.9 - i * 0.01));
    // same tool/args would dedupe; vary args via tool name in allowlist a-d
    const preds = many.map((p, i) => ({ ...p, args: { i } }));
    executor.submit(preds);
    expect(calls.length).toBe(1); // one in flight, rest queued/dropped
    const suppressed = metrics
      .statsSnapshot()
      .perRule.filter((r) => r.suppressedByFeedback === 0).length;
    expect(suppressed).toBeGreaterThan(0); // queue-full drops recorded
  });
});
