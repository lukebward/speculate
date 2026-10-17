/**
 * Speculation executor (DESIGN.md §3.1): takes predictions, applies tool
 * eligibility, host permission, budgets, and dedup, and issues surviving
 * calls through Claude Code's own MCP connection.
 *
 * The executor never holds the host interface. Each submit carries a
 * SpeculationIo built inside the mod hook that raised it, so every call it
 * makes is that hook's own `$.mcp.call` and every authorization its own
 * `$.tool.check`.
 *
 * Predictions denied only by a busy budget slot (stdio idle-only rule, HTTP
 * concurrency cap) are not dropped: they wait in a small per-server drain
 * queue, ordered by confidence, and fire when the slot frees — bounded by
 * QUEUE_MAX_AGE_MS so a stale prediction never fires long after its trigger.
 * (Refinement discovered during MVP benchmarking; see DESIGN.md §3.1.)
 */
import { DEFAULT_TTL_MS, LONG_HORIZON_TTL_FACTOR, type SpeculationCache } from './cache.js';
import type { ToolKnowledge } from './tools.js';
import type { BudgetManager } from './budget.js';
import type { Metrics } from './metrics.js';
import { canonicalKey } from './keys.js';
import type { Prediction, ToolResult } from './types.js';

const QUEUE_MAX_AGE_MS = 5_000;
const QUEUE_MAX_LENGTH = 8;

/** The host operations one speculative call needs, bound to one mod hook. */
export interface SpeculationIo {
  /** Calls the tool on Claude Code's own connection to the server. */
  call(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** True only when the host would run this exact call without asking. */
  authorize(server: string, tool: string, args: Record<string, unknown>): Promise<boolean>;
  /** Resolves after `ms`; bounds a speculative call so it cannot hold a slot. */
  sleep?(ms: number): Promise<void>;
}

/** A speculative call still unsettled after this is abandoned (its slot freed). */
export const SPECULATIVE_CALL_TIMEOUT_MS = 30_000;

interface QueuedPrediction {
  p: Prediction;
  io: SpeculationIo;
  queuedAt: number;
}

export function looksLikeAuthError(text: string): boolean {
  return /\b(unauthorized|forbidden|permission denied|not authorized|invalid[ _-]?token|expired[ _-]?token|401|403)\b/i.test(
    text,
  );
}

/** First text block of a result, for error sniffing. */
export function resultText(result: ToolResult): string {
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

/** The server structurally cannot serve this tool (it vanished, or is unknown). */
function isToolUnavailable(message: string): boolean {
  return /\btool\b.{0,40}\bnot found\b|\bunknown tool\b|\bmethod not found\b/i.test(message);
}

export class SpeculationExecutor {
  private readonly pending = new Map<string, QueuedPrediction[]>();
  private readonly draining = new Set<string>();
  private readonly invalidationRevisions = new Map<string, number>();
  private readonly nextSupersessionRevisions = new Map<string, number>();
  private lifecycleRevision = 0;

  constructor(
    private readonly deps: {
      cache: SpeculationCache;
      tools: ToolKnowledge;
      budget: BudgetManager;
      metrics: Metrics;
      ttlMs?: number;
      now?: () => number;
    },
  ) {}

  /** Fire-and-forget: never throws, never blocks the caller. */
  submit(predictions: Prediction[], io: SpeculationIo, opts: { queueOnBusy?: boolean } = {}): void {
    for (const p of predictions) {
      void this.authorizeAndIssue(p, io, { queueOnBusy: opts.queueOnBusy !== false });
    }
  }

  /**
   * A real call advances the server past predictions for its previous
   * trigger. Drop only queued next-call work; issued calls and explicit
   * standing bets keep their existing lifecycle.
   */
  supersedePendingNext(server: string): number {
    this.nextSupersessionRevisions.set(server, (this.nextSupersessionRevisions.get(server) ?? 0) + 1);
    const queue = this.pending.get(server);
    if (!queue?.length) return 0;
    const standing: QueuedPrediction[] = [];
    let dropped = 0;
    for (const item of queue) {
      if (item.p.horizon === 'standing') {
        standing.push(item);
      } else {
        this.suppress(item.p, 'superseded-next-call');
        dropped++;
      }
    }
    if (standing.length > 0) this.pending.set(server, standing);
    else this.pending.delete(server);
    return dropped;
  }

  /**
   * Drop predictions that never acquired a slot before the session ended.
   * They are suppression, not waste: no speculative call was issued. Keeping
   * the event makes the end-of-session funnel reconcile without penalizing a
   * rule for work the budget deliberately prevented.
   */
  abandonPending(): number {
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

  invalidatePending(server: string): number {
    this.invalidationRevisions.set(server, (this.invalidationRevisions.get(server) ?? 0) + 1);
    const queue = this.pending.get(server);
    if (!queue?.length) return 0;
    for (const { p } of queue) this.suppress(p, 'cache-invalidation');
    this.pending.delete(server);
    return queue.length;
  }

  /**
   * Drain hook: called when a budget slot may have freed (a speculative call
   * settled, or a real call finished). Queued work runs on the io it was
   * submitted with, unless the caller hands a fresher one.
   */
  drainServer(server: string, io?: SpeculationIo): void {
    if (!this.draining.has(server)) void this.drainServerAuthorized(server, io);
  }

  /**
   * Returns 'busy' when the only obstacle is an occupied budget slot; the
   * caller decides whether the prediction waits or dies.
   */
  private tryIssue(
    p: Prediction,
    io: SpeculationIo,
    opts: { queueOnBusy: boolean },
  ): 'issued' | 'dropped' | 'busy' {
    const { cache, tools, budget, metrics } = this.deps;
    const now = this.deps.now ?? Date.now;

    const decision = tools.eligibility(p.server, p.tool);
    if (!decision.eligible) {
      this.suppress(p, `policy:${decision.reason}`);
      return 'dropped';
    }

    const ttlMs = this.resolveTtl(p.horizon);
    if (ttlMs <= 0) {
      this.suppress(p, 'ttl-zero');
      return 'dropped';
    }

    const key = p.key ?? canonicalKey(p.server, p.tool, p.args);
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
        this.enqueue(p, io);
        return 'busy';
      }
      if (isBusy) return 'busy';
      this.suppress(p, `budget:${b.reason}`);
      return 'dropped';
    }

    const specDispatchAt = now();
    const meta = {
      server: p.server,
      tool: p.tool,
      ruleId: p.ruleId,
      issuedAt: specDispatchAt,
    };

    let publicationAllowed = true;
    let call: Promise<ToolResult>;
    try {
      call = io.call(p.server, p.tool, p.args);
      const timer = io.sleep?.(SPECULATIVE_CALL_TIMEOUT_MS);
      if (timer) {
        call = Promise.race([
          call,
          timer.then(
            () => Promise.reject(new Error('speculative call timed out')),
            () => new Promise<never>(() => {}),
          ),
        ]);
      }
    } catch (err) {
      call = Promise.reject(err);
    }
    const promise = call
      .then(async (result) => {
        if (result.isError) {
          // §4/§6: error results are never cached speculatively.
          const text = resultText(result);
          if (looksLikeAuthError(text)) tools.suspend(p.server, p.tool, 'auth');
          throw new Error(`upstream error result: ${text.slice(0, 200)}`);
        }
        // Permission may have changed while the call ran; an entry is only
        // published if the host would still run this exact call.
        publicationAllowed = await this.authorize(p, io);
        return result;
      })
      .catch((err: unknown) => {
        const message = String((err as Error)?.message ?? err);
        if (looksLikeAuthError(message)) {
          tools.suspend(p.server, p.tool, 'auth');
        } else if (isToolUnavailable(message)) {
          // Structurally un-callable: stop speculating it rather than
          // re-burning budget every trigger. A real call succeeding later
          // resets this (§4).
          tools.suspend(p.server, p.tool, 'tool-unavailable');
        }
        throw err;
      })
      .finally(() => {
        budget.release(p.server);
        this.drainServer(p.server);
      });

    // The cache attaches handlers synchronously, so rejections are owned there.
    cache.putInFlight(key, meta, promise, ttlMs, () => publicationAllowed);
    metrics.record({
      type: 'speculated',
      server: p.server,
      tool: p.tool,
      ruleId: p.ruleId,
      confidence: p.confidence,
      timestamp: specDispatchAt,
    });
    return 'issued';
  }

  private async authorizeAndIssue(
    p: Prediction,
    io: SpeculationIo,
    opts: { queueOnBusy: boolean },
  ): Promise<void> {
    const lifecycleRevision = this.lifecycleRevision;
    const invalidationRevision = this.invalidationRevisions.get(p.server) ?? 0;
    const nextSupersessionRevision = this.nextSupersessionRevisions.get(p.server) ?? 0;
    // Cheap synchronous checks first, so an ineligible prediction never costs
    // a permission query.
    const decision = this.deps.tools.eligibility(p.server, p.tool);
    if (!decision.eligible) {
      this.suppress(p, `policy:${decision.reason}`);
      return;
    }
    const allowed = await this.authorize(p, io);
    if (lifecycleRevision !== this.lifecycleRevision) {
      this.suppress(p, 'session-end');
      return;
    }
    if (invalidationRevision !== (this.invalidationRevisions.get(p.server) ?? 0)) {
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
      this.tryIssue(p, io, opts);
    } catch (err) {
      this.suppress(p, `executor-error: ${(err as Error).message}`);
    }
  }

  private async authorize(p: Prediction, io: SpeculationIo): Promise<boolean> {
    try {
      return (await io.authorize(p.server, p.tool, p.args)) === true;
    } catch {
      return false;
    }
  }

  private async drainServerAuthorized(server: string, fresh?: SpeculationIo): Promise<void> {
    this.draining.add(server);
    let replaced = false;
    try {
      const queue = this.pending.get(server);
      if (!queue?.length) return;
      const now = this.deps.now ?? Date.now;
      while (queue.length > 0) {
        const head = queue[0]!;
        if (now() - head.queuedAt > QUEUE_MAX_AGE_MS) {
          queue.shift();
          this.suppress(head.p, 'queue-expired');
          continue;
        }
        const io = fresh ?? head.io;
        const allowed = await this.authorize(head.p, io);
        if (this.pending.get(server) !== queue || queue[0] !== head) {
          // The queue changed while authorization ran (superseded, flushed,
          // or a new queue started): drain what is there now, not this copy.
          replaced = true;
          return;
        }
        if (!allowed) {
          queue.shift();
          this.suppress(head.p, 'host-permission');
          continue;
        }
        const outcome = this.tryIssue(head.p, io, { queueOnBusy: false });
        if (outcome === 'busy') return;
        queue.shift();
      }
      this.pending.delete(server);
    } finally {
      this.draining.delete(server);
      if (replaced && this.pending.get(server)?.length) this.drainServer(server, fresh);
    }
  }

  private enqueue(p: Prediction, io: SpeculationIo): void {
    const now = this.deps.now ?? Date.now;
    let queue = this.pending.get(p.server);
    if (!queue) {
      queue = [];
      this.pending.set(p.server, queue);
    }
    // Highest-confidence predictions fire first when the slot frees.
    const at = queue.findIndex((q) => q.p.confidence < p.confidence);
    const item = { p, io, queuedAt: now() };
    if (at === -1) queue.push(item);
    else queue.splice(at, 0, item);
    while (queue.length > QUEUE_MAX_LENGTH) {
      const dropped = queue.pop()!;
      this.suppress(dropped.p, 'queue-full');
    }
  }

  private suppress(p: Prediction, reason: string): void {
    this.deps.metrics.record({
      type: 'suppressed',
      server: p.server,
      tool: p.tool,
      ruleId: p.ruleId,
      confidence: p.confidence,
      reason,
    });
  }

  /**
   * The TTL this prediction is fetched with (§6.2). A long-horizon
   * prediction gets a fraction of the base, which stays the ceiling.
   */
  private resolveTtl(horizon: Prediction['horizon']): number {
    const base = this.deps.ttlMs ?? DEFAULT_TTL_MS;
    if (horizon !== 'standing' || base <= 0) return base; // 0 stays disabled
    // At least 1 ms: rounding a live TTL down to 0 would make the entry dead
    // on arrival, quietly turning every standing bet into pure waste.
    return Math.max(1, Math.round(base * LONG_HORIZON_TTL_FACTOR));
  }
}
