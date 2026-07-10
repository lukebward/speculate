/**
 * Speculation executor (DESIGN.md §3.1): takes predictions, applies the
 * safety policy, budgets, and dedup, and issues surviving calls upstream.
 */
import type { SpeculationCache } from './cache.js';
import type { SafetyPolicy } from './policy.js';
import type { BudgetManager } from './budget.js';
import type { Metrics } from './metrics.js';
import { canonicalKey } from './keys.js';
import { looksLikeAuthError, resultText, type Upstream } from './upstream.js';
import type {
  Prediction,
  ServerProfile,
  SpeculateConfig,
} from './types.js';

const SPECULATIVE_CALL_TIMEOUT_MS = 30_000;

export class SpeculationExecutor {
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
        this.submitOne(p);
      } catch (err) {
        this.deps.metrics.record({
          type: 'suppressed',
          server: p.server,
          tool: p.tool,
          ruleId: p.ruleId,
          reason: `executor-error: ${(err as Error).message}`,
        });
      }
    }
  }

  private submitOne(p: Prediction): void {
    const { cache, policy, budget, metrics, profiles, config, upstreams } = this.deps;
    const now = this.deps.now ?? Date.now;

    const suppress = (reason: string): void =>
      metrics.record({
        type: 'suppressed',
        server: p.server,
        tool: p.tool,
        ruleId: p.ruleId,
        confidence: p.confidence,
        reason,
      });

    const upstream = upstreams.get(p.server);
    if (!upstream?.connected) return suppress('upstream-unavailable');

    const decision = policy.eligibility(p.server, p.tool);
    if (!decision.eligible) return suppress(`policy:${decision.reason}`);

    const ttlMs = this.resolveTtl(p.server, p.tool);
    if (ttlMs <= 0) return suppress('ttl-zero');

    const profile = profiles[p.server];
    const key = canonicalKey(p.server, p.tool, p.args, profile?.canonicalizers[p.tool]);
    if (cache.has(key)) return suppress('dedup');

    const b = budget.tryAcquire(p.server);
    if (!b.ok) return suppress(`budget:${b.reason}`);

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
        }
        throw err;
      })
      .finally(() => budget.release(p.server));

    // The cache attaches handlers synchronously, so rejections are owned there.
    cache.putInFlight(key, meta, promise, ttlMs);
    metrics.record({
      type: 'speculated',
      server: p.server,
      tool: p.tool,
      ruleId: p.ruleId,
      confidence: p.confidence,
    });

    void config; // config reserved for future per-server executor knobs
  }

  private resolveTtl(server: string, tool: string): number {
    const { profiles, config } = this.deps;
    const serverCfg = config.servers[server];
    const profile = profiles[server];
    return (
      profile?.ttlMsByTool[tool] ??
      serverCfg?.speculation?.defaultTtlMs ??
      profile?.defaultTtlMs ??
      30_000
    );
  }
}
