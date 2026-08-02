/**
 * Executor drain-queue behavior (DESIGN.md §3.1 refinement): predictions
 * denied only by a busy slot wait briefly and fire when the slot frees,
 * in confidence order, and expire rather than firing stale.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SpeculationExecutor } from '../src/executor.js';
import { LONG_HORIZON_TTL_FACTOR, SpeculationCache } from '../src/cache.js';
import { canonicalKey } from '../src/keys.js';
import { SafetyPolicy } from '../src/policy.js';
import { BudgetManager } from '../src/budget.js';
import { Metrics } from '../src/metrics.js';
import type { Prediction, ServerProfile } from '../src/types.js';
import type { Upstream } from '../src/upstream.js';

const RESULT: CallToolResult = { content: [{ type: 'text', text: '{}' }] };

interface Deferred {
  promise: Promise<CallToolResult>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<CallToolResult>((r, j) => {
    resolve = () => r(RESULT);
    reject = j;
  });
  return { promise, resolve, reject };
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

function makeHarness(
  transport: 'stdio' | 'http',
  serverConfig: import('../src/types.js').ServerConfig = {},
  latency?: {
    expected(server: string, tool: string): number | undefined;
    record(server: string, tool: string, ms: number): void;
  },
) {
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
    config: {
      mode: 'strict',
      maxPredictionsPerTrigger: 3,
      servers: { github: serverConfig },
      log: 'off',
    },
    now,
    ...(latency ? { latency } : {}),
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

// --- TTL and the long-horizon multiplier (DESIGN.md §6.2) ---------------------

describe('long-horizon TTL', () => {
  /** Fires one prediction and reports the entry's remaining life, in ms. */
  async function lifetime(
    horizon: Prediction['horizon'],
    serverConfig?: import('../src/types.js').ServerConfig,
  ): Promise<number> {
    const { executor, calls, advance, cache } = makeHarness('http', serverConfig);
    executor.submit([{ ...pred('a', 0.9), horizon }]);
    calls[0]!.deferred.resolve();
    await settle();
    const key = canonicalKey('github', 'a', { tool: 'a' });
    // Binary-search the expiry instant by advancing until the entry is gone.
    let alive = 0;
    for (let step = 0; step < 400; step++) {
      if (!cache.has(key)) break;
      advance(250);
      alive += 250;
    }
    return alive;
  }

  it('ships as the identity: no class gets a shortened TTL by default', async () => {
    // The default is 1 on evidence, not by omission (see cache.ts): the eval
    // measures standing bets consumed at a lead of exactly 1.000 calls, so
    // shortening them buys no measured freshness while measurably costing
    // hits once an agent's inter-call gap passes half the TTL.
    expect(LONG_HORIZON_TTL_FACTOR).toBe(1);
    expect(await lifetime('next')).toBe(30_000);
    expect(await lifetime('standing')).toBe(30_000);
    expect(await lifetime(undefined)).toBe(30_000);
  });

  it('shortens a standing bet only when an operator opts in', async () => {
    const on = { speculation: { longHorizonTtlFactor: 0.5 } };
    expect(await lifetime('standing', on)).toBe(15_000);
    // A next-call prediction is untouched by the knob: it is a horizon
    // policy, not a server-wide TTL cut.
    expect(await lifetime('next', on)).toBe(30_000);
    // Hand-written profile rules emit no horizon at all, so they keep the
    // full TTL even with the knob on.
    expect(await lifetime(undefined, on)).toBe(30_000);
  });

  it('applies the factor to the resolved TTL, whatever resolved it', async () => {
    // The operator per-tool TTL wins the resolution (§6.2); the multiplier
    // then applies to THAT, not to the profile default it beat.
    const cfg = { speculation: { ttlMsByTool: { a: 10_000 }, longHorizonTtlFactor: 0.5 } };
    expect(await lifetime('next', cfg)).toBe(10_000);
    expect(await lifetime('standing', cfg)).toBe(5_000);
  });

  it('never turns a live TTL into a dead one', async () => {
    // Rounding a tiny TTL down to 0 would make the entry dead on arrival and
    // silently convert every standing bet into pure waste.
    const cfg = { speculation: { ttlMsByTool: { a: 1 }, longHorizonTtlFactor: 0.01 } };
    expect(await lifetime('standing', cfg)).toBeGreaterThan(0);
  });

  it('leaves an operator TTL of 0 disabled rather than reviving it', async () => {
    const { executor, calls, metrics } = makeHarness('http', {
      speculation: { ttlMsByTool: { a: 0 } },
    });
    executor.submit([{ ...pred('a', 0.9), horizon: 'standing' }]);
    expect(calls.length).toBe(0);
    expect(metrics.statsSnapshot().suppressed['ttl-zero']).toBe(1);
  });
});

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

  it('stays in confidence order even when latencies are known', async () => {
    // Deliberate: the per-trigger cap cuts on expected value, but a BUSY
    // slot rations upstream time rather than launches, and under a time
    // budget the greedy ratio (p×T)/T is p. Firing the expensive bet first
    // would starve the likelier cheap one for no gain, because a real call
    // arriving mid-flight is credited the work already done either way.
    const ms: Record<string, number> = { b: 4_000, c: 500 };
    const { executor, calls } = makeHarness('stdio', {}, {
      expected: (_server, tool) => ms[tool],
      record: () => {},
    });
    executor.submit([pred('a', 0.9), pred('b', 0.4), pred('c', 0.6)]);
    expect(calls.map((c) => c.tool)).toEqual(['a']); // idle-only: one in flight

    calls[0]!.deferred.resolve();
    await settle();
    expect(calls.map((c) => c.tool)).toEqual(['a', 'c']); // c 0.6 before b 0.4
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

// --- latency measurement (§5.6, Appendix A) ----------------------------------

describe('executor latency measurement', () => {
  function recorder() {
    const seen: { server: string; tool: string; ms: number }[] = [];
    return {
      seen,
      expected: (): number | undefined => undefined,
      record(server: string, tool: string, ms: number): void {
        seen.push({ server, tool, ms });
      },
    };
  }

  it('records the full upstream duration of a speculative call', async () => {
    const rec = recorder();
    const { executor, calls, advance } = makeHarness('http', {}, rec);
    executor.submit([pred('a', 0.9)]);
    advance(750);
    calls[0]!.deferred.resolve();
    await settle();
    expect(rec.seen).toEqual([{ server: 'github', tool: 'a', ms: 750 }]);
  });

  it('records nothing when the upstream never answered', async () => {
    // A timeout or transport failure is not a measurement of how long this
    // tool takes; it would poison the mean with the speculative timeout.
    const rec = recorder();
    const upstreamFails = { ...rec };
    const { executor, calls, advance } = makeHarness('http', {}, upstreamFails);
    executor.submit([pred('a', 0.9)]);
    advance(30_000);
    calls[0]!.deferred.reject(new Error('timeout'));
    await settle();
    expect(rec.seen).toEqual([]);
  });
});
