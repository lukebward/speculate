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
import { DEFAULT_TTL_MS, LONG_HORIZON_TTL_FACTOR, type SpeculationCache } from './cache.js';
import type { SafetyPolicy } from './policy.js';
import type { BudgetManager } from './budget.js';
import type { Metrics } from './metrics.js';
import { canonicalKey } from './keys.js';
import { profileCanonicalizer, profileTtlMs } from './profiles/index.js';
import { looksLikeAuthError, resultText, type Upstream } from './upstream.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type {
  Prediction,
  ServerProfile,
  SpeculateConfig,
} from './types.js';

const SPECULATIVE_CALL_TIMEOUT_MS = 30_000;
const QUEUE_MAX_AGE_MS = 5_000;
const QUEUE_MAX_LENGTH = 8;

interface QueuedPrediction {
  p: Prediction;
  queuedAt: number;
}

/**
 * The server structurally cannot serve this tool. SDK-based servers reject a
 * vanished/unknown tool with InvalidParams ("Tool X not found", per the MCP
 * spec's example); MethodNotFound means tools/call itself is unsupported.
 */
function isToolUnavailable(err: McpError): boolean {
  if (err.code === ErrorCode.MethodNotFound) return true;
  return (
    err.code === ErrorCode.InvalidParams &&
    /\btool\b.{0,40}\bnot found\b|\bunknown tool\b/i.test(err.message)
  );
}

export class SpeculationExecutor {
  private readonly pending = new Map<string, QueuedPrediction[]>();

  constructor(
    private readonly deps: {
      upstreams: Map<string, Upstream>;
      cache: SpeculationCache;
      policy: SafetyPolicy;
      budget: BudgetManager;
      metrics: Metrics;
      profiles: Record<string, ServerProfile>;
      config: SpeculateConfig;
      now?: () => number;
    },
  ) {}

  /** Fire-and-forget: never throws, never blocks the caller. */
  submit(predictions: Prediction[]): void {
    for (const p of predictions) {
      try {
        this.tryIssue(p, { queueOnBusy: true });
      } catch (err) {
        this.suppress(p, `executor-error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Drain hook: called when a budget slot may have freed (a speculative call
   * settled, or a real call finished on a serial upstream).
   */
  drainServer(server: string): void {
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
      const outcome = this.tryIssue(head.p, { queueOnBusy: false });
      if (outcome === 'busy') return; // slot still occupied; keep queue intact
      queue.shift();
    }
    this.pending.delete(server);
  }

  /**
   * Returns 'busy' when the only obstacle is an occupied budget slot; the
   * caller decides whether the prediction waits or dies.
   */
  private tryIssue(
    p: Prediction,
    opts: { queueOnBusy: boolean },
  ): 'issued' | 'dropped' | 'busy' {
    const { cache, policy, budget, metrics, profiles, upstreams } = this.deps;
    const now = this.deps.now ?? Date.now;

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

    const profile = profiles[p.server];
    const key =
      p.key ??
      canonicalKey(p.server, p.tool, p.args, profileCanonicalizer(profile, p.tool));
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
      if (isBusy) return 'busy';
      this.suppress(p, `budget:${b.reason}`);
      return 'dropped';
    }

    const meta = {
      server: p.server,
      tool: p.tool,
      ruleId: p.ruleId,
      issuedAt: now(),
    };

    const promise = upstream
      .callTool(p.tool, p.args, { timeoutMs: SPECULATIVE_CALL_TIMEOUT_MS })
      .then((result) => {
        if (result.isError) {
          // §4/§6: error results are never cached speculatively.
          const text = resultText(result);
          if (looksLikeAuthError({ resultText: text })) {
            policy.suspend(p.server, p.tool, 'auth');
          }
          throw new Error(`upstream error result: ${text.slice(0, 200)}`);
        }
        return result;
      })
      .catch((err: unknown) => {
        if (looksLikeAuthError({ message: (err as Error)?.message })) {
          policy.suspend(p.server, p.tool, 'auth');
        } else if (err instanceof McpError && isToolUnavailable(err)) {
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
    cache.putInFlight(key, meta, promise, ttlMs);
    metrics.record({
      type: 'speculated',
      server: p.server,
      tool: p.tool,
      ruleId: p.ruleId,
      confidence: p.confidence,
    });
    return 'issued';
  }

  private enqueue(p: Prediction): void {
    const now = this.deps.now ?? Date.now;
    let queue = this.pending.get(p.server);
    if (!queue) {
      queue = [];
      this.pending.set(p.server, queue);
    }
    // Highest-confidence predictions fire first when the slot frees.
    const at = queue.findIndex((q) => q.p.confidence < p.confidence);
    const item = { p, queuedAt: now() };
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
   * The TTL this prediction is fetched with (§6.2). Resolution order is
   * unchanged — operator per-tool, profile per-tool, operator default,
   * profile default, hardcoded fallback — and a long-horizon prediction then
   * gets a FRACTION of whatever won, so an operator's per-tool freshness
   * decision still sets the ceiling.
   */
  private resolveTtl(
    server: string,
    tool: string,
    horizon: Prediction['horizon'],
  ): number {
    const { profiles, config } = this.deps;
    const serverCfg = config.servers[server];
    const profile = profiles[server];
    const cfgByTool = serverCfg?.speculation?.ttlMsByTool;
    const operatorTtl =
      cfgByTool && Object.hasOwn(cfgByTool, tool) ? cfgByTool[tool] : undefined;
    const base =
      operatorTtl ?? // operator per-tool beats everything (incl. 0 = never)
      profileTtlMs(profile, tool) ??
      serverCfg?.speculation?.defaultTtlMs ??
      profile?.defaultTtlMs ??
      DEFAULT_TTL_MS;
    if (horizon !== 'standing' || base <= 0) return base; // 0 stays disabled
    const factor = serverCfg?.speculation?.longHorizonTtlFactor ?? LONG_HORIZON_TTL_FACTOR;
    // At least 1 ms: rounding a live TTL down to 0 would make the entry dead
    // on arrival, quietly turning every standing bet into pure waste.
    return Math.max(1, Math.round(base * factor));
  }
}
