import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { SpeculationCache, type SpeculationCacheEvent } from '../src/cache.js';
import { canonicalKey } from '../src/keys.js';
import type { CacheEntryMeta, CacheLookup } from '../src/types.js';

// Minimal module-local typing for the Node process events used below, so the
// file typechecks even when @types/node is not in the ambient lib set.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCache() {
  let t = 0;
  const events: SpeculationCacheEvent[] = [];
  const cache = new SpeculationCache({
    now: () => t,
    onEvent: (ev) => events.push(ev),
  });
  return { cache, events, setTime: (ms: number) => (t = ms) };
}

function meta(server = 'github', tool = 'get_issue', issuedAt = 0): CacheEntryMeta {
  return { server, tool, ruleId: 'rule-1', issuedAt };
}

function res(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res_, rej) => {
    resolve = res_;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtasks (and give node a chance to fire unhandledRejection). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function asHit(l: CacheLookup): Extract<CacheLookup, { outcome: 'hit' }> {
  if (l.outcome !== 'hit') throw new Error(`expected hit, got ${l.outcome}`);
  return l;
}

function asJoined(l: CacheLookup): Extract<CacheLookup, { outcome: 'joined' }> {
  if (l.outcome !== 'joined') throw new Error(`expected joined, got ${l.outcome}`);
  return l;
}

function asMiss(l: CacheLookup): Extract<CacheLookup, { outcome: 'miss' }> {
  if (l.outcome !== 'miss') throw new Error(`expected miss, got ${l.outcome}`);
  return l;
}

const K1 = canonicalKey('github', 'get_issue', { owner: 'a', repo: 'r', n: 1 });
const K2 = canonicalKey('github', 'get_issue', { owner: 'a', repo: 'r', n: 2 });

// ---------------------------------------------------------------------------
// Hits and single-use semantics
// ---------------------------------------------------------------------------

describe('hit semantics', () => {
  it('a completed entry hits and returns the exact upstream result and meta', async () => {
    const { cache, events } = makeCache();
    const result = res('issue-1');
    const m = meta();
    cache.putInFlight(K1, m, Promise.resolve(result), 1000);
    await tick();

    expect(cache.size()).toEqual({ ready: 1, inFlight: 0 });
    const hit = asHit(cache.lookup(K1));
    expect(hit.result).toBe(result); // exactly the upstream bytes, no copy
    expect(hit.meta).toBe(m);
    expect(events).toEqual([]);
  });

  it('reports how much of the entry TTL had elapsed when it was consumed', async () => {
    // §9 staleness telemetry: the whole point of measuring age is that better
    // prediction fetches earlier, so entries are consumed later in their life.
    const { cache, setTime } = makeCache();
    setTime(100);
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), 1000);
    await tick(); // ready at t=100, expires at t=1100

    setTime(850);
    const hit = asHit(cache.lookup(K1));
    expect(hit.ageMs).toBe(750);
    expect(hit.ttlFraction).toBeCloseTo(0.75, 10);
  });

  it('reports a fresh hit as age 0, not as a fraction of nothing', async () => {
    const { cache } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), 1000);
    await tick();
    const hit = asHit(cache.lookup(K1));
    expect(hit.ageMs).toBe(0);
    expect(hit.ttlFraction).toBe(0);
  });

  it('a hit consumes the entry: the second lookup is a miss', async () => {
    const { cache } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), 1000);
    await tick();

    asHit(cache.lookup(K1));
    expect(cache.lookup(K1).outcome).toBe('miss');
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
  });
});

// ---------------------------------------------------------------------------
// TTL and expiry
// ---------------------------------------------------------------------------

describe('TTL and expiry', () => {
  it('measures TTL from completion, not issuance, and records upstream latency', async () => {
    const { cache, setTime } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta('github', 'get_issue', 0), d.promise, 1000);

    setTime(5000); // long after issuedAt; would be dead if TTL ran from issuance
    d.resolve(res('late'));
    await tick();

    setTime(5999); // 999 ms after completion: still fresh
    const hit = asHit(cache.lookup(K1));
    expect(hit.meta.upstreamLatencyMs).toBe(5000);
  });

  it('expires exactly at completion + ttl', async () => {
    const { cache, events, setTime } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 1000);
    setTime(5000);
    d.resolve(res('late'));
    await tick();

    setTime(6000); // completion(5000) + ttl(1000): expired
    expect(asMiss(cache.lookup(K1)).nearMissDistance).toBeUndefined();
    expect(events).toEqual([
      { type: 'expired', key: K1, meta: expect.objectContaining({ tool: 'get_issue' }) },
    ]);
  });

  it('lookup of an expired entry deletes it, emits "expired", and misses', async () => {
    const { cache, events, setTime } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), 1000);
    await tick();

    setTime(1000);
    expect(cache.lookup(K1).outcome).toBe('miss');
    expect(events.map((e) => e.type)).toEqual(['expired']);
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
    // Gone for good: a later lookup does not re-emit.
    expect(cache.lookup(K1).outcome).toBe('miss');
    expect(events).toHaveLength(1);
  });

  it('sweep removes only expired ready entries and emits "expired" per entry', async () => {
    const { cache, events, setTime } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('short')), 1000);
    cache.putInFlight(K2, meta(), Promise.resolve(res('long')), 5000);
    await tick();
    const inflight = deferred<CallToolResult>();
    const K3 = canonicalKey('github', 'get_issue', { n: 3 });
    cache.putInFlight(K3, meta(), inflight.promise, 1000);

    expect(cache.sweep()).toBe(0); // nothing expired yet
    setTime(1000);
    expect(cache.sweep()).toBe(1);
    expect(events).toEqual([
      { type: 'expired', key: K1, meta: expect.objectContaining({ server: 'github' }) },
    ]);
    // In-flight entries are never swept (their TTL hasn't started).
    expect(cache.size()).toEqual({ ready: 1, inFlight: 1 });

    setTime(5000);
    expect(cache.sweep()).toBe(1);
    expect(events.map((e) => [e.type, e.key])).toEqual([
      ['expired', K1],
      ['expired', K2],
    ]);
    inflight.resolve(res('done'));
    await tick();
  });
});

// ---------------------------------------------------------------------------
// In-flight joins
// ---------------------------------------------------------------------------

describe('joined lookups', () => {
  it('claims the in-flight entry and resolves for the joiner after the claim', async () => {
    const { cache, events } = makeCache();
    const d = deferred<CallToolResult>();
    const m = meta();
    cache.putInFlight(K1, m, d.promise, 1000);

    const joined = asJoined(cache.lookup(K1));
    expect(joined.meta).toBe(m);
    // Claimed: a second concurrent lookup misses, and the entry is unmapped.
    expect(cache.lookup(K1).outcome).toBe('miss');
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });

    const result = res('joined-result');
    d.resolve(result); // resolves after the claim
    await expect(joined.promise).resolves.toBe(result);
    await tick();
    // The claimed promise never re-enters the cache and fires no events.
    expect(cache.lookup(K1).outcome).toBe('miss');
    expect(events).toEqual([]);
  });

  it('propagates the upstream rejection to the joiner without emitting events', async () => {
    const { cache, events } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 1000);

    const joined = asJoined(cache.lookup(K1));
    d.reject(new Error('upstream 500'));
    await expect(joined.promise).rejects.toThrow('upstream 500');
    await tick();
    expect(events).toEqual([]); // the joiner owns the failure; not a spec_error
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
  });
});

// ---------------------------------------------------------------------------
// Speculative failures
// ---------------------------------------------------------------------------

describe('rejected speculative calls', () => {
  it('emits "spec_error" with the message and removes the entry', async () => {
    const { cache, events } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 1000);
    expect(cache.size()).toEqual({ ready: 0, inFlight: 1 });

    d.reject(new Error('boom'));
    await tick();
    expect(events).toEqual([
      { type: 'spec_error', key: K1, meta: expect.objectContaining({ ruleId: 'rule-1' }), error: 'boom' },
    ]);
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
    expect(cache.lookup(K1).outcome).toBe('miss');
  });

  it('stringifies non-Error rejection reasons', async () => {
    const { cache, events } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 1000);
    d.reject('flaky upstream');
    await tick();
    expect(events[0]).toMatchObject({ type: 'spec_error', error: 'flaky upstream' });
  });

  it('never lets a speculative rejection become an unhandledRejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { cache } = makeCache();
      const d = deferred<CallToolResult>();
      cache.putInFlight(K1, meta(), d.promise, 1000);
      d.reject(new Error('nobody awaits me'));
      await tick();
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('swallows the rejection of a duplicate (ignored) put as well', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { cache, events } = makeCache();
      cache.putInFlight(K1, meta(), Promise.resolve(res('winner')), 1000);
      const loser = deferred<CallToolResult>();
      cache.putInFlight(K1, meta(), loser.promise, 1000); // ignored: first wins
      loser.reject(new Error('ignored failure'));
      await tick();
      await tick();
      expect(seen).toEqual([]);
      expect(events).toEqual([]); // the ignored put is not an entry: no spec_error
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe('invalidateServer', () => {
  it('removes ready entries, dooms in-flight ones, and only touches the named server', async () => {
    const { cache, events } = makeCache();
    const ghReady = canonicalKey('github', 'get_issue', { n: 1 });
    const ghInflightKey = canonicalKey('github', 'list_pull_requests', { repo: 'r' });
    const slackKey = canonicalKey('slack', 'search', { q: 'x' });
    const d = deferred<CallToolResult>();

    cache.putInFlight(ghReady, meta('github', 'get_issue'), Promise.resolve(res('gh')), 1000);
    cache.putInFlight(slackKey, meta('slack', 'search'), Promise.resolve(res('sl')), 1000);
    await tick();
    cache.putInFlight(ghInflightKey, meta('github', 'list_pull_requests'), d.promise, 1000);

    expect(cache.invalidateServer('github')).toBe(2); // ready + doomed in-flight
    expect(events).toEqual([
      { type: 'invalidated', key: ghReady, meta: expect.objectContaining({ server: 'github' }) },
    ]);

    // Doomed entries are not lookupable and don't count toward size.
    expect(cache.lookup(ghInflightKey).outcome).toBe('miss');
    expect(cache.has(ghInflightKey)).toBe(false);
    expect(cache.size()).toEqual({ ready: 1, inFlight: 0 });

    // The other server's entry is untouched.
    asHit(cache.lookup(slackKey));

    // When the doomed promise resolves, it is dropped with 'invalidated'.
    d.resolve(res('too late'));
    await tick();
    expect(events.map((e) => [e.type, e.key])).toEqual([
      ['invalidated', ghReady],
      ['invalidated', ghInflightKey],
    ]);
    expect(cache.lookup(ghInflightKey).outcome).toBe('miss');
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
  });

  it('returns 0 and emits nothing for a server with no entries', async () => {
    const { cache, events } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), 1000);
    await tick();
    expect(cache.invalidateServer('slack')).toBe(0);
    expect(events).toEqual([]);
    asHit(cache.lookup(K1));
  });

  it('a doomed key can be re-speculated immediately; the doomed settle does not clobber it', async () => {
    const { cache, events } = makeCache();
    const doomed = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), doomed.promise, 1000);
    expect(cache.invalidateServer('github')).toBe(1);

    const fresh = res('fresh');
    cache.putInFlight(K1, meta(), Promise.resolve(fresh), 1000);
    doomed.resolve(res('stale'));
    await tick();

    expect(events.map((e) => e.type)).toEqual(['invalidated']);
    expect(asHit(cache.lookup(K1)).result).toBe(fresh);
  });
});

describe('flushAll', () => {
  it('counts ready and in-flight entries, emitting/dooming respectively', async () => {
    const { cache, events } = makeCache();
    const kA = canonicalKey('github', 'get_issue', { n: 1 });
    const kB = canonicalKey('slack', 'search', { q: 'x' });
    const kC = canonicalKey('github', 'list_pull_requests', { repo: 'r' });
    const d = deferred<CallToolResult>();

    cache.putInFlight(kA, meta('github', 'get_issue'), Promise.resolve(res('a')), 1000);
    cache.putInFlight(kB, meta('slack', 'search'), Promise.resolve(res('b')), 1000);
    await tick();
    cache.putInFlight(kC, meta('github', 'list_pull_requests'), d.promise, 1000);

    expect(cache.flushAll()).toBe(3);
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
    expect(events.filter((e) => e.type === 'invalidated')).toHaveLength(2);

    d.resolve(res('c'));
    await tick();
    expect(events.filter((e) => e.type === 'invalidated')).toHaveLength(3);
    expect(cache.flushAll()).toBe(0);
  });
});

describe('abandonAll', () => {
  it('terminalizes ready and in-flight entries exactly once at session end', async () => {
    const { cache, events } = makeCache();
    const pending = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), Promise.resolve(res('ready')), 1000);
    cache.putInFlight(K2, meta(), pending.promise, 1000);
    await tick();

    expect(cache.abandonAll()).toBe(2);
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
    expect(events.map((event) => event.type)).toEqual(['abandoned', 'abandoned']);

    pending.resolve(res('late'));
    await tick();
    expect(events.map((event) => event.type)).toEqual(['abandoned', 'abandoned']);
    expect(cache.abandonAll()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ttlMs <= 0
// ---------------------------------------------------------------------------

describe('non-positive TTLs', () => {
  it('ttlMs 0 entries are never stored and never become hits', async () => {
    const { cache, setTime } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 0);
    expect(cache.has(K1)).toBe(true); // still dedupes while in flight

    setTime(100);
    d.resolve(res('discard'));
    await tick();
    expect(cache.size()).toEqual({ ready: 0, inFlight: 0 });
    expect(cache.has(K1)).toBe(false);
    expect(cache.lookup(K1).outcome).toBe('miss');
  });

  it('reports the drop as "expired" so the waste is countable', async () => {
    const { cache, events } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), -5);
    await tick();
    expect(events.map((e) => [e.type, e.key])).toEqual([['expired', K1]]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate puts
// ---------------------------------------------------------------------------

describe('duplicate putInFlight', () => {
  it('first wins while the first is still in flight', async () => {
    const { cache } = makeCache();
    const first = deferred<CallToolResult>();
    const winner = res('first');
    cache.putInFlight(K1, meta(), first.promise, 1000);
    cache.putInFlight(K1, meta(), Promise.resolve(res('second')), 1000);
    expect(cache.size()).toEqual({ ready: 0, inFlight: 1 });

    first.resolve(winner);
    await tick();
    expect(cache.size()).toEqual({ ready: 1, inFlight: 0 });
    expect(asHit(cache.lookup(K1)).result).toBe(winner);
  });

  it('first wins against a fresh ready entry', async () => {
    const { cache } = makeCache();
    const winner = res('ready');
    cache.putInFlight(K1, meta(), Promise.resolve(winner), 1000);
    await tick();
    cache.putInFlight(K1, meta(), Promise.resolve(res('usurper')), 1000);
    await tick();
    expect(asHit(cache.lookup(K1)).result).toBe(winner);
    expect(cache.lookup(K1).outcome).toBe('miss'); // and the usurper never landed
  });

  it('an expired husk does not block a new put', async () => {
    const { cache, events, setTime } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('old')), 1000);
    await tick();
    setTime(1000); // old entry now expired

    const fresh = res('new');
    cache.putInFlight(K1, meta(), Promise.resolve(fresh), 1000);
    expect(events.map((e) => e.type)).toEqual(['expired']); // husk lazily evicted
    await tick();
    expect(asHit(cache.lookup(K1)).result).toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// has()
// ---------------------------------------------------------------------------

describe('has', () => {
  it('is true for in-flight and fresh-ready, false when absent/consumed/expired', async () => {
    const { cache, setTime } = makeCache();
    expect(cache.has(K1)).toBe(false);

    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 1000);
    expect(cache.has(K1)).toBe(true); // in-flight

    d.resolve(res('x'));
    await tick();
    expect(cache.has(K1)).toBe(true); // fresh-ready

    setTime(999);
    expect(cache.has(K1)).toBe(true); // still fresh at ttl - 1
    setTime(1000);
    expect(cache.has(K1)).toBe(false); // expired (lazily; not removed by has)

    setTime(500 /* pretend time went back — entry is still there and fresh */);
    asHit(cache.lookup(K1));
    expect(cache.has(K1)).toBe(false); // consumed
  });
});

// ---------------------------------------------------------------------------
// Near-miss telemetry
// ---------------------------------------------------------------------------

describe('near-miss distance', () => {
  it('reports the min top-level arg distance to same-(server, tool) entries', async () => {
    const { cache } = makeCache();
    cache.putInFlight(
      canonicalKey('github', 'list_pull_requests', { owner: 'a', repo: 'r', state: 'open' }),
      meta('github', 'list_pull_requests'),
      Promise.resolve(res('one-away')),
      1000,
    );
    cache.putInFlight(
      canonicalKey('github', 'list_pull_requests', { owner: 'b', repo: 'z', state: 'closed' }),
      meta('github', 'list_pull_requests'),
      Promise.resolve(res('three-away')),
      1000,
    );
    await tick();

    const missed = asMiss(
      cache.lookup(
        canonicalKey('github', 'list_pull_requests', { owner: 'a', repo: 'r', state: 'closed' }),
      ),
    );
    expect(missed.nearMissDistance).toBe(1); // min(1, 3)
  });

  it('is undefined when no same-tool entries exist (including other servers)', async () => {
    const { cache } = makeCache();
    cache.putInFlight(K1, meta('github', 'get_issue'), Promise.resolve(res('x')), 1000);
    cache.putInFlight(
      canonicalKey('slack', 'list_pull_requests', { repo: 'r' }),
      meta('slack', 'list_pull_requests'),
      Promise.resolve(res('y')),
      1000,
    );
    await tick();

    // Same server, different tool: no candidates.
    const noTool = asMiss(cache.lookup(canonicalKey('github', 'list_pull_requests', { repo: 'r' })));
    expect(noTool.nearMissDistance).toBeUndefined();
    // Same tool name on a different server does not count either — checked
    // above: the slack entry was the only list_pull_requests entry.
  });

  it('counts in-flight entries as near-miss candidates', () => {
    const { cache } = makeCache();
    const d = deferred<CallToolResult>();
    cache.putInFlight(K1, meta(), d.promise, 1000);

    const missed = asMiss(cache.lookup(K2)); // differs from K1 only in n
    expect(missed.nearMissDistance).toBe(1);
    d.resolve(res('x'));
  });

  it('an identical-args entry never reports distance 0 to itself', async () => {
    const { cache } = makeCache();
    cache.putInFlight(K1, meta(), Promise.resolve(res('x')), 1000);
    await tick();
    asHit(cache.lookup(K1)); // consumed before the miss below
    expect(asMiss(cache.lookup(K1)).nearMissDistance).toBeUndefined();
  });
});
