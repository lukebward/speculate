/**
 * Speculation budgets and backpressure (DESIGN.md §7, §3.1).
 *
 * Speculative traffic is strictly lower priority than real traffic. Claude
 * Code does not tell a mod how it reaches a server, so the mod budgets every
 * server as stdio, the conservative case:
 * - HTTP upstreams: speculative calls use spare concurrency only
 *   (default cap 2), bounded by a per-minute sliding-window budget
 *   (default 30/min).
 * - stdio upstreams: serial transport — speculate only when the server is
 *   completely idle (no real or speculative call in flight), at most one at
 *   a time, regardless of configured concurrency.
 *
 * A stdio budget is serial only until the agent shows otherwise. When the
 * agent's own calls have been in flight on a server together, that server
 * takes calls together, and speculation may too: never more calls in flight,
 * its own and the agent's, than the agent alone has had (`concurrency`), and
 * never more than MAX_LEARNED_CONCURRENT of its own.
 */
import type { BudgetDecision, UpstreamTransport } from './types.js';

export interface ServerBudgetConfig {
  transport: UpstreamTransport;
  maxPerMinute?: number;
  maxConcurrent?: number;
}

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 30;
const DEFAULT_HTTP_MAX_CONCURRENT = 2;
/** The most speculative calls at once on a server the agent has shown takes calls together. */
export const MAX_LEARNED_CONCURRENT = 3;

interface ServerBudgetState {
  transport: UpstreamTransport;
  maxPerMinute: number;
  /** Effective cap: stdio is 1 until the agent's own calls show more (§3.1). */
  maxConcurrent: number;
  realInFlight: number;
  /** Of those, the calls that are running on the server (not answered from a prefetch). */
  serverCalls: number;
  /** The most such calls seen in flight together this session. */
  peak: number;
  specInFlight: number;
  /** Issuance timestamps of speculative calls within the sliding window. */
  issuedAt: number[];
}

export class BudgetManager {
  private readonly servers = new Map<string, ServerBudgetState>();
  private readonly now: () => number;

  private readonly defaults: ServerBudgetConfig | undefined;
  private readonly known: ((server: string) => number) | undefined;

  /**
   * `defaults`, when given, budgets any server not listed in `perServer` the
   * first time it is seen; without it an unlisted server never speculates.
   * `concurrency` answers how many of the agent's own calls a server has been
   * seen to run together in earlier sessions (1 when none).
   */
  constructor(
    perServer: Record<string, ServerBudgetConfig>,
    opts?: { now?: () => number; defaults?: ServerBudgetConfig; concurrency?: (server: string) => number },
  ) {
    this.now = opts?.now ?? Date.now;
    this.defaults = opts?.defaults;
    this.known = opts?.concurrency;
    for (const [name, cfg] of Object.entries(perServer)) this.servers.set(name, initialState(cfg));
  }

  private state(server: string): ServerBudgetState | undefined {
    let s = this.servers.get(server);
    if (s === undefined && this.defaults !== undefined) {
      s = initialState(this.defaults);
      this.servers.set(server, s);
    }
    return s;
  }

  // -- Real-traffic bookkeeping (real calls are never blocked; we only
  //    observe them so stdio speculation can stay idle-only). --------------

  /**
   * One of the agent's calls began. `onServer` is false for a call a
   * prefetched result is expected to answer: it occupies no server, so it is
   * no evidence of what the server runs together.
   */
  realStarted(server: string, onServer = true): void {
    const s = this.state(server);
    if (s === undefined) return;
    s.realInFlight++;
    if (!onServer) return;
    s.serverCalls++;
    if (s.serverCalls > s.peak) s.peak = s.serverCalls;
  }

  realFinished(server: string, onServer = true): void {
    const s = this.servers.get(server);
    if (s === undefined) return;
    if (s.realInFlight > 0) s.realInFlight--;
    if (onServer && s.serverCalls > 0) s.serverCalls--;
  }

  realInFlight(server: string): number {
    return this.servers.get(server)?.realInFlight ?? 0;
  }

  /**
   * How many of the agent's own calls this server has run together: seen this
   * session, or remembered from earlier ones. 1 means none ever overlapped.
   */
  concurrency(server: string): number {
    const seen = this.servers.get(server)?.peak ?? 1;
    return Math.max(1, seen, this.known?.(server) ?? 1);
  }

  // -- Speculative bookkeeping ---------------------------------------------

  /**
   * Atomically check budgets and, if allowed, take a concurrency slot and a
   * per-minute token. A denial consumes nothing.
   */
  tryAcquire(server: string): BudgetDecision {
    const s = this.state(server);
    if (s === undefined) return { ok: false, reason: 'unknown-server' };
    const together = s.transport === 'stdio' ? this.concurrency(server) : 1;
    if (s.transport === 'stdio' && together < 2) {
      if (s.realInFlight > 0 || s.specInFlight > 0) return { ok: false, reason: 'stdio-busy' };
    } else if (s.transport === 'stdio') {
      // The agent has run `together` calls here at once: stay within that,
      // counting its calls in flight now, and within the mod's own cap.
      if (s.serverCalls + s.specInFlight >= together || s.specInFlight >= MAX_LEARNED_CONCURRENT) {
        return { ok: false, reason: 'concurrency' };
      }
    }
    if (s.transport !== 'stdio' && s.specInFlight >= s.maxConcurrent) {
      return { ok: false, reason: 'concurrency' };
    }
    const now = this.now();
    this.prune(s, now);
    if (s.issuedAt.length >= s.maxPerMinute) {
      return { ok: false, reason: 'per-minute' };
    }
    s.specInFlight++;
    s.issuedAt.push(now);
    return { ok: true };
  }

  /** Release the concurrency slot when the speculative call settles. */
  release(server: string): void {
    const s = this.servers.get(server);
    if (s !== undefined && s.specInFlight > 0) s.specInFlight--;
  }

  specInFlight(server: string): number {
    return this.servers.get(server)?.specInFlight ?? 0;
  }

  /** Drop issuance timestamps that have slid out of the 60 s window. */
  private prune(s: ServerBudgetState, now: number): void {
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < s.issuedAt.length && s.issuedAt[drop]! <= cutoff) drop++;
    if (drop > 0) s.issuedAt.splice(0, drop);
  }
}

function initialState(cfg: ServerBudgetConfig): ServerBudgetState {
  return {
    transport: cfg.transport,
    maxPerMinute: cfg.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE,
    maxConcurrent: cfg.transport === 'stdio' ? 1 : cfg.maxConcurrent ?? DEFAULT_HTTP_MAX_CONCURRENT,
    realInFlight: 0,
    serverCalls: 0,
    peak: 0,
    specInFlight: 0,
    issuedAt: [],
  };
}
