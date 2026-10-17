/**
 * SpeculationExecutor (DESIGN.md §3.1): eligibility, host authorization
 * (before issue and again before publication), dedup, budgets and the
 * drain queue, error handling, timeouts, and TTL resolution. Every submit
 * carries a fake SpeculationIo; the clock is injected.
 */
import { describe, expect, it } from 'vitest';
import { SPECULATIVE_CALL_TIMEOUT_MS, SpeculationExecutor, type SpeculationIo } from '../src/executor.js';
import { DEFAULT_TTL_MS, LONG_HORIZON_TTL_FACTOR, SpeculationCache } from '../src/cache.js';
import { canonicalKey } from '../src/keys.js';
import { ToolKnowledge } from '../src/tools.js';
import { BudgetManager } from '../src/budget.js';
import { Metrics } from '../src/metrics.js';
import type { Prediction, ToolResult } from '../src/types.js';

const RESULT: ToolResult = { content: [{ type: 'text', text: '{}' }] };

interface PendingCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  resolve: (result?: ToolResult) => void;
  reject: (err: unknown) => void;
}

interface FakeIo extends SpeculationIo {
  calls: PendingCall[];
  authorizations: number;
  /** Current host verdict; a function lets a test hold an authorization open. */
  allow: boolean | (() => Promise<boolean>);
}

function fakeIo(opts: { sleep?: SpeculationIo['sleep'] } = {}): FakeIo {
  const io: FakeIo = {
    calls: [],
    authorizations: 0,
    allow: true,
    call(server, tool, args) {
      return new Promise<ToolResult>((resolve, reject) => {
        io.calls.push({ server, tool, args, resolve: (r = RESULT) => resolve(r), reject });
      });
    },
    async authorize() {
      io.authorizations++;
      return typeof io.allow === 'function' ? io.allow() : io.allow;
    },
  };
  if (opts.sleep) io.sleep = opts.sleep;
  return io;
}

function makeHarness(
  transport: 'stdio' | 'http',
  opts: { ttlMs?: number; maxPerMinute?: number; readTools?: string[] } = {},
) {
  let t = 0;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };

  const metrics = new Metrics({ mode: 'on', now });
  const tools = new ToolKnowledge(now);
  for (const name of opts.readTools ?? ['a', 'b', 'c', 'd']) {
    tools.record('github', name, { readOnly: true, servable: true, args: { tool: name } });
  }
  const cache = new SpeculationCache({
    now,
    onEvent: (ev) =>
      metrics.record({
        type: ev.type,
        server: ev.meta.server,
        tool: ev.meta.tool,
        ruleId: ev.meta.ruleId,
        reason: ev.error,
      }),
  });
  const budget = new BudgetManager(
    { github: { transport, maxPerMinute: opts.maxPerMinute ?? 100 } },
    { now },
  );
  const executor = new SpeculationExecutor({
    cache,
    tools,
    budget,
    metrics,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    now,
  });
  const io = fakeIo();
  const suppressed = () => metrics.statsSnapshot().suppressed;
  return { executor, io, advance, metrics, budget, cache, tools, suppressed };
}

const pred = (tool: string, confidence: number, extra: Partial<Prediction> = {}): Prediction => ({
  server: 'github',
  tool,
  args: { tool },
  confidence,
  ruleId: `rule:${tool}`,
  ...extra,
});

const keyOf = (tool: string) => canonicalKey('github', tool, { tool });

/** Flushes every pending microtask chain (authorize → issue → settle → drain). */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

const tools = (io: FakeIo) => io.calls.map((c) => c.tool);

// --- eligibility --------------------------------------------------------------

describe('eligibility', () => {
  it('suppresses a tool never recorded, without asking the host', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('z', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(h.io.authorizations).toBe(0);
    expect(h.suppressed()['policy:unknown']).toBe(1);
  });

  it('suppresses a tool recorded as not read-only or not servable', async () => {
    const h = makeHarness('http');
    h.tools.record('github', 'write', { readOnly: false, servable: true, args: {} });
    h.tools.record('github', 'blob', { readOnly: true, servable: false, args: {} });
    h.executor.submit([pred('write', 0.9), pred('blob', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(h.suppressed()['policy:not-read-only']).toBe(1);
    expect(h.suppressed()['policy:not-servable']).toBe(1);
  });

  it('suppresses a tool that settings hooks watch', async () => {
    const h = makeHarness('http');
    h.tools.setHooked((_s, tool) => tool === 'a');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(h.suppressed()['policy:tool-hooks']).toBe(1);
  });

  it('re-checks eligibility at drain time (suspension between queue and fire)', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']);

    // b gets suspended while queued (e.g. an auth failure elsewhere).
    h.tools.suspend('github', 'b', 'auth');
    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a']);
    expect(h.suppressed()['policy:suspended:auth']).toBe(1);
  });
});

// --- authorization ----------------------------------------------------------

describe('host authorization', () => {
  it('suppresses a prediction the host would not run without asking', async () => {
    const h = makeHarness('http');
    h.io.allow = false;
    h.executor.submit([pred('a', 0.9, { horizon: 'standing' }), pred('b', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toEqual([]);
    expect(h.suppressed()['host-permission']).toBe(2);
  });

  it('treats a throwing authorize as a denial', async () => {
    const h = makeHarness('http');
    h.io.allow = () => Promise.reject(new Error('host gone'));
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toEqual([]);
    expect(h.suppressed()['host-permission']).toBe(1);
  });

  it('publishes only when the host still allows the call once its result arrives', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
    h.io.allow = false; // permission revoked mid-flight
    h.io.calls[0]!.resolve();
    await settle();

    expect(h.cache.has(keyOf('a'))).toBe(false);
    expect(h.cache.lookup(keyOf('a')).outcome).toBe('miss');
    expect(h.metrics.statsSnapshot().invalidated).toBe(1);
    expect(h.io.authorizations).toBe(2); // before issue, and before publication
  });

  it('publishes a result whose permission held throughout', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.io.calls[0]!.resolve();
    await settle();
    expect(h.cache.lookup(keyOf('a')).outcome).toBe('hit');
  });

  it('rechecks permission before a queued prediction issues', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
    let revoked = false;
    h.io.allow = async () => !revoked;
    revoked = true;
    h.io.calls[0]!.resolve();
    await settle();

    expect(tools(h.io)).toEqual(['a']);
    expect(h.suppressed()['host-permission']).toBe(1);
  });

  it('does not issue after invalidation wins a pending permission check', async () => {
    const h = makeHarness('http');
    let release!: (allowed: boolean) => void;
    h.io.allow = () => new Promise<boolean>((r) => (release = r));
    h.executor.submit([pred('a', 0.9, { horizon: 'standing' })], h.io);
    h.executor.invalidatePending('github');
    release(true);
    await settle();

    expect(h.io.calls).toEqual([]);
    expect(h.suppressed()['cache-invalidation']).toBe(1);
  });

  it('does not issue after the session ends during a pending permission check', async () => {
    const h = makeHarness('http');
    let release!: (allowed: boolean) => void;
    h.io.allow = () => new Promise<boolean>((r) => (release = r));
    h.executor.submit([pred('a', 0.9)], h.io);
    expect(h.executor.abandonPending()).toBe(0); // nothing queued yet
    release(true);
    await settle();
    expect(h.io.calls).toEqual([]);
    expect(h.suppressed()['session-end']).toBe(1);
  });

  it('drains standing work again when the queue is replaced during authorization', async () => {
    const h = makeHarness('stdio');
    h.budget.realStarted('github');
    h.executor.submit([pred('a', 0.9, { horizon: 'standing' }), pred('b', 0.8, { horizon: 'next' })], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0); // both queued behind the real call
    let release!: (allowed: boolean) => void;
    h.io.allow = () => new Promise<boolean>((r) => (release = r));
    h.budget.realFinished('github');
    h.executor.drainServer('github');
    await settle();
    // A new real call supersedes next-call work while the drain awaits permission.
    h.executor.supersedePendingNext('github');
    h.io.allow = () => Promise.resolve(true);
    release(true);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
  });

  it('supersedes a next prediction awaiting permission while preserving a standing one', async () => {
    const h = makeHarness('http');
    const releases: Array<(allowed: boolean) => void> = [];
    h.io.allow = () => new Promise<boolean>((r) => releases.push(r));
    h.executor.submit([pred('a', 0.9, { horizon: 'next' }), pred('b', 0.8, { horizon: 'standing' })], h.io);
    h.executor.supersedePendingNext('github');
    for (const r of releases) r(true);
    await settle();

    expect(tools(h.io)).toEqual(['b']);
    expect(h.suppressed()['superseded-next-call']).toBe(1);
  });

  it('ignores invalidation of another server during a pending permission check', async () => {
    const h = makeHarness('http');
    let release!: (allowed: boolean) => void;
    h.io.allow = () => new Promise<boolean>((r) => (release = r));
    h.executor.submit([pred('a', 0.9)], h.io);
    h.executor.invalidatePending('linear');
    h.executor.supersedePendingNext('linear');
    release(true);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
  });
});

// --- dedup, errors, suspension --------------------------------------------------

describe('dedup and error handling', () => {
  it('dedups against an in-flight or fresh cache entry', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9), pred('a', 0.8)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
    h.io.calls[0]!.resolve();
    await settle();
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
    expect(h.suppressed()['dedup']).toBe(2);
  });

  it('never caches an error result', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.io.calls[0]!.resolve({ isError: true, content: [{ type: 'text', text: 'rate limited' }] });
    await settle();
    expect(h.cache.has(keyOf('a'))).toBe(false);
    expect(h.metrics.statsSnapshot().perServer['github']!.specErrors).toBe(1);
    expect(h.tools.isSuspended('github', 'a')).toBe(false);
  });

  it('suspends a tool on an auth-looking error result', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.io.calls[0]!.resolve({ isError: true, content: [{ type: 'text', text: 'Unauthorized: bad credentials' }] });
    await settle();
    expect(h.cache.has(keyOf('a'))).toBe(false);
    expect(h.tools.eligibility('github', 'a')).toEqual({ eligible: false, reason: 'suspended:auth' });

    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(1);
    expect(h.suppressed()['policy:suspended:auth']).toBe(1);
  });

  it('suspends a tool on an auth-looking rejection', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.io.calls[0]!.reject(new Error('HTTP 403 Forbidden'));
    await settle();
    expect(h.tools.eligibility('github', 'a').reason).toBe('suspended:auth');
  });

  it.each(['Tool b not found', 'Unknown tool: b', 'MCP error -32601: Method not found'])(
    'suspends a tool the server cannot serve (%s)',
    async (message) => {
      const h = makeHarness('http');
      h.executor.submit([pred('b', 0.9)], h.io);
      await settle();
      h.io.calls[0]!.reject(new Error(message));
      await settle();
      expect(h.tools.eligibility('github', 'b').reason).toBe('suspended:tool-unavailable');
      expect(h.cache.has(keyOf('b'))).toBe(false);
    },
  );

  it('suspends a tool whose error result says it is unknown', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('b', 0.9)], h.io);
    await settle();
    h.io.calls[0]!.resolve({ isError: true, content: [{ type: 'text', text: 'Unknown tool: b' }] });
    await settle();
    expect(h.tools.eligibility('github', 'b').reason).toBe('suspended:tool-unavailable');
  });

  it('does not suspend on an ordinary failure', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.io.calls[0]!.reject(new Error('ECONNRESET'));
    await settle();
    expect(h.tools.isSuspended('github', 'a')).toBe(false);
    expect(h.metrics.statsSnapshot().perServer['github']!.specErrors).toBe(1);
  });

  it('records a synchronous throw from io.call as a speculative error, freeing the slot', async () => {
    const h = makeHarness('stdio');
    let first = true;
    const call = h.io.call;
    h.io.call = (s, t, a) => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return call(s, t, a);
    };
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['b']);
    expect(h.metrics.statsSnapshot().perServer['github']!.specErrors).toBe(1);
  });
});

// --- timeout -------------------------------------------------------------------

describe('speculative call timeout', () => {
  it('abandons a call that outlives io.sleep, freeing the stdio slot', async () => {
    const h = makeHarness('stdio');
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const io = fakeIo({
      sleep: (ms) => new Promise<void>((r) => timers.push({ ms, fire: r })),
    });
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], io);
    await settle();
    expect(tools(io)).toEqual(['a']);
    expect(timers.map((t) => t.ms)).toEqual([SPECULATIVE_CALL_TIMEOUT_MS]);

    timers[0]!.fire();
    await settle();
    expect(tools(io)).toEqual(['a', 'b']);
    expect(h.cache.has(keyOf('a'))).toBe(false);
    expect(h.metrics.statsSnapshot().perServer['github']!.specErrors).toBe(1);

    // The late result of the abandoned call is never published.
    io.calls[0]!.resolve();
    await settle();
    expect(h.cache.lookup(keyOf('a')).outcome).toBe('miss');
  });

  it('a call that settles first is unaffected by its timer', async () => {
    const h = makeHarness('http');
    let fire!: () => void;
    const io = fakeIo({ sleep: () => new Promise<void>((r) => (fire = r)) });
    h.executor.submit([pred('a', 0.9)], io);
    await settle();
    io.calls[0]!.resolve();
    await settle();
    fire();
    await settle();
    expect(h.cache.lookup(keyOf('a')).outcome).toBe('hit');
  });

  it('a rejecting sleep never times the call out', async () => {
    const h = makeHarness('http');
    const io = fakeIo({ sleep: () => Promise.reject(new Error('no timers')) });
    h.executor.submit([pred('a', 0.9)], io);
    await settle();
    expect(h.cache.has(keyOf('a'))).toBe(true);
    io.calls[0]!.resolve();
    await settle();
    expect(h.cache.lookup(keyOf('a')).outcome).toBe('hit');
  });
});

// --- TTL -------------------------------------------------------------------------

describe('TTL resolution', () => {
  /** Fires one prediction and reports the entry's remaining life, in ms. */
  async function lifetime(horizon: Prediction['horizon'], ttlMs?: number): Promise<number> {
    const h = makeHarness('http', ttlMs !== undefined ? { ttlMs } : {});
    h.executor.submit([pred('a', 0.9, horizon ? { horizon } : {})], h.io);
    await settle();
    h.io.calls[0]!.resolve();
    await settle();
    let alive = 0;
    for (let step = 0; step < 400; step++) {
      if (!h.cache.has(keyOf('a'))) break;
      h.advance(250);
      alive += 250;
    }
    return alive;
  }

  it('ships the long-horizon factor as the identity', async () => {
    expect(LONG_HORIZON_TTL_FACTOR).toBe(1);
    expect(await lifetime('next')).toBe(DEFAULT_TTL_MS);
    expect(await lifetime('standing')).toBe(DEFAULT_TTL_MS);
    expect(await lifetime(undefined)).toBe(DEFAULT_TTL_MS);
  });

  it('applies the configured ttlMs, with standing derived from it', async () => {
    expect(await lifetime('next', 10_000)).toBe(10_000);
    expect(await lifetime('standing', 10_000)).toBe(Math.round(10_000 * LONG_HORIZON_TTL_FACTOR));
  });

  it('never turns a live TTL into a dead one for a standing bet', async () => {
    expect(await lifetime('standing', 1)).toBeGreaterThan(0);
  });

  it('leaves a TTL of 0 disabled rather than reviving it', async () => {
    const h = makeHarness('http', { ttlMs: 0 });
    h.executor.submit([pred('a', 0.9, { horizon: 'standing' })], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(h.suppressed()['ttl-zero']).toBe(1);
  });
});

// --- budget and the drain queue --------------------------------------------------

describe('budget and drain queue', () => {
  it('stdio: queues over-budget predictions and fires them in confidence order', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.4), pred('c', 0.6)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']); // idle-only: one in flight

    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a', 'c']);

    h.io.calls[1]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a', 'c', 'b']);
  });

  it('http: respects concurrency 2 and drains the third', async () => {
    const h = makeHarness('http');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8), pred('c', 0.7)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a', 'b']);
    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a', 'b', 'c']);
  });

  it('does not queue a per-minute denial', async () => {
    const h = makeHarness('http', { maxPerMinute: 1 });
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    expect(tools(h.io)).toEqual(['a']);
    expect(h.suppressed()['budget:per-minute']).toBe(1);
    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a']);
  });

  it('drops a server the budget does not know, unless defaults budget it lazily', async () => {
    const h = makeHarness('http');
    h.tools.record('linear', 'a', { readOnly: true, servable: true, args: {} });
    h.executor.submit([{ ...pred('a', 0.9), server: 'linear' }], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(h.suppressed()['budget:unknown-server']).toBe(1);

    const now = () => 0;
    const tk = new ToolKnowledge(now);
    tk.record('linear', 'a', { readOnly: true, servable: true, args: {} });
    const executor = new SpeculationExecutor({
      cache: new SpeculationCache({ now }),
      tools: tk,
      budget: new BudgetManager({}, { now, defaults: { transport: 'stdio' } }),
      metrics: new Metrics({ mode: 'on', now }),
      now,
    });
    const io = fakeIo();
    executor.submit([{ ...pred('a', 0.9), server: 'linear' }, { ...pred('b', 0.8), server: 'linear' }], io);
    await settle();
    expect(io.calls.map((c) => `${c.server}/${c.tool}`)).toEqual(['linear/a']); // b unknown tool
  });

  it('expires queued predictions instead of firing them stale', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(1);

    h.advance(5_001); // beyond QUEUE_MAX_AGE_MS
    h.io.calls[0]!.resolve();
    await settle();
    expect(h.io.calls).toHaveLength(1);
    expect(h.suppressed()['queue-expired']).toBe(1);
  });

  it('fires a queued prediction just inside the 5 s window', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    h.advance(5_000);
    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a', 'b']);
  });

  it('never exceeds the queue cap, dropping the least confident', async () => {
    const h = makeHarness('stdio');
    const preds = Array.from({ length: 12 }, (_, i) => ({
      ...pred('a', 0.9 - i * 0.01),
      args: { i },
      ruleId: `rule:${i}`,
    }));
    h.executor.submit(preds, h.io);
    await settle();
    expect(h.io.calls).toHaveLength(1); // one in flight, eight queued, three dropped
    expect(h.suppressed()['queue-full']).toBe(3);

    for (let n = 0; n < 9; n++) {
      h.io.calls[n]!.resolve();
      await settle();
    }
    expect(h.io.calls.map((c) => c.args['i'])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('drainServer on real-call completion unblocks stdio speculation', async () => {
    const h = makeHarness('stdio');
    h.budget.realStarted('github');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0); // stdio busy with a real call

    h.budget.realFinished('github');
    h.executor.drainServer('github');
    await settle();
    expect(tools(h.io)).toEqual(['a']);
  });

  it('drains on the io the work was queued with unless a fresh one is passed', async () => {
    const h = makeHarness('stdio');
    h.budget.realStarted('github');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.budget.realFinished('github');
    const fresh = fakeIo();
    h.executor.drainServer('github', fresh);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(tools(fresh)).toEqual(['a']);

    const g = makeHarness('stdio');
    g.budget.realStarted('github');
    g.executor.submit([pred('a', 0.9)], g.io);
    await settle();
    g.budget.realFinished('github');
    g.executor.drainServer('github');
    await settle();
    expect(tools(g.io)).toEqual(['a']);
  });

  it('a fresh io that denies at drain time drops the queued work', async () => {
    const h = makeHarness('stdio');
    h.budget.realStarted('github');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    h.budget.realFinished('github');
    const fresh = fakeIo();
    fresh.allow = false;
    h.executor.drainServer('github', fresh);
    await settle();
    expect(fresh.calls).toHaveLength(0);
    expect(h.io.calls).toHaveLength(0);
    expect(h.suppressed()['host-permission']).toBe(1);
  });

  it('supersedes queued default and next-call predictions but keeps standing ones', async () => {
    const h = makeHarness('stdio');
    h.executor.submit(
      [pred('a', 0.9), pred('b', 0.8), pred('c', 0.7, { horizon: 'next' }), pred('d', 0.6, { horizon: 'standing' })],
      h.io,
    );
    await settle();
    expect(tools(h.io)).toEqual(['a']);

    expect(h.executor.supersedePendingNext('github')).toBe(2);
    expect(h.suppressed()['superseded-next-call']).toBe(2);

    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a', 'd']);
  });

  it('does not supersede another server queue', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8)], h.io);
    await settle();
    expect(h.executor.supersedePendingNext('linear')).toBe(0);
    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a', 'b']);
  });

  it('does not cancel a prediction that already acquired a slot', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9, { horizon: 'next' })], h.io);
    await settle();
    expect(h.executor.supersedePendingNext('github')).toBe(0);
    expect(h.cache.has(keyOf('a'))).toBe(true);
    h.io.calls[0]!.resolve();
    await settle();
    expect(h.cache.has(keyOf('a'))).toBe(true);
  });

  it('invalidatePending drops queued work for the server and counts it', async () => {
    const h = makeHarness('stdio');
    h.executor.submit([pred('a', 0.9), pred('b', 0.8), pred('c', 0.7)], h.io);
    await settle();
    expect(h.executor.invalidatePending('linear')).toBe(0);
    expect(h.executor.invalidatePending('github')).toBe(2);
    expect(h.suppressed()['cache-invalidation']).toBe(2);
    expect(h.executor.invalidatePending('github')).toBe(0);
    h.io.calls[0]!.resolve();
    await settle();
    expect(tools(h.io)).toEqual(['a']);
  });

  it('drops never-issued queued work cleanly at session end', async () => {
    const h = makeHarness('stdio');
    h.budget.realStarted('github');
    h.executor.submit([pred('a', 0.9)], h.io);
    await settle();
    expect(h.io.calls).toHaveLength(0);
    expect(h.executor.abandonPending()).toBe(1);
    expect(h.suppressed()['session-end']).toBe(1);
    h.budget.realFinished('github');
    h.executor.drainServer('github');
    await settle();
    expect(h.io.calls).toHaveLength(0);
  });
});
