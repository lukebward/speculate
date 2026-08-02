/**
 * Claude Code MCP config discovery and entry wrapping (DESIGN.md §13.12).
 *
 * Read-only knowledge of where the host keeps its MCP server registry:
 *
 *   user scope     ~/.claude.json           top-level `mcpServers`
 *   project scope  <project>/.mcp.json      `mcpServers` (often checked in)
 *   local scope    ~/.claude.json           `projects[<project>].mcpServers`
 *
 * Same-named servers resolve local > project > user (verified against
 * Claude Code 2.1: the local entry wins; the host emits a "conflicting
 * scopes" diagnostic but uses exactly one).
 *
 * Everything here is pure reading and pure transformation. The things
 * that WRITE — `try` (a throwaway generated config) and `on`/`off` (the
 * host's own `claude mcp` CLI) — live in tryRun.ts and manage.ts.
 *
 * Wrapped entries are self-describing: the original command line survives
 * verbatim after the `--`, and env is carried unchanged. unwrapEntry()
 * can therefore reconstruct the original from the entry alone — no state
 * file required — which is what makes `speculate off` safe even after a
 * lost or stale state file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  [key: string]: unknown;
}

export type ClaudeScope = 'user' | 'project' | 'local';

export interface ScopedServer {
  name: string;
  scope: ClaudeScope;
  entry: McpServerEntry;
}

export interface ClaudeConfigView {
  servers: ScopedServer[];
  /**
   * Project-scope (.mcp.json) approval state, read from the host's own
   * records: Claude Code asks per-project consent for checked-in servers,
   * and anything Speculate generates must respect the same consent.
   */
  approvedProjectServers: Set<string>;
  projectApprovalKnown: boolean;
  warnings: string[];
}

/**
 * The server name a <=0.10 install registered for CLI speculation. Nothing
 * writes it any more (the tier was retired in 0.11); it survives so
 * manage.ts can recognize and remove the leftover entry on upgrade.
 */
export const WORKSPACE_SERVER_NAME = 'speculate-workspace';

function readJsonFile(path: string, warnings: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`${path}: not a JSON object — ignored`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    warnings.push(`${path}: unreadable (${(err as Error).message}) — ignored`);
    return null;
  }
}

function serverMap(raw: unknown): Record<string, McpServerEntry> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      out[name] = entry as McpServerEntry;
    }
  }
  return out;
}

/**
 * Where Claude Code keeps `.claude.json`. `CLAUDE_CONFIG_DIR` relocates the
 * host's whole config directory; when it's set the file is NOT under $HOME,
 * so reading `<home>/.claude.json` would miss every user/local server and
 * all approval state. Honor the same override the host does.
 */
export function claudeJsonPath(home: string): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir && dir.length > 0 ? resolve(dir, '.claude.json') : resolve(home, '.claude.json');
}

/** Discover every MCP server Claude Code would see for `cwd`. Read-only. */
export function readClaudeServers(opts: { home: string; cwd: string }): ClaudeConfigView {
  const warnings: string[] = [];
  const servers: ScopedServer[] = [];
  const cwd = resolve(opts.cwd);

  const claudeJson = readJsonFile(claudeJsonPath(opts.home), warnings);
  for (const [name, entry] of Object.entries(serverMap(claudeJson?.mcpServers))) {
    servers.push({ name, scope: 'user', entry });
  }

  const projects =
    claudeJson?.projects && typeof claudeJson.projects === 'object'
      ? (claudeJson.projects as Record<string, unknown>)
      : {};
  const projectRecord =
    projects[cwd] !== null && typeof projects[cwd] === 'object'
      ? (projects[cwd] as Record<string, unknown>)
      : {};
  for (const [name, entry] of Object.entries(serverMap(projectRecord.mcpServers))) {
    servers.push({ name, scope: 'local', entry });
  }

  const mcpJson = readJsonFile(resolve(cwd, '.mcp.json'), warnings);
  for (const [name, entry] of Object.entries(serverMap(mcpJson?.mcpServers))) {
    servers.push({ name, scope: 'project', entry });
  }

  // Host consent for checked-in servers: enabledMcpjsonServers /
  // enableAllProjectMcpServers, minus disabledMcpjsonServers.
  const approved = new Set<string>();
  const enabledAll = projectRecord.enableAllProjectMcpServers === true;
  const enabledList = Array.isArray(projectRecord.enabledMcpjsonServers)
    ? (projectRecord.enabledMcpjsonServers as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
  const disabledList = Array.isArray(projectRecord.disabledMcpjsonServers)
    ? (projectRecord.disabledMcpjsonServers as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
  for (const s of servers) {
    if (s.scope !== 'project') continue;
    if (enabledAll || enabledList.includes(s.name)) approved.add(s.name);
  }
  for (const name of disabledList) approved.delete(name);
  const projectApprovalKnown =
    enabledAll || enabledList.length > 0 || disabledList.length > 0;

  return { servers, approvedProjectServers: approved, projectApprovalKnown, warnings };
}

const SCOPE_PRECEDENCE: Record<ClaudeScope, number> = { local: 3, project: 2, user: 1 };

/** Resolve same-named servers the way the host does: local > project > user. */
export function effectiveServers(servers: ScopedServer[]): Map<string, ScopedServer> {
  const out = new Map<string, ScopedServer>();
  for (const s of servers) {
    const existing = out.get(s.name);
    if (!existing || SCOPE_PRECEDENCE[s.scope] > SCOPE_PRECEDENCE[existing.scope]) {
      out.set(s.name, s);
    }
  }
  return out;
}

/** stdio entries are wrappable; url/http/sse entries pass through verbatim. */
export function isStdioEntry(entry: McpServerEntry): boolean {
  if (typeof entry.url === 'string' && entry.url.length > 0) return false;
  if (entry.type !== undefined && entry.type !== 'stdio') return false;
  return typeof entry.command === 'string' && entry.command.length > 0;
}

/** Already behind Speculate? (a `wrap` token inside a speculate invocation) */
export function isWrappedEntry(entry: McpServerEntry): boolean {
  const args = entry.args ?? [];
  const wrapIdx = args.indexOf('wrap');
  if (wrapIdx === -1) return false;
  const invocationPrefix = [entry.command ?? '', ...args.slice(0, wrapIdx)].join(' ');
  return /speculate/i.test(invocationPrefix);
}

/**
 * How Speculate invokes itself from a host config entry: the built CLI
 * under node when installed, tsx + source in a dev checkout.
 */
export function selfCommand(): { command: string; args: string[] } {
  const builtJs = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (builtJs.endsWith('.js') && existsSync(builtJs)) {
    return { command: process.execPath, args: [builtJs] };
  }
  const tsSource = fileURLToPath(new URL('./cli.ts', import.meta.url));
  // tsx's entry point under node, not the .bin shim: Windows cannot spawn an
  // extensionless sh script, and node refuses .cmd shims without a shell.
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  if (existsSync(tsSource) && existsSync(tsx)) {
    return { command: process.execPath, args: [tsx, tsSource] };
  }
  throw new Error('cannot locate the speculate CLI entrypoint; run npm run build');
}

/**
 * Wrap one stdio entry: same env, same everything, the command line
 * prefixed with `speculate wrap --`. The original survives verbatim
 * after the `--` (self-describing; see unwrapEntry).
 */
export function wrapEntry(
  entry: McpServerEntry,
  self: { command: string; args: string[] },
  opts: { mode?: 'strict' | 'annotated' | 'off' } = {},
): McpServerEntry {
  return {
    ...entry,
    command: self.command,
    args: [
      ...self.args,
      'wrap',
      ...(opts.mode ? ['--mode', opts.mode] : []),
      '--',
      entry.command!,
      ...(entry.args ?? []),
    ],
  };
}

/** Reconstruct the original entry from a wrapped one; null if not wrapped. */
export function unwrapEntry(entry: McpServerEntry): McpServerEntry | null {
  if (!isWrappedEntry(entry)) return null;
  const args = entry.args ?? [];
  const wrapIdx = args.indexOf('wrap');
  const dashIdx = args.indexOf('--', wrapIdx + 1);
  if (dashIdx === -1 || dashIdx + 1 >= args.length) return null; // no wrapped command to restore
  const original = args.slice(dashIdx + 1);
  const out: McpServerEntry = { ...entry, command: original[0]!, args: original.slice(1) };
  return out;
}
