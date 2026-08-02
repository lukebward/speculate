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
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { SpeculationMode } from './types.js';

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CmdRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>;

/** Quote one argument the way the CHILD's CommandLineToArgvW parses it back. */
function quoteWin32Arg(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * Escape the characters cmd.exe acts on. cmd tracks "inside quotes" by
 * toggling on EVERY `"` — it knows nothing of the `\"` escapes the child's
 * parser uses — and only treats metacharacters specially while it considers
 * itself outside quotes, so escape exactly those.
 *
 * `%` needs more than a caret, and is why this function inserts quotes.
 * Expansion happens BEFORE caret removal and ignores quoting, while a caret
 * INSIDE quotes is a literal caret (cmd only consumes carets outside them) —
 * so `"^%APPDATA^%"` would reach the child as `^%APPDATA^%`, corrupted. The
 * percent therefore steps OUT of the quotes to be escaped: `"` + `^%` + `"`.
 * There the caret is consumed, and while it lives it sits inside the variable
 * NAME cmd is scanning for (`APPDATA^`), which is undefined, so the reference
 * survives as written. The extra quotes are invisible to the child:
 * CommandLineToArgvW treats a quote boundary with no whitespace as the same
 * argument continuing — provided the inserted quote is not itself escaped,
 * hence the doubling of any backslash run in front of it (`C:\x\%APPDATA%`
 * would otherwise arrive as `C:\x"%APPDATA%`).
 *
 * Without this, `%APPDATA%` in an MCP entry expanded on the way through
 * (breaking `off`'s exact restore) and a variable whose VALUE was cmd syntax
 * executed it.
 */
function escapeCmdMetaChars(line: string): string {
  let out = '';
  let inQuotes = false;
  let backslashes = 0; // length of the `\` run immediately before this char
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      out += ch;
    } else if (ch === '%') {
      out += inQuotes ? `${'\\'.repeat(backslashes)}"^%"` : '^%';
    } else {
      out += !inQuotes && '()!^<>&|'.includes(ch) ? `^${ch}` : ch;
    }
    backslashes = ch === '\\' ? backslashes + 1 : 0;
  }
  return out;
}

/**
 * Windows .cmd/.bat shims (npm-installed Claude Code is one) are batch
 * scripts: since CVE-2024-27980 Node refuses to spawn them directly —
 * `execFile('…/claude.cmd', …)` throws `spawn EINVAL` synchronously — so
 * cmd.exe has to run them.
 *
 * The escaping is applied TWICE because the shim forwards its arguments with
 * `%*`, which cmd re-parses: one round is consumed launching the shim, the
 * second survives into the batch line that finally starts the real program.
 * Verified end-to-end against a `%*`-forwarding shim in manage.test.ts.
 *
 * Known limits of this route, both inherited from cmd.exe:
 *   - the command line cannot exceed ~8191 characters. It fails loud —
 *     "The command line is too long.", exit 1 — never silently truncated.
 *   - a RAW newline inside an argument ends the line there (`\r` is simply
 *     dropped), so the rest of the arguments are lost. JSON-escaped `\\n` —
 *     what `mcp add-json` payloads actually carry — is unaffected.
 */
export function win32ShimInvocation(
  cmd: string,
  args: string[],
): { file: string; args: string[] } {
  const quoted = [cmd, ...args].map(quoteWin32Arg).join(' ');
  const line = escapeCmdMetaChars(escapeCmdMetaChars(quoted));
  return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}

export const execFileRunner: CmdRunner = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    const viaShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const invocation = viaShim ? win32ShimInvocation(cmd, args) : { file: cmd, args };
    try {
      execFile(
        invocation.file,
        invocation.args,
        {
          cwd: opts.cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          ...(viaShim ? { windowsVerbatimArguments: true } : {}),
        },
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
    } catch (err) {
      // execFile can throw synchronously (EINVAL for an unspawnable shim).
      // Never let that escape as a rejection: callers expect a CmdResult.
      resolvePromise({ code: 127, stdout: '', stderr: (err as Error).message });
    }
  });

/**
 * Windows: `claude` installed from npm is a `claude.cmd` shim, and neither
 * execFile nor spawn does a PATHEXT search (libuv tries `.com`/`.exe` only) —
 * so a bare 'claude' fails with ENOENT even though it works in the user's
 * shell. Resolve a BARE name against PATH × the extensions Windows can
 * execute, most-native first. Fail-soft: anything already carrying a path,
 * any non-win32 platform, or no hit at all returns the input untouched.
 */
export function resolveClaudeBin(
  bin: string,
  opts: { platform?: NodeJS.Platform; pathEnv?: string } = {},
): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return bin;
  if (bin.includes('/') || bin.includes('\\') || isAbsolute(bin)) return bin;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(';')) {
    const trimmed = dir.replace(/^"|"$/g, '').trim();
    if (trimmed.length === 0) continue;
    for (const ext of ['.exe', '.cmd', '.bat', '']) {
      const candidate = join(trimmed, `${bin}${ext}`);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // unreadable PATH entry — keep looking
      }
    }
  }
  return bin;
}

// -- managed-state file ---------------------------------------------------------

export interface ManagedEntry {
  name: string;
  scope: ClaudeScope;
  /** 'plugin' = the Claude Code plugin `on` installed at local scope. */
  action: 'rewrote' | 'shadowed' | 'added' | 'plugin';
  original?: McpServerEntry;
}

/**
 * Records are per (scope, name), never per name: the SAME server name can be
 * wrapped at user scope and again at local scope (a local override shadows
 * the user entry), and each wrap has its own original to restore. Keying by
 * name alone made the second `on` overwrite the first record and let `off`
 * leave a still-wrapped entry behind while reporting success.
 */
export function managedKey(scope: ClaudeScope, name: string): string {
  return `${scope}\u0000${name}`;
}

export interface ManagedState {
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
  /**
   * `speculate sync`'s cheap "did anything change?" check: cwd ->
   * effectiveServerHash(view) as of the last sync for that project. Absent
   * from every file written before this field existed — `loadManagedState`
   * must keep loading those unchanged, since the hash is keyed per project
   * and there is nothing to migrate.
   */
  syncHashes?: Record<string, string>;
  /**
   * cwd -> true for projects where `off` opted out of auto-wrap: the
   * user-scope auto-wrap plugin's session-start hook runs `speculate sync`
   * globally, and without this flag it would silently re-wrap a project
   * right after `off` unwrapped it, on the next session start. `off` sets
   * the flag for its own project; `on` clears it. A later task makes `sync`
   * honor it. Absent from every file written before this field existed —
   * `loadManagedState` must keep loading those unchanged.
   */
  syncOptOut?: Record<string, true>;
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

export function loadManagedState(path: string): ManagedState {
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

export function saveManagedState(path: string, state: ManagedState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Recursively sort OBJECT keys so `JSON.stringify` of the result is
 * insensitive to source field order — but never reorder ARRAY elements,
 * whose order is semantically meaningful (an entry's `args` is a command
 * line). Entries reach effectiveServerHash straight from `JSON.parse` of
 * the host config, which preserves whatever field order the file happens
 * to have; `claude mcp add-json` rewriting `~/.claude.json` can change that
 * order for a server whose meaning didn't change at all, and the hash must
 * not misfire (and trigger a pointless sync) over that.
 */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable hash of the effective server set (names + command lines + the
 * approval state of .mcp.json servers) for a project: `speculate sync`'s
 * fast path spawns no subprocess, so this is the whole "did anything change
 * since last sync?" check.
 *
 * Approval belongs in the hash because approving a .mcp.json server in
 * Claude Code writes the host's approval record, NOT the server entry: a
 * hash over entries alone is identical before and after, so the fast path
 * would fire and a server the user JUST approved would never be wrapped.
 * Only project-scope entries carry the flag, since they're the only ones
 * with an approval gate. Sorted by name
 * so key order in the source config can never change the hash — the state
 * (which scope won, and its exact entry) is what must be stable, not the
 * order the host happened to enumerate servers in. Each entry is
 * canonicalized before stringifying so an entry's own field order (and any
 * nested object's, e.g. `env`) can't change the hash either — only array
 * order (e.g. `args`) is preserved, since that's semantically meaningful.
 * The parts are hashed as a JSON array, not delimiter-joined, so two
 * different server sets can never concatenate to the same string.
 */
export function effectiveServerHash(view: ClaudeConfigView): string {
  const parts: string[] = [];
  for (const [name, scoped] of [...effectiveServers(view.servers)].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const approval =
      scoped.scope === 'project' ? (view.approvedProjectServers.has(name) ? '+' : '-') : '';
    parts.push(
      `${scoped.scope}${approval} ${name} ${JSON.stringify(canonicalizeForHash(scoped.entry))}`,
    );
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// -- the claude mcp front door ---------------------------------------------------

export interface Ctx {
  home: string;
  cwd: string;
  self: { command: string; args: string[] };
  runner: CmdRunner;
  claudeBin: string;
  statePath: string;
  log: (line: string) => void;
  /** Memoized `claude plugin list --json`; see fetchPluginList. */
  pluginList?: Promise<unknown | null>;
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

export function makeCtx(opts: ManageOptions): Ctx {
  // An explicitly passed bin is used verbatim (callers — and tests — that
  // name one mean it); only the default/env name gets PATHEXT resolution,
  // and only on first USE. That resolution is a synchronous PATH × PATHEXT
  // existsSync walk, which `sync`'s fast path — the common case, run at
  // every session start — must not pay for a subprocess it never spawns.
  let bin = opts.claudeBin;
  return {
    home: opts.home ?? homedir(),
    cwd: resolve(opts.cwd ?? process.cwd()),
    self: opts.self,
    runner: opts.runner ?? execFileRunner,
    get claudeBin(): string {
      bin ??= resolveClaudeBin(process.env.SPECULATE_CLAUDE_BIN ?? 'claude');
      return bin;
    },
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

export interface LegacyCleanupResult {
  pluginUninstalled: boolean;
  pluginUninstallAttempted: boolean;
  workspaceServerRemoved: boolean;
  workspaceServerRemovalAttempted: boolean;
  marketplaceRemoved: boolean;
}

const NO_LEGACY_CLEANUP: LegacyCleanupResult = {
  pluginUninstalled: false,
  pluginUninstallAttempted: false,
  workspaceServerRemoved: false,
  workspaceServerRemovalAttempted: false,
  marketplaceRemoved: false,
};

/**
 * IDs a ≤0.10 install may have registered the plugin under. 0.10's own
 * PLUGIN_ID was the fully-qualified `speculate@speculate`; try that first,
 * then fall back to the bare marketplace-less name some hosts also accept.
 */
const LEGACY_PLUGIN_IDS = ['speculate@speculate', 'speculate'] as const;

/**
 * The only ids that ARE the retired Speculate plugin. Matched exactly: a
 * user's unrelated `speculate-tools`, or an id like `my-speculate@corp`, is
 * someone else's plugin and must never be detected — let alone uninstalled.
 */
const LEGACY_PLUGIN_MATCH: ReadonlySet<string> = new Set(LEGACY_PLUGIN_IDS);

/**
 * The `claude plugin uninstall` invocation(s), shared by cleanup and off()'s
 * fallback. The BARE id ('speculate') is only ever attempted when our own
 * ≤0.10 state records that we installed the plugin for this project: on hosts
 * that resolve bare names it would otherwise uninstall any plugin that
 * happens to be called 'speculate', from any marketplace.
 */
async function runLegacyPluginUninstall(
  ctx: Ctx,
  opts: { allowBareFallback: boolean },
): Promise<{ res: CmdResult; id: string }> {
  const ids = opts.allowBareFallback ? [...LEGACY_PLUGIN_IDS] : [LEGACY_PLUGIN_IDS[0]];
  let last: { res: CmdResult; id: string } = {
    res: { code: 1, stdout: '', stderr: 'no id attempted' },
    id: LEGACY_PLUGIN_IDS[0],
  };
  for (const id of ids) {
    const res = await ctx.runner(ctx.claudeBin, ['plugin', 'uninstall', '-s', 'local', id], {
      cwd: ctx.cwd,
    });
    last = { res, id };
    if (res.code === 0) break;
  }
  // The installed set just changed: drop the memoized list so a later
  // detector re-reads the host instead of trusting a pre-uninstall answer.
  ctx.pluginList = undefined;
  return last;
}

/** Does one `plugin list --json` record name the retired plugin (exactly)? */
function isLegacyPluginRecord(item: unknown): boolean {
  if (typeof item === 'string') return LEGACY_PLUGIN_MATCH.has(item);
  if (Array.isArray(item)) return item.some(isLegacyPluginRecord);
  if (!item || typeof item !== 'object') return false;
  const rec = item as Record<string, unknown>;
  for (const field of ['id', 'name'] as const) {
    const value = rec[field];
    if (typeof value === 'string' && LEGACY_PLUGIN_MATCH.has(value)) return true;
  }
  return false;
}

/**
 * The one `claude plugin list --json` every detector reads (`off` used to
 * spawn it twice: once for the legacy plugin, once for the auto-wrap one).
 * Memoized on the ctx, which lives exactly as long as a single command run.
 * Anything that CHANGES the installed set clears the memo (see
 * runLegacyPluginUninstall), so staleness is prevented by construction
 * rather than by an argument about which ids each detector matches.
 *
 * Fail-soft in every direction: a missing plugin CLI, a nonzero exit, or
 * unparseable output all yield null, which every caller reads as "not
 * detected", never a guess.
 */
function fetchPluginList(ctx: Ctx): Promise<unknown | null> {
  ctx.pluginList ??= (async () => {
    try {
      const list = await ctx.runner(ctx.claudeBin, ['plugin', 'list', '--json'], { cwd: ctx.cwd });
      if (list.code !== 0) return null;
      try {
        return JSON.parse(list.stdout) as unknown;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  })();
  return ctx.pluginList;
}

/**
 * Does a parsed `plugin list --json` payload name a plugin `matches` accepts?
 * Hosts emit either an array of records or an id-keyed object; both shapes
 * are matched exactly (never by substring — a user's unrelated
 * `speculate-tools` is someone else's plugin).
 */
function pluginListHas(parsed: unknown, matches: (item: unknown) => boolean): boolean {
  if (Array.isArray(parsed)) return parsed.some(matches);
  if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>;
    return Object.keys(rec).some((k) => matches(k)) || Object.values(rec).some(matches);
  }
  return false;
}

/**
 * Detect a still-installed legacy plugin. Fail-soft: "not detected" is the
 * answer for every unknown — callers with their own ≤0.10 record still act.
 */
async function detectLegacyPlugin(ctx: Ctx): Promise<boolean> {
  return pluginListHas(await fetchPluginList(ctx), isLegacyPluginRecord);
}

/**
 * Is the ≤0.10 `speculate` marketplace still registered on this host?
 * Fail-soft (older hosts have no `plugin marketplace list`): unknown → false.
 */
async function detectLegacyMarketplace(ctx: Ctx): Promise<boolean> {
  try {
    const list = await ctx.runner(ctx.claudeBin, ['plugin', 'marketplace', 'list', '--json'], {
      cwd: ctx.cwd,
    });
    if (list.code !== 0) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(list.stdout);
    } catch {
      return false;
    }
    const named = (item: unknown): boolean => {
      if (typeof item === 'string') return item === 'speculate';
      if (!item || typeof item !== 'object') return false;
      const rec = item as Record<string, unknown>;
      return rec['name'] === 'speculate' || rec['id'] === 'speculate';
    };
    if (Array.isArray(parsed)) return parsed.some(named);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      return Object.keys(rec).includes('speculate') || Object.values(rec).some(named);
    }
    return false;
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
 * hosts with no `claude plugin` CLI at all, or an id outside the exact set
 * LEGACY_PLUGIN_MATCH matches), and a recorded install must never be
 * silently dropped just because detection missed. When an attempt was made
 * here and it failed, callers should also skip a duplicate attempt (it would
 * just fail again) but still count the failure — see off() below. The same
 * shape (removed-here vs attempted-here) is reported for the workspace
 * server, so off()'s per-entry handling of a legacy `speculate-workspace`
 * record never re-attempts a removal this function already ran.
 *
 * `marketplaceRemoved` reports a successful (host-global) marketplace
 * removal so callers can clear the ownership flag that authorized it —
 * leaving it set would let a LATER run remove a registration the user
 * re-added by hand.
 */
export async function cleanupLegacyArtifacts(
  ctx: Ctx,
  view: ClaudeConfigView,
  opts: { marketplaceAddedByOn: boolean; pluginRecorded?: boolean } = {
    marketplaceAddedByOn: false,
  },
): Promise<LegacyCleanupResult> {
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
      ...NO_LEGACY_CLEANUP,
      workspaceServerRemoved,
      workspaceServerRemovalAttempted,
    };
  }
  const { res: un, id } = await runLegacyPluginUninstall(ctx, {
    allowBareFallback: opts.pluginRecorded === true,
  });
  ctx.log(
    un.code === 0
      ? '[speculate] legacy: uninstalled the speculate plugin (Bash hook retired in 0.11)'
      : `[speculate] legacy: plugin uninstall failed (tried ${id}) — remove manually: ${ctx.claudeBin} plugin uninstall -s local ${id}`,
  );
  // The marketplace registration is host-global, not per-project — only
  // remove it when this project's own ≤0.10 state recorded that its `on`
  // was the one that added it. Otherwise it may belong to another project,
  // or the user added it by hand, and it's not ours to take.
  let marketplaceRemoved = false;
  if (un.code === 0 && opts.marketplaceAddedByOn) {
    const rm = await ctx.runner(ctx.claudeBin, ['plugin', 'marketplace', 'remove', 'speculate'], {
      cwd: ctx.cwd,
    });
    marketplaceRemoved = rm.code === 0;
    // What a marketplace offers changes what `plugin list` can report, so the
    // memo is dropped here too — the docstring on fetchPluginList claims
    // staleness is prevented by construction, and this is one of the sites
    // that has to be true for.
    ctx.pluginList = undefined;
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
    marketplaceRemoved,
  };
}

// -- shared wrap path ---------------------------------------------------------

export interface WrapOutcome {
  changed: number;
  failed: number;
  /**
   * True when the pass stopped early because `opts.deadline` had passed, so
   * servers were left unvisited. The pass is INCOMPLETE: callers must not
   * record anything that claims the whole set was handled (`sync`'s hash).
   */
  timedOut: boolean;
}

/**
 * Wraps every eligible server in `view` into `managed`, applying all consent
 * gates. Mutates `managed` in place. Used by both `on` and `sync`.
 *
 * `onWrapped` fires once per server actually wrapped here, so `sync` can name
 * them in its one-line summary without re-deriving the set from the config it
 * just rewrote. `on` passes nothing (it logs each server as it goes).
 *
 * `deadline` (a `performance.now()` timestamp) makes the pass COOPERATIVELY
 * interruptible for `sync`, whose session-start budget is finite. It is
 * checked only at the top of an iteration, never between a server's `mcp
 * remove` and the `mcp add-json` that puts it back — killing the process in
 * that window would leave the host with the server deleted, no restore, and
 * no state record. Stopping between servers costs at most one unvisited
 * server, which the next run picks up.
 */
export async function wrapEffectiveServers(
  ctx: Ctx,
  view: ClaudeConfigView,
  managed: Map<string, ManagedEntry>,
  opts: { mode?: SpeculationMode; onWrapped?: (name: string) => void; deadline?: number },
): Promise<WrapOutcome> {
  let changed = 0;
  let failed = 0;

  for (const [name, scoped] of effectiveServers(view.servers)) {
    if (opts.deadline !== undefined && performance.now() >= opts.deadline) {
      ctx.log(`[speculate] out of time before ${name} — the next run picks it up`);
      return { changed, failed, timedOut: true };
    }
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
      managed.set(managedKey('local', name), { name, scope: 'local', action: 'shadowed' });
      ctx.log(`[speculate] ${name}: wrapped via local shadow (.mcp.json untouched; local wins)`);
      opts.onWrapped?.(name);
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
    managed.set(managedKey(scoped.scope, name), {
      name,
      scope: scoped.scope,
      action: 'rewrote',
      original: scoped.entry,
    });
    ctx.log(`[speculate] ${name}: wrapped (${scoped.scope} scope)`);
    opts.onWrapped?.(name);
    changed++;
  }

  return { changed, failed, timedOut: false };
}

// -- the auto-wrap plugin -------------------------------------------------------

/**
 * The auto-wrap plugin's id. Its whole content is ONE SessionStart hook that
 * runs `speculate sync`, so MCP servers added after `speculate on` are wrapped
 * without anyone remembering to re-run it. Installed at USER scope by `on`.
 *
 * Deliberately disjoint from LEGACY_PLUGIN_IDS/LEGACY_PLUGIN_MATCH, which name
 * only the retired ≤0.10 plugin: were the two sets ever to overlap, cleanup
 * would uninstall the plugin `on` had just installed.
 */
export const AUTOWRAP_PLUGIN_ID = 'speculate-autowrap';

/**
 * The marketplace `.claude-plugin/marketplace.json` declares. NOT `speculate`
 * — that name belongs to the retired ≤0.10 registration, which cleanup removes
 * when this project's state claims it and `status` tells everyone else to
 * remove by hand. Sharing the name would make `on` re-add what cleanup had
 * just removed, and turn that status hint into advice that breaks auto-wrap.
 */
const AUTOWRAP_MARKETPLACE_ID = 'speculate-mcp';

/**
 * How long the host lets the hook run, in SECONDS. It must exceed `sync`'s own
 * last-resort exit (60s): a shorter host-side timeout kills a wrap in flight,
 * reopening the very window — a server deleted between `mcp remove` and `mcp
 * add-json` — that the cooperative deadline exists to close. It is a ceiling
 * that should never be approached: the fast path costs two file reads.
 */
const AUTOWRAP_HOOK_TIMEOUT_S = 90;

/**
 * The ids a host may report our plugin under. `claude plugin list --json`
 * emits records identified ONLY by `id`, and that id is
 * `<plugin>@<marketplace>` (measured) — so the qualified form has to be
 * matched or the plugin `on` just installed reads back as absent. Matched
 * exactly, never by substring: a stranger's `speculate-autowrap-fork` is
 * someone else's plugin.
 */
const AUTOWRAP_PLUGIN_MATCH: ReadonlySet<string> = new Set([
  AUTOWRAP_PLUGIN_ID,
  `${AUTOWRAP_PLUGIN_ID}@${AUTOWRAP_MARKETPLACE_ID}`,
]);

/**
 * Fail-soft check (same shared plugin list as detectLegacyPlugin, matching a
 * different, disjoint id): is the auto-wrap plugin installed?
 */
async function detectAutowrapPlugin(ctx: Ctx): Promise<boolean> {
  const named = (item: unknown): boolean => {
    if (typeof item === 'string') return AUTOWRAP_PLUGIN_MATCH.has(item);
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    for (const field of ['id', 'name'] as const) {
      const value = rec[field];
      if (typeof value === 'string' && AUTOWRAP_PLUGIN_MATCH.has(value)) return true;
    }
    return false;
  };
  return pluginListHas(await fetchPluginList(ctx), named);
}

/**
 * The installed package root — the directory that ships `plugin/`. Resolved by
 * walking up from THIS module so it works from `src/manage.ts` (a checkout)
 * and `dist/src/manage.js` (an npm install) alike. Not derived from
 * `ctx.self`, which in a source checkout points at tsx's entrypoint, not ours.
 */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'plugin', 'hooks', 'autowrap.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The hook's command line, baked absolute at install time.
 *
 * Never a bare `speculate`: Claude Code cannot exec a `.cmd` shim as a hook on
 * Windows, and npm installs `speculate` as one. `${CLAUDE_PLUGIN_ROOT}` is the
 * host's own expansion for the INSTALLED plugin directory and has to be used
 * for the wrapper, because `claude plugin install` COPIES the plugin: a path
 * into the npm package is precisely the path that disappears on `npm
 * uninstall`, which is the case the wrapper exists to survive. The CLI path
 * after it may well disappear — the wrapper checks it and exits 0 silently.
 */
function autowrapHookCommand(self: { command: string; args: string[] }): string {
  const quoted = (s: string): string => `"${s}"`;
  return [
    quoted(self.command),
    quoted('${CLAUDE_PLUGIN_ROOT}/hooks/autowrap.mjs'),
    ...self.args.map(quoted),
  ].join(' ');
}

function autowrapHooksJson(self: { command: string; args: string[] }): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: autowrapHookCommand(self),
                timeout: AUTOWRAP_HOOK_TIMEOUT_S,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Stage a complete, self-contained copy of the plugin (plus its one-plugin
 * marketplace) next to the managed state, with the hook command generated for
 * THIS install, and return the directory to hand `plugin marketplace add`.
 *
 * The shipped copy inside the package is the template, never the target: a
 * global npm install is frequently root-owned or otherwise read-only, and
 * writing a generated hook command into it would fail exactly where auto-wrap
 * matters most. Staging also keeps `speculate on` from dirtying an npm package
 * (or, in a checkout, the working tree).
 *
 * Returns null when the package's plugin files can't be found at all, which
 * every caller treats as "skip, quietly".
 */
function stageAutowrapPlugin(ctx: Ctx): string | null {
  const root = packageRoot();
  if (!root) return null;
  const dest = join(dirname(ctx.statePath), 'autowrap');
  mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dest, 'plugin', '.claude-plugin'), { recursive: true });
  mkdirSync(join(dest, 'plugin', 'hooks'), { recursive: true });
  copyFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    join(dest, '.claude-plugin', 'marketplace.json'),
  );
  copyFileSync(
    join(root, 'plugin', '.claude-plugin', 'plugin.json'),
    join(dest, 'plugin', '.claude-plugin', 'plugin.json'),
  );
  copyFileSync(
    join(root, 'plugin', 'hooks', 'autowrap.mjs'),
    join(dest, 'plugin', 'hooks', 'autowrap.mjs'),
  );
  writeFileSync(join(dest, 'plugin', 'hooks', 'hooks.json'), autowrapHooksJson(ctx.self));
  return dest;
}

/**
 * Install the auto-wrap plugin at user scope. Every step is fail-soft: a
 * failure logs ONE line and never aborts `on`, whose real work — wrapping this
 * project's servers — has nothing to do with it.
 *
 * User scope, not local, because the point is to catch servers added in
 * projects where nobody thought to run `speculate on`. `off` opts a single
 * project out through the state file rather than uninstalling this.
 */
async function installAutowrapPlugin(ctx: Ctx): Promise<void> {
  try {
    if (await detectAutowrapPlugin(ctx)) {
      ctx.log(
        '[speculate] auto-wrap: already installed (new servers wrap at the next session start)',
      );
      return;
    }
    const source = stageAutowrapPlugin(ctx);
    if (!source) {
      ctx.log(
        "[speculate] auto-wrap: plugin files not found — skipped ('speculate on' still wraps this project)",
      );
      return;
    }
    // An "already exists" here is a success for us (the host replaces a
    // same-named registration), so the result is deliberately not checked —
    // a genuine failure surfaces through the install below.
    await ctx.runner(ctx.claudeBin, ['plugin', 'marketplace', 'add', source], { cwd: ctx.cwd });
    const ins = await ctx.runner(
      ctx.claudeBin,
      ['plugin', 'install', '-s', 'user', AUTOWRAP_PLUGIN_ID],
      { cwd: ctx.cwd },
    );
    // The installed set just changed: drop the memoized list (see
    // fetchPluginList) so a later detector doesn't read the pre-install answer.
    ctx.pluginList = undefined;
    ctx.log(
      ins.code === 0
        ? '[speculate] auto-wrap: installed — servers added later wrap at the next session start'
        : `[speculate] auto-wrap: not installed (${(ins.stderr || ins.stdout).trim() || `exit ${ins.code}`}) — 'speculate on' still wraps this project`,
    );
  } catch (err) {
    ctx.log(`[speculate] auto-wrap: install skipped (${(err as Error).message})`);
  }
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
  let legacy: LegacyCleanupResult = NO_LEGACY_CLEANUP;
  try {
    legacy = await cleanupLegacyArtifacts(ctx, view, {
      marketplaceAddedByOn: readMarketplaceAddedByOn(state),
      pluginRecorded: record.entries.some((e) => e.action === 'plugin'),
    });
  } catch (err) {
    ctx.log(`[speculate] legacy cleanup failed: ${(err as Error).message}`);
  }
  // A ≤0.10 record is dropped only once the artifact it describes is really
  // gone from the HOST — otherwise `off`'s recorded-artifact safety net (the
  // only path left when detection misses) would be destroyed by an `on` that
  // never removed anything. Conversely, keeping a record for an artifact
  // cleanup DID remove would make the next `off` chase a clean host and
  // report a spurious failure. So: prune on confirmed removal, or on the
  // host view already showing the artifact gone.
  const workspaceGone =
    legacy.workspaceServerRemoved || !effectiveServers(view.servers).has(WORKSPACE_SERVER_NAME);
  const managed = new Map(
    record.entries
      .filter((e) => {
        if (e.name === WORKSPACE_SERVER_NAME) return !workspaceGone;
        if (e.action === 'plugin') return !legacy.pluginUninstalled;
        return true;
      })
      .map((e) => [managedKey(e.scope, e.name), e]),
  );
  const { changed, failed } = await wrapEffectiveServers(ctx, view, managed, {
    mode: opts.mode ?? undefined,
  });
  // Servers added AFTER this run are the auto-wrap plugin's job. Installed
  // after the wrap so its one line lands with the summary rather than in the
  // middle of the per-server output — and it can never fail `on`.
  await installAutowrapPlugin(ctx);

  state.projects[ctx.cwd] = { entries: [...managed.values()], updatedAt: Date.now() };
  // The ownership flag authorized exactly one host-global removal; consume it
  // so a future run never claims a registration the user re-added by hand.
  if (legacy.marketplaceRemoved) state.marketplaceAddedByOn = false;
  // `on` opts this project back into a later `sync`'s auto-wrap (see
  // ManagedState.syncOptOut) — undoing whatever `off` last recorded here.
  delete state.syncOptOut?.[ctx.cwd];
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
  let legacyCleanup: LegacyCleanupResult = NO_LEGACY_CLEANUP;
  try {
    legacyCleanup = await cleanupLegacyArtifacts(ctx, preView, {
      marketplaceAddedByOn: readMarketplaceAddedByOn(state),
      pluginRecorded: (record?.entries ?? []).some((e) => e.action === 'plugin'),
    });
  } catch (err) {
    ctx.log(`[speculate] legacy cleanup failed: ${(err as Error).message}`);
  }
  let failed = 0;
  const handled = new Set<string>();

  for (const entry of record?.entries ?? []) {
    handled.add(managedKey(entry.scope, entry.name));
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
      // plugin` CLI, or an id its exact match doesn't cover) does a
      // recorded install need a direct attempt here, so it's never silently
      // dropped.
      if (legacyCleanup.pluginUninstalled) {
        // already confirmed removed — nothing more to do.
      } else if (legacyCleanup.pluginUninstallAttempted) {
        failed++;
      } else {
        // This IS the recorded install, so the bare-id fallback is ours.
        const { res, id } = await runLegacyPluginUninstall(ctx, { allowBareFallback: true });
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
    if (handled.has(managedKey(scoped.scope, scoped.name)) || scoped.scope === 'project') continue;
    if (!isWrappedEntry(scoped.entry)) continue;
    if (scoped.name.startsWith('-')) {
      // Same guard `on` applies: `claude mcp remove/add-json` take the name
      // positionally, so a leading dash would be parsed as an option.
      ctx.log(`[speculate] ${scoped.name}: skipped (name starts with '-')`);
      continue;
    }
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

  if (record) delete state.projects[ctx.cwd];
  // Consume the marketplace-ownership flag exactly once (see on()).
  if (legacyCleanup.marketplaceRemoved) state.marketplaceAddedByOn = false;
  // Opt this project out of a later `sync`'s auto-wrap (see ManagedState.
  // syncOptOut) — the global plugin, if installed, would otherwise re-wrap
  // it at the next session start. `on` clears this.
  state.syncOptOut = { ...(state.syncOptOut ?? {}), [ctx.cwd]: true };
  if (await detectAutowrapPlugin(ctx)) {
    ctx.log(
      '[speculate] auto-wrap is still installed globally (this project is now opted out).',
    );
    ctx.log(
      `[speculate]   remove it everywhere with: ${ctx.claudeBin} plugin uninstall -s user ${AUTOWRAP_PLUGIN_ID}`,
    );
  }
  saveManagedState(ctx.statePath, state);
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
  if (await detectAutowrapPlugin(ctx)) {
    // Says the quiet part out loud: the wrap a session-start hook performs
    // lands in the NEXT session, because the host snapshots MCP config before
    // running the hook. Measured, inherent, and not worth hiding.
    ctx.log('[speculate]   auto-wrap: installed (new servers wrap at the next session start)');
  }
  if (await detectLegacyPlugin(ctx)) {
    ctx.log(
      `[speculate] legacy plugin installed (its Bash hook breaks 'git ...' commands under 0.11) — run 'speculate on' to remove`,
    );
  } else if (await detectLegacyMarketplace(ctx)) {
    // The plugin is gone but the host-global registration survives, and 0.11
    // deleted the manifest it resolves. Cleanup only removes registrations
    // our own ≤0.10 state claims to own (another project may still need it),
    // so for everyone else the honest move is to name it and the one command
    // that fixes it.
    ctx.log(
      `[speculate] legacy marketplace 'speculate' registered (its source was removed in 0.11) — remove with: ${ctx.claudeBin} plugin marketplace remove speculate`,
    );
  }
  return 0;
}
