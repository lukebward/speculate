/**
 * The speculator: Speculate's read path inside Claude Code (DESIGN.md §3.1).
 *
 * Claude Code runs every MCP call through the mod's `tool.call` hook, which
 * asks the speculator two things. Before the call, `serve`: is there a
 * prefetched result for exactly this call that the host still allows? After
 * a real call, `observe`: learn from it, invalidate on anything not
 * read-only, and prefetch what is likely next. `prompt` and `sessionStart`
 * add the two earlier signals: the person's own words, and the session's
 * habitual opening reads.
 *
 * The speculator is pure: it never touches the host. Every operation that
 * reaches the host goes through the SpeculationIo the calling hook supplies.
 */
import { SpeculationCache, DEFAULT_TTL_MS } from './cache.js';
import { BudgetManager } from './budget.js';
import { Metrics, type UsageCounters } from './metrics.js';
import { Predictor } from './predictor.js';
import { TransitionLearner } from './learner.js';
import { SpeculationExecutor, type SpeculationIo } from './executor.js';
import { LatencyModel } from './latency.js';
import { CandidateCalibrator } from './calibration.js';
import { morphologicalPairs } from './priming.js';
import { canonicalKey } from './keys.js';
import { ToolKnowledge } from './tools.js';
import { intentMappings } from './intent.js';
import type { MemorySnapshot, PersistedState } from './persistence.js';
import type { SpeculateOptions, StatsReport, ToolResult } from './types.js';

export type { SpeculationIo } from './executor.js';

/** How many of a session's leading reads are recorded as openers (§13.15). */
const OPENER_RECORD_LIMIT = 3;
const INTENT_CONFIDENCE = 0.95;

export const DEFAULT_OPTIONS: SpeculateOptions = {
  mode: 'on',
  maxPredictionsPerTrigger: 3,
  ttlMs: DEFAULT_TTL_MS,
  maxPerMinute: 30,
  minExpectedSavedMs: 15,
};

/** What a real call through the host revealed. */
export interface RealOutcome {
  result: ToolResult;
  /** The host's verdict on this call (`isReadOnly`). */
  isReadOnly: boolean;
  /** The host's record was content blocks, which a prefetch can stand in for. */
  servable: boolean;
  isError: boolean;
  latencyMs: number;
}

/**
 * A prefetched result claimed for one real call. Nothing is counted until
 * the call's PreToolUse hooks have had their say: `commit` when the result
 * answered the call, `discard` when the call ran through the host anyway.
 */
export interface Claim {
  result: ToolResult;
  source: 'hit' | 'joined';
  /** The upstream latency the prefetch took, i.e. what the call would have. */
  latencyMs: number;
  commit(): void;
  discard(reason: string): void;
}

export interface McpToolName {
  server: string;
  tool: string;
}

/**
 * Splits `mcp__<server>__<tool>`. The server part is Claude Code's
 * normalized server name, which `$.mcp.call` accepts as written.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match) return null;
  return { server: match[1]!, tool: match[2]! };
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export class Speculator {
  readonly options: SpeculateOptions;
  readonly metrics: Metrics;
  readonly cache: SpeculationCache;
  readonly tools: ToolKnowledge;
  readonly budget: BudgetManager;
  readonly predictor: Predictor;
  readonly executor: SpeculationExecutor;

  private readonly now: () => number;
  private readonly learner: TransitionLearner;
  private readonly latency: LatencyModel;
  private readonly calibration: CandidateCalibrator;
  /** Remaining opener-recording slots per server this session (§13.15). */
  private readonly openerSlots = new Map<string, number>();
  /** Servers already primed and fired at for this session. */
  private readonly started = new Set<string>();
  /** Usage counters already folded into the cross-session totals. */
  private reportedUsage: UsageCounters | null = null;

  constructor(options: Partial<SpeculateOptions> = {}, opts: { now?: () => number } = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.now = opts.now ?? Date.now;
    const now = this.now;

    this.metrics = new Metrics({ mode: this.options.mode, now });
    this.cache = new SpeculationCache({
      now,
      onEvent: (ev) =>
        this.metrics.record({
          type: ev.type,
          server: ev.meta.server,
          tool: ev.meta.tool,
          ruleId: ev.meta.ruleId,
          reason: ev.error,
        }),
    });
    this.tools = new ToolKnowledge(now);
    this.budget = new BudgetManager({}, {
      now,
      defaults: { transport: 'stdio', maxPerMinute: this.options.maxPerMinute },
    });
    // The cap belongs to the learner as much as to the predictor: it sizes
    // the beam (§13.18).
    this.learner = new TransitionLearner({
      now,
      maxPredictionsPerTrigger: this.options.maxPredictionsPerTrigger,
    });
    this.latency = new LatencyModel({ now });
    this.calibration = new CandidateCalibrator({ now });
    this.predictor = new Predictor({
      maxPerTrigger: this.options.maxPredictionsPerTrigger,
      metrics: this.metrics,
      learner: this.learner,
      latency: this.latency,
      calibration: this.calibration,
      defaultAdmission: { enabled: true, minExpectedSavedMs: this.options.minExpectedSavedMs },
    });
    this.executor = new SpeculationExecutor({
      cache: this.cache,
      tools: this.tools,
      budget: this.budget,
      metrics: this.metrics,
      ttlMs: this.options.ttlMs,
      now,
    });
  }

  get enabled(): boolean {
    return this.options.mode !== 'off';
  }

  // -------------------------------------------------------------------------
  // The read path
  // -------------------------------------------------------------------------

  /**
   * Before a real call: claim the prefetched result for exactly this call,
   * when one exists and the host would run the call without asking. Null
   * sends the call through the host as normal.
   *
   * `deadline`, when it settles first, ends a join's wait for an in-flight
   * prefetch; the call then goes through the host instead.
   */
  async serve(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    io: SpeculationIo,
    deadline?: Promise<unknown>,
  ): Promise<Claim | null> {
    if (!this.enabled) return null;
    this.executor.supersedePendingNext(server);
    if (!this.tools.isReadOnly(server, tool)) {
      // §6.2 conservative invalidation: an unknown or mutating tool flushes
      // the server on issue, and again on settle (observe).
      this.invalidate(server);
      return null;
    }

    let key: string;
    try {
      key = canonicalKey(server, tool, args);
    } catch {
      return null; // unkeyable args never fail a real call (§3.3)
    }
    const found = this.cache.lookup(key);
    if (found.outcome === 'miss') {
      this.metrics.record({ type: 'miss', server, tool, nearMissDistance: found.nearMissDistance });
      return null;
    }
    const { ruleId } = found.meta;
    const wasted = (reason: string): void =>
      this.metrics.record({ type: 'invalidated', server, tool, ruleId, reason });

    // The host decides at the moment of use, as it would for the real call:
    // a rule or mode that changed since the prefetch is honored.
    if (!this.tools.eligibility(server, tool).eligible || !(await this.authorized(io, server, tool, args))) {
      if (found.outcome === 'joined') found.promise.then(noop, noop);
      wasted('host-permission');
      return null;
    }

    if (found.outcome === 'hit') {
      const { meta, ageMs, ttlFraction } = found;
      return {
        result: found.result,
        source: 'hit',
        latencyMs: meta.upstreamLatencyMs ?? 0,
        commit: () =>
          this.metrics.record({
            type: 'hit',
            server,
            tool,
            ruleId,
            savedMs: meta.upstreamLatencyMs ?? 0,
            ageMs,
            ttlFraction,
          }),
        discard: wasted,
      };
    }

    const joinedAt = this.now();
    let result: ToolResult;
    try {
      result = await before(found.promise, deadline);
    } catch (err) {
      // Never surface a speculative failure for a call the agent made: fall
      // through to the real call, and count the waste so feedback learns.
      this.metrics.record({
        type: 'spec_error',
        server,
        tool,
        ruleId,
        reason: `join-failed: ${String((err as Error)?.message ?? 'unknown').slice(0, 200)}`,
      });
      return null;
    }
    const savedMs = Math.max(0, joinedAt - found.meta.issuedAt);
    return {
      result,
      source: 'joined',
      latencyMs: found.meta.upstreamLatencyMs ?? this.now() - found.meta.issuedAt,
      commit: () => this.metrics.record({ type: 'joined', server, tool, ruleId, savedMs }),
      discard: wasted,
    };
  }

  /** A real call is about to run through the host. */
  beginReal(server: string): { mayWaitBehindSpeculation: boolean } {
    const mayWaitBehindSpeculation = this.budget.specInFlight(server) > 0;
    this.budget.realStarted(server);
    return { mayWaitBehindSpeculation };
  }

  /**
   * A real call ran through the host (or was refused: pass no outcome).
   * Order matters (§6.2): a call that may have mutated flushes the server
   * BEFORE the drain, so queued speculation never fires into a stale window.
   */
  observe(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    outcome: RealOutcome | null,
    io: SpeculationIo,
    started: { mayWaitBehindSpeculation: boolean } = { mayWaitBehindSpeculation: false },
  ): void {
    this.budget.realFinished(server);
    if (!outcome) {
      this.executor.drainServer(server, io);
      return;
    }

    const prior = this.tools.fact(server, tool);
    // An error the host reports without a read-only verdict may never have
    // reached the tool (a hook or a rule refused it): it says nothing about
    // the tool, so it neither sets nor clears a verdict. It still flushes the
    // server below, since it may also be a write that failed partway.
    const verdict = outcome.isError && !outcome.isReadOnly ? prior?.readOnly : outcome.isReadOnly;
    if (verdict !== undefined) {
      this.tools.record(server, tool, {
        readOnly: verdict,
        // An error result says nothing about the record's shape; keep what a
        // successful call showed.
        servable: outcome.isError ? prior?.servable ?? false : outcome.servable,
        args,
      });
    }
    if (!outcome.isReadOnly) this.invalidate(server);
    this.executor.drainServer(server, io);

    this.metrics.record({ type: 'real_call', server, tool, latencyMs: outcome.latencyMs });
    if (started.mayWaitBehindSpeculation) {
      // Conservative upper bound: the host exposes no split between queueing
      // and the tool's own work, so charge the full wait.
      this.metrics.record({ type: 'stdio_delay', server, tool, latencyMs: outcome.latencyMs });
    }
    if (outcome.isError) return;
    if (this.tools.isSuspended(server, tool)) this.tools.resetSuspension(server, tool);
    this.learn(server, tool, args, outcome.result, outcome.latencyMs, outcome.isReadOnly, io);
  }

  /**
   * A claimed prefetch answered the call. It is learned from like the real
   * call it stood in for, so a chain keeps predicting past a served step.
   */
  observeServed(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    claim: Pick<Claim, 'result' | 'latencyMs'>,
    io: SpeculationIo,
  ): void {
    this.budget.realFinished(server);
    this.executor.drainServer(server, io);
    this.learn(server, tool, args, claim.result, claim.latencyMs, true, io);
  }

  private learn(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
    latencyMs: number,
    isReadOnly: boolean,
    io: SpeculationIo,
  ): void {
    // §5.5: off means off. A disabled mod learns nothing and stores nothing.
    if (!this.enabled) return;
    try {
      if (isReadOnly) {
        // §13.15: the session's first few reads per server become opener
        // candidates for the NEXT session's start-time prefetch.
        const slots = this.openerSlots.get(server) ?? OPENER_RECORD_LIMIT;
        if (slots > 0) {
          this.openerSlots.set(server, slots - 1);
          this.learner.recordOpener(server, tool, args);
        }
      }
      const predictions = this.predictor.observe({
        server,
        tool,
        args,
        result,
        latencyMs,
        timestamp: this.now(),
        eligibleTarget: isReadOnly,
      });
      if (predictions.length > 0) this.executor.submit(predictions, io);
    } catch {
      // Prediction is best-effort; the call already returned.
    }
  }

  // -------------------------------------------------------------------------
  // Earlier signals
  // -------------------------------------------------------------------------

  /**
   * The person submitted a prompt. When its words name exactly one known
   * read-only tool call, prefetch it while the model reads the prompt.
   * Returns the number of predictions submitted.
   */
  prompt(text: string, cwd: string, io: SpeculationIo): number {
    if (!this.enabled) return 0;
    const matches: Array<{ server: string; tool: string; args: Record<string, unknown>; ruleId: string }> = [];
    for (const mapping of intentMappings(text, cwd)) {
      for (const server of this.tools.servers()) {
        if (!this.tools.eligibility(server, mapping.tool).eligible) continue;
        if (!this.tools.hasShape(server, mapping.tool, Object.keys(mapping.args))) continue;
        matches.push({ server, ...mapping });
      }
    }
    // Ambiguity is a miss, never a guess between servers or tools.
    if (matches.length !== 1) return 0;
    const match = matches[0]!;
    const predictions = this.predictor.admitResolved(
      match.server,
      [{
        tool: match.tool,
        args: match.args,
        confidence: INTENT_CONFIDENCE,
        candidateId: match.ruleId,
        ruleId: match.ruleId,
      }],
      { timestamp: this.now(), trackNextCall: false },
    );
    if (predictions.length > 0) this.executor.submit(predictions, io);
    return predictions.length;
  }

  /**
   * MCP tools the session can call (their `mcp__server__tool` names). The
   * first time a server appears: prime the learner with lister→getter pairs
   * among its known reads (§13.9), then fire its learned openers (§13.15).
   * Idempotent per server, so it is safe to call whenever the list may have
   * grown.
   */
  sessionStart(toolNames: readonly string[], io: SpeculationIo): number {
    if (!this.enabled) return 0;
    const byServer = new Map<string, string[]>();
    for (const name of toolNames) {
      const parsed = parseMcpToolName(name);
      if (!parsed) continue;
      const tools = byServer.get(parsed.server) ?? [];
      tools.push(parsed.tool);
      byServer.set(parsed.server, tools);
    }
    let submitted = 0;
    for (const [server, names] of byServer) {
      if (this.started.has(server)) continue;
      this.started.add(server);
      try {
        for (const [prev, next] of morphologicalPairs(names)) {
          if (this.tools.eligibility(server, next).eligible) this.learner.prime(server, prev, next);
        }
        const openers = this.predictor.sessionStart(server);
        if (openers.length > 0) {
          this.executor.submit(openers, io);
          submitted += openers.length;
        }
      } catch {
        // Priming is best-effort.
      }
    }
    return submitted;
  }

  // -------------------------------------------------------------------------
  // Lifecycle, memory, and reporting
  // -------------------------------------------------------------------------

  private invalidate(server: string): void {
    this.cache.invalidateServer(server);
    this.executor.invalidatePending(server);
  }

  private async authorized(
    io: SpeculationIo,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      return (await io.authorize(server, tool, args)) === true;
    } catch {
      return false;
    }
  }

  /** Lazy expiry: entries past their TTL become waste events (§6.2). */
  sweep(): void {
    this.cache.sweep();
  }

  /**
   * The session ended. Reconcile the prediction funnel before the final
   * save: a session's last real call commonly emits a batch nothing will
   * claim; letting it vanish would make poor rules look artificially
   * effective.
   */
  close(): void {
    this.executor.abandonPending();
    this.cache.abandonAll();
    // What follows (a /clear, or another session in a long-lived host) is a
    // new conversation: its openers fire again and its first reads count.
    this.started.clear();
    this.openerSlots.clear();
  }

  /** Changes whenever anything worth saving changed (§13.6 dirty gate). */
  get revision(): string {
    return `${this.learner.revision}:${this.metrics.feedbackRevision}:${this.latency.revision}:${this.calibration.revision}:${this.tools.revision}`;
  }

  importMemory(state: PersistedState | null): void {
    if (!state) return;
    this.learner.importState(state.learner);
    this.metrics.importRuleFeedback(state.ruleFeedback);
    this.latency.importState(state.latency);
    this.calibration.importState(state.candidateFeedback);
    this.tools.importState(state.tools);
  }

  exportMemory(): MemorySnapshot {
    return {
      learner: this.learner.exportState(),
      ruleFeedback: this.metrics.exportRuleFeedback(),
      latency: this.latency.exportState(),
      candidateFeedback: this.calibration.exportState(),
      tools: this.tools.exportState(),
    };
  }

  /**
   * Counter growth since the last call, for the cross-session totals. Each
   * increment is reported exactly once.
   */
  usageDelta(): UsageCounters {
    const current = this.metrics.usageCounters();
    const prior = this.reportedUsage;
    this.reportedUsage = current;
    if (!prior) return current;
    const delta = { ...current };
    for (const key of Object.keys(delta) as Array<keyof UsageCounters>) {
      delta[key] = current[key] - prior[key];
    }
    return delta;
  }

  stats(): StatsReport & { cache: { ready: number; inFlight: number } } {
    return { ...this.metrics.statsSnapshot(), cache: this.cache.size() };
  }
}

/** Adds counters into stored totals; malformed stored totals start over. */
export function addUsage(stored: unknown, delta: UsageCounters): UsageCounters {
  const out = { ...delta };
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const key of Object.keys(out) as Array<keyof UsageCounters>) {
      const prior = (stored as Record<string, unknown>)[key];
      if (typeof prior === 'number' && Number.isFinite(prior) && prior >= 0) out[key] += prior;
    }
  }
  return out;
}

function noop(): void {}

function before<T>(promise: Promise<T>, deadline: Promise<unknown> | undefined): Promise<T> {
  if (!deadline) return promise;
  const expired = deadline.then(
    () => Promise.reject(new Error('join wait reached the hook deadline')),
    () => Promise.reject(new Error('join wait reached the hook deadline')),
  );
  return Promise.race([promise, expired]);
}
