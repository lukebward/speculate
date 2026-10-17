import { argsDistance, keyServer, keyTool, parseKeyArgs } from './keys.js';
/**
 * Last-resort TTL when the operator does not configure one
 * (DESIGN.md §6.2). Honestly, an UNMEASURED GUESS: it was chosen because the
 * prefetch-to-use gap for intra-turn chains is seconds, not because anyone
 * has measured how often a 30 s-old answer is wrong. See §13.19 for the
 * (deliberately unbuilt) shadow-validation design that would replace it with
 * a number.
 */
export const DEFAULT_TTL_MS = 30_000;
/**
 * TTL multiplier for session-opening predictions (`horizon === 'standing'`).
 * Triggered predictions, including those with constant arguments, use the
 * ordinary TTL. The default factor remains 1; operators may shorten opener
 * retention per server with `speculation.longHorizonTtlFactor`.
 */
export const LONG_HORIZON_TTL_FACTOR = 1;
const noop = () => { };
export class SpeculationCache {
    entries = new Map();
    now;
    onEvent;
    constructor(opts) {
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
    putInFlight(key, meta, promise, ttlMs, canPublish) {
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            if (existing.state === 'ready' && this.now() >= existing.expiresAt) {
                this.entries.delete(key);
                this.emit({ type: 'expired', key, meta: existing.meta });
            }
            else {
                // First wins. Still observe the loser's rejection so it stays handled.
                promise.then(noop, noop);
                return;
            }
        }
        const entry = {
            state: 'inflight',
            server: meta.server,
            tool: meta.tool,
            meta,
            promise,
            doomed: false,
            claimed: false,
            canPublish,
        };
        this.entries.set(key, entry);
        promise.then((result) => this.settleResolved(key, entry, result, ttlMs), (err) => this.settleRejected(key, entry, err));
    }
    /**
     * Single-use lookup (DESIGN.md §6.2): a hit consumes the entry, a join
     * claims the in-flight call (a second concurrent lookup misses), an
     * expired entry is dropped with an 'expired' event and treated as a miss.
     * Misses carry near-miss key distance when same-(server, tool) entries
     * exist (§9 telemetry).
     */
    lookup(key) {
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
    has(key) {
        const entry = this.entries.get(key);
        if (entry === undefined)
            return false;
        return entry.state === 'inflight' || this.now() < entry.expiresAt;
    }
    /**
     * Mutation/flush invalidation for one server (DESIGN.md §6.2): ready
     * entries are removed (with an 'invalidated' event each); in-flight entries
     * are doomed — no longer lookupable, dropped with an 'invalidated' event
     * when their promise eventually resolves. Returns entries affected.
     */
    invalidateServer(server) {
        return this.evict((entry) => entry.server === server);
    }
    /** Remove everything (restart/re-auth flush). Returns entries affected. */
    flushAll() {
        return this.evict(() => true);
    }
    /**
     * End-of-session terminalization. Unlike mutation invalidation, this emits
     * synchronously for BOTH ready and in-flight entries: the process is about
     * to stop, so waiting for an in-flight promise to settle would lose the
     * feedback entirely. Marking an in-flight entry claimed makes its existing
     * settlement handlers consume the eventual resolution/rejection silently,
     * so every speculative call still has exactly one terminal outcome.
     */
    abandonAll() {
        let removed = 0;
        for (const [key, entry] of this.entries) {
            this.entries.delete(key);
            entry.claimed = true;
            this.emit({ type: 'abandoned', key, meta: entry.meta });
            removed++;
        }
        return removed;
    }
    /** Drop expired ready entries, emitting 'expired' per entry. */
    sweep() {
        const t = this.now();
        let removed = 0;
        for (const [key, entry] of this.entries) {
            if (entry.state !== 'ready' || t < entry.expiresAt)
                continue;
            this.entries.delete(key);
            this.emit({ type: 'expired', key, meta: entry.meta });
            removed++;
        }
        return removed;
    }
    size() {
        let ready = 0;
        let inFlight = 0;
        for (const entry of this.entries.values()) {
            if (entry.state === 'ready')
                ready++;
            else
                inFlight++;
        }
        return { ready, inFlight };
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    settleResolved(key, entry, result, ttlMs) {
        const t = this.now();
        entry.meta.upstreamLatencyMs = t - entry.meta.issuedAt;
        // A claimed entry belongs to its joiner: nothing to store, no events.
        if (entry.claimed)
            return;
        if (entry.doomed || (entry.canPublish && !entry.canPublish())) {
            if (this.entries.get(key) === entry)
                this.entries.delete(key);
            this.emit({ type: 'invalidated', key, meta: entry.meta });
            return;
        }
        // Defensive: only the map's current occupant may transition to ready.
        if (this.entries.get(key) !== entry)
            return;
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
    settleRejected(key, entry, err) {
        // A claimed entry's rejection is the joiner's to handle (caller fallback).
        if (entry.claimed)
            return;
        if (this.entries.get(key) === entry)
            this.entries.delete(key);
        this.emit({
            type: 'spec_error',
            key,
            meta: entry.meta,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    evict(match) {
        let affected = 0;
        for (const [key, entry] of this.entries) {
            if (!match(entry))
                continue;
            this.entries.delete(key);
            affected++;
            if (entry.state === 'ready') {
                this.emit({ type: 'invalidated', key, meta: entry.meta });
            }
            else {
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
    miss(key) {
        const server = keyServer(key);
        const tool = keyTool(key);
        let probeArgs;
        let nearMissDistance;
        for (const [otherKey, other] of this.entries) {
            if (other.server !== server || other.tool !== tool)
                continue;
            if (probeArgs === undefined)
                probeArgs = parseKeyArgs(key);
            if (probeArgs === null)
                break;
            if (other.parsedArgs === undefined)
                other.parsedArgs = parseKeyArgs(otherKey);
            if (other.parsedArgs === null)
                continue;
            const d = argsDistance(probeArgs, other.parsedArgs);
            if (nearMissDistance === undefined || d < nearMissDistance) {
                nearMissDistance = d;
            }
        }
        return nearMissDistance === undefined
            ? { outcome: 'miss' }
            : { outcome: 'miss', nearMissDistance };
    }
    emit(ev) {
        if (this.onEvent === undefined)
            return;
        try {
            this.onEvent(ev);
        }
        catch {
            // A misbehaving observer must not corrupt cache state or turn a
            // handled speculative rejection back into an unhandled one.
        }
    }
}
