/**
 * Speculation buffer (DESIGN.md §6).
 *
 * Per-session, in-memory, single-use cache of speculative tool-call results:
 * small, short-lived, biased toward missing rather than serving anything
 * questionable. Expiry is lazy — checked on lookup and via an explicit
 * sweep(); there are no internal timers.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { argsDistance, keyServer, keyTool, parseKeyArgs } from './keys.js';
import type { CacheEntryMeta, CacheKey, CacheLookup } from './types.js';

/**
 * Last-resort TTL when neither the operator nor a profile says otherwise
 * (DESIGN.md §6.2). Honestly, an UNMEASURED GUESS: it was chosen because the
 * prefetch-to-use gap for intra-turn chains is seconds, not because anyone
 * has measured how often a 30 s-old answer is wrong. See §13.19 for the
 * (deliberately unbuilt) shadow-validation design that would replace it with
 * a number.
 */
export const DEFAULT_TTL_MS = 30_000;

/**
 * TTL multiplier for long-horizon predictions (`Prediction.horizon ===
 * 'standing'`). Those bet that the agent will ask for something at SOME
 * point rather than next, so they sit in the buffer longest and are the
 * likeliest to be served near the TTL edge — the guesses whose staleness
 * risk is worst-evidenced expire soonest. Operator-overridable per server
 * via `speculation.longHorizonTtlFactor`.
 */
export const LONG_HORIZON_TTL_FACTOR = 0.5;

/**
 * Terminal entry outcomes, reported to the metrics layer so waste is
 * countable (DESIGN.md §9): an entry emits at most one of these, ever.
 */
export interface SpeculationCacheEvent {
  type: 'expired' | 'invalidated' | 'spec_error';
  key: CacheKey;
  meta: CacheEntryMeta;
  /** For 'spec_error': the upstream error message. */
  error?: string;
}

export interface SpeculationCacheOptions {
  /** Injectable clock (ms timestamps); defaults to Date.now. */
  now?: () => number;
  /** Observer for terminal entry outcomes. Throws are swallowed. */
  onEvent?: (ev: SpeculationCacheEvent) => void;
}

interface EntryBase {
  readonly server: string;
  readonly tool: string;
  readonly meta: CacheEntryMeta;
  /** The original speculative promise (handed to joiners as-is). */
  readonly promise: Promise<CallToolResult>;
  /**
   * Invalidated while in flight: unmapped already; when the promise resolves
   * it is dropped with an 'invalidated' event (rejections still report
   * 'spec_error' — the upstream failure is the more truthful terminal
   * outcome).
   */
  doomed: boolean;
  /**
   * Claimed by a 'joined' lookup: the joiner owns the outcome, so later
   * settlement stores nothing and emits no events.
   */
  claimed: boolean;
  /**
   * Canonical args parsed from the key, memoized on first near-miss scan
   * (undefined = not yet parsed; null = unparseable).
   */
  parsedArgs?: Record<string, unknown> | null;
}

interface InFlightEntry extends EntryBase {
  readonly state: 'inflight';
}

interface ReadyEntry extends EntryBase {
  readonly state: 'ready';
  readonly result: CallToolResult;
  /** When the result landed. TTL counts from completion, not issuance. */
  readonly readyAt: number;
  /** Absolute ms deadline; TTL counts from completion, not issuance. */
  readonly expiresAt: number;
}

type Entry = InFlightEntry | ReadyEntry;

const noop = (): void => {};

export class SpeculationCache {
  private readonly entries = new Map<CacheKey, Entry>();
  private readonly now: () => number;
  private readonly onEvent: ((ev: SpeculationCacheEvent) => void) | undefined;

  constructor(opts?: SpeculationCacheOptions) {
    this.now = opts?.now ?? Date.now;
    this.onEvent = opts?.onEvent;
  }

  /**
   * Register an in-flight speculative call. First put wins: if the key is
   * already occupied (fresh-ready or in-flight) the new put is ignored —
   * though an expired-ready husk is lazily evicted rather than allowed to
   * block a live speculation. Settlement handlers are attached synchronously,
   * so a rejection of `promise` can never become an unhandledRejection.
   */
  putInFlight(
    key: CacheKey,
    meta: CacheEntryMeta,
    promise: Promise<CallToolResult>,
    ttlMs: number,
  ): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.state === 'ready' && this.now() >= existing.expiresAt) {
        this.entries.delete(key);
        this.emit({ type: 'expired', key, meta: existing.meta });
      } else {
        // First wins. Still observe the loser's rejection so it stays handled.
        promise.then(noop, noop);
        return;
      }
    }

    const entry: InFlightEntry = {
      state: 'inflight',
      server: meta.server,
      tool: meta.tool,
      meta,
      promise,
      doomed: false,
      claimed: false,
    };
    this.entries.set(key, entry);
    promise.then(
      (result) => this.settleResolved(key, entry, result, ttlMs),
      (err) => this.settleRejected(key, entry, err),
    );
  }

  /**
   * Single-use lookup (DESIGN.md §6.2): a hit consumes the entry, a join
   * claims the in-flight call (a second concurrent lookup misses), an
   * expired entry is dropped with an 'expired' event and treated as a miss.
   * Misses carry near-miss key distance when same-(server, tool) entries
   * exist (§9 telemetry).
   */
  lookup(key: CacheKey): CacheLookup {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      if (entry.state === 'inflight') {
        entry.claimed = true;
        this.entries.delete(key);
        return { outcome: 'joined', promise: entry.promise, meta: entry.meta };
      }
      this.entries.delete(key);
      const t = this.now();
      if (t < entry.expiresAt) {
        // §9 staleness telemetry: how much of this entry's life had already
        // elapsed. Measured from readyAt, the same instant the TTL counts
        // from, so the fraction is exactly "how close to expiry".
        const ageMs = Math.max(0, t - entry.readyAt);
        const ttlMs = entry.expiresAt - entry.readyAt;
        return {
          outcome: 'hit',
          result: entry.result,
          meta: entry.meta,
          ageMs,
          ttlFraction: ttlMs > 0 ? Math.min(1, ageMs / ttlMs) : 0,
        };
      }
      this.emit({ type: 'expired', key, meta: entry.meta });
    }
    return this.miss(key);
  }

  /** True if the key holds a fresh-ready or in-flight entry (executor dedup). */
  has(key: CacheKey): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    return entry.state === 'inflight' || this.now() < entry.expiresAt;
  }

  /**
   * Mutation/flush invalidation for one server (DESIGN.md §6.2): ready
   * entries are removed (with an 'invalidated' event each); in-flight entries
   * are doomed — no longer lookupable, dropped with an 'invalidated' event
   * when their promise eventually resolves. Returns entries affected.
   */
  invalidateServer(server: string): number {
    return this.evict((entry) => entry.server === server);
  }

  /** Remove everything (restart/re-auth flush). Returns entries affected. */
  flushAll(): number {
    return this.evict(() => true);
  }

  /** Drop expired ready entries, emitting 'expired' per entry. */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state !== 'ready' || t < entry.expiresAt) continue;
      this.entries.delete(key);
      this.emit({ type: 'expired', key, meta: entry.meta });
      removed++;
    }
    return removed;
  }

  size(): { ready: number; inFlight: number } {
    let ready = 0;
    let inFlight = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === 'ready') ready++;
      else inFlight++;
    }
    return { ready, inFlight };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private settleResolved(
    key: CacheKey,
    entry: InFlightEntry,
    result: CallToolResult,
    ttlMs: number,
  ): void {
    const t = this.now();
    entry.meta.upstreamLatencyMs = t - entry.meta.issuedAt;
    // A claimed entry belongs to its joiner: nothing to store, no events.
    if (entry.claimed) return;
    if (entry.doomed) {
      this.emit({ type: 'invalidated', key, meta: entry.meta });
      return;
    }
    // Defensive: only the map's current occupant may transition to ready.
    if (this.entries.get(key) !== entry) return;
    if (ttlMs <= 0) {
      // TTL counts from completion, so the result is dead on arrival: never
      // store it. Reported as 'expired' so the waste is still countable.
      this.entries.delete(key);
      this.emit({ type: 'expired', key, meta: entry.meta });
      return;
    }
    this.entries.set(key, {
      ...entry,
      state: 'ready',
      result,
      readyAt: t,
      expiresAt: t + ttlMs,
    });
  }

  private settleRejected(key: CacheKey, entry: InFlightEntry, err: unknown): void {
    // A claimed entry's rejection is the joiner's to handle (caller fallback).
    if (entry.claimed) return;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    this.emit({
      type: 'spec_error',
      key,
      meta: entry.meta,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private evict(match: (entry: Entry) => boolean): number {
    let affected = 0;
    for (const [key, entry] of this.entries) {
      if (!match(entry)) continue;
      this.entries.delete(key);
      affected++;
      if (entry.state === 'ready') {
        this.emit({ type: 'invalidated', key, meta: entry.meta });
      } else {
        // Doomed: unmapped now (not lookupable, doesn't block a re-put); the
        // 'invalidated' event fires when the in-flight promise resolves.
        entry.doomed = true;
      }
    }
    return affected;
  }

  /**
   * Near-miss telemetry over remaining same-(server, tool) entries (§6.1).
   * Runs on the real-call hot path, so the probe key is parsed exactly once
   * and each entry's parsed args are memoized on the entry.
   */
  private miss(key: CacheKey): CacheLookup {
    const server = keyServer(key);
    const tool = keyTool(key);
    let probeArgs: Record<string, unknown> | null | undefined;
    let nearMissDistance: number | undefined;
    for (const [otherKey, other] of this.entries) {
      if (other.server !== server || other.tool !== tool) continue;
      if (probeArgs === undefined) probeArgs = parseKeyArgs(key);
      if (probeArgs === null) break;
      if (other.parsedArgs === undefined) other.parsedArgs = parseKeyArgs(otherKey);
      if (other.parsedArgs === null) continue;
      const d = argsDistance(probeArgs, other.parsedArgs);
      if (nearMissDistance === undefined || d < nearMissDistance) {
        nearMissDistance = d;
      }
    }
    return nearMissDistance === undefined
      ? { outcome: 'miss' }
      : { outcome: 'miss', nearMissDistance };
  }

  private emit(ev: SpeculationCacheEvent): void {
    if (this.onEvent === undefined) return;
    try {
      this.onEvent(ev);
    } catch {
      // A misbehaving observer must not corrupt cache state or turn a
      // handled speculative rejection back into an unhandled one.
    }
  }
}
