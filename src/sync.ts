/**
 * `speculate sync` — the unattended wrap (see
 * .superpowers/specs/2026-08-02-auto-wrap-design.md).
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
import { dirname, join } from 'node:path';
import { readClaudeServers } from './hostConfig.js';
import {
  acquireManagementLock,
  effectiveServerHash,
  refreshClaudeGlobal,
  loadManagedState,
  makeCtx,
  managedKey,
  saveManagedState,
  wrapEffectiveServers,
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

/** Manual refresh visits known projects and reports failures; it never installs a hook. */
export async function speculateSyncGlobal(opts: SyncOptions): Promise<number> {
  return refreshClaudeGlobal({ ...opts, onNeedsAuth: undefined });
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
    if (peek.global?.enabled === false || peek.syncOptOut?.[ctx.cwd]) return 0;
    const seen = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
    // Fast path: no subprocess, no lock, no write.
    if (peek.syncHashes?.[ctx.cwd] === effectiveServerHash(seen)) return 0;
    const release = acquireManagementLock(opts.lockPath ?? join(dirname(ctx.statePath), 'sync.lock'));
    if (!release) return 0; // another session is syncing; next session picks it up
    try {
      // Global on/off share this lock. Re-read after acquiring it so a
      // completed global off cannot be undone by a previously started hook.
      const state = loadManagedState(ctx.statePath);
      if (state.global?.enabled === false || state.syncOptOut?.[ctx.cwd]) return 0;
      const view = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
      const record = state.projects[ctx.cwd] ?? { entries: [], updatedAt: Date.now() };
      const managed = new Map(record.entries.map((e) => [managedKey(e.scope, e.name), e]));
      const wrapped: string[] = [];
      const wrapOptions = {
        mode: opts.mode ?? state.global?.mode,
        onWrapped: (name: string) => wrapped.push(name),
        deadline: performance.now() + (opts.timeoutMs ?? DEFAULT_BUDGET_MS),
      };
      // New user registrations remain global even when a project shadows
      // the same name. Keep plugin records out of this user-only pass so
      // its narrower view cannot revoke an unrelated project's copy.
      const userManaged = new Map([...managed].filter(([, entry]) => entry.scope === 'user'));
      const userOutcome = state.global?.enabled === true
        ? await wrapEffectiveServers(ctx, { ...view, servers: view.servers.filter((s) => s.scope === 'user'), pluginServers: [] }, userManaged, wrapOptions)
        : undefined;
      if (userOutcome) for (const [key, entry] of userManaged) managed.set(key, entry);
      const outcome = await wrapEffectiveServers(ctx,
        userOutcome ? readClaudeServers({ home: ctx.home, cwd: ctx.cwd }) : view,
        managed, wrapOptions);
      if (userOutcome) {
        outcome.changed += userOutcome.changed;
        outcome.failed += userOutcome.failed;
        outcome.timedOut ||= userOutcome.timedOut;
        outcome.needsAuth.push(...userOutcome.needsAuth);
      }
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
      // Preserve updates from older project-scoped callers, which predate
      // the shared global lifecycle lock.
      const merged = loadManagedState(ctx.statePath);
      // Record originals for whatever DID get wrapped, even on a run that
      // ran out of time — that record is what makes `off`'s exact restore
      // possible. Nothing wrapped and nothing removed means nothing to
      // record: writing an empty entry list would make `status` report drift
      // "since 'speculate on'" in a project where `on` has never run.
      if (
        outcome.changed > 0 ||
        wrapped.length > 0 ||
        outcome.shadowsRemoved > 0 ||
        outcome.pluginShadowsRemoved > 0 ||
        outcome.adopted.length > 0
      ) {
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
        // The repair OVERRIDES something the user did in the host's own UI
        // (re-enabling a wrapped plugin original), so it must never happen
        // silently — this line is the only place the unattended path can say
        // so, and it names the two real opt-outs.
        if (outcome.repaired.length > 0) {
          report(
            `[speculate] re-disabled ${outcome.repaired.join(', ')}: a wrapped copy is standing in for ` +
              "it — to unwrap, disable the copy in /mcp or run 'speculate off'",
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
