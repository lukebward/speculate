/**
 * Byte-result cache for CLI speculation (DESIGN.md §13.12).
 *
 * Same semantics as the MCP speculation buffer (§6): entries are
 * single-use, short-TTL, memory-only, and a real call may join an
 * in-flight speculative execution. Invalidation dooms in-flight work via
 * a generation stamp — a speculative run that started before a flush can
 * never deposit its (possibly stale) result after it.
 */
export interface ExecOutcome {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
  durationMs: number;
}

export type ExecLookup =
  | { kind: 'hit'; outcome: ExecOutcome }
  | { kind: 'join'; promise: Promise<ExecOutcome | null>; issuedAt: number }
  | { kind: 'miss' };

interface ReadyEntry {
  outcome: ExecOutcome;
  expiresAt: number;
}

interface InFlightEntry {
  promise: Promise<ExecOutcome | null>;
  issuedAt: number;
}

export class ExecCache {
  private readonly ready = new Map<string, ReadyEntry>();
  private readonly inflight = new Map<string, InFlightEntry>();
  private readonly now: () => number;
  private readonly onWaste?: () => void;
  private generation = 0;
  /** Speculative results produced but never served. */
  wasted = 0;

  constructor(opts: { now?: () => number; onWaste?: () => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.onWaste = opts.onWaste;
  }

  lookup(key: string): ExecLookup {
    const entry = this.ready.get(key);
    if (entry) {
      this.ready.delete(key); // single-use, hit or expired
      if (entry.expiresAt > this.now()) return { kind: 'hit', outcome: entry.outcome };
      this.recordWaste();
    }
    const inFlight = this.inflight.get(key);
    if (inFlight) return { kind: 'join', promise: inFlight.promise, issuedAt: inFlight.issuedAt };
    return { kind: 'miss' };
  }

  /** Fresh-or-in-flight — the prefetcher's dedupe check. */
  has(key: string): boolean {
    const entry = this.ready.get(key);
    if (entry && entry.expiresAt > this.now()) return true;
    return this.inflight.has(key);
  }

  /**
   * Register a speculative execution. `exec` failures (spawn errors,
   * timeouts, output overflow) drop the entry — a legitimate non-zero
   * exit is a valid outcome and caches normally (the exec fn decides
   * which is which by resolving vs rejecting).
   */
  beginSpeculative(key: string, ttlMs: number, exec: () => Promise<ExecOutcome>): void {
    if (this.has(key)) return;
    const gen = this.generation;
    const issuedAt = this.now();
    const promise = exec().then(
      (outcome) => {
        this.inflight.delete(key);
        if (gen === this.generation) {
          this.ready.set(key, { outcome, expiresAt: this.now() + ttlMs });
        } else {
          this.recordWaste(); // finished after a flush: stale by definition
        }
        return outcome;
      },
      () => {
        this.inflight.delete(key);
        this.recordWaste();
        return null;
      },
    );
    this.inflight.set(key, { promise, issuedAt });
  }

  /** Workspace changed (or a mutation ran): everything staged is stale. */
  invalidateAll(): void {
    this.generation++;
    this.recordWaste(this.ready.size);
    this.ready.clear();
    // Joining a pre-flush in-flight run would serve stale bytes: drop the
    // handles; the doomed runs discard themselves via the generation stamp.
    this.inflight.clear();
  }

  /** Expire old entries so `wasted` reflects reality between lookups. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.ready) {
      if (entry.expiresAt <= now) {
        this.ready.delete(key);
        this.recordWaste();
      }
    }
  }

  size(): { ready: number; inFlight: number } {
    return { ready: this.ready.size, inFlight: this.inflight.size };
  }

  private recordWaste(count = 1): void {
    if (count === 0) return;
    this.wasted += count;
    try {
      this.onWaste?.();
    } catch {}
  }
}
