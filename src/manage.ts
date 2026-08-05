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
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeRemote, type RemoteProbe, type RemoteProber } from './remoteProbe.js';
import { oauthStorePath, readOAuthRecord } from './oauthStore.js';
import {
  WORKSPACE_SERVER_NAME,
  claudeJsonPath,
  effectiveServers,
  isStdioEntry,
  isWrappedEntry,
  normalizeProjectKey,
  planRemoteWrap,
  projectRoot,
  resolveWrapHeaders,
  readClaudeServers,
  unwrapEntry,
  wrapEntry,
  type ClaudeConfigView,
  type ClaudeScope,
  type McpServerEntry,
  type PluginScopedServer,
  type RemoteWrapPlan,
  type ScopedServer,
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
  /**
   * 'plugin' = the Claude Code plugin `on` installed at local scope (≤0.10).
   * 'pluginShadowed' = a wrapped copy of a PLUGIN-declared server registered
   * at local scope, with the original disabled via the host's per-project
   * `disabledMcpServers` switch (spec:
   * docs/superpowers/specs/2026-08-05-plugin-wrap-design.md).
   */
  action: 'rewrote' | 'shadowed' | 'added' | 'plugin' | 'pluginShadowed';
  /**
   * For 'pluginShadowed' only: the plugin-qualified server name
   * (`plugin:<plugin>:<server>`) — both the identity of the wrapped original
   * and the EXACT string this wrap added to `disabledMcpServers`, which is
   * what `off` removes. The disable has no self-describing fallback in the
   * entry itself beyond the SPECULATE_PLUGIN_ORIGIN env marker, so this
   * record (or that marker) is what makes the restore exact.
   */
  pluginServer?: string;
  /**
   * The host's entry, VERBATIM, which is what makes `off` byte-exact —
   * including any unknown field the host added, and including the `headers`
   * of a remote server. A bearer token written inline in the host config is
   * therefore copied into this state file in the clear. That is deliberate
   * and it is the price of an exact restore: the alternative is an `off`
   * that guesses. The file is written 0600 inside a 0700 directory (see
   * saveManagedState), and no log line ever prints a header value.
   */
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

/**
 * Has `on` already been run for this project?
 *
 * Lets `speculate auth` finish the job: after a login it can re-run the wrap
 * so the newly reachable servers go live now, but only where the user has
 * already opted this project in. Running `on` off the back of `auth` in a
 * project that never had it would be a config change nobody asked for.
 */
export function projectIsManaged(opts: { cwd?: string; statePath?: string } = {}): boolean {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const state = loadManagedState(opts.statePath ?? managedStatePath());
  return state.projects[cwd] !== undefined;
}

/**
 * Fold in any record an older version wrote under a SUBDIRECTORY of this
 * project, so upgrading does not orphan it.
 *
 * Through v0.14.3 the managed record was keyed by the current directory; from
 * v0.14.4 it is keyed by the repository root (hostConfig.projectRoot). Without
 * this, an `on` run from a subdirectory becomes unreachable the moment the
 * user upgrades: `status` stops reporting those servers as managed, and `off`
 * falls back to reconstructing each entry from its own wrapped command line.
 * That fallback works, but it only recovers what the wrap carries, so any
 * field the HOST had added to the entry is silently dropped on restore.
 *
 * Mutates `state`, so the next save writes one record and drops the strays.
 * Callers that only read (`status`) simply do not persist it.
 */
export function adoptLegacyProjectRecords(state: ManagedState, cwd: string): void {
  const root = normalizeProjectKey(cwd);
  const legacy = Object.keys(state.projects).filter(
    (key) => key !== cwd && normalizeProjectKey(key).startsWith(`${root}/`),
  );
  if (legacy.length === 0) return;
  const current = state.projects[cwd] ?? { entries: [], updatedAt: 0 };
  // The root's own entries win: they describe the most recent wrap.
  const byKey = new Map<string, ManagedEntry>();
  for (const key of legacy) {
    for (const entry of state.projects[key]!.entries) {
      byKey.set(managedKey(entry.scope, entry.name), entry);
    }
    delete state.projects[key];
  }
  for (const entry of current.entries) byKey.set(managedKey(entry.scope, entry.name), entry);
  state.projects[cwd] = {
    entries: [...byKey.values()],
    updatedAt: Math.max(current.updatedAt, Date.now()),
  };
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
 * with an approval gate.
 *
 * A project entry that has been SHADOWED (by the wrapped local copy `on`
 * and `sync` register for it) is hashed too, even though it is no longer
 * the effective server. It has to be: the moment the shadow exists,
 * `effectiveServers` resolves the name to the local entry, the project
 * entry's approval flag drops out of the hash, and REVOKING that approval
 * changes nothing the fast path can see — so sync would make zero calls
 * while the wrapped shadow stayed registered and running at a scope with no
 * approval gate at all. Consent still hangs on the .mcp.json record, so the
 * hash has to keep watching it. Sorted by name
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
  const part = (scoped: ScopedServer): string => {
    const approval =
      scoped.scope === 'project' ? (view.approvedProjectServers.has(scoped.name) ? '+' : '-') : '';
    return `${scoped.scope}${approval} ${scoped.name} ${JSON.stringify(canonicalizeForHash(scoped.entry))}`;
  };
  const shadowedProjectEntries = new Map(
    view.servers.filter((s) => s.scope === 'project').map((s) => [s.name, s]),
  );
  const parts: string[] = [];
  for (const [name, scoped] of [...effectiveServers(view.servers)].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    parts.push(part(scoped));
    const shadowed = scoped.scope === 'project' ? undefined : shadowedProjectEntries.get(name);
    if (shadowed) parts.push(part(shadowed));
  }
  // Plugin-declared servers and the host's per-project disable list are in
  // the hash for the same reason shadowed project entries are: they carry
  // consent and identity the effective map cannot see. Without them,
  // installing, updating, disabling, or un-disabling a plugin changes nothing
  // sync's fast path can observe — so the wrap (or the restore consent
  // requires) would never happen. The entry is hashed post-interpolation, so
  // a plugin update that moves the versioned root moves the hash even when
  // nothing else changed, which is exactly the drift the refresh pass needs
  // to be woken for. (One extra slow-path sync per project on upgrade to a
  // build that adds these parts: the price of any hash-format change.)
  for (const ps of view.pluginServers) {
    parts.push(
      `plugin ${ps.qualifiedName} ${ps.unwrappableReason ?? ''} ` +
        JSON.stringify(canonicalizeForHash(ps.entry)),
    );
  }
  parts.push(`disabledMcpServers ${JSON.stringify([...view.disabledMcpServers].sort())}`);
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
  /**
   * Asks a remote server whether Speculate can connect to it. Injectable so
   * the suite never touches the network; see remoteProbe.ts for why config
   * shape alone cannot answer the question.
   */
  probeRemote: RemoteProber;
  /** Speculate's own OAuth credential store (oauthStore.ts). */
  oauthStorePath: string;
  /** Memoized `claude plugin list --json`; see fetchPluginList. */
  pluginList?: Promise<unknown | null>;
}

/**
 * Shortest header value worth scrubbing out of a log line — the same floor
 * Upstream#redact uses, for the same reason: below it a value is far likelier
 * to be an innocuous literal ('1', 'v2') whose redaction would mangle
 * unrelated text than a credential worth protecting.
 */
const MIN_REDACTABLE_LENGTH = 8;

/**
 * The secret strings an entry carries: HTTP header values, and nothing else.
 * A `${VAR}` placeholder is not one — it is the reference, not the token.
 *
 * Both shapes an entry can be in are read, because both are logged about:
 * the host's own `headers` map, and the `--header "Name: value"` pairs of an
 * entry Speculate has already wrapped.
 */
function entrySecrets(entry: McpServerEntry): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= MIN_REDACTABLE_LENGTH) out.push(value);
  };
  const headers = entry.headers;
  if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const value of Object.values(headers as Record<string, unknown>)) push(value);
  }
  const args = entry.args ?? [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--header') continue;
    const split = args[i + 1]!.indexOf(':');
    if (split > 0) push(args[i + 1]!.slice(split + 1).trim());
  }
  return out;
}

/**
 * Scrub `secrets` out of text on its way to a LOG LINE. `claude mcp add-json`
 * is handed the entry as one argv element, and a host that rejects it may
 * quote the payload back in its error — which is how a bearer token would
 * otherwise reach stderr through a message nobody wrote by hand.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * An entry as JSON for a human to read, header VALUES masked. The names stay:
 * they say what has to be re-supplied without disclosing any of it.
 */
function entryForLog(entry: McpServerEntry): string {
  const headers = entry.headers;
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    return JSON.stringify(entry);
  }
  const masked = Object.fromEntries(
    Object.keys(headers as Record<string, unknown>).map((name) => [name, '<redacted>']),
  );
  return JSON.stringify({ ...entry, headers: masked });
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
  probeRemote?: RemoteProber;
  oauthStorePath?: string;
  /**
   * Offered the servers that only need a login. Returns true if it obtained
   * one, which makes `on` re-run the wrap so they go live immediately.
   *
   * Supplied ONLY by the interactive CLI: it opens a browser, so a hook or a
   * script must never trigger it. Its absence is what keeps `sync` silent
   * here and `on` non-interactive when piped.
   */
  onNeedsAuth?: (servers: { name: string; url: string }[]) => Promise<boolean>;
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
    // The REPOSITORY ROOT, matching what the host calls this project (see
    // hostConfig.projectRoot). Using it here too keeps one identity across
    // discovery, the managed-state key and sync's hash, so `on` from a
    // subdirectory and `off` from the root are the same project.
    cwd: projectRoot(opts.cwd ?? process.cwd()),
    self: opts.self,
    runner: opts.runner ?? execFileRunner,
    get claudeBin(): string {
      bin ??= resolveClaudeBin(process.env.SPECULATE_CLAUDE_BIN ?? 'claude');
      return bin;
    },
    statePath: opts.statePath ?? managedStatePath(),
    log: opts.log ?? ((line) => process.stderr.write(`${line}\n`)),
    probeRemote: opts.probeRemote ?? probeRemote,
    oauthStorePath: opts.oauthStorePath ?? oauthStorePath(),
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
   * How many Speculate-owned local shadows were REMOVED because the approved
   * `.mcp.json` entry they stood on is gone — approval revoked, or the server
   * no longer in the file at all. Counted separately from `changed` so `sync`
   * knows its managed record needs rewriting even on a pass that wrapped
   * nothing.
   */
  shadowsRemoved: number;
  /**
   * How many wrapped PLUGIN copies were torn down because their licence is
   * gone — the plugin uninstalled or disabled, its server gone from the
   * manifest, or the user opting out through the host's own switches.
   * Counted apart from `shadowsRemoved` so `sync` can name each kind.
   */
  pluginShadowsRemoved: number;
  /**
   * True when the pass stopped early because `opts.deadline` had passed, so
   * servers were left unvisited. The pass is INCOMPLETE: callers must not
   * record anything that claims the whole set was handled (`sync`'s hash).
   */
  timedOut: boolean;
  /**
   * Servers left unwrapped ONLY because Speculate has no login for them, and
   * that `speculate auth` would fix. Carried out of the pass rather than just
   * logged, because it is the single manual step in an otherwise automatic
   * tool: `on` offers to do it on the spot, and `sync` names it once.
   */
  needsAuth: { name: string; url: string }[];
}

/**
 * Why this remote server must be left unwrapped, or null to go ahead.
 *
 * Costs one HTTP round trip per NEW remote server. Already-wrapped servers
 * return earlier (isWrappedEntry), so a steady-state `sync` pays nothing, and
 * a probe that times out only defers wrapping to the next session.
 *
 * The returned string is logged: it names header VARIABLES but never values,
 * and never the server's response body.
 */
async function remoteWrapBlocker(
  ctx: Ctx,
  name: string,
  remote: Extract<RemoteWrapPlan, { wrappable: true }>,
): Promise<{ reason: string; fixableByAuth?: boolean } | null> {
  const resolved = resolveWrapHeaders(remote.headers);
  if (!resolved.ok) return { reason: `header variable \${${resolved.missing}} is not set` };
  const probe = await ctx.probeRemote(remote.url, resolved.headers);
  if (probe.kind === 'ok') return null;
  if (probe.kind !== 'needs-auth') return { reason: probe.reason };
  // The server wants a login. If the user has already given Speculate one,
  // the wrapped proxy will connect with it (the store is consulted by URL at
  // proxy startup), so this is wrappable after all.
  if (readOAuthRecord(ctx.oauthStorePath, remote.url)?.tokens) return null;
  return { reason: `needs authorization — run: speculate auth ${name}`, fixableByAuth: true };
}

// -- plugin-declared servers (the §13.23 fifth row) -------------------------------

/**
 * Env marker stamped into every wrapped plugin copy, holding the qualified
 * name of the plugin server it stands in for. Env survives verbatim in host
 * config and is inert in the child, so the copy stays self-describing even
 * with the state file lost — which is what lets a stateless `off` remove the
 * copy AND the disable entry instead of leaking a disabled original forever.
 */
export const PLUGIN_ORIGIN_ENV = 'SPECULATE_PLUGIN_ORIGIN';

/** The qualified plugin name a wrapped copy claims to stand in for, if any. */
function pluginOriginOf(entry: McpServerEntry): string | null {
  if (!isWrappedEntry(entry)) return null;
  const env = entry.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return null;
  const marker = (env as Record<string, unknown>)[PLUGIN_ORIGIN_ENV];
  return typeof marker === 'string' && marker.length > 0 ? marker : null;
}

/**
 * The wrapped copy for one plugin server. Beyond the ordinary wrap, two env
 * additions keep the copy faithful and self-describing:
 *
 *   - stdio children get `CLAUDE_PLUGIN_ROOT`, because the host injects it
 *     into plugin-declared processes (measured) and a server's code may read
 *     it. Injected FIRST so a plugin's own env value wins, matching the
 *     host's spread order. (`CLAUDE_PLUGIN_DATA` is NOT replicated — its
 *     derivation is the host's — which is a documented limitation for stdio
 *     servers whose code reads it.)
 *   - the SPECULATE_PLUGIN_ORIGIN marker, last, so nothing overrides it.
 */
function wrapPluginCopy(
  ps: PluginScopedServer,
  self: { command: string; args: string[] },
  mode?: SpeculationMode,
): McpServerEntry {
  const env: Record<string, string> = {
    ...(isStdioEntry(ps.entry) ? { CLAUDE_PLUGIN_ROOT: ps.root } : {}),
    ...(ps.entry.env ?? {}),
    [PLUGIN_ORIGIN_ENV]: ps.qualifiedName,
  };
  return wrapEntry({ ...ps.entry, env }, self, { mode });
}

/**
 * Add or remove one plugin-qualified name in the project record's
 * `disabledMcpServers` array — the host's own per-project switch for plugin
 * servers, the key its /mcp UI writes, and the ONE key Speculate edits in a
 * host-owned file directly (no CLI writes it; the invariant amendment is
 * documented in the spec and DESIGN.md).
 *
 * The write is held to the same discipline as managed.json: re-read the file
 * at call time, mutate only this one array in this one project record, and
 * write tmp + rename so a crash never leaves a torn file. The project record
 * is never CREATED here — by the time a disable is needed, the front-door
 * `add-json` that registered the copy has already made the host create it,
 * so a missing record means something is wrong and the caller rolls back.
 *
 * Removing is tolerant where adding is strict: `off` must succeed against a
 * record (or file) that is already gone, because there is nothing left to
 * re-enable and failing would strand the restore.
 */
function setPluginServerDisabled(
  ctx: Ctx,
  qualifiedName: string,
  disabled: boolean,
): { ok: true } | { ok: false; reason: string } {
  const path = claudeJsonPath(ctx.home);
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return disabled ? { ok: false, reason: `${path} is not a JSON object` } : { ok: true };
    }
    config = parsed as Record<string, unknown>;
  } catch (err) {
    // Unreadable file: nothing can have been disabled in it, so a removal is
    // already complete; an add has nowhere safe to land.
    return disabled ? { ok: false, reason: `cannot read ${path}: ${(err as Error).message}` } : { ok: true };
  }
  const projects =
    config.projects !== null && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? (config.projects as Record<string, unknown>)
      : null;
  if (!projects) {
    return disabled ? { ok: false, reason: `no projects record in ${path}` } : { ok: true };
  }
  // The EXISTING key, found the way the host would (exact first, then
  // separator/case-normalized): writing under a second spelling of the same
  // project would leave two records disagreeing about the same server.
  let key: string | null = Object.prototype.hasOwnProperty.call(projects, ctx.cwd) ? ctx.cwd : null;
  if (key === null) {
    const want = normalizeProjectKey(ctx.cwd);
    for (const candidate of Object.keys(projects)) {
      if (normalizeProjectKey(candidate) === want) {
        key = candidate;
        break;
      }
    }
  }
  if (key === null || projects[key] === null || typeof projects[key] !== 'object') {
    return disabled ? { ok: false, reason: `no project record for ${ctx.cwd} in ${path}` } : { ok: true };
  }
  const record = projects[key] as Record<string, unknown>;
  // The raw array is preserved verbatim — junk elements included — and only
  // our one entry is added or removed. This function edits a host-owned
  // file; the least it can do is touch nothing it does not own.
  const current = Array.isArray(record.disabledMcpServers)
    ? (record.disabledMcpServers as unknown[])
    : [];
  // Already in the desired state — never rewrite the host's file for a no-op.
  if (disabled === current.includes(qualifiedName)) return { ok: true };
  record.disabledMcpServers = disabled
    ? [...current, qualifiedName]
    : current.filter((v) => v !== qualifiedName);
  try {
    const tmp = `${path}.speculate-tmp`;
    let mode = 0o600;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      // stat raced a concurrent rewrite: keep the restrictive default.
    }
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `cannot write ${path}: ${(err as Error).message}` };
  }
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
  let shadowsRemoved = 0;
  let pluginShadowsRemoved = 0;
  const needsAuth: { name: string; url: string }[] = [];
  const projectScopeNames = new Set(
    view.servers.filter((s) => s.scope === 'project').map((s) => s.name),
  );
  const outOfTime = (name: string): WrapOutcome => {
    ctx.log(`[speculate] out of time before ${name} — the next run picks it up`);
    return { changed, failed, shadowsRemoved, pluginShadowsRemoved, timedOut: true, needsAuth };
  };

  for (const [name, scoped] of effectiveServers(view.servers)) {
    if (opts.deadline !== undefined && performance.now() >= opts.deadline) {
      return outOfTime(name);
    }
    if (name === WORKSPACE_SERVER_NAME) continue;
    if (name.startsWith('-')) {
      // `claude mcp remove/add-json` take the name positionally; a leading
      // dash would be parsed as an option. Leave such servers untouched.
      ctx.log(`[speculate] ${name}: skipped (name starts with '-')`);
      continue;
    }
    // The shadow's licence is gone: this local entry is a wrapped copy WE
    // registered for an APPROVED .mcp.json server, and that server is no
    // longer both present and approved. Two ways it gets there, and they are
    // one condition, not two — the approval was revoked, or the server left
    // `.mcp.json` altogether (a git pull, a branch switch, an edit, or the
    // file deleted). Nothing else would notice either: the shadow wins the
    // scope contest, so it stays registered and running at a scope with no
    // approval gate, for a server the project no longer declares. Remove it,
    // leaving whatever the project actually declares (a pending entry, or
    // nothing at all) as the only thing left.
    //
    // Strictly "our own": the managed record says WE created this shadow
    // (action 'shadowed') and it is still a Speculate wrap. A local entry the
    // user wrapped themselves is theirs, and stays exactly where they put it.
    // The corollary is conservative by design — with the state file lost or
    // corrupt there is no record, so the shadow survives, the same stance
    // `off` takes when it cannot prove a local entry was a shadow.
    if (
      scoped.scope === 'local' &&
      !(projectScopeNames.has(name) && view.approvedProjectServers.has(name)) &&
      managed.get(managedKey('local', name))?.action === 'shadowed' &&
      // Still OUR shadow, not something the user has since replaced it with:
      // a record plus an entry that is no longer a Speculate wrap means the
      // local entry stopped being ours, whatever the state file remembers.
      isWrappedEntry(scoped.entry)
    ) {
      const res = await mcpRemove(ctx, name, 'local');
      if (res.code !== 0) {
        ctx.log(
          `[speculate] ${name}: shadow removal failed: ${redactSecrets((res.stderr || res.stdout).trim(), entrySecrets(scoped.entry))}`,
        );
        failed++;
        continue;
      }
      managed.delete(managedKey('local', name));
      ctx.log(
        projectScopeNames.has(name)
          ? `[speculate] ${name}: .mcp.json approval revoked — wrapped shadow removed (pending again)`
          : `[speculate] ${name}: gone from .mcp.json — wrapped shadow removed`,
      );
      shadowsRemoved++;
      changed++;
      continue;
    }
    if (isWrappedEntry(scoped.entry)) {
      ctx.log(`[speculate] ${name}: already wrapped — skipping`);
      continue;
    }
    // Remote (streamable-HTTP) servers are wrapped too — that is where the
    // latency is — but only when the entry ITSELF is enough to connect: its
    // own token, or no auth at all. A connector the HOST holds credentials
    // for is not in local config to begin with, so it is not reachable from
    // here and nothing below goes looking for it.
    const remote = planRemoteWrap(scoped.entry);
    if (!isStdioEntry(scoped.entry) && !remote?.wrappable) {
      ctx.log(
        `[speculate] ${name}: ${remote ? remote.reason : 'non-stdio'} — passed through unwrapped`,
      );
      continue;
    }
    // The entry LOOKS connectable. Now find out whether it actually is,
    // because for a remote server those are different questions: an
    // OAuth-protected server and an open one are byte-identical in host
    // config (remoteProbe.ts). Wrapping one we cannot reach would take a
    // working server away from the user, so a non-`ok` answer always leaves
    // the server exactly as it was.
    if (remote?.wrappable) {
      const blocker = await remoteWrapBlocker(ctx, name, remote);
      if (blocker) {
        if (blocker.fixableByAuth) needsAuth.push({ name, url: remote.url });
        ctx.log(`[speculate] ${name}: ${blocker.reason} — passed through unwrapped`);
        continue;
      }
    }
    const wrapped = wrapEntry(scoped.entry, ctx.self, { mode: opts.mode ?? undefined });
    // Header values, for scrubbing every failure message below: the host CLI
    // is handed the entry as one argv element and may quote it back.
    const secrets = entrySecrets(scoped.entry);

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
        ctx.log(
          `[speculate] ${name}: shadow failed: ${redactSecrets((res.stderr || res.stdout).trim(), secrets)}`,
        );
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
      ctx.log(
        `[speculate] ${name}: remove failed: ${redactSecrets((removed.stderr || removed.stdout).trim(), secrets)}`,
      );
      failed++;
      continue;
    }
    const added = await mcpAddJson(ctx, name, wrapped, scoped.scope);
    if (added.code !== 0) {
      // Put the original back rather than leave the server missing.
      const restored = await mcpAddJson(ctx, name, scoped.entry, scoped.scope);
      // The recovery command is printed with header VALUES masked: they are
      // the user's own, from their own config, and printing them to a
      // terminal (or a hook's captured output) would be irreversible.
      ctx.log(
        `[speculate] ${name}: wrap failed (${redactSecrets((added.stderr || added.stdout).trim(), secrets)}); ` +
          (restored.code === 0
            ? 'original restored'
            : `RESTORE ALSO FAILED — re-add manually: claude mcp add-json ${name} '${entryForLog(scoped.entry)}' -s ${scoped.scope}` +
              (secrets.length ? ' (header values are yours to fill back in)' : '')),
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
    ctx.log(
      `[speculate] ${name}: wrapped (${scoped.scope} scope${remote?.wrappable ? ', remote' : ''})`,
    );
    opts.onWrapped?.(name);
    changed++;
  }

  // -- plugin-declared servers (the §13.23 fifth row; see the 2026-08-05 spec).
  //
  // Two passes. The first audits every existing plugin wrap against its
  // licence and tears down the ones whose licence is gone; the second wraps
  // what is eligible and repairs drift. Teardown runs first so a record it
  // deletes cannot confuse the wrap pass.
  const localByName = new Map(
    view.servers.filter((s) => s.scope === 'local').map((s) => [s.name, s]),
  );
  const anyScopeNames = new Map<string, ScopedServer>();
  for (const s of view.servers) if (!anyScopeNames.has(s.name)) anyScopeNames.set(s.name, s);
  const pluginByQual = new Map(view.pluginServers.map((p) => [p.qualifiedName, p]));
  const disabledSet = new Set(view.disabledMcpServers);

  for (const rec of [...managed.values()]) {
    if (rec.action !== 'pluginShadowed') continue;
    if (opts.deadline !== undefined && performance.now() >= opts.deadline) {
      return outOfTime(rec.name);
    }
    const qual = rec.pluginServer;
    const current = qual ? pluginByQual.get(qual) : undefined;
    const local = localByName.get(rec.name);
    const copyIsOurs =
      local !== undefined && isWrappedEntry(local.entry) && pluginOriginOf(local.entry) === qual;
    // The user disabling the COPY through the host's own switch is the
    // per-server opt-out: honor it by restoring the original and standing
    // down (the wrap pass below refuses to re-wrap while that entry stands).
    const userOptedOut = disabledSet.has(rec.name);
    const healthy =
      !userOptedOut &&
      qual !== undefined &&
      current !== undefined &&
      current.unwrappableReason === null &&
      copyIsOurs &&
      disabledSet.has(qual);
    if (healthy) continue; // drift, if any, is the wrap pass's job
    // Repair before teardown: a live wrap whose disable entry alone is gone
    // (the original re-enabled in /mcp, or the entry lost) is DEGRADED — both
    // copies run and every tool doubles — not revoked. The wrap opt-outs are
    // `speculate off` and disabling the copy; the managed record plus the
    // still-present copy says the wrap itself is wanted, so the pair is made
    // whole again, and status says so rather than leaving the repair silent.
    if (
      !userOptedOut &&
      qual !== undefined &&
      current !== undefined &&
      current.unwrappableReason === null &&
      copyIsOurs &&
      !disabledSet.has(qual)
    ) {
      const repaired = setPluginServerDisabled(ctx, qual, true);
      if (repaired.ok) {
        disabledSet.add(qual);
        ctx.log(
          `[speculate] ${qual}: re-disabled the plugin original (its wrapped copy '${rec.name}' is live; ` +
            `to unwrap it, disable '${rec.name}' in /mcp or run 'speculate off')`,
        );
        changed++;
      } else {
        ctx.log(`[speculate] ${qual}: could not re-disable the plugin original: ${repaired.reason}`);
        failed++;
      }
      continue;
    }
    // Teardown: re-enable first, then remove the copy — the mirror of the
    // wrap order, so a crash in between leaves both running, never neither.
    if (qual !== undefined && disabledSet.has(qual)) {
      const enabled = setPluginServerDisabled(ctx, qual, false);
      if (!enabled.ok) {
        ctx.log(`[speculate] ${qual}: could not re-enable the plugin original: ${enabled.reason}`);
        failed++;
        continue; // keep the record; the next pass retries the whole restore
      }
      disabledSet.delete(qual);
    }
    if (copyIsOurs) {
      const res = await mcpRemove(ctx, rec.name, 'local');
      if (res.code !== 0) {
        ctx.log(
          `[speculate] ${rec.name}: plugin copy removal failed: ${redactSecrets((res.stderr || res.stdout).trim(), entrySecrets(local!.entry))}`,
        );
        failed++;
        continue; // record kept: the disable is already lifted, so retrying is safe
      }
      localByName.delete(rec.name);
      anyScopeNames.delete(rec.name);
    }
    managed.delete(managedKey('local', rec.name));
    ctx.log(
      userOptedOut
        ? `[speculate] ${qual ?? rec.name}: copy disabled in Claude Code — wrap removed, plugin original back in effect`
        : `[speculate] ${qual ?? rec.name}: plugin server gone or no longer wrappable — wrap removed`,
    );
    pluginShadowsRemoved++;
    changed++;
  }

  for (const ps of view.pluginServers) {
    if (opts.deadline !== undefined && performance.now() >= opts.deadline) {
      return outOfTime(ps.qualifiedName);
    }
    const qual = ps.qualifiedName;
    const copyName = ps.serverName;
    const rec = managed.get(managedKey('local', copyName));
    const recIsThis = rec?.action === 'pluginShadowed' && rec.pluginServer === qual;
    // A qualified name in the disable list that no record of ours claims is
    // the USER's disable — their consent decision, never overridden and
    // never removed.
    if (disabledSet.has(qual) && !recIsThis) {
      ctx.log(`[speculate] ${qual}: disabled in Claude Code — left alone`);
      continue;
    }
    // A disabled COPY name is the per-server opt-out the teardown pass
    // honors; while the user keeps that entry, the server stays unwrapped.
    if (disabledSet.has(copyName)) {
      ctx.log(`[speculate] ${qual}: wrap opted out ('${copyName}' is disabled in Claude Code) — skipping`);
      continue;
    }
    if (recIsThis) {
      // Healthy wrap (teardown above already handled everything else) —
      // refresh the copy if the plugin's declaration has drifted under it
      // (a plugin update moves the versioned root, changing baked paths).
      const local = localByName.get(copyName);
      if (!local) continue;
      const expected = wrapPluginCopy(ps, ctx.self, opts.mode);
      const canon = (e: McpServerEntry): string => JSON.stringify(canonicalizeForHash(e));
      if (canon(local.entry) === canon(expected)) {
        ctx.log(`[speculate] ${qual}: already wrapped as '${copyName}' — skipping`);
        continue;
      }
      const secrets = [...entrySecrets(local.entry), ...entrySecrets(ps.entry)];
      const removed = await mcpRemove(ctx, copyName, 'local');
      if (removed.code !== 0) {
        ctx.log(
          `[speculate] ${qual}: stale copy removal failed: ${redactSecrets((removed.stderr || removed.stdout).trim(), secrets)}`,
        );
        failed++;
        continue;
      }
      const added = await mcpAddJson(ctx, copyName, expected, 'local');
      if (added.code !== 0) {
        // Put the previous copy back rather than leave the pair broken.
        const restored = await mcpAddJson(ctx, copyName, local.entry, 'local');
        ctx.log(
          `[speculate] ${qual}: refresh failed (${redactSecrets((added.stderr || added.stdout).trim(), secrets)}); ` +
            (restored.code === 0 ? 'previous copy restored' : 'RESTORE ALSO FAILED — run speculate off'),
        );
        failed++;
        continue;
      }
      ctx.log(`[speculate] ${qual}: refreshed the wrapped copy (plugin updated)`);
      changed++;
      continue;
    }
    if (copyName.startsWith('-') || copyName === WORKSPACE_SERVER_NAME) {
      ctx.log(`[speculate] ${qual}: copy name '${copyName}' is not usable — skipping`);
      continue;
    }
    if (ps.unwrappableReason !== null) {
      ctx.log(`[speculate] ${qual}: ${ps.unwrappableReason} — passed through unwrapped`);
      continue;
    }
    const existing = anyScopeNames.get(copyName);
    if (existing) {
      // Crash recovery: a marked copy with no record means a previous pass
      // died between `add-json` and the disable. Adopt it — complete the
      // disable and the record — instead of skipping a half-made wrap.
      if (
        existing.scope === 'local' &&
        isWrappedEntry(existing.entry) &&
        pluginOriginOf(existing.entry) === qual
      ) {
        if (!disabledSet.has(qual)) {
          const dis = setPluginServerDisabled(ctx, qual, true);
          if (!dis.ok) {
            ctx.log(`[speculate] ${qual}: could not disable the plugin original: ${dis.reason}`);
            failed++;
            continue;
          }
          disabledSet.add(qual);
        }
        managed.set(managedKey('local', copyName), {
          name: copyName,
          scope: 'local',
          action: 'pluginShadowed',
          pluginServer: qual,
        });
        ctx.log(`[speculate] ${qual}: adopted a half-finished wrap as '${copyName}' (disable completed)`);
        opts.onWrapped?.(qual);
        changed++;
        continue;
      }
      ctx.log(
        `[speculate] ${qual}: copy name '${copyName}' is taken by an existing ${existing.scope} server — skipping`,
      );
      continue;
    }
    const remote = planRemoteWrap(ps.entry);
    if (!isStdioEntry(ps.entry) && !remote?.wrappable) {
      ctx.log(
        `[speculate] ${qual}: ${remote ? remote.reason : 'non-stdio'} — passed through unwrapped`,
      );
      continue;
    }
    if (remote?.wrappable) {
      const blocker = await remoteWrapBlocker(ctx, qual, remote);
      if (blocker) {
        if (blocker.fixableByAuth) needsAuth.push({ name: qual, url: remote.url });
        ctx.log(`[speculate] ${qual}: ${blocker.reason} — passed through unwrapped`);
        continue;
      }
    }
    // Copy first, then disable: a crash in between leaves BOTH running
    // (duplicated tools for one session, adopted and completed by the next
    // pass via the marker) — disable-first would leave the server gone.
    const wrapped = wrapPluginCopy(ps, ctx.self, opts.mode);
    const secrets = entrySecrets(ps.entry);
    const added = await mcpAddJson(ctx, copyName, wrapped, 'local');
    if (added.code !== 0) {
      ctx.log(
        `[speculate] ${qual}: wrap failed: ${redactSecrets((added.stderr || added.stdout).trim(), secrets)}`,
      );
      failed++;
      continue;
    }
    const dis = setPluginServerDisabled(ctx, qual, true);
    if (!dis.ok) {
      // Roll the copy back rather than leave a permanent duplicate pair.
      const rolledBack = await mcpRemove(ctx, copyName, 'local');
      ctx.log(
        `[speculate] ${qual}: could not disable the plugin original (${dis.reason}) — ` +
          (rolledBack.code === 0 ? 'copy rolled back' : `ROLLBACK ALSO FAILED — remove manually: claude mcp remove ${copyName} -s local`),
      );
      failed++;
      continue;
    }
    disabledSet.add(qual);
    managed.set(managedKey('local', copyName), {
      name: copyName,
      scope: 'local',
      action: 'pluginShadowed',
      pluginServer: qual,
    });
    anyScopeNames.set(copyName, { name: copyName, scope: 'local', entry: wrapped });
    localByName.set(copyName, { name: copyName, scope: 'local', entry: wrapped });
    ctx.log(
      `[speculate] ${qual}: wrapped as '${copyName}' (local copy; plugin original disabled${remote?.wrappable ? ', remote' : ''})`,
    );
    opts.onWrapped?.(qual);
    changed++;
  }

  return { changed, failed, shadowsRemoved, pluginShadowsRemoved, timedOut: false, needsAuth };
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
 * last-resort exit (120s — see the comment on that timer in cli.ts, including
 * why the arithmetic is only the weak form of the guarantee): a shorter
 * host-side timeout kills a wrap in flight, reopening the very window — a
 * server deleted between `mcp remove` and `mcp add-json` — that the
 * cooperative deadline exists to close. It is a ceiling that should never be
 * approached: the fast path costs two file reads.
 *
 * Kept in step with the shipped plugin/hooks/hooks.json template, which the
 * generator below overwrites at install time (a test pins the two together).
 */
const AUTOWRAP_HOOK_TIMEOUT_S = 150;

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

/** Does one `plugin list --json` record name the auto-wrap plugin (exactly)? */
function isAutowrapRecord(item: unknown): boolean {
  if (typeof item === 'string') return AUTOWRAP_PLUGIN_MATCH.has(item);
  if (!item || typeof item !== 'object') return false;
  const rec = item as Record<string, unknown>;
  for (const field of ['id', 'name'] as const) {
    const value = rec[field];
    if (typeof value === 'string' && AUTOWRAP_PLUGIN_MATCH.has(value)) return true;
  }
  return false;
}

/** What the host reports about an installed copy; both fields are optional. */
interface AutowrapInstall {
  version?: string;
  installPath?: string;
}

/**
 * The host's record for our plugin, or null when it isn't installed. Same
 * two payload shapes `pluginListHas` handles, but the RECORD is kept: `on`
 * needs the reported `version` and `installPath` to tell a current install
 * from one it has to refresh.
 */
function autowrapRecord(parsed: unknown): AutowrapInstall | null {
  const fields = (item: unknown): AutowrapInstall => {
    const rec = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      ...(typeof rec['version'] === 'string' ? { version: rec['version'] } : {}),
      ...(typeof rec['installPath'] === 'string' ? { installPath: rec['installPath'] } : {}),
    };
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) if (isAutowrapRecord(item)) return fields(item);
    return null;
  }
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isAutowrapRecord(key) || isAutowrapRecord(value)) return fields(value);
    }
  }
  return null;
}

/**
 * Fail-soft check (same shared plugin list as detectLegacyPlugin, matching a
 * different, disjoint id): is the auto-wrap plugin installed?
 */
async function detectAutowrapPlugin(ctx: Ctx): Promise<boolean> {
  return autowrapRecord(await fetchPluginList(ctx)) !== null;
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
 * The hook's command line, with both file paths baked at install time.
 *
 * Never a bare `speculate`: Claude Code cannot exec a `.cmd` shim as a hook on
 * Windows, and npm installs `speculate` as one. `node` by NAME is a different
 * case and is deliberate: node/node.exe is a real executable, so PATH
 * resolution works where a shim would not — and it self-heals the one thing a
 * baked `process.execPath` cannot survive, an nvm/fnm/volta version switch
 * that deletes the interpreter the hook was pinned to. `ctx.self.command` is
 * therefore intentionally unused here; only its ARGS are baked.
 *
 * This is a trade, not a strict improvement: a GUI-launched host (e.g. a
 * desktop app opened from a dock/Start Menu icon) inherits whatever PATH the
 * OS session set up, which may lack the nvm/fnm shim directory entirely, and
 * a bare `node` there resolves to nothing or the wrong interpreter, whereas
 * a baked `process.execPath` would have kept working. PATH resolution wins
 * the common case (a terminal-launched host, where version managers live)
 * at the cost of that less common one.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is the host's own expansion for the INSTALLED plugin
 * directory and has to be used for the wrapper, because `claude plugin
 * install` COPIES the plugin: a path into the npm package is precisely the
 * path that disappears on `npm uninstall`, which is the case the wrapper
 * exists to survive. The CLI path after it may well disappear too — the
 * wrapper checks it and exits 0 silently.
 */
function autowrapHookCommand(self: { command: string; args: string[] }): string {
  const quoted = (s: string): string => `"${s}"`;
  return [
    'node',
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
 */
function stageAutowrapPlugin(ctx: Ctx, root: string): string {
  const dest = join(dirname(ctx.statePath), 'autowrap');
  // 0o700, like every other creator of the state directory: on a first-ever
  // `on` this runs BEFORE the first saveManagedState, so it is what CREATES
  // that directory, and a default 0755 here would be the one path that left
  // it world-readable for good.
  mkdirSync(join(dest, '.claude-plugin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dest, 'plugin', '.claude-plugin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dest, 'plugin', 'hooks'), { recursive: true, mode: 0o700 });
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

/** The version the shipped plugin manifest declares, or null if unreadable. */
function shippedPluginVersion(root: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Is the copy the host already has still the one THIS Speculate would install?
 *
 * Two ways it stops being: `claude plugin install` caches per version, so a
 * newer plugin never reaches anyone who already has an older one; and the hook
 * command bakes this install's absolute CLI path, which an npm move (or a
 * checkout that became a global install) invalidates. Either way the hook
 * would keep running the OLD copy forever, so `on` reinstalls.
 *
 * Only positive evidence of staleness counts. A host that reports neither a
 * version nor an install path, or an install path we cannot read, leaves a
 * working install alone: reinstalling on every `on` would be worse than the
 * problem.
 *
 * Repeated refreshes on every `on` are expected, not a bug, in two narrow
 * cases: a host that does not round-trip the version string it was given
 * (so `installed.version` never matches `shipped`, forever); and a developer
 * who runs `speculate on` from both a source checkout and a global install
 * (`selfCommand` differs between the two, so the baked hook command flips
 * back and forth and each run sees the other's copy as stale).
 */
function autowrapInstallIsCurrent(ctx: Ctx, root: string, installed: AutowrapInstall): boolean {
  const shipped = shippedPluginVersion(root);
  if (shipped !== null && installed.version !== undefined && installed.version !== shipped) {
    return false;
  }
  if (installed.installPath !== undefined) {
    try {
      const hooks = JSON.parse(
        readFileSync(join(installed.installPath, 'hooks', 'hooks.json'), 'utf8'),
      ) as { hooks?: { SessionStart?: { hooks?: { command?: unknown }[] }[] } };
      const command = hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
      if (typeof command === 'string' && command !== autowrapHookCommand(ctx.self)) return false;
    } catch {
      // Unreadable: no evidence either way, so nothing to act on.
    }
  }
  return true;
}

/**
 * Install (or refresh) the auto-wrap plugin at user scope. Every step is
 * fail-soft: a failure logs ONE line and never aborts `on`, whose real work —
 * wrapping this project's servers — has nothing to do with it.
 *
 * User scope, not local, because the point is to catch servers added in
 * projects where nobody thought to run `speculate on`. `off` opts a single
 * project out through the state file rather than uninstalling this.
 */
async function installAutowrapPlugin(ctx: Ctx): Promise<void> {
  try {
    const installed = autowrapRecord(await fetchPluginList(ctx));
    const root = packageRoot();
    if (installed && (root === null || autowrapInstallIsCurrent(ctx, root, installed))) {
      ctx.log(
        '[speculate] auto-wrap: already installed (new servers wrap at the next session start)',
      );
      return;
    }
    if (root === null) {
      ctx.log(
        "[speculate] auto-wrap: plugin files not found — skipped ('speculate on' still wraps this project)",
      );
      return;
    }
    const source = stageAutowrapPlugin(ctx, root);
    if (installed) {
      // Measured: with the plugin already installed, `plugin install` is a
      // no-op ("is already installed") and `plugin update` reports "already at
      // the latest version" — NEITHER re-copies the plugin. Only an uninstall
      // first actually replaces the stale copy. This is the one place
      // Speculate uninstalls its own plugin, and it is gated on positive
      // evidence of staleness and immediately followed by the install below.
      const un = await ctx.runner(
        ctx.claudeBin,
        ['plugin', 'uninstall', '-s', 'user', AUTOWRAP_PLUGIN_ID],
        { cwd: ctx.cwd },
      );
      ctx.pluginList = undefined;
      if (un.code !== 0) {
        ctx.log(
          // Two lines, not one `&&` chain: PowerShell 5.1 (the default shell
          // on stock Windows) parse-errors on `&&`, so a chained recipe would
          // run NEITHER command at the moment the user is already stuck.
          `[speculate] auto-wrap: could not refresh the installed hook (${(un.stderr || un.stdout).trim() || `exit ${un.code}`}). Refresh it manually by running these in order:\n` +
            `[speculate]   ${ctx.claudeBin} plugin uninstall -s user ${AUTOWRAP_PLUGIN_ID}\n` +
            `[speculate]   speculate on`,
        );
        return;
      }
    }
    // Measured: adding an already-registered marketplace exits 0 ("already on
    // disk"), so this is expected to succeed on every run after the first. The
    // detail is kept anyway and reported only if the install that depends on
    // it fails.
    const add = await ctx.runner(ctx.claudeBin, ['plugin', 'marketplace', 'add', source], {
      cwd: ctx.cwd,
    });
    const ins = await ctx.runner(
      ctx.claudeBin,
      ['plugin', 'install', '-s', 'user', AUTOWRAP_PLUGIN_ID],
      { cwd: ctx.cwd },
    );
    // The installed set just changed: drop the memoized list (see
    // fetchPluginList) so a later detector doesn't read the pre-install answer.
    ctx.pluginList = undefined;
    if (ins.code === 0) {
      ctx.log(
        installed
          ? '[speculate] auto-wrap: refreshed — the installed hook now matches this install'
          : '[speculate] auto-wrap: installed — servers added later wrap at the next session start',
      );
      return;
    }
    const detail = (ins.stderr || ins.stdout).trim() || `exit ${ins.code}`;
    const addDetail = add.code === 0 ? '' : `; marketplace: ${(add.stderr || add.stdout).trim()}`;
    ctx.log(
      `[speculate] auto-wrap: not installed (${detail}${addDetail}) — 'speculate on' still wraps this project`,
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
  adoptLegacyProjectRecords(state, ctx.cwd);
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
  // `changed` counts a revoked shadow's removal too: it is a change `on`
  // made to the host, and the summary line must not under-report it.
  let { changed, failed, needsAuth } = await wrapEffectiveServers(ctx, view, managed, {
    mode: opts.mode ?? undefined,
  });
  // The one manual step in the whole tool, offered here instead of left as
  // homework. `opts.onNeedsAuth` is supplied only by the interactive CLI (it
  // opens a browser, so it must never fire from a hook or a script); when it
  // authorizes something, the wrap pass runs AGAIN so those servers are live
  // now rather than next session.
  if (needsAuth.length > 0 && opts.onNeedsAuth) {
    const authorized = await opts.onNeedsAuth(needsAuth);
    if (authorized) {
      const second = await wrapEffectiveServers(ctx, readClaudeServers({ home: ctx.home, cwd: ctx.cwd }), managed, {
        mode: opts.mode ?? undefined,
      });
      changed += second.changed;
      failed += second.failed;
      needsAuth = second.needsAuth;
    }
  }
  if (needsAuth.length > 0) {
    ctx.log(
      `[speculate] ${needsAuth.length} server${needsAuth.length > 1 ? 's need' : ' needs'} a login: ` +
        `run 'speculate auth' (${needsAuth.map((s) => s.name).join(', ')})`,
    );
  }
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
  // Seed sync's fast-path hash from the config AS `on` LEFT IT. Without this
  // the session right after every `on` found no hash for the project, took
  // the slow path — lock, full pass, one `claude mcp` probe per server — and
  // discovered there was nothing to do. Same rule as sync: only a pass with
  // no failures may claim "nothing has changed since this hash", or a
  // transient failure would be frozen in by a hash that skips the retry.
  if (failed === 0) {
    state.syncHashes = {
      ...(state.syncHashes ?? {}),
      [ctx.cwd]: effectiveServerHash(readClaudeServers({ home: ctx.home, cwd: ctx.cwd })),
    };
  }
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
  adoptLegacyProjectRecords(state, ctx.cwd);
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
  /**
   * How many USER-scope servers this run unwrapped. They are host-global —
   * every project sees them — while the opt-out `off` records is per project,
   * so this number is exactly the part of `off` that another project can
   * undo. See the note it prints below.
   */
  let userScopeUnwrapped = 0;
  const handled = new Set<string>();
  /**
   * Records whose undo did not complete. They are KEPT in the state file
   * rather than dropped with the rest: the recorded original is the only copy
   * of the entry left once the host's has been removed, and for a remote
   * server that entry holds the credential — which the failure message
   * deliberately does not print. Dropping it would destroy it.
   */
  const unfinished: ManagedEntry[] = [];

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
    if (entry.action === 'pluginShadowed') {
      // Restore order is the mirror of the wrap order: re-enable the plugin
      // original FIRST, then remove the copy — a crash in between leaves
      // both running for one session, never neither.
      if (entry.pluginServer) {
        const enabled = setPluginServerDisabled(ctx, entry.pluginServer, false);
        if (!enabled.ok) {
          ctx.log(
            `[speculate] ${entry.name}: could not re-enable ${entry.pluginServer}: ${enabled.reason}`,
          );
          failed++;
          unfinished.push(entry);
          continue;
        }
      }
      const res = await mcpRemove(ctx, entry.name, 'local');
      if (res.code !== 0) {
        ctx.log(
          `[speculate] ${entry.name}: plugin copy removal failed: ${(res.stderr || res.stdout).trim()}`,
        );
        failed++;
        unfinished.push(entry);
        continue;
      }
      ctx.log(
        `[speculate] ${entry.name}: plugin copy removed` +
          (entry.pluginServer ? ` (${entry.pluginServer} back in effect)` : ''),
      );
      continue;
    }
    const secrets = entrySecrets(entry.original ?? {});
    if (entry.action === 'added' || entry.action === 'shadowed') {
      const res = await mcpRemove(ctx, entry.name, entry.scope);
      if (res.code !== 0) {
        ctx.log(
          `[speculate] ${entry.name}: remove failed: ${redactSecrets((res.stderr || res.stdout).trim(), secrets)}`,
        );
        failed++;
        unfinished.push(entry);
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
      ctx.log(
        `[speculate] ${entry.name}: remove failed: ${redactSecrets((removed.stderr || removed.stdout).trim(), secrets)}`,
      );
      failed++;
      unfinished.push(entry);
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
      // The entry is printed with header VALUES masked, so the recovery line
      // is not itself a disclosure — which is exactly why the record has to
      // survive: it is now the only place the real values exist.
      ctx.log(
        `[speculate] ${entry.name}: restore failed (${redactSecrets((res.stderr || res.stdout).trim(), secrets)}) — ` +
          `re-add manually: claude mcp add-json ${entry.name} '${entryForLog(original)}' -s ${entry.scope}`,
      );
      ctx.log(
        `[speculate]   the exact original is still recorded in ${ctx.statePath} — rerunning 'speculate off' retries it`,
      );
      failed++;
      unfinished.push(entry);
      continue;
    }
    if (entry.scope === 'user') userScopeUnwrapped++;
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
    // A wrapped copy of a PLUGIN server carries its origin in the
    // SPECULATE_PLUGIN_ORIGIN env marker — the no-state proof of ownership.
    // Its restore lifts the disable BEFORE removing the copy (the same order
    // the recorded path uses: a crash in between leaves both running, never
    // neither), and never re-adds an unwrapped clone at local scope, which
    // would leak a plain copy of a server the plugin should own.
    const pluginOrigin = pluginOriginOf(scoped.entry);
    if (pluginOrigin) {
      const enabled = setPluginServerDisabled(ctx, pluginOrigin, false);
      if (!enabled.ok) {
        ctx.log(`[speculate] ${scoped.name}: could not re-enable ${pluginOrigin}: ${enabled.reason}`);
        failed++;
        continue; // keep the copy while the original stays disabled
      }
    }
    // A wrapped remote entry carries its credential in `--header` args, so
    // this net needs the same scrub the recorded path gets.
    const secrets = entrySecrets(scoped.entry);
    const removed = await mcpRemove(ctx, scoped.name, scoped.scope);
    if (removed.code !== 0) {
      ctx.log(
        `[speculate] ${scoped.name}: remove failed: ${redactSecrets((removed.stderr || removed.stdout).trim(), secrets)}`,
      );
      failed++;
      continue;
    }
    if (pluginOrigin) {
      ctx.log(`[speculate] ${scoped.name}: plugin copy removed (${pluginOrigin} back in effect)`);
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
      if (scoped.scope === 'user') userScopeUnwrapped++;
      ctx.log(`[speculate] ${scoped.name}: unwrapped (${scoped.scope} scope, reconstructed)`);
    } else {
      if (scoped.scope === 'user') userScopeUnwrapped++;
      ctx.log(`[speculate] ${scoped.name}: wrap removed (no original command recorded)`);
    }
  }

  if (record) {
    if (unfinished.length > 0) {
      state.projects[ctx.cwd] = { entries: unfinished, updatedAt: Date.now() };
    } else {
      delete state.projects[ctx.cwd];
    }
  }
  // Consume the marketplace-ownership flag exactly once (see on()).
  if (legacyCleanup.marketplaceRemoved) state.marketplaceAddedByOn = false;
  // Opt this project out of a later `sync`'s auto-wrap (see ManagedState.
  // syncOptOut) — the global plugin, if installed, would otherwise re-wrap
  // it at the next session start. `on` clears this.
  state.syncOptOut = { ...(state.syncOptOut ?? {}), [ctx.cwd]: true };
  // What `off` cannot do, said plainly. The servers it just unwrapped at USER
  // scope are shared by every project on this machine, while the opt-out it
  // records covers this project only — so the next session start in ANY other
  // project re-wraps them at user scope, and they come back wrapped here too,
  // within one session. Nothing short of removing the plugin stops that.
  if (userScopeUnwrapped > 0) {
    ctx.log(
      `[speculate] note: ${userScopeUnwrapped} of those live at USER scope, shared by every project — ` +
        'this opt-out covers this project only, so any other project’s next session start re-wraps them ' +
        'and they are wrapped here again.',
    );
  }
  if (await detectAutowrapPlugin(ctx)) {
    ctx.log(
      '[speculate] auto-wrap is still installed globally (this project is now opted out).',
    );
    ctx.log(
      `[speculate]   remove it everywhere with: ${ctx.claudeBin} plugin uninstall -s user ${AUTOWRAP_PLUGIN_ID}`,
    );
    // Uninstalling the plugin leaves the registration that supplied it behind,
    // pointing at a staged directory nothing else uses. Naming it here is the
    // difference between "removed" and "removed, mostly".
    ctx.log(
      `[speculate]   and its marketplace: ${ctx.claudeBin} plugin marketplace remove ${AUTOWRAP_MARKETPLACE_ID}`,
    );
  } else if (userScopeUnwrapped > 0) {
    // Detection is fail-soft (an older host has no `claude plugin` CLI at
    // all), so the one command that really stops it is named either way.
    ctx.log(
      `[speculate]   the only thing that stops that everywhere: ${ctx.claudeBin} plugin uninstall -s user ${AUTOWRAP_PLUGIN_ID}`,
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
  adoptLegacyProjectRecords(state, ctx.cwd);
  const record = state.projects[ctx.cwd];
  const managedNames = new Set((record?.entries ?? []).map((e) => e.name));
  let unwrapped = 0;
  let needAuth = 0;
  ctx.log(`[speculate] project: ${ctx.cwd}`);
  const effective = effectiveServers(view.servers);
  if (effective.size === 0 && view.pluginServers.length === 0) {
    ctx.log('[speculate] no MCP servers visible to Claude Code here');
  }
  const disabledSet = new Set(view.disabledMcpServers);
  const managedPluginByQual = new Map(
    (record?.entries ?? [])
      .filter((e) => e.action === 'pluginShadowed' && typeof e.pluginServer === 'string')
      .map((e) => [e.pluginServer!, e]),
  );
  // Ask every unwrapped remote server whether it would take us, ALL AT ONCE.
  // Without this, status reports "NOT wrapped (remote)" for an OAuth-protected
  // server and then advises running `on`, which will not wrap it either --
  // sending the user round a loop with no way to see why. Wrapped servers are
  // not probed: they are already working, and the answer would cost a round
  // trip to tell us so. Plugin-declared remotes are probed for the same
  // reason, keyed by their qualified name.
  const reachability = new Map<string, RemoteProbe>();
  await Promise.all([
    ...[...effective].map(async ([name, scoped]) => {
      if (name === WORKSPACE_SERVER_NAME || isWrappedEntry(scoped.entry)) return;
      const plan = planRemoteWrap(scoped.entry);
      if (!plan?.wrappable) return;
      const headers = resolveWrapHeaders(plan.headers);
      if (!headers.ok) return;
      try {
        reachability.set(name, await ctx.probeRemote(plan.url, headers.headers));
      } catch {
        // Diagnostics must not fail on a network hiccup; the label just falls
        // back to the plain "NOT wrapped (remote)".
      }
    }),
    ...view.pluginServers.map(async (ps) => {
      if (managedPluginByQual.has(ps.qualifiedName)) return;
      if (disabledSet.has(ps.qualifiedName) || disabledSet.has(ps.serverName)) return;
      if (ps.unwrappableReason !== null) return;
      const plan = planRemoteWrap(ps.entry);
      if (!plan?.wrappable) return;
      const headers = resolveWrapHeaders(plan.headers);
      if (!headers.ok) return;
      try {
        reachability.set(ps.qualifiedName, await ctx.probeRemote(plan.url, headers.headers));
      } catch {
        // Same fallback as above.
      }
    }),
  ]);
  for (const [name, scoped] of effective) {
    if (name === WORKSPACE_SERVER_NAME) {
      // A leftover ≤0.10 artifact, not a healthy managed server — reporting
      // it as "wrapped" would hide that CLI speculation was retired in 0.11.
      ctx.log(
        `[speculate]   ${name} (${scoped.scope}): legacy CLI-speculation server (retired in 0.11) — run 'speculate on' to remove`,
      );
      continue;
    }
    const remote = planRemoteWrap(scoped.entry);
    let stateLabel: string;
    if (isWrappedEntry(scoped.entry)) {
      // A wrapped REMOTE server no longer looks remote — it is a `wrap --url`
      // command line — so say which kind it is rather than let it read as a
      // wrapped local process.
      const url = unwrapEntry(scoped.entry)?.url;
      // Naming the login is what makes a later 401 legible: it is the
      // difference between "this server is broken" and "my token expired".
      const login = url && readOAuthRecord(ctx.oauthStorePath, url)?.tokens ? ', logged in' : '';
      const kind = url ? `, remote${login}` : '';
      stateLabel = managedNames.has(name) ? `wrapped (managed${kind})` : `wrapped${kind}`;
    } else if (remote?.wrappable) {
      const probe = reachability.get(name);
      const authorized = readOAuthRecord(ctx.oauthStorePath, remote.url)?.tokens !== undefined;
      if (probe?.kind === 'needs-auth' && !authorized) {
        stateLabel = `NOT wrapped (remote) — needs a login: run 'speculate auth ${name}'`;
        needAuth++;
      } else if (probe?.kind === 'unreachable') {
        stateLabel = `NOT wrapped (remote) — ${probe.reason}`;
      } else {
        stateLabel = `NOT wrapped (remote${authorized ? ', logged in' : ''})`;
        unwrapped++;
      }
    } else if (!isStdioEntry(scoped.entry)) {
      stateLabel = `${remote ? remote.reason : 'non-stdio'} — passed through`;
    } else {
      stateLabel = 'NOT wrapped';
      unwrapped++;
    }
    ctx.log(`[speculate]   ${name} (${scoped.scope}): ${stateLabel}`);
  }
  // The fifth row (§13.23): servers installed plugins declare. Their wrapped
  // copies already printed above as ordinary local servers; these lines tie
  // each original to its copy, or say why it was left alone.
  for (const ps of view.pluginServers) {
    const rec = managedPluginByQual.get(ps.qualifiedName);
    const copy = rec ? effective.get(rec.name) : undefined;
    const copyIsOurs =
      copy !== undefined &&
      isWrappedEntry(copy.entry) &&
      pluginOriginOf(copy.entry) === ps.qualifiedName;
    let stateLabel: string;
    if (copyIsOurs) {
      stateLabel = `wrapped as '${rec!.name}' (local copy; the plugin original is disabled)`;
    } else if (disabledSet.has(ps.qualifiedName)) {
      stateLabel = 'disabled in Claude Code — left alone';
    } else if (disabledSet.has(ps.serverName)) {
      stateLabel = `wrap opted out ('${ps.serverName}' is disabled in Claude Code)`;
    } else if (ps.unwrappableReason !== null) {
      stateLabel = `${ps.unwrappableReason} — passed through`;
    } else {
      const remote = planRemoteWrap(ps.entry);
      if (remote?.wrappable) {
        const probe = reachability.get(ps.qualifiedName);
        const authorized = readOAuthRecord(ctx.oauthStorePath, remote.url)?.tokens !== undefined;
        if (probe?.kind === 'needs-auth' && !authorized) {
          stateLabel = `NOT wrapped (remote) — needs a login: run 'speculate auth ${ps.qualifiedName}'`;
          needAuth++;
        } else if (probe?.kind === 'unreachable') {
          stateLabel = `NOT wrapped (remote) — ${probe.reason}`;
        } else {
          stateLabel = `NOT wrapped (remote${authorized ? ', logged in' : ''})`;
          unwrapped++;
        }
      } else if (!isStdioEntry(ps.entry)) {
        stateLabel = `${remote ? remote.reason : 'non-stdio'} — passed through`;
      } else {
        stateLabel = 'NOT wrapped';
        unwrapped++;
      }
    }
    ctx.log(`[speculate]   ${ps.qualifiedName} (plugin): ${stateLabel}`);
  }
  // The limit of everything above, stated once. Connectors enabled through
  // the claude.ai UI are held by the host, not written to any local MCP
  // config, so they are invisible here — and this makes no claim about
  // whether any exist, because from here that is unknowable.
  ctx.log(
    '[speculate] not listed: connectors added in the claude.ai UI — they are not in local MCP config, so nothing here can see or wrap them',
  );
  if (unwrapped > 0 && record) {
    ctx.log(
      `[speculate] ${unwrapped} server(s) added since 'speculate on' — run it again to wrap them`,
    );
  } else if (!record && unwrapped > 0) {
    ctx.log(`[speculate] run 'speculate on' to wrap them (or 'speculate try' for a zero-write trial)`);
  }
  // Counted apart from `unwrapped` because `on` alone does NOT fix these, and
  // advising it without saying so is the loop this whole block exists to break.
  if (needAuth > 0) {
    ctx.log(
      `[speculate] ${needAuth} server(s) need a login first: run 'speculate auth' (or say yes when 'speculate on' offers)`,
    );
  }
  if (await detectAutowrapPlugin(ctx)) {
    // The plugin being installed is only half the answer: `off` records a
    // per-project opt-out that `sync` honors before anything else, so in an
    // opted-out project "new servers wrap at the next session start" is
    // actively false — and this is the only place the opt-out surfaces at
    // all. Otherwise, say the quiet part out loud: the wrap a session-start
    // hook performs lands in the NEXT session, because the host snapshots
    // MCP config before running the hook. Measured, inherent, not hidden.
    ctx.log(
      state.syncOptOut?.[ctx.cwd]
        ? "[speculate]   auto-wrap: installed, but this project is opted out ('speculate off' did that) — run 'speculate on' here to re-enable"
        : '[speculate]   auto-wrap: installed (new servers wrap at the next session start)',
    );
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
