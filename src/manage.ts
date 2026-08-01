/**
 * `speculate on` / `off` / `status` — persistent activation through the
 * host's front door (DESIGN.md §13.12).
 *
 * `on` never hand-edits a config file. Every mutation goes through
 * `claude mcp remove` / `claude mcp add-json`, the host's own supported
 * interface, scoped per project (run it where you work):
 *
 *   - user/local-scope servers are re-registered wrapped, IN PLACE, with
 *     the original entry recorded for exact restore;
 *   - project-scope servers (.mcp.json — often checked in and shared)
 *     are never touched: a wrapped copy is registered at local scope,
 *     which shadows them (local > project, verified). The host prints a
 *     benign "conflicting scopes" diagnostic for shadows; local wins.
 *
 * Both `on` and `off` also run cleanupLegacyArtifacts(), which removes
 * whatever a ≤0.10 install left behind (the Claude Code plugin and the
 * bundled workspace shell server) — CLI speculation was retired in 0.11.
 *
 * `off` reverses exactly what `on` did, using the state file when
 * present — and, because wrapped entries are self-describing (the
 * original command line survives after the `--`), it can also unwrap
 * in place with no state at all.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  WORKSPACE_SERVER_NAME,
  effectiveServers,
  isStdioEntry,
  isWrappedEntry,
  readClaudeServers,
  unwrapEntry,
  wrapEntry,
  type ClaudeConfigView,
  type ClaudeScope,
  type McpServerEntry,
} from './hostConfig.js';

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CmdRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>;

export const execFileRunner: CmdRunner = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number | string }) | null;
        if (anyErr && typeof anyErr.code !== 'number') {
          // Spawn-level failure (ENOENT, timeout): surface as 127-ish.
          resolvePromise({ code: 127, stdout: stdout ?? '', stderr: anyErr.message });
          return;
        }
        resolvePromise({
          code: typeof anyErr?.code === 'number' ? anyErr.code : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });

// -- managed-state file ---------------------------------------------------------

export interface ManagedEntry {
  name: string;
  scope: ClaudeScope;
  /** 'plugin' = the Claude Code plugin `on` installed at local scope. */
  action: 'rewrote' | 'shadowed' | 'added' | 'plugin';
  original?: McpServerEntry;
}

interface ManagedState {
  version: 1;
  projects: Record<string, { entries: ManagedEntry[]; updatedAt: number }>;
  /**
   * ≤0.10 only: true when that host's `on` run added the (host-global)
   * plugin marketplace registration itself, as opposed to finding one
   * already there. 0.11 never sets this — `on` no longer installs the
   * plugin — but it's read tolerantly from old state files so cleanup never
   * removes a marketplace registration it doesn't know it owns.
   */
  marketplaceAddedByOn?: boolean;
}

function readMarketplaceAddedByOn(state: ManagedState): boolean {
  return (state as { marketplaceAddedByOn?: unknown }).marketplaceAddedByOn === true;
}

/** One human-readable record of everything `on` created, all projects. */
export function managedStatePath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome =
    xdg && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state');
  return join(stateHome, 'speculate', 'managed.json');
}

function loadManagedState(path: string): ManagedState {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as ManagedState;
    if (data && typeof data === 'object' && data.version === 1 && data.projects) {
      return data;
    }
  } catch {
    // missing/corrupt → empty; `off` still works via self-describing entries
  }
  return { version: 1, projects: {} };
}

function saveManagedState(path: string, state: ManagedState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// -- the claude mcp front door ---------------------------------------------------

interface Ctx {
  home: string;
  cwd: string;
  self: { command: string; args: string[] };
  runner: CmdRunner;
  claudeBin: string;
  statePath: string;
  log: (line: string) => void;
}

async function mcpAddJson(
  ctx: Ctx,
  name: string,
  entry: McpServerEntry,
  scope: ClaudeScope,
): Promise<CmdResult> {
  return ctx.runner(
    ctx.claudeBin,
    ['mcp', 'add-json', name, JSON.stringify(entry), '-s', scope],
    { cwd: ctx.cwd },
  );
}

async function mcpRemove(ctx: Ctx, name: string, scope: ClaudeScope): Promise<CmdResult> {
  return ctx.runner(ctx.claudeBin, ['mcp', 'remove', name, '-s', scope], { cwd: ctx.cwd });
}

export interface ManageOptions {
  home?: string;
  cwd?: string;
  self: { command: string; args: string[] };
  runner?: CmdRunner;
  claudeBin?: string;
  statePath?: string;
  log?: (line: string) => void;
  mode?: 'strict' | 'annotated' | 'off' | null;
}

function makeCtx(opts: ManageOptions): Ctx {
  return {
    home: opts.home ?? homedir(),
    cwd: resolve(opts.cwd ?? process.cwd()),
    self: opts.self,
    runner: opts.runner ?? execFileRunner,
    claudeBin: opts.claudeBin ?? process.env.SPECULATE_CLAUDE_BIN ?? 'claude',
    statePath: opts.statePath ?? managedStatePath(),
    log: opts.log ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

/** True when the front door exists at all (clear error beats N failures). */
async function frontDoorAvailable(ctx: Ctx): Promise<boolean> {
  const probe = await ctx.runner(ctx.claudeBin, ['mcp', 'list', '--help'], { cwd: ctx.cwd });
  return probe.code === 0;
}

// -- legacy artifact cleanup (≤0.10 plugin + workspace server) -------------------

/**
 * IDs a ≤0.10 install may have registered the plugin under. 0.10's own
 * PLUGIN_ID was the fully-qualified `speculate@speculate`; try that first,
 * then fall back to the bare marketplace-less name some hosts also accept.
 */
const LEGACY_PLUGIN_IDS = ['speculate@speculate', 'speculate'] as const;

/** The `claude plugin uninstall` invocation(s), shared by cleanup and off()'s fallback. */
async function runLegacyPluginUninstall(ctx: Ctx): Promise<{ res: CmdResult; id: string }> {
  let last: { res: CmdResult; id: string } = {
    res: { code: 1, stdout: '', stderr: 'no id attempted' },
    id: LEGACY_PLUGIN_IDS[0],
  };
  for (const id of LEGACY_PLUGIN_IDS) {
    const res = await ctx.runner(ctx.claudeBin, ['plugin', 'uninstall', '-s', 'local', id], {
      cwd: ctx.cwd,
    });
    last = { res, id };
    if (res.code === 0) break;
  }
  return last;
}

/** Detect a still-installed legacy plugin via `claude plugin list --json`; fail-soft. */
async function detectLegacyPlugin(ctx: Ctx): Promise<boolean> {
  try {
    const list = await ctx.runner(ctx.claudeBin, ['plugin', 'list', '--json'], { cwd: ctx.cwd });
    // Match a bare `"speculate"` name field AND a `speculate@...` id (e.g.
    // `speculate@speculate`) — hosts differ in which field they populate.
    return (
      list.code === 0 &&
      (list.stdout.includes('"speculate"') || list.stdout.includes('speculate@'))
    );
  } catch {
    return false;
  }
}

/**
 * Remove artifacts a ≤0.10 install left behind (plugin, workspace server).
 *
 * Returns whether the plugin was confirmed uninstalled here, and whether an
 * uninstall was attempted at all, so callers with their own record of a
 * legacy plugin install (off()'s `action: 'plugin'` state entries) know
 * whether they still need to try themselves — detection can miss (older
 * hosts with no `claude plugin` CLI at all, or a plugin id shape this
 * substring check doesn't recognize), and a recorded install must never be
 * silently dropped just because detection missed. When an attempt was made
 * here and it failed, callers should also skip a duplicate attempt (it would
 * just fail again) but still count the failure — see off() below. The same
 * shape (removed-here vs attempted-here) is reported for the workspace
 * server, so off()'s per-entry handling of a legacy `speculate-workspace`
 * record never re-attempts a removal this function already ran.
 */
export async function cleanupLegacyArtifacts(
  ctx: Ctx,
  view: ClaudeConfigView,
  opts: { marketplaceAddedByOn: boolean } = { marketplaceAddedByOn: false },
): Promise<{
  pluginUninstalled: boolean;
  pluginUninstallAttempted: boolean;
  workspaceServerRemoved: boolean;
  workspaceServerRemovalAttempted: boolean;
}> {
  let workspaceServerRemoved = false;
  let workspaceServerRemovalAttempted = false;
  if (effectiveServers(view.servers).has(WORKSPACE_SERVER_NAME)) {
    workspaceServerRemovalAttempted = true;
    const res = await ctx.runner(
      ctx.claudeBin,
      ['mcp', 'remove', WORKSPACE_SERVER_NAME, '-s', 'local'],
      { cwd: ctx.cwd },
    );
    workspaceServerRemoved = res.code === 0;
    ctx.log(
      res.code === 0
        ? `[speculate] legacy: removed ${WORKSPACE_SERVER_NAME} (CLI speculation was retired in 0.11)`
        : `[speculate] legacy: could not remove ${WORKSPACE_SERVER_NAME}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  const detected = await detectLegacyPlugin(ctx);
  if (!detected) {
    return {
      pluginUninstalled: false,
      pluginUninstallAttempted: false,
      workspaceServerRemoved,
      workspaceServerRemovalAttempted,
    };
  }
  const { res: un, id } = await runLegacyPluginUninstall(ctx);
  ctx.log(
    un.code === 0
      ? '[speculate] legacy: uninstalled the speculate plugin (Bash hook retired in 0.11)'
      : `[speculate] legacy: plugin uninstall failed (tried ${id}) — remove manually: ${ctx.claudeBin} plugin uninstall -s local ${id}`,
  );
  // The marketplace registration is host-global, not per-project — only
  // remove it when this project's own ≤0.10 state recorded that its `on`
  // was the one that added it. Otherwise it may belong to another project,
  // or the user added it by hand, and it's not ours to take.
  if (un.code === 0 && opts.marketplaceAddedByOn) {
    const rm = await ctx.runner(ctx.claudeBin, ['plugin', 'marketplace', 'remove', 'speculate'], {
      cwd: ctx.cwd,
    });
    ctx.log(
      rm.code === 0
        ? '[speculate] legacy: removed the speculate marketplace registration'
        : `[speculate] legacy: could not remove the speculate marketplace registration: ${(rm.stderr || rm.stdout).trim()}`,
    );
  }
  return {
    pluginUninstalled: un.code === 0,
    pluginUninstallAttempted: true,
    workspaceServerRemoved,
    workspaceServerRemovalAttempted,
  };
}

// -- on ---------------------------------------------------------------------------

export async function speculateOn(opts: ManageOptions): Promise<number> {
  const ctx = makeCtx(opts);
  if (!(await frontDoorAvailable(ctx))) {
    ctx.log(
      `[speculate] cannot run '${ctx.claudeBin} mcp' — is Claude Code installed and on PATH?`,
    );
    return 1;
  }
  const view = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
  for (const w of view.warnings) ctx.log(`[speculate] warning: ${w}`);
  const state = loadManagedState(ctx.statePath);
  const record = state.projects[ctx.cwd] ?? { entries: [], updatedAt: Date.now() };
  try {
    await cleanupLegacyArtifacts(ctx, view, {
      marketplaceAddedByOn: readMarketplaceAddedByOn(state),
    });
  } catch (err) {
    ctx.log(`[speculate] legacy cleanup failed: ${(err as Error).message}`);
  }
  // ≤0.10 entries never belong in 0.11 state: cleanupLegacyArtifacts (above)
  // already removed the workspace server and/or plugin from the HOST, so
  // writing their managed.json records back would make `off` chase
  // already-clean artifacts next time (spurious "remove failed").
  const managed = new Map(
    record.entries
      .filter((e) => e.name !== WORKSPACE_SERVER_NAME && e.action !== 'plugin')
      .map((e) => [e.name, e]),
  );
  let changed = 0;
  let failed = 0;

  for (const [name, scoped] of effectiveServers(view.servers)) {
    if (name === WORKSPACE_SERVER_NAME) continue;
    if (name.startsWith('-')) {
      // `claude mcp remove/add-json` take the name positionally; a leading
      // dash would be parsed as an option. Leave such servers untouched.
      ctx.log(`[speculate] ${name}: skipped (name starts with '-')`);
      continue;
    }
    if (isWrappedEntry(scoped.entry)) {
      ctx.log(`[speculate] ${name}: already wrapped — skipping`);
      continue;
    }
    if (!isStdioEntry(scoped.entry)) {
      ctx.log(`[speculate] ${name}: ${scoped.entry.url ? 'http/sse' : 'non-stdio'} — passed through unwrapped`);
      continue;
    }
    const wrapped = wrapEntry(scoped.entry, ctx.self, { mode: opts.mode ?? undefined });

    if (scoped.scope === 'project') {
      // Never touch the checked-in file; shadow at local scope instead —
      // but only for servers the user has already approved in Claude Code.
      // When approval state is unknown (a fresh clone, or the host's
      // enabled/disabled lists are empty — the COMMON case), the safe
      // default is to leave it pending, exactly as `try` does. Wrapping it
      // would register it at local scope, where it runs with no approval
      // gate at all: that would widen consent, which Speculate never does.
      if (!view.approvedProjectServers.has(name)) {
        ctx.log(`[speculate] ${name}: .mcp.json server not approved in Claude Code — skipping`);
        continue;
      }
      const res = await mcpAddJson(ctx, name, wrapped, 'local');
      if (res.code !== 0) {
        ctx.log(`[speculate] ${name}: shadow failed: ${(res.stderr || res.stdout).trim()}`);
        failed++;
        continue;
      }
      managed.set(name, { name, scope: 'local', action: 'shadowed' });
      ctx.log(`[speculate] ${name}: wrapped via local shadow (.mcp.json untouched; local wins)`);
      changed++;
      continue;
    }

    // user/local scope: re-register wrapped in place, original recorded.
    const removed = await mcpRemove(ctx, name, scoped.scope);
    if (removed.code !== 0) {
      ctx.log(`[speculate] ${name}: remove failed: ${(removed.stderr || removed.stdout).trim()}`);
      failed++;
      continue;
    }
    const added = await mcpAddJson(ctx, name, wrapped, scoped.scope);
    if (added.code !== 0) {
      // Put the original back rather than leave the server missing.
      const restored = await mcpAddJson(ctx, name, scoped.entry, scoped.scope);
      ctx.log(
        `[speculate] ${name}: wrap failed (${(added.stderr || added.stdout).trim()}); ` +
          (restored.code === 0
            ? 'original restored'
            : `RESTORE ALSO FAILED — re-add manually: claude mcp add-json ${name} '${JSON.stringify(scoped.entry)}' -s ${scoped.scope}`),
      );
      failed++;
      continue;
    }
    managed.set(name, { name, scope: scoped.scope, action: 'rewrote', original: scoped.entry });
    ctx.log(`[speculate] ${name}: wrapped (${scoped.scope} scope)`);
    changed++;
  }

  state.projects[ctx.cwd] = { entries: [...managed.values()], updatedAt: Date.now() };
  saveManagedState(ctx.statePath, state);
  ctx.log(
    `[speculate] on: ${changed} change(s)${failed ? `, ${failed} failure(s)` : ''}. Undo anytime with 'speculate off'.`,
  );
  return failed > 0 ? 1 : 0;
}

// -- off --------------------------------------------------------------------------

export async function speculateOff(opts: ManageOptions): Promise<number> {
  const ctx = makeCtx(opts);
  if (!(await frontDoorAvailable(ctx))) {
    ctx.log(
      `[speculate] cannot run '${ctx.claudeBin} mcp' — is Claude Code installed and on PATH?`,
    );
    return 1;
  }
  const preView = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
  const state = loadManagedState(ctx.statePath);
  const record = state.projects[ctx.cwd];
  let legacyCleanup: {
    pluginUninstalled: boolean;
    pluginUninstallAttempted: boolean;
    workspaceServerRemoved: boolean;
    workspaceServerRemovalAttempted: boolean;
  } = {
    pluginUninstalled: false,
    pluginUninstallAttempted: false,
    workspaceServerRemoved: false,
    workspaceServerRemovalAttempted: false,
  };
  try {
    legacyCleanup = await cleanupLegacyArtifacts(ctx, preView, {
      marketplaceAddedByOn: readMarketplaceAddedByOn(state),
    });
  } catch (err) {
    ctx.log(`[speculate] legacy cleanup failed: ${(err as Error).message}`);
  }
  let failed = 0;
  const handled = new Set<string>();

  for (const entry of record?.entries ?? []) {
    handled.add(entry.name);
    if (entry.name === WORKSPACE_SERVER_NAME) {
      // Legacy (≤0.10) record for the retired workspace server.
      // cleanupLegacyArtifacts (above) already removed it from the HOST if
      // it was still there — don't chase an already-clean host (that just
      // produces a spurious "remove failed" and a wrong exit code).
      if (legacyCleanup.workspaceServerRemoved) {
        // already confirmed removed — nothing more to do.
      } else if (legacyCleanup.workspaceServerRemovalAttempted) {
        // cleanup tried and failed — already logged; count it once.
        failed++;
      } else {
        // cleanup never saw it in the host view (already gone before this
        // run, or an older host with no `claude mcp` visibility of it) —
        // attempt directly, but "no such server" here means someone (or a
        // previous run) already cleaned up: that's success, not failure.
        const res = await mcpRemove(ctx, entry.name, entry.scope);
        if (res.code === 0) {
          ctx.log(`[speculate] ${entry.name}: removed`);
        } else if (!/no\s+(mcp\s+)?server/i.test(res.stderr || res.stdout)) {
          ctx.log(`[speculate] ${entry.name}: remove failed: ${(res.stderr || res.stdout).trim()}`);
          failed++;
        }
      }
      continue;
    }
    if (entry.action === 'plugin') {
      // Legacy (≤0.10) record. cleanupLegacyArtifacts (above) already
      // uninstalled the plugin if its detection fired — don't double up.
      // If it detected the plugin but the uninstall itself failed, don't
      // retry here either: it already logged one honest failure line, and
      // retrying would just fail again with a near-identical second line —
      // count the failure without repeating the attempt. Only when cleanup
      // never got to try (detection can miss: older host with no `claude
      // plugin` CLI, or a plugin id shape it doesn't recognize) does a
      // recorded install need a direct attempt here, so it's never silently
      // dropped.
      if (legacyCleanup.pluginUninstalled) {
        // already confirmed removed — nothing more to do.
      } else if (legacyCleanup.pluginUninstallAttempted) {
        failed++;
      } else {
        const { res, id } = await runLegacyPluginUninstall(ctx);
        if (res.code !== 0) {
          ctx.log(
            `[speculate] plugin: uninstall failed: ${(res.stderr || res.stdout).trim()} — remove manually: ${ctx.claudeBin} plugin uninstall -s local ${id}`,
          );
          failed++;
        } else {
          ctx.log('[speculate] plugin: uninstalled (this project)');
        }
      }
      continue;
    }
    if (entry.action === 'added' || entry.action === 'shadowed') {
      const res = await mcpRemove(ctx, entry.name, entry.scope);
      if (res.code !== 0) {
        ctx.log(`[speculate] ${entry.name}: remove failed: ${(res.stderr || res.stdout).trim()}`);
        failed++;
        continue;
      }
      ctx.log(
        entry.action === 'added'
          ? `[speculate] ${entry.name}: removed`
          : `[speculate] ${entry.name}: shadow removed (.mcp.json entry back in effect)`,
      );
      continue;
    }
    // rewrote: swap the wrapped entry back for the recorded original.
    const removed = await mcpRemove(ctx, entry.name, entry.scope);
    if (removed.code !== 0) {
      ctx.log(`[speculate] ${entry.name}: remove failed: ${(removed.stderr || removed.stdout).trim()}`);
      failed++;
      continue;
    }
    const original = entry.original;
    if (!original) {
      ctx.log(`[speculate] ${entry.name}: no recorded original — removed only`);
      failed++;
      continue;
    }
    const res = await mcpAddJson(ctx, entry.name, original, entry.scope);
    if (res.code !== 0) {
      ctx.log(
        `[speculate] ${entry.name}: restore failed — re-add manually: claude mcp add-json ${entry.name} '${JSON.stringify(original)}' -s ${entry.scope}`,
      );
      failed++;
      continue;
    }
    ctx.log(`[speculate] ${entry.name}: unwrapped (${entry.scope} scope)`);
  }

  // Safety net for a lost state file: wrapped entries are self-describing,
  // so anything still wrapped in user/local scope unwraps in place. Re-read
  // since the entries loop (and cleanup, above) may have changed the config.
  const postView = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
  const projectScopeNames = new Set(
    postView.servers.filter((s) => s.scope === 'project').map((s) => s.name),
  );
  for (const scoped of postView.servers) {
    if (handled.has(scoped.name) || scoped.scope === 'project') continue;
    if (!isWrappedEntry(scoped.entry)) continue;
    const original = unwrapEntry(scoped.entry);
    const removed = await mcpRemove(ctx, scoped.name, scoped.scope);
    if (removed.code !== 0) {
      ctx.log(`[speculate] ${scoped.name}: remove failed: ${(removed.stderr || removed.stdout).trim()}`);
      failed++;
      continue;
    }
    // A wrapped LOCAL entry that shadows a same-named .mcp.json server was a
    // shadow, not an in-place rewrite: removing the local copy lets the
    // project entry take effect again. Re-adding the unwrapped original at
    // local scope would leak a permanent shadow that never existed before
    // `on` — and, worse, bypass the .mcp.json approval gate forever. So for
    // shadows we stop at the remove. (State-file `off` distinguishes these
    // precisely via the recorded action; this heuristic is only the no-state
    // fallback, where a same-named local+project pair is genuinely ambiguous
    // and consent-preservation is the safer resolution.)
    if (scoped.scope === 'local' && projectScopeNames.has(scoped.name)) {
      ctx.log(`[speculate] ${scoped.name}: shadow removed (.mcp.json entry back in effect)`);
      continue;
    }
    if (original) {
      const res = await mcpAddJson(ctx, scoped.name, original, scoped.scope);
      if (res.code !== 0) {
        ctx.log(`[speculate] ${scoped.name}: restore failed after unwrap`);
        failed++;
        continue;
      }
      ctx.log(`[speculate] ${scoped.name}: unwrapped (${scoped.scope} scope, reconstructed)`);
    } else {
      ctx.log(`[speculate] ${scoped.name}: wrap removed (no original command recorded)`);
    }
  }

  if (record) {
    delete state.projects[ctx.cwd];
    saveManagedState(ctx.statePath, state);
  }
  ctx.log(`[speculate] off: done${failed ? ` (${failed} failure(s))` : ''}.`);
  return failed > 0 ? 1 : 0;
}

// -- status -----------------------------------------------------------------------

export async function speculateStatus(opts: ManageOptions): Promise<number> {
  const ctx = makeCtx(opts);
  const view = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
  const state = loadManagedState(ctx.statePath);
  const record = state.projects[ctx.cwd];
  const managedNames = new Set((record?.entries ?? []).map((e) => e.name));
  let unwrapped = 0;
  ctx.log(`[speculate] project: ${ctx.cwd}`);
  const effective = effectiveServers(view.servers);
  if (effective.size === 0) ctx.log('[speculate] no MCP servers visible to Claude Code here');
  for (const [name, scoped] of effective) {
    if (name === WORKSPACE_SERVER_NAME) {
      // A leftover ≤0.10 artifact, not a healthy managed server — reporting
      // it as "wrapped" would hide that CLI speculation was retired in 0.11.
      ctx.log(
        `[speculate]   ${name} (${scoped.scope}): legacy CLI-speculation server (retired in 0.11) — run 'speculate on' to remove`,
      );
      continue;
    }
    let stateLabel: string;
    if (isWrappedEntry(scoped.entry)) {
      stateLabel = managedNames.has(name) ? 'wrapped (managed)' : 'wrapped';
    } else if (!isStdioEntry(scoped.entry)) {
      stateLabel = 'http/sse — passed through';
    } else {
      stateLabel = 'NOT wrapped';
      unwrapped++;
    }
    ctx.log(`[speculate]   ${name} (${scoped.scope}): ${stateLabel}`);
  }
  if (unwrapped > 0 && record) {
    ctx.log(
      `[speculate] ${unwrapped} server(s) added since 'speculate on' — run it again to wrap them`,
    );
  } else if (!record && unwrapped > 0) {
    ctx.log(`[speculate] run 'speculate on' to wrap them (or 'speculate try' for a zero-write trial)`);
  }
  if (await detectLegacyPlugin(ctx)) {
    ctx.log(
      `[speculate] legacy plugin installed (its Bash hook breaks 'git ...' commands under 0.11) — run 'speculate on' to remove`,
    );
  }
  return 0;
}
