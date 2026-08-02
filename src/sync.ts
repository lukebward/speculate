/**
 * `speculate sync` — the unattended wrap (see
 * docs/superpowers/specs/2026-08-02-auto-wrap-design.md).
 *
 * Same wrap as `speculate on`, through the same front door, with the same
 * consent gates — but run by the auto-wrap plugin's SessionStart hook rather
 * than by a person, so it obeys three extra rules:
 *
 *   - Fail-open and silent. Every error path returns 0 with no output: a
 *     session start must never be blocked, and must never be sprayed with
 *     diagnostics. Diagnosis stays with `speculate status`.
 *   - Near-zero cost when nothing changed. The stored per-project hash of
 *     the effective server set is checked BEFORE anything spawns, so the
 *     common case is a couple of file reads and nothing else.
 *   - Never a decision. No legacy cleanup, no plugin install, no prompts.
 *
 * One thing it cannot do is take effect immediately: Claude Code snapshots
 * MCP config BEFORE running SessionStart hooks, so a wrap done here lands in
 * the NEXT session. That one-session lag is inherent (measured, not assumed),
 * which is why the summary line says so out loud.
 */
import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readClaudeServers } from './hostConfig.js';
import {
  effectiveServerHash,
  loadManagedState,
  makeCtx,
  managedKey,
  saveManagedState,
  wrapEffectiveServers,
  type Ctx,
  type ManageOptions,
} from './manage.js';

export interface SyncOptions extends ManageOptions {
  /**
   * Cap on the wrap phase (the only part that spawns subprocesses). Expiry
   * is treated as success — a slow day must never cost a session — and the
   * stored hash is left alone so the next session retries. The CLI also
   * applies a hard process-level cap on top of this.
   */
  timeoutMs?: number;
  lockPath?: string;
}

/**
 * A lock older than this belonged to a session that died mid-sync (the CLI's
 * hard cap can kill one at 5s). Generous enough that a live-but-slow run is
 * never trampled, short enough that a crash costs at most one more session.
 */
const LOCK_STALE_MS = 30_000;

/**
 * Concurrent sessions all read-modify-write the same global `~/.claude.json`
 * through `claude mcp add-json`, so one lock per HOST (next to the managed
 * state, which is likewise host-wide) is the right granularity — not one per
 * project.
 */
function defaultLockPath(ctx: Ctx): string {
  return join(dirname(ctx.statePath), 'sync.lock');
}

/**
 * Exclusive-create lock. Returns a release function, or null when another
 * live session holds it — in which case this run simply exits: the work is
 * picked up by the next session, which costs nothing given the wrap is
 * already one session behind.
 */
function acquireLock(path: string): (() => void) | null {
  try {
    // Same 0o700 the state directory is created with elsewhere: the lock
    // usually creates it first, and must not leave it more permissive.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age < LOCK_STALE_MS) return null; // a live session holds it
      writeFileSync(path, String(process.pid), { mode: 0o600 }); // stale: take it over
    }
    return () => {
      try {
        unlinkSync(path);
      } catch {
        // already gone (a takeover, or a cleaned-up temp dir) — fine
      }
    };
  } catch {
    return null;
  }
}

/** Resolves to the promise's value, or null if `ms` elapses (or it rejects). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolveRace) => {
    const timer = setTimeout(() => resolveRace(null), ms);
    timer.unref?.();
    const settle = (value: T | null): void => {
      clearTimeout(timer);
      resolveRace(value);
    };
    promise.then(settle, () => settle(null));
  });
}

/** Always resolves 0. Silent unless it wrapped something. */
export async function speculateSync(opts: SyncOptions): Promise<number> {
  // `makeCtx` defaults `log` to a stderr write, and `wrapEffectiveServers`
  // logs one line per server. A session-start hook must not spray that into
  // the user's terminal, so the ctx logger is silenced and `sync` emits only
  // its own one-line summary through `report`.
  const report = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const ctx = makeCtx({ ...opts, log: () => {} });
    const state = loadManagedState(ctx.statePath);
    // `off` opted this project out; the global hook must not undo that.
    if (state.syncOptOut?.[ctx.cwd]) return 0;
    const view = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
    const hash = effectiveServerHash(view);
    if (state.syncHashes?.[ctx.cwd] === hash) return 0; // fast path: no subprocess
    const release = acquireLock(opts.lockPath ?? defaultLockPath(ctx));
    if (!release) return 0; // another session is syncing; next session picks it up
    try {
      const record = state.projects[ctx.cwd] ?? { entries: [], updatedAt: Date.now() };
      const managed = new Map(record.entries.map((e) => [managedKey(e.scope, e.name), e]));
      const wrapped: string[] = [];
      const wrapping = wrapEffectiveServers(ctx, view, managed, {
        mode: opts.mode ?? undefined,
        onWrapped: (name) => wrapped.push(name),
      });
      const outcome =
        opts.timeoutMs === undefined ? await wrapping : await withDeadline(wrapping, opts.timeoutMs);
      // Record originals for whatever DID get wrapped, even on a run that
      // ran out of time — that record is what makes `off`'s exact restore
      // possible. Nothing wrapped means nothing to record: writing an empty
      // entry list here would make `status` report drift "since 'speculate
      // on'" in a project where `on` has never run.
      if (wrapped.length > 0) {
        state.projects[ctx.cwd] = { entries: [...managed.values()], updatedAt: Date.now() };
      }
      // Only a pass that COMPLETED and wrapped everything it could may claim
      // "nothing has changed since this hash". A failure usually leaves the
      // config exactly as it found it (the wrap path restores the original),
      // so storing the hash anyway would make every later session take the
      // fast path and never retry that server — a transient `claude mcp`
      // failure would silently become permanent. Leaving the previous hash
      // in place costs one retry per session until it succeeds. A run that
      // ran out of time is the same case: unfinished, so no claim.
      if (outcome && outcome.failed === 0) {
        // Recomputed from the config AS IT NOW STANDS: storing the pre-wrap
        // hash would make the very next session sync all over again.
        state.syncHashes = {
          ...(state.syncHashes ?? {}),
          [ctx.cwd]: effectiveServerHash(readClaudeServers({ home: ctx.home, cwd: ctx.cwd })),
        };
      }
      saveManagedState(ctx.statePath, state);
      if (outcome && wrapped.length > 0 && outcome.failed === 0) {
        report(
          `[speculate] wrapped ${wrapped.length} new server${wrapped.length > 1 ? 's' : ''} ` +
            `(${wrapped.join(', ')}); speculation active next session`,
        );
      }
    } finally {
      release();
    }
    return 0;
  } catch {
    return 0; // fail-open: never block a session start
  }
}
