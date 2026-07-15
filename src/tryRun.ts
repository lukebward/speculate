/**
 * `speculate try` — the zero-write trial (DESIGN.md §13.12).
 *
 * Read the user's real Claude Code config (all three scopes), build an
 * in-memory copy with every stdio server wrapped and the workspace shell
 * server added, write it to a throwaway file, and launch
 * `claude --mcp-config <tmp> --strict-mcp-config`. Nothing persists:
 * no config is modified, the generated file dies with the session.
 *
 * Consent is preserved, not widened: checked-in .mcp.json servers are
 * included only if the host's own records show the user already approved
 * them for this project — `try` must never turn "pending approval" into
 * "running".
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_SERVER_NAME,
  effectiveServers,
  isStdioEntry,
  isWrappedEntry,
  readClaudeServers,
  selfCommand,
  workspaceEntry,
  wrapEntry,
  type McpServerEntry,
} from './hostConfig.js';

export interface TryArgs {
  noWorkspace: boolean;
  mode: 'strict' | 'annotated' | 'off' | null;
  /** Arguments after `--`, passed through to the launched client. */
  clientArgs: string[];
}

export function parseTryArgs(argv: string[]): TryArgs | { error: string } {
  const out: TryArgs = { noWorkspace: false, mode: null, clientArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.clientArgs = argv.slice(i + 1);
      break;
    }
    if (a === '--no-workspace') {
      out.noWorkspace = true;
    } else if (a === '--mode') {
      const m = argv[++i];
      if (m !== 'strict' && m !== 'annotated' && m !== 'off') {
        return { error: `--mode must be strict|annotated|off (got '${m ?? ''}')` };
      }
      out.mode = m;
    } else {
      return { error: `unknown try argument '${a}' (client args go after '--')` };
    }
  }
  return out;
}

export interface TryPlan {
  mcpServers: Record<string, McpServerEntry>;
  wrapped: string[];
  passedThrough: string[];
  skipped: Array<{ name: string; reason: string }>;
  warnings: string[];
}

/** Pure config assembly, injectable for tests. */
export function buildTryConfig(opts: {
  home: string;
  cwd: string;
  self: { command: string; args: string[] };
  noWorkspace?: boolean;
  mode?: 'strict' | 'annotated' | 'off' | null;
}): TryPlan {
  const view = readClaudeServers({ home: opts.home, cwd: opts.cwd });
  const plan: TryPlan = {
    mcpServers: {},
    wrapped: [],
    passedThrough: [],
    skipped: [],
    warnings: [...view.warnings],
  };
  for (const [name, scoped] of effectiveServers(view.servers)) {
    if (scoped.scope === 'project' && !view.approvedProjectServers.has(name)) {
      plan.skipped.push({
        name,
        reason: '.mcp.json server not yet approved in Claude Code — approve it there first',
      });
      continue;
    }
    if (isWrappedEntry(scoped.entry)) {
      plan.mcpServers[name] = scoped.entry; // already behind Speculate
      plan.passedThrough.push(name);
    } else if (isStdioEntry(scoped.entry)) {
      plan.mcpServers[name] = wrapEntry(scoped.entry, opts.self, {
        mode: opts.mode ?? undefined,
      });
      plan.wrapped.push(name);
    } else {
      plan.mcpServers[name] = scoped.entry; // http/sse: verbatim
      plan.passedThrough.push(name);
    }
  }
  if (!opts.noWorkspace && !plan.mcpServers[WORKSPACE_SERVER_NAME]) {
    plan.mcpServers[WORKSPACE_SERVER_NAME] = workspaceEntry(opts.self, opts.cwd);
  }
  return plan;
}

export function tryClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, SPECULATE_USAGE_OFF: '1' };
}

/** Assemble, launch, clean up. Returns the client's exit code. */
export async function runTry(args: TryArgs): Promise<number> {
  const plan = buildTryConfig({
    home: homedir(),
    cwd: process.cwd(),
    self: selfCommand(),
    noWorkspace: args.noWorkspace,
    mode: args.mode,
  });
  for (const w of plan.warnings) process.stderr.write(`[speculate] warning: ${w}\n`);
  for (const s of plan.skipped) {
    process.stderr.write(`[speculate] skipping '${s.name}': ${s.reason}\n`);
  }
  const summary = [
    plan.wrapped.length ? `wrapping ${plan.wrapped.join(', ')}` : 'no servers to wrap',
    args.noWorkspace ? null : 'workspace CLI speculation on',
  ]
    .filter(Boolean)
    .join('; ');
  process.stderr.write(`[speculate] try: ${summary} — nothing on disk is modified\n`);

  const dir = mkdtempSync(join(tmpdir(), 'speculate-try-'), { mode: 0o700 } as never);
  const configPath = join(dir, 'mcp-config.json');
  // The generated file contains every wrapped server's env block (tokens).
  // 0600 + guaranteed cleanup, even on Ctrl-C, so it never lingers on disk.
  writeFileSync(configPath, JSON.stringify({ mcpServers: plan.mcpServers }, null, 2), {
    mode: 0o600,
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('exit', cleanup);

  const clientBin = process.env.SPECULATE_CLAUDE_BIN || 'claude';
  const child = spawn(
    clientBin,
    [...args.clientArgs, '--mcp-config', configPath, '--strict-mcp-config'],
    { env: tryClientEnv(process.env), stdio: 'inherit' },
  );

  // Claude Code runs its own TUI and traps SIGINT; forward terminal signals
  // so the child controls shutdown, but never die before it does (and never
  // leave the temp file behind if we're killed first).
  const forward = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {
      // child already gone
    }
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(
        `[speculate] cannot launch '${clientBin}': ${err.message}\n` +
          `[speculate] is Claude Code installed and on PATH?\n`,
      );
      cleanup();
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      cleanup();
      resolve(signal ? 128 + (nodeSignalNumber(signal) ?? 1) : (code ?? 0));
    });
  });
}

/** Best-effort signal-name → number for conventional 128+n exit codes. */
function nodeSignalNumber(sig: NodeJS.Signals): number | null {
  const map: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[sig] ?? null;
}
