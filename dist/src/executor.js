/**
 * Speculation executor (DESIGN.md §3.1): takes predictions, applies the
 * safety policy, budgets, and dedup, and issues surviving calls upstream.
 *
 * Predictions denied only by a busy budget slot (stdio idle-only rule, HTTP
 * concurrency cap) are not dropped: they wait in a small per-server drain
 * queue, ordered by confidence, and fire when the slot frees — bounded by
 * QUEUE_MAX_AGE_MS so a stale prediction never fires long after its trigger.
 * (Refinement discovered during MVP benchmarking; see DESIGN.md §3.1.)
 */
import { DEFAULT_TTL_MS, LONG_HORIZON_TTL_FACTOR } from './cache.js';
import { canonicalKey } from './keys.js';
import { looksLikeAuthError, resultText } from './upstream.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
const SPECULATIVE_CALL_TIMEOUT_MS = 30_000;
const QUEUE_MAX_AGE_MS = 5_000;
const QUEUE_MAX_LENGTH = 8;
/**
 * The server structurally cannot serve this tool. SDK-based servers reject a
 * vanished/unknown tool with InvalidParams ("Tool X not found", per the MCP
 * spec's example); MethodNotFound means tools/call itself is unsupported.
 */
function isToolUnavailable(err) {
    if (err.code === ErrorCode.MethodNotFound)
        return true;
    return (err.code === ErrorCode.InvalidParams &&
        /\btool\b.{0,40}\bnot found\b|\bunknown tool\b/i.test(err.message));
}
export class SpeculationExecutor {
    deps;
    pending = new Map();
    draining = new Set();
    invalidationRevisions = new Map();
    nextSupersessionRevisions = new Map();
    lifecycleRevision = 0;
    observerIssueSequence = 0;
    constructor(deps) {
        this.deps = deps;
    }
    /** Fire-and-forget: never throws, never blocks the caller. */
    submit(predictions, opts = {}) {
        for (const p of predictions) {
            if (this.deps.predictionGate?.authorize) {
                void this.authorizeAndIssue(p, { queueOnBusy: opts.queueOnBusy !== false });
                continue;
            }
            try {
                this.tryIssue(p, { queueOnBusy: opts.queueOnBusy !== false });
            }
            catch (err) {
                this.suppress(p, `executor-error: ${err.message}`);
            }
        }
    }
    /**
     * A real call advances the server past predictions for its previous
     * trigger. Drop only queued next-call work; issued calls and explicit
     * standing bets keep their existing lifecycle.
     */
    supersedePendingNext(server) {
        this.nextSupersessionRevisions.set(server, (this.nextSupersessionRevisions.get(server) ?? 0) + 1);
        const queue = this.pending.get(server);
        if (!queue?.length)
            return 0;
        const standing = [];
        let dropped = 0;
        for (const item of queue) {
            if (item.p.horizon === 'standing') {
                standing.push(item);
            }
            else {
                this.suppress(item.p, 'superseded-next-call');
                dropped++;
            }
        }
        if (standing.length > 0)
            this.pending.set(server, standing);
        else
            this.pending.delete(server);
        return dropped;
    }
    /**
     * Drop predictions that never acquired an upstream slot before shutdown.
     * They are suppression, not waste: no speculative call was issued. Keeping
     * the event makes the end-of-session funnel reconcile without penalizing a
     * rule for work the budget deliberately prevented.
     */
    abandonPending() {
        this.lifecycleRevision++;
        let dropped = 0;
        for (const queue of this.pending.values()) {
            for (const { p } of queue) {
                this.suppress(p, 'session-end');
                dropped++;
            }
        }
        this.pending.clear();
        return dropped;
    }
    invalidatePending(server) {
        this.invalidationRevisions.set(server, (this.invalidationRevisions.get(server) ?? 0) + 1);
        const queue = this.pending.get(server);
        if (!queue?.length)
            return 0;
        for (const { p } of queue)
            this.suppress(p, 'cache-invalidation');
        this.pending.delete(server);
        return queue.length;
    }
    /**
     * Drain hook: called when a budget slot may have freed (a speculative call
     * settled, or a real call finished on a serial upstream).
     */
    drainServer(server) {
        if (this.deps.predictionGate?.authorize) {
            if (!this.draining.has(server))
                void this.drainServerAuthorized(server);
            return;
        }
        const queue = this.pending.get(server);
        if (!queue?.length)
            return;
        const now = this.deps.now ?? Date.now;
        while (queue.length > 0) {
            const head = queue[0];
            if (now() - head.queuedAt > QUEUE_MAX_AGE_MS) {
                queue.shift();
                this.suppress(head.p, 'queue-expired');
                continue;
            }
            const outcome = this.tryIssue(head.p, { queueOnBusy: false });
            if (outcome === 'busy')
                return; // slot still occupied; keep queue intact
            queue.shift();
        }
        this.pending.delete(server);
    }
    /**
     * Returns 'busy' when the only obstacle is an occupied budget slot; the
     * caller decides whether the prediction waits or dies.
     */
    tryIssue(p, opts, hostAuthorized = false) {
        const { cache, policy, budget, metrics, upstreams } = this.deps;
        const now = this.deps.now ?? Date.now;
        if (p.executionLease && !this.deps.leaseValidator?.isCurrent(p.executionLease)) {
            this.suppress(p, 'stale-generation');
            return 'dropped';
        }
        if (!hostAuthorized && this.deps.predictionGate && !this.deps.predictionGate.allows(p.server, p.tool)) {
            this.suppress(p, 'host-permission');
            return 'dropped';
        }
        const upstream = upstreams.get(p.server);
        if (!upstream?.connected) {
            this.suppress(p, 'upstream-unavailable');
            return 'dropped';
        }
        const decision = policy.eligibility(p.server, p.tool);
        if (!decision.eligible) {
            this.suppress(p, `policy:${decision.reason}`);
            return 'dropped';
        }
        const ttlMs = this.resolveTtl(p.server, p.tool, p.horizon);
        if (ttlMs <= 0) {
            this.suppress(p, 'ttl-zero');
            return 'dropped';
        }
        const key = p.key ??
            canonicalKey(p.server, p.tool, p.args);
        if (cache.has(key)) {
            this.suppress(p, 'dedup');
            return 'dropped';
        }
        const b = budget.tryAcquire(p.server);
        if (!b.ok) {
            // Busy slots clear (a call settles); rate/config denials don't clear
            // on any event we see, so queuing them would defeat the budget.
            const isBusy = b.reason === 'stdio-busy' || b.reason === 'concurrency';
            if (isBusy && opts.queueOnBusy) {
                this.enqueue(p);
                return 'busy';
            }
            if (isBusy)
                return 'busy';
            this.suppress(p, `budget:${b.reason}`);
            return 'dropped';
        }
        const specDispatchAt = now();
        const observerIssue = p.observerAttribution ? {
            ...p.observerAttribution,
            issueId: `observer-issue:${++this.observerIssueSequence}`,
            specDispatchAt,
        } : undefined;
        const meta = {
            server: p.server,
            tool: p.tool,
            ruleId: p.ruleId,
            issuedAt: specDispatchAt,
            observerIssue,
        };
        let publicationAllowed = true;
        const promise = upstream
            .callTool(p.tool, p.args, { timeoutMs: SPECULATIVE_CALL_TIMEOUT_MS })
            .then(async (result) => {
            if (result.isError) {
                // §4/§6: error results are never cached speculatively.
                const text = resultText(result);
                if (looksLikeAuthError({ resultText: text })) {
                    policy.suspend(p.server, p.tool, 'auth');
                }
                throw new Error(`upstream error result: ${text.slice(0, 200)}`);
            }
            if (this.deps.predictionGate?.authorize) {
                publicationAllowed = await this.authorize(p);
            }
            return result;
        })
            .catch((err) => {
            if (looksLikeAuthError({ message: err?.message })) {
                policy.suspend(p.server, p.tool, 'auth');
            }
            else if (err instanceof McpError && isToolUnavailable(err)) {
                // Structurally un-callable (tool vanished, server can't serve it):
                // stop speculating it rather than re-burning budget every trigger.
                // A real call succeeding later resets this (§4).
                policy.suspend(p.server, p.tool, 'tool-unavailable');
            }
            throw err;
        })
            .finally(() => {
            budget.release(p.server);
            this.drainServer(p.server);
        });
        // The cache attaches handlers synchronously, so rejections are owned there.
        cache.putInFlight(key, meta, promise, ttlMs, p.executionLease || this.deps.predictionGate
            ? () => (!p.executionLease || this.deps.leaseValidator?.isCurrent(p.executionLease) === true) &&
                publicationAllowed && (!this.deps.predictionGate?.authorize && this.deps.predictionGate
                ? this.deps.predictionGate.allows(p.server, p.tool)
                : true)
            : undefined);
        metrics.record({
            type: 'speculated',
            server: p.server,
            tool: p.tool,
            ruleId: p.ruleId,
            confidence: p.confidence,
            timestamp: specDispatchAt,
            observerIssue,
        });
        return 'issued';
    }
    async authorizeAndIssue(p, opts) {
        const lifecycleRevision = this.lifecycleRevision;
        const invalidationRevision = this.invalidationRevisions.get(p.server) ?? 0;
        const nextSupersessionRevision = this.nextSupersessionRevisions.get(p.server) ?? 0;
        const allowed = await this.authorize(p);
        if (lifecycleRevision !== this.lifecycleRevision || invalidationRevision !== (this.invalidationRevisions.get(p.server) ?? 0)) {
            this.suppress(p, 'cache-invalidation');
            return;
        }
        if (p.horizon !== 'standing' && nextSupersessionRevision !== (this.nextSupersessionRevisions.get(p.server) ?? 0)) {
            this.suppress(p, 'superseded-next-call');
            return;
        }
        if (!allowed) {
            this.suppress(p, 'host-permission');
            return;
        }
        try {
            this.tryIssue(p, opts, true);
        }
        catch (err) {
            this.suppress(p, `executor-error: ${err.message}`);
        }
    }
    async authorize(p) {
        try {
            return await this.deps.predictionGate.authorize(p.server, p.tool);
        }
        catch {
            return false;
        }
    }
    async drainServerAuthorized(server) {
        this.draining.add(server);
        try {
            const queue = this.pending.get(server);
            if (!queue?.length)
                return;
            const now = this.deps.now ?? Date.now;
            while (queue.length > 0) {
                const head = queue[0];
                if (now() - head.queuedAt > QUEUE_MAX_AGE_MS) {
                    queue.shift();
                    this.suppress(head.p, 'queue-expired');
                    continue;
                }
                const allowed = await this.authorize(head.p);
                if (this.pending.get(server) !== queue || queue[0] !== head)
                    return;
                if (!allowed) {
                    queue.shift();
                    this.suppress(head.p, 'host-permission');
                    continue;
                }
                const outcome = this.tryIssue(head.p, { queueOnBusy: false }, true);
                if (outcome === 'busy')
                    return;
                queue.shift();
            }
            this.pending.delete(server);
        }
        finally {
            this.draining.delete(server);
        }
    }
    enqueue(p) {
        const now = this.deps.now ?? Date.now;
        let queue = this.pending.get(p.server);
        if (!queue) {
            queue = [];
            this.pending.set(p.server, queue);
        }
        // Highest-confidence predictions fire first when the slot frees.
        const at = queue.findIndex((q) => q.p.confidence < p.confidence);
        const item = { p, queuedAt: now() };
        if (at === -1)
            queue.push(item);
        else
            queue.splice(at, 0, item);
        while (queue.length > QUEUE_MAX_LENGTH) {
            const dropped = queue.pop();
            this.suppress(dropped.p, 'queue-full');
        }
    }
    suppress(p, reason) {
        this.deps.metrics.record({
            type: 'suppressed',
            server: p.server,
            tool: p.tool,
            ruleId: p.ruleId,
            confidence: p.confidence,
            reason,
            observerAttribution: p.observerAttribution,
        });
    }
    /**
     * The TTL this prediction is fetched with (§6.2). Resolution order is
     * unchanged — operator per-tool, operator default, hardcoded fallback —
     * and a long-horizon prediction then
     * gets a FRACTION of whatever won, so an operator's per-tool freshness
     * decision still sets the ceiling.
     */
    resolveTtl(server, tool, horizon) {
        const { config } = this.deps;
        const serverCfg = config.servers[server];
        const cfgByTool = serverCfg?.speculation?.ttlMsByTool;
        const operatorTtl = cfgByTool && Object.hasOwn(cfgByTool, tool) ? cfgByTool[tool] : undefined;
        const base = operatorTtl ?? // operator per-tool beats everything (incl. 0 = never)
            serverCfg?.speculation?.defaultTtlMs ??
            DEFAULT_TTL_MS;
        if (horizon !== 'standing' || base <= 0)
            return base; // 0 stays disabled
        const factor = serverCfg?.speculation?.longHorizonTtlFactor ?? LONG_HORIZON_TTL_FACTOR;
        // At least 1 ms: rounding a live TTL down to 0 would make the entry dead
        // on arrival, quietly turning every standing bet into pure waste.
        return Math.max(1, Math.round(base * factor));
    }
}
