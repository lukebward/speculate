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
 *   - the bundled workspace shell server is added at local scope for CLI
 *     speculation.
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
  workspaceEntry,
  wrapEntry,
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
  action: 'rewrote' | 'shadowed' | 'added';
  original?: McpServerEntry;
}

interface ManagedState {
  version: 1;
  projects: Record<string, { entries: ManagedEntry[]; updatedAt: number }>;
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
  const managed = new Map(record.entries.map((e) => [e.name, e]));
  let changed = 0;
  let failed = 0;

  for (const [name, scoped] of effectiveServers(view.servers)) {
    if (name === WORKSPACE_SERVER_NAME) continue;
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
      // Never touch the checked-in file; shadow at local scope instead.
      if (!view.approvedProjectServers.has(name) && view.projectApprovalKnown) {
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

  // CLI speculation for this project, one local-scope registration.
  if (!effectiveServers(view.servers).has(WORKSPACE_SERVER_NAME)) {
    const res = await mcpAddJson(ctx, WORKSPACE_SERVER_NAME, workspaceEntry(ctx.self, ctx.cwd), 'local');
    if (res.code === 0) {
      managed.set(WORKSPACE_SERVER_NAME, {
        name: WORKSPACE_SERVER_NAME,
        scope: 'local',
        action: 'added',
      });
      ctx.log(`[speculate] ${WORKSPACE_SERVER_NAME}: added (git/rg/CLI speculation for ${ctx.cwd})`);
      changed++;
    } else {
      ctx.log(
        `[speculate] ${WORKSPACE_SERVER_NAME}: add failed: ${(res.stderr || res.stdout).trim()}`,
      );
      failed++;
    }
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
  const state = loadManagedState(ctx.statePath);
  const record = state.projects[ctx.cwd];
  let failed = 0;
  const handled = new Set<string>();

  for (const entry of record?.entries ?? []) {
    handled.add(entry.name);
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
  // so anything still wrapped in user/local scope unwraps in place.
  const view = readClaudeServers({ home: ctx.home, cwd: ctx.cwd });
  for (const scoped of view.servers) {
    if (handled.has(scoped.name) || scoped.scope === 'project') continue;
    if (!isWrappedEntry(scoped.entry)) continue;
    const original = unwrapEntry(scoped.entry);
    const removed = await mcpRemove(ctx, scoped.name, scoped.scope);
    if (removed.code !== 0) {
      ctx.log(`[speculate] ${scoped.name}: remove failed: ${(removed.stderr || removed.stdout).trim()}`);
      failed++;
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
      ctx.log(`[speculate] ${scoped.name}: workspace wrap removed`);
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
  return 0;
}
