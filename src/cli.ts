#!/usr/bin/env node
/**
 * Speculate CLI.
 *
 *   speculate --config <path> [--mode strict|annotated|off]   run the proxy
 *   speculate doctor --config <path>                          diagnose setup
 *   speculate validate --config <path>                        check config only
 *
 * When running the proxy, stdout carries the MCP protocol; all diagnostics
 * go to stderr. `doctor` and `validate` are human-facing and use stdout.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import { loadConfig } from './config.js';
import { defaultStatePath, defaultStatePathForKey } from './persistence.js';
import { SpeculateProxy } from './proxy.js';
import { runDoctor } from './doctor.js';
import { buildWrapConfig, parseWrapArgs } from './wrap.js';
import { selfCommand } from './hostConfig.js';
import {
  claudeIsGloballyEnabled,
  projectIsManaged,
  speculateOffGlobal,
  speculateOn,
  speculateOnGlobal,
  speculateStatus,
  speculateStatusGlobal,
} from './manage.js';
import { speculateSync, speculateSyncGlobal } from './sync.js';
import { parseShimsArgs, uninstallShims } from './shims.js';
import { parseStatsArgs, runStats } from './stats.js';
import { speculateAuth } from './authCommand.js';
import { attachStoredOAuth } from './oauthProvider.js';
import { oauthStorePath, readOAuthRecord } from './oauthStore.js';
import { createUsageRecorder } from './usage.js';
import { VERSION } from './version.js';
import { parseMemoryArgs, runMemory } from './memory.js';
import {
  speculateCodexAuth,
  speculateCodexOff,
  speculateCodexOn,
  speculateCodexStatus,
  speculateCodexSync,
} from './codexManage.js';
import { applyCodexPolicy } from './codexPolicy.js';

const HELP = `speculate ${VERSION} — speculative-prefetching MCP proxy

managed setup (on/off/status/sync/auth accept --client both|claude|codex):
  speculate on [--mode <mode>]             wrap supported MCP servers for both clients
  speculate off                            restore registrations changed by 'on'
  speculate status [path]                  inspect wrapping for the selected client
  speculate sync                           wrap servers added since the last run
  speculate stats [--json] [--since 7d] [--workspace PATH]
                   [--by-server] [--by-tool] [--compact]
                                           cumulative usage and prediction quality
  speculate memory [--json] [--config PATH]
                                           inventory bounded learned/usage memory
  speculate memory clear (--all | --config PATH) [--json]
                                           clear only the explicitly scoped memory records
  speculate auth [server]                  authorize Speculate with remote servers that need a
                                           login (no argument: every one that does)
  speculate auth <server> --forget         forget a saved remote-server login

client scope:
  --client both      default: configure Claude Code and Codex independently
  --client claude     Claude Code setup across known projects; 'on' installs an auto-wrap hook
                      'status' alone lists projects; 'status .' inspects this project
  --client codex      Codex user MCP config shared by local clients; restart Codex afterward
                      a session-start hook wraps new servers for later sessions
  --codex-bin <path>  Codex executable for both/codex (default: codex on PATH)

manual wrapping:
  speculate wrap [flags] -- <server command...>              zero config: wrap any MCP server
  speculate wrap --url <url> [--header "K: V"]               wrap a remote (http) MCP server
  speculate --config <path> [--mode strict|annotated|off]    run the proxy from a config file
  speculate init [path]                                      write a starter config
  speculate doctor --config <path>                           connect upstreams, explain
                                                             per-tool speculation eligibility
  speculate validate --config <path>                         validate the config and exit

wrap flags (before the '--'):
  --mode <mode>       strict|annotated|off (default for wrap: annotated)
  --allow <t1,t2>     extra read-only allowlist entries
  --url <url>         wrap a remote http MCP server instead of a child process
  --header "K: V"     request header for --url; repeatable. Values may use
                      \${VAR}, resolved from the environment (unset = fatal),
                      so a token need never be written down

options:
  --config <path>   path to speculate config (JSON with comments allowed)
  --mode <mode>     override the config's speculation mode for this run
  --version         print version and exit
  --help            show this help

compatibility:
  speculate shims uninstall [--rc <path>] [--no-rc]
                                                remove retired PATH shims and their shell block
  speculate exec [--cwd <dir>] -- <command...>   run <command> verbatim; kept only so a
                                                stranded ≤0.10 Bash hook still works
`;

const STARTER_CONFIG = `{
  // strict: annotated read-only AND allowlisted · annotated: trust readOnlyHint · off: pass-through
  "mode": "strict",
  "servers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." },
    },
  },
  // "persistence": { "enabled": false },
}
`;

interface Args {
  command:
    | 'run'
    | 'doctor'
    | 'validate'
    | 'init'
    | 'wrap'
    | 'try'
    | 'on'
    | 'off'
    | 'status'
    | 'sync'
    | 'stats'
    | 'memory'
    | 'shims'
    | 'auth'
    | 'exec';
  configPath: string;
  modeOverride: 'strict' | 'annotated' | 'off' | null;
  rest: string[];
}

/** Subcommands that own their whole argv (flags parsed by their module). */
const REST_COMMANDS = new Set([
  'wrap',
  'try',
  'on',
  'off',
  'status',
  'sync',
  'stats',
  'memory',
  'shims',
  'auth',
  'exec',
] as const);

interface ClientArgs {
  client: 'both' | 'claude' | 'codex';
  codexBin?: string;
  rest: string[];
}

/** Client selection belongs to management commands, never the wrapped server. */
export function parseClientArgs(argv: string[]): ClientArgs | { error: string } {
  const out: ClientArgs = { client: 'both', rest: [] };
  let selected = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--client') {
      if (selected) return { error: '--client may only be specified once' };
      const value = argv[++i];
      if (value !== 'both' && value !== 'claude' && value !== 'codex') {
        return { error: '--client must be both, claude, or codex' };
      }
      selected = true;
      out.client = value;
    } else if (arg === '--codex-bin') {
      if (out.codexBin !== undefined) return { error: '--codex-bin may only be specified once' };
      const value = argv[++i];
      if (!value || value.startsWith('-')) return { error: '--codex-bin requires an executable path' };
      out.codexBin = value;
    } else {
      out.rest.push(arg);
    }
  }
  if (out.codexBin !== undefined && out.client === 'claude') {
    return { error: '--codex-bin requires --client both or --client codex' };
  }
  return out;
}

/** One unavailable client must not prevent the other from being configured. */
async function runSelectedClients(
  selection: ClientArgs['client'],
  command: string,
  actions: Record<'claude' | 'codex', () => Promise<number>>,
): Promise<number> {
  const clients: Array<'claude' | 'codex'> = selection === 'both' ? ['claude', 'codex'] : [selection];
  let failed = false;
  for (const client of clients) {
    let code: number;
    try {
      code = await actions[client]();
    } catch {
      // Host errors can quote configuration or credentials. The client name
      // and operation identify the failed work without echoing those values.
      process.stderr.write(`[speculate] ${client === 'claude' ? 'Claude Code' : 'Codex'} ${command} failed; check the client installation and configuration.\n`);
      code = 1;
    }
    failed ||= code !== 0;
    if (selection === 'both') {
      process.stderr.write(`[speculate] ${client === 'claude' ? 'Claude Code' : 'Codex'} ${command}: ${code === 0 ? 'completed' : 'failed'}.\n`);
    }
  }
  return failed ? 1 : 0;
}

/**
 * Exit policy: never call process.exit() while output may still be
 * buffered — process.exit() discards it, and any flush *timeout* just
 * converts backpressure from a slow reader into silent truncation.
 *
 * - Normal command paths: set process.exitCode and return (unwound via
 *   ExitRequest where needed). Node exits once the event loop drains,
 *   which flushes stdout/stderr completely, however slow the consumer —
 *   the same blocking semantics as any ordinary CLI.
 * - Paths where live handles would hold the loop open forever (proxy
 *   transports and upstream children, a piped stdin): exitWhenFlushed()
 *   hands process.exit() to the streams' write callbacks, which fire only
 *   after everything previously buffered has reached the OS. Exact, no
 *   timer.
 */
class ExitRequest {
  constructor(readonly code: number) {}
}

function exitWhenFlushed(code: number): void {
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

function fail(message: string): never {
  process.stderr.write(`speculate: ${message}\nRun 'speculate --help' for usage.\n`);
  throw new ExitRequest(2);
}

function parseArgs(argv: string[]): Args {
  let command: Args['command'] = 'run';
  let configPath: string | null = null;
  let modeOverride: Args['modeOverride'] = null;
  let i = 0;
  if (
    argv[0] === 'doctor' ||
    argv[0] === 'validate' ||
    argv[0] === 'init' ||
    (REST_COMMANDS as Set<string>).has(argv[0] ?? '')
  ) {
    command = argv[0] as Args['command'];
    i = 1;
  }
  if ((REST_COMMANDS as Set<string>).has(command)) {
    // These own their own flag grammar; everything after the name is theirs.
    return { command, configPath: '', modeOverride: null, rest: argv.slice(1) };
  }
  if (command === 'init') {
    const target = argv[1] ?? 'speculate.config.json';
    if (target.startsWith('-')) fail(`init takes a file path, not flags (got '${target}')`);
    return { command, configPath: target, modeOverride: null, rest: [] };
  }
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config') {
      configPath = argv[++i] ?? null;
      if (!configPath) fail('--config requires a path');
    } else if (a === '--mode') {
      const m = argv[++i];
      if (m !== 'strict' && m !== 'annotated' && m !== 'off') {
        fail(`--mode must be strict|annotated|off (got '${m ?? ''}')`);
      }
      modeOverride = m;
    } else if (a === '--version' || a === '-v') {
      process.stdout.write(`speculate ${VERSION}\n`);
      throw new ExitRequest(0);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      throw new ExitRequest(0);
    } else {
      fail(`unknown argument '${a}'`);
    }
  }
  if (!configPath) fail('--config is required');
  return { command, configPath, modeOverride, rest: [] };
}

/**
 * `speculate exec [--cwd <dir>] -- <command...>` — compatibility only.
 *
 * CLI speculation (and the ≤0.10 plugin's Bash hook that rewrote the agent's
 * `git status`/`rg`/`ls` into `speculate exec -- …`) was retired in 0.11, but
 * that hook stays installed per-project until `speculate on` cleans it up.
 * Failing those calls would break the agent's basic workflow in every
 * not-yet-cleaned project, so exec remains a verbatim pass-through: no
 * shell, no rewriting, the child's own exit code.
 */
interface ExecArgs {
  cwd: string | null;
  argv: string[];
}

export function parseExecArgs(argv: string[]): ExecArgs | { error: string } {
  let cwd: string | null = null;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--cwd') {
      const v = argv[++i];
      if (!v) return { error: '--cwd requires a directory' };
      cwd = v;
    } else {
      return { error: `unknown exec argument '${a}'` };
    }
  }
  const rest = argv.slice(i);
  if (rest.length === 0) return { error: "expected '--' followed by a command" };
  return { cwd, argv: rest };
}

const EXEC_NOTICE =
  "[speculate] CLI speculation was retired in 0.11 — this is a compatibility pass-through; run 'speculate on' to remove the legacy hook.";

/** Keep retired launch hooks functional without inspecting or buffering stdin. */
async function runCommandPassThrough(execArgs: ExecArgs, label: string): Promise<number> {
  const command = execArgs.argv[0]!;
  return new Promise<number>((resolveExit) => {
    let child;
    try {
      child = spawn(command, execArgs.argv.slice(1), {
        cwd: execArgs.cwd ?? process.cwd(),
        stdio: 'inherit',
      });
    } catch (err) {
      // spawn() can throw SYNCHRONOUSLY instead of emitting 'error': EINVAL
      // for a .cmd/.bat target on Node >= 20 (CVE-2024-27980), or
      // ERR_INVALID_ARG_VALUE for an empty argv0. A legacy hook's call must
      // fail the same fail-soft way whichever door it comes through.
      process.stderr.write(
        `[speculate] ${label}: cannot run '${command}': ${(err as Error).message}\n`,
      );
      resolveExit(127);
      return;
    }
    const onInt = (): void => {
      child.kill('SIGINT');
    };
    const onTerm = (): void => {
      child.kill('SIGTERM');
    };
    const cleanup = (): void => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.on('error', (err) => {
      cleanup();
      process.stderr.write(`[speculate] ${label}: cannot run '${command}': ${err.message}\n`);
      resolveExit(127);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolveExit(signal ? 128 + (osConstants.signals[signal] ?? 1) : (code ?? 0));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let selectedClient: ClientArgs = { client: 'both', rest: args.rest };
  if (['on', 'off', 'status', 'sync', 'auth'].includes(args.command)) {
    // Hooks installed before client selection existed baked only this flag.
    // Keep those invocations local and quiet when the default becomes both.
    const legacyClaudeHook = args.command === 'sync' && args.rest.includes('--claude-bin')
      && !args.rest.includes('--client');
    const parsed = parseClientArgs(legacyClaudeHook ? [...args.rest, '--client', 'claude', '--quiet'] : args.rest);
    if ('error' in parsed) fail(parsed.error);
    selectedClient = parsed;
    args.rest = parsed.rest;
  }

  if (args.command === 'exec') {
    const execArgs = parseExecArgs(args.rest);
    if ('error' in execArgs) fail(`exec: ${execArgs.error}`);
    process.stderr.write(`${EXEC_NOTICE}\n`);
    // stdio is inherited, so nothing of the child's is buffered here.
    process.exitCode = await runCommandPassThrough(execArgs, 'exec');
    return;
  }

  if (args.command === 'init') {
    if (existsSync(args.configPath)) {
      fail(`${args.configPath} already exists — not overwriting`);
    }
    writeFileSync(args.configPath, STARTER_CONFIG);
    process.stdout.write(
      `wrote ${args.configPath}\nnext: edit it, then 'speculate doctor --config ${args.configPath}'\n`,
    );
    return;
  }

  if (args.command === 'try') {
    fail(
      "'speculate try' was retired. Use 'speculate on' for your MCP servers, " +
        "or 'speculate wrap -- <server command...>' for explicit wrapping.",
    );
  }

  if (args.command === 'stats') {
    const statsArgs = parseStatsArgs(args.rest);
    if ('error' in statsArgs) fail(`stats: ${statsArgs.error}`);
    process.exitCode = runStats(statsArgs);
    return;
  }

  if (args.command === 'memory') {
    const memoryArgs = parseMemoryArgs(args.rest);
    if ('error' in memoryArgs) fail(`memory: ${memoryArgs.error}`);
    process.exitCode = runMemory(memoryArgs);
    return;
  }

  if (args.command === 'shims') {
    const shimsArgs = parseShimsArgs(args.rest);
    if ('error' in shimsArgs) fail(`shims: ${shimsArgs.error}`);
    const opts = { rcPath: shimsArgs.rcPath, noRc: shimsArgs.noRc };
    process.exitCode = uninstallShims(opts);
    return;
  }

  if (args.command === 'sync') {
    const rest = [...args.rest];
    const quietIndex = rest.indexOf('--quiet');
    const quiet = quietIndex !== -1;
    if (quiet) rest.splice(quietIndex, 1);
    if (quiet && selectedClient.client === 'both') {
      fail('--quiet requires --client claude or --client codex');
    }
    // Older Claude hooks bake an absolute executable for GUI launches. A
    // moved executable falls back to normal resolution instead of breaking
    // every session start.
    let claudeBin: string | undefined;
    const binIndex = rest.indexOf('--claude-bin');
    if (binIndex !== -1) {
      if (selectedClient.client === 'codex') fail('--claude-bin applies to Claude Code only');
      const value = rest[binIndex + 1];
      if (!quiet && (value === undefined || value.startsWith('--'))) fail('--claude-bin requires an executable path');
      rest.splice(binIndex, value !== undefined ? 2 : 1);
      if (value !== undefined && isAbsolute(value) && existsSync(value)) claudeBin = value;
    }
    if (rest.length > 0) fail(`unknown sync argument '${rest[0]}'`);
    if (quiet) {
      // Hook failures must not block a host session. Keep the existing
      // Claude emergency cap beyond its remove/add transaction timeouts;
      // manual commands use the clients' ordinary bounded operations.
      const timer = selectedClient.client === 'claude'
        ? setTimeout(() => process.exit(0), 120_000).unref() : undefined;
      try {
        if (selectedClient.client === 'claude') {
          await speculateSync({ self: selfCommand(), mode: null, log: () => {},
            ...(claudeBin !== undefined ? { claudeBin } : {}) });
        } else {
          await speculateCodexSync({ self: selfCommand(), codexBin: selectedClient.codexBin, log: () => {} });
        }
      } catch { /* A stale installation must not turn into a session-start error. */ }
      finally { if (timer !== undefined) clearTimeout(timer); }
      process.exitCode = 0;
      return;
    }
    process.exitCode = await runSelectedClients(selectedClient.client, args.command, {
      claude: () => speculateSyncGlobal({ self: selfCommand(), mode: null,
        ...(claudeBin !== undefined ? { claudeBin } : {}) }),
      codex: () => speculateCodexSync({ self: selfCommand(), codexBin: selectedClient.codexBin }),
    });
    return;
  }

  if (args.command === 'on' || args.command === 'off' || args.command === 'status') {
    let mode: 'strict' | 'annotated' | 'off' | null = null;
    // `status` alone is the machine-wide view; `status <path>` is the deep
    // per-project view ('.' for the current one).
    let statusPath: string | undefined;
    for (let i = 0; i < args.rest.length; i++) {
      if (args.rest[i] === '--mode' && args.command === 'on') {
        const m = args.rest[++i];
        if (m !== 'strict' && m !== 'annotated' && m !== 'off') {
          fail(`--mode must be strict|annotated|off (got '${m ?? ''}')`);
        }
        mode = m;
      } else if (
        args.command === 'status' &&
        statusPath === undefined &&
        !args.rest[i]!.startsWith('-')
      ) {
        statusPath = args.rest[i];
      } else {
        fail(`unknown ${args.command} argument '${args.rest[i]}'`);
      }
    }
    process.exitCode = await runSelectedClients(selectedClient.client, args.command, {
      claude: async () => {
        const manageOpts = { self: selfCommand(), mode, onNeedsAuth };
        return args.command === 'on'
          ? await speculateOnGlobal(manageOpts)
          : args.command === 'off'
            ? await speculateOffGlobal(manageOpts)
            : statusPath !== undefined
              ? await speculateStatus({ ...manageOpts, cwd: resolve(statusPath) })
              : await speculateStatusGlobal(manageOpts);
      },
      codex: async () => {
        const self = selfCommand();
        const codexOpts = {
          self,
          mode,
          codexBin: selectedClient.codexBin,
          ...(statusPath !== undefined ? { cwd: resolve(statusPath) } : {}),
          onNeedsAuth: (servers: { name: string; url: string }[]) => onNeedsAuth(
            servers,
            (target) => speculateCodexAuth({ self, codexBin: selectedClient.codexBin, target }),
          ),
        };
        return args.command === 'on'
          ? await speculateCodexOn(codexOpts)
          : args.command === 'off'
            ? await speculateCodexOff(codexOpts)
            : await speculateCodexStatus(codexOpts);
      },
    });
    return;
  }

  if (args.command === 'auth') {
    let target: string | undefined;
    let forget = false;
    for (const arg of args.rest) {
      if (arg === '--forget') forget = true;
      else if (arg.startsWith('-')) fail(`unknown auth argument '${arg}'`);
      else if (target === undefined) target = arg;
      else fail(`auth takes at most one server (got '${arg}' as well as '${target}')`);
    }
    // Claude permits forgetting all logins, while Codex requires a named
    // server. Validate the shared command before either client changes the
    // credential store.
    if (forget && target === undefined && selectedClient.client !== 'claude') {
      fail('auth --forget requires a server name for --client both or --client codex');
    }
    process.exitCode = await runSelectedClients(selectedClient.client, args.command, {
      claude: async () => {
        const code = await speculateAuth({ target, forget });
        // Finish wrapping newly authorized servers only where setup was
        // already enabled; auth alone does not opt a project in.
        if (code === 0 && !forget && claudeIsGloballyEnabled()) {
          return await speculateSyncGlobal({ self: selfCommand(), mode: null });
        }
        if (code === 0 && !forget && projectIsManaged()) {
          return await speculateOn({ self: selfCommand(), mode: null });
        }
        return code;
      },
      codex: () => speculateCodexAuth({ self: selfCommand(), codexBin: selectedClient.codexBin, target, forget }),
    });
    return;
  }

  if (args.command === 'wrap') {
    const wrapArgs = parseWrapArgs(args.rest);
    if ('error' in wrapArgs) fail(`wrap: ${wrapArgs.error}`);
    if (wrapArgs.legacyPassthrough) {
      process.stderr.write(
        "[speculate] PATH shims and --sniff were retired; running the command directly. " +
          "Run 'speculate shims uninstall', then use 'speculate on' or explicit 'speculate wrap'.\n",
      );
      process.exitCode = await runCommandPassThrough(
        { cwd: null, argv: wrapArgs.command },
        'wrap --sniff',
      );
      return;
    }
    const oauthScope = wrapArgs.url
      ? (readOAuthRecord(oauthStorePath(), wrapArgs.url)?.authEpoch ?? 'legacy-or-none')
      : 'none';
    const { config: wrapConfig, stateKey } = buildWrapConfig(
      wrapArgs,
      process.cwd(),
      oauthScope,
    );
    await applyCodexPolicy(wrapConfig, wrapArgs);
    await runProxy(
      wrapConfig,
      defaultStatePathForKey(stateKey),
      '(wrap)',
    );
    return;
  }

  // loadConfig throws with pretty, pointered messages (see config.ts).
  const config = loadConfig(args.configPath);
  if (args.modeOverride) config.mode = args.modeOverride;

  if (args.command === 'validate') {
    process.stdout.write(
      `ok: ${args.configPath} is valid (${Object.keys(config.servers).length} server(s), mode ${config.mode})\n`,
    );
    return;
  }

  // §13.6: learned state persists per config file unless disabled.
  const statePath =
    config.persistence?.enabled === false
      ? null
      : (config.persistence?.path ?? defaultStatePath(args.configPath));

  if (args.command === 'doctor') {
    applyStoredOAuth(config);
    // Doctor's report can exceed the pipe buffer, and probed upstreams may
    // leave handles alive — flush-gated exit covers both.
    const ok = await runDoctor(config, statePath, undefined, {
      stateScope: createStateScope(config, process.cwd()),
    });
    exitWhenFlushed(ok ? 0 : 1);
    return;
  }

  await runProxy(config, statePath, args.configPath);
}

/** One y/n question on stderr, so stdout stays clean for real output. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * `on`'s offer to run the login for you.
 *
 * Gated on a TTY on BOTH ends, because this opens a browser: `on` inside a
 * script, a CI job, or a piped shell must stay non-interactive and just say
 * what to run. Returns true only if something was actually authorized, which
 * is what tells `on` to re-run the wrap.
 */
async function onNeedsAuth(
  servers: { name: string; url: string }[],
  authorize: (target: string) => Promise<number> = (target) => speculateAuth({ target }),
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const names = servers.map((s) => s.name).join(', ');
  const subject = servers.length > 1 ? `${servers.length} servers` : names;
  process.stderr.write(
    `\n[speculate] ${subject} can be sped up, but ${servers.length > 1 ? 'they need' : 'it needs'} a login first${servers.length > 1 ? ` (${names})` : ''}.\n`,
  );
  if (!(await confirm('[speculate] Open your browser to authorize now? [Y/n] '))) {
    return false;
  }
  let authorized = false;
  for (const server of servers) {
    if ((await authorize(server.url)) === 0) authorized = true;
  }
  return authorized;
}

/**
 * Wire up any upstream the user has run `speculate auth` for. A conflict here
 * is fatal rather than a warning: the failure it prevents (a stale header
 * shadowing a valid token) surfaces as an unexplainable 401 much later.
 */
function applyStoredOAuth(config: import('./types.js').SpeculateConfig): void {
  const errors = attachStoredOAuth(config.servers, oauthStorePath());
  if (errors.length > 0) fail(errors.join('\n'));
}

async function runProxy(
  config: import('./types.js').SpeculateConfig,
  statePath: string | null,
  configLabel: string,
): Promise<void> {
  applyStoredOAuth(config);
  const stateScope = createStateScope(config, process.cwd());
  const usageRecorder = createUsageRecorder({
    source: 'mcp',
    workspace: process.cwd(),
  });
  const proxy = new SpeculateProxy(config, {
    statePath,
    stateScope,
    usageRecorder,
  });
  const shutdown = async (): Promise<void> => {
    try {
      await proxy.close();
      const s = proxy.metrics.statsSnapshot();
      // §9 freshness: only shown once something was actually served from the
      // buffer, so a session with no hits keeps the one-line summary short.
      const age = s.ageAtHit;
      const freshness =
        age.count === 0 || age.p50Ms === null
          ? ''
          : `, prefetch age median ${(age.p50Ms / 1000).toFixed(1)}s / p95 ` +
            `${((age.p95Ms ?? age.p50Ms) / 1000).toFixed(1)}s ` +
            `(${Math.round((age.lastTtlQuarter ?? 0) * 100)}% served in the last quarter of their TTL)`;
      process.stderr.write(
        `[speculate] session summary: ${s.hits + s.joins} prefetch hits, ` +
          `${(s.estimatedSavedMs / 1000).toFixed(1)}s saved, ` +
          `${s.wasted} wasted speculative call(s), ${s.realCalls} upstream call(s)` +
          `${freshness}\n`,
      );
    } finally {
      exitWhenFlushed(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await proxy.start();
  if (!proxy.anyUpstreamConnected()) {
    const hint =
      configLabel === '(wrap)'
        ? 'check the wrapped command runs on its own'
        : `run 'speculate doctor --config ${configLabel}' to diagnose`;
    process.stderr.write(
      `[speculate] fatal: no upstream connected (0 of ${Object.keys(config.servers).length}) — nothing to proxy.\n` +
        `[speculate] ${hint}.\n`,
    );
    await proxy.close();
    exitWhenFlushed(1);
    return;
  }
  // Startup summary: enough to answer "is it working?" from the host's logs.
  for (const [name, up] of proxy.upstreams) {
    if (!up.connected) {
      process.stderr.write(`[speculate] ${name}: NOT CONNECTED\n`);
      continue;
    }
    const eligible = up.tools.filter(
      (t) => proxy.policy.eligibility(name, t.name).eligible,
    ).length;
    process.stderr.write(
      `[speculate] ${name}: ${up.tools.length} tools, ${eligible} eligible for speculation\n`,
    );
  }
  process.stderr.write(
    `[speculate] v${VERSION} proxying ${Object.keys(config.servers).join(', ')} (mode: ${config.mode}${statePath ? `, state: ${statePath}` : ', persistence off'})\n`,
  );
}

/** One-way discriminator only: neither state files nor logs receive secrets. */
function createStateScope(
  config: import('./types.js').SpeculateConfig,
  workspace: string,
): string {
  const credentialEnv = (env: Record<string, string> | undefined): Array<[string, string]> =>
    Object.entries(env ?? {})
      .filter(([name]) => /token|api_?key|secret|credential|account|tenant/i.test(name))
      .sort(([a], [b]) => a.localeCompare(b));
  const servers = Object.entries(config.servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => ({
      name,
      upstream: server.url
        ? { url: server.url }
        : { command: server.command, args: server.args ?? [], ...(server.cwd ? { cwd: server.cwd } : {}) },
      identity: {
        oauth: server.oauthAuthEpoch ?? 'none',
        headers: Object.entries(server.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        env: credentialEnv(server.env),
      },
    }));
  return createHash('sha256')
    .update(JSON.stringify({ workspace: resolve(workspace), servers }))
    .digest('hex');
}

main().catch((err) => {
  if (err instanceof ExitRequest) {
    process.exitCode = err.code;
    return; // help/version/usage errors: small writes, natural exit flushes
  }
  process.stderr.write(`[speculate] fatal: ${(err as Error).message ?? err}\n`);
  // A fatal can surface with proxy transports already attached (loop held).
  exitWhenFlushed(1);
});
