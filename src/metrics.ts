/**
 * Metrics and decision log (DESIGN.md §9).
 *
 * Every speculative decision is recorded as a DecisionEvent; with
 * log === 'stderr' each event is also emitted as one JSON line on stderr —
 * never stdout, which carries the MCP stdio protocol. Counters roll up into
 * the StatsReport served by `/stats` and the session summary, including the
 * honest metric: estimated ms saved vs. wasted calls per hit.
 */
import process from 'node:process';
import type {
  DecisionEvent,
  RuleStats,
  SpeculationMode,
  StatsReport,
} from './types.js';

interface PerServerCounters {
  speculativeCalls: number;
  hits: number;
  wasted: number;
  specErrors: number;
}

interface PerRuleCounters {
  predicted: number;
  speculated: number;
  hits: number;
  wasted: number;
  suppressedByFeedback: number;
}

export class Metrics {
  private readonly mode: SpeculationMode;
  private readonly log: 'stderr' | 'off';
  private readonly now: () => number;
  private readonly startedAt: number;

  private realCalls = 0;
  private speculativeCalls = 0;
  private hits = 0;
  private joins = 0;
  private misses = 0;
  private expired = 0;
  private invalidated = 0;
  private wasted = 0;
  private parserMisses = 0;
  private estimatedSavedMs = 0;

  private readonly perServer = new Map<string, PerServerCounters>();
  private readonly perRule = new Map<string, PerRuleCounters>();

  constructor(opts: {
    mode: SpeculationMode;
    log: 'stderr' | 'off';
    now?: () => number;
  }) {
    this.mode = opts.mode;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  record(ev: DecisionEvent): void {
    const event: DecisionEvent =
      ev.timestamp === undefined ? { ...ev, timestamp: this.now() } : ev;

    if (this.log === 'stderr') {
      process.stderr.write(`${JSON.stringify({ speculate: event })}\n`);
    }

    switch (event.type) {
      case 'real_call':
        this.realCalls++;
        break;
      case 'speculated':
        this.speculativeCalls++;
        this.server(event.server).speculativeCalls++;
        if (event.ruleId !== undefined) this.rule(event.ruleId).speculated++;
        break;
      case 'hit':
        this.hits++;
        this.recordUse(event);
        break;
      case 'joined':
        this.joins++;
        this.recordUse(event);
        break;
      case 'miss':
        this.misses++;
        break;
      case 'expired':
        this.expired++;
        this.recordWaste(event);
        break;
      case 'invalidated':
        this.invalidated++;
        this.recordWaste(event);
        break;
      case 'spec_error':
        this.server(event.server).specErrors++;
        this.recordWaste(event);
        break;
      case 'parser_miss':
        this.parserMisses++;
        break;
      case 'predicted':
        if (event.ruleId !== undefined) this.rule(event.ruleId).predicted++;
        break;
      case 'suppressed':
        if (event.reason === 'feedback' && event.ruleId !== undefined) {
          this.rule(event.ruleId).suppressedByFeedback++;
        }
        break;
      default:
        // 'stdio_delay' is logged but rolls into no counter; waste is derived
        // from its terminal causes (expired / invalidated / spec_error).
        break;
    }
  }

  /** Per-rule feedback for the predictor's suppression loop (§5.6). */
  ruleFeedback(ruleId: string): {
    hits: number;
    wasted: number;
    speculated: number;
  } {
    const r = this.perRule.get(ruleId);
    return {
      hits: r?.hits ?? 0,
      wasted: r?.wasted ?? 0,
      speculated: r?.speculated ?? 0,
    };
  }

  statsSnapshot(): StatsReport {
    const used = this.hits + this.joins;
    const perServer: StatsReport['perServer'] = {};
    for (const [server, c] of this.perServer) {
      perServer[server] = { ...c };
    }
    const perRule: RuleStats[] = [...this.perRule.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ruleId, c]) => ({ ruleId, ...c }));
    return {
      mode: this.mode,
      uptimeMs: this.now() - this.startedAt,
      realCalls: this.realCalls,
      speculativeCalls: this.speculativeCalls,
      hits: this.hits,
      joins: this.joins,
      misses: this.misses,
      expired: this.expired,
      invalidated: this.invalidated,
      wasted: this.wasted,
      parserMisses: this.parserMisses,
      estimatedSavedMs: this.estimatedSavedMs,
      wastePerHit: used === 0 ? null : this.wasted / used,
      perServer,
      perRule,
    };
  }

  /** Shared bookkeeping for 'hit' and 'joined'. */
  private recordUse(event: DecisionEvent): void {
    this.estimatedSavedMs += event.savedMs ?? 0;
    this.server(event.server).hits++;
    if (event.ruleId !== undefined) this.rule(event.ruleId).hits++;
  }

  /** Shared bookkeeping for 'expired' / 'invalidated' / 'spec_error'. */
  private recordWaste(event: DecisionEvent): void {
    this.wasted++;
    this.server(event.server).wasted++;
    if (event.ruleId !== undefined) this.rule(event.ruleId).wasted++;
  }

  private server(name: string): PerServerCounters {
    let c = this.perServer.get(name);
    if (c === undefined) {
      c = { speculativeCalls: 0, hits: 0, wasted: 0, specErrors: 0 };
      this.perServer.set(name, c);
    }
    return c;
  }

  private rule(ruleId: string): PerRuleCounters {
    let c = this.perRule.get(ruleId);
    if (c === undefined) {
      c = {
        predicted: 0,
        speculated: 0,
        hits: 0,
        wasted: 0,
        suppressedByFeedback: 0,
      };
      this.perRule.set(ruleId, c);
    }
    return c;
  }
}
