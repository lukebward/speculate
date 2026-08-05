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
   * Budget for the wrap phase (the only part that spawns subprocesses),
   * default DEFAULT_BUDGET_MS. It is COOPERATIVE: `wrapEffectiveServers`
   * checks it between servers, so a wrap is never cut in half. Running out
   * is treated as success — a slow day must never cost a session — but not
   * as completion: the stored hash is left alone so the next session picks
   * up whatever was left.
   */
  timeoutMs?: number;
  lockPath?: string;
}

/**
 * What a session start can afford to wait for. Hooks are synchronous, so
 * this is time the user spends staring at a prompt that hasn't appeared.
 */
const DEFAULT_BUDGET_MS = 5_000;

/**
 * A lock older than this belonged to a session that died mid-sync (the CLI's
 * last-resort cap kills one at 120s, and the host's own hook timeout at 150s).
 * It MUST exceed both: a holder that legitimately runs to either would
 * otherwise look stale to a second session, which would seize the lock and
 * write concurrently — the exact race the lock exists to prevent. Short enough
 * that a crash still costs at most one more session.
 */
const LOCK_STALE_MS = 180_000;

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

/** Always resolves 0. Silent unless it actually changed something. */
export async function speculateSync(opts: SyncOptions): Promise<number> {
  // `makeCtx` defaults `log` to a stderr write, and `wrapEffectiveServers`
  // logs one line per server. A session-start hook must not spray that into
  // the user's terminal, so the ctx logger is silenced and `sync` emits only
  // its own summary through `report`: a handful of lines at most — wraps,
  // .mcp.json shadows removed, plugin copies removed, and the needs-auth
  // notice — each gated on something actually changing. The hook wrapper
  // (plugin/hooks/autowrap.mjs) forwards every line it is given, not just
  // the last — dropping one was a real bug.
  const report = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const ctx = makeCtx({ ...opts, log: () => {} });
    const peek = loadManagedState(ctx.statePath);
    // `off` opted this project out; the global hook must not undo that.
    if (peek.syncOptOut?.[ctx.cwd]) return 0;
    const seen = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
    // Fast path: no subprocess, no lock, no write.
    if (peek.syncHashes?.[ctx.cwd] === effectiveServerHash(seen)) return 0;
    const release = acquireLock(opts.lockPath ?? defaultLockPath(ctx));
    if (!release) return 0; // another session is syncing; next session picks it up
    try {
      // Re-read everything under the lock. `on` and `off` don't take it (they
      // are interactive and rare), so a concurrent one may have changed both
      // the state and the config since the fast-path peek — and this run ends
      // by WRITING the state back, which would otherwise clobber, say, the
      // opt-out `off` just recorded.
      const state = loadManagedState(ctx.statePath);
      if (state.syncOptOut?.[ctx.cwd]) return 0;
      const view = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
      const record = state.projects[ctx.cwd] ?? { entries: [], updatedAt: Date.now() };
      const managed = new Map(record.entries.map((e) => [managedKey(e.scope, e.name), e]));
      const wrapped: string[] = [];
      const outcome = await wrapEffectiveServers(ctx, view, managed, {
        mode: opts.mode ?? undefined,
        onWrapped: (name) => wrapped.push(name),
        deadline: performance.now() + (opts.timeoutMs ?? DEFAULT_BUDGET_MS),
      });
      // Only a pass that COMPLETED and wrapped everything it could may claim
      // "nothing has changed since this hash". A failure usually leaves the
      // config exactly as it found it (the wrap path restores the original),
      // so storing the hash anyway would make every later session take the
      // fast path and never retry that server — a transient `claude mcp`
      // failure would silently become permanent. Leaving the previous hash
      // in place costs one retry per session until it succeeds. A run that
      // ran out of time is the same case: unfinished, so no claim.
      const nextHash =
        outcome.failed === 0 && !outcome.timedOut
          ? // Recomputed from the config AS IT NOW STANDS: storing the pre-wrap
            // hash would make the very next session sync all over again.
            effectiveServerHash(readClaudeServers({ home: ctx.home, cwd: ctx.cwd }))
          : null;
      // Read-merge-write, not write-back. `on` and `off` never take this lock
      // (they are interactive; blocking a person on a background hook would
      // be worse than the race), so the state on disk may have moved since
      // the load above — a concurrent `off` in ANOTHER project records its
      // opt-out and deletes its project record. Writing this run's whole
      // in-memory copy back reverted both, so the project the user had just
      // turned off was re-wrapped at its next session start. Re-read now and
      // touch only the two keys that belong to THIS project.
      const merged = loadManagedState(ctx.statePath);
      // Record originals for whatever DID get wrapped, even on a run that
      // ran out of time — that record is what makes `off`'s exact restore
      // possible. Nothing wrapped and nothing removed means nothing to
      // record: writing an empty entry list would make `status` report drift
      // "since 'speculate on'" in a project where `on` has never run.
      if (wrapped.length > 0 || outcome.shadowsRemoved > 0 || outcome.pluginShadowsRemoved > 0) {
        const entries = [...managed.values()];
        if (entries.length > 0) merged.projects[ctx.cwd] = { entries, updatedAt: Date.now() };
        else delete merged.projects[ctx.cwd];
      }
      if (nextHash !== null) {
        merged.syncHashes = { ...(merged.syncHashes ?? {}), [ctx.cwd]: nextHash };
      }
      saveManagedState(ctx.statePath, merged);
      // Report what really happened, including on a run that ran out of
      // time: those servers ARE wrapped, and they do take effect next
      // session. The rest are simply the next run's work.
      //
      // Both lines carry the SAME gate. A pass with failures says nothing at
      // all — a half-failed run is a bug report, not a status line, and
      // `speculate status` is where diagnosis lives — so reporting the
      // removals while swallowing the wraps would be the one shape that
      // makes a bad run look tidy.
      if (outcome.failed === 0) {
        if (wrapped.length > 0) {
          report(
            `[speculate] wrapped ${wrapped.length} new server${wrapped.length > 1 ? 's' : ''} ` +
              `(${wrapped.join(', ')}); speculation active next session`,
          );
        }
        // Consent moving the other way is the one other thing worth a line:
        // it takes a running server away, and silence there would look like
        // Speculate had ignored the revoke (or the deletion).
        if (outcome.shadowsRemoved > 0) {
          report(
            `[speculate] removed ${outcome.shadowsRemoved} wrapped .mcp.json shadow` +
              `${outcome.shadowsRemoved > 1 ? 's' : ''} ` +
              '(approval revoked, or the server is gone from .mcp.json)',
          );
        }
        // Same consent-moving-the-other-way rule as the .mcp.json line: a
        // wrapped plugin copy going away takes a running server shape with
        // it, and silence would look like Speculate ignored the change.
        if (outcome.pluginShadowsRemoved > 0) {
          report(
            `[speculate] removed ${outcome.pluginShadowsRemoved} wrapped plugin ` +
              `${outcome.pluginShadowsRemoved > 1 ? 'copies' : 'copy'} ` +
              '(plugin gone or disabled, or the wrap was opted out in Claude Code)',
          );
        }
        // The one thing the automatic path cannot do for you. Worth a line
        // BECAUSE this path is otherwise silent: a user who adds an
        // OAuth-protected server would otherwise get prefetching on
        // everything except the server that would benefit most, and never
        // learn that one command fixes it.
        //
        // Said once, not every session: the hash gate above means this whole
        // block is only reached when the effective server set changed, so
        // this is a notification rather than a nag. Never interactive here —
        // a session-start hook must not open a browser.
        if (outcome.needsAuth.length > 0) {
          const names = outcome.needsAuth.map((s) => s.name).join(', ');
          report(
            `[speculate] ${names}: needs a login before it can be sped up — run 'speculate auth'`,
          );
        }
      }
    } finally {
      release();
    }
    return 0;
  } catch {
    return 0; // fail-open: never block a session start
  }
}
