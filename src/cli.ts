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
import { writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { defaultStatePath, defaultStatePathForKey } from './persistence.js';
import { SpeculateProxy } from './proxy.js';
import { runDoctor } from './doctor.js';
import { buildWrapConfig, parseWrapArgs } from './wrap.js';
import { runPipe, sniffFirstLine } from './sniff.js';
import { selfCommand } from './hostConfig.js';
import { nodeSignalNumber, parseTryArgs, runTry } from './tryRun.js';
import { speculateOff, speculateOn, speculateStatus } from './manage.js';
import { speculateSync } from './sync.js';
import { installShims, parseShimsArgs, shimsStatus, uninstallShims } from './shims.js';
import { parseStatsArgs, runStats } from './stats.js';
import { createUsageRecorder } from './usage.js';
import { VERSION } from './version.js';

const HELP = `speculate ${VERSION} — speculative-prefetching MCP proxy

install-and-it-works (no config files edited by hand):
  speculate try [-- <claude args...>]      zero-write trial: launch Claude Code with every
                                           MCP server wrapped, this session only
  speculate on [--mode <mode>]             wrap this project's MCP servers via 'claude mcp'
  speculate off                            undo everything 'on' did (exact restore)
  speculate status                         what's wrapped here, and what drifted since 'on'
  speculate sync                           wrap MCP servers added since the last run (run by the auto-wrap hook)
  speculate stats [--json]                 cumulative speculation usage
  speculate shims install|uninstall|status opt-in: sniffing npx/uvx shims — wraps every MCP
                                           server any client launches, even ones added later

manual wrapping:
  speculate wrap [flags] -- <server command...>              zero config: wrap any MCP server
  speculate --config <path> [--mode strict|annotated|off]    run the proxy from a config file
  speculate init [path]                                      write a starter config
  speculate doctor --config <path>                           connect upstreams, explain
                                                             per-tool speculation eligibility
  speculate validate --config <path>                         validate the config and exit

wrap flags (before the '--'):
  --mode <mode>       strict|annotated|off (default for wrap: annotated)
  --profile <name>    force a vetted profile (auto-detected for known servers)
  --allow <t1,t2>     extra read-only allowlist entries
  --sniff             engage only if the client speaks MCP; else byte-transparent pipe

options:
  --config <path>   path to speculate config (JSON with comments allowed)
  --mode <mode>     override the config's speculation mode for this run
  --version         print version and exit
  --help            show this help

compatibility:
  speculate exec [--cwd <dir>] -- <command...>   run <command> verbatim; kept only so a
                                                stranded ≤0.10 Bash hook still works (removed in 0.12)
`;

const STARTER_CONFIG = `{
  // strict: annotated read-only AND allowlisted · annotated: trust readOnlyHint · off: pass-through
  "mode": "strict",
  "servers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." },
      "profile": "github",
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
    | 'shims'
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
  'shims',
  'exec',
] as const);

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
 * not-yet-cleaned project, so exec survives one release as a VERBATIM
 * pass-through: no shell, no rewriting, the child's own exit code. Remove in
 * 0.12.
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

async function runExecPassThrough(execArgs: ExecArgs): Promise<number> {
  process.stderr.write(`${EXEC_NOTICE}\n`);
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
        `[speculate] exec: cannot run '${command}': ${(err as Error).message}\n`,
      );
      resolveExit(127);
      return;
    }
    child.on('error', (err) => {
      process.stderr.write(`[speculate] exec: cannot run '${command}': ${err.message}\n`);
      resolveExit(127);
    });
    child.on('exit', (code, signal) =>
      resolveExit(signal ? 128 + (nodeSignalNumber(signal) ?? 1) : (code ?? 0)),
    );
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'exec') {
    const execArgs = parseExecArgs(args.rest);
    if ('error' in execArgs) fail(`exec: ${execArgs.error}`);
    // stdio is inherited, so nothing of the child's is buffered here.
    process.exitCode = await runExecPassThrough(execArgs);
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
    const tryArgs = parseTryArgs(args.rest);
    if ('error' in tryArgs) fail(`try: ${tryArgs.error}`);
    process.exitCode = await runTry(tryArgs);
    return; // natural exit: the loop drains, stdout flushes completely
  }

  if (args.command === 'stats') {
    const statsArgs = parseStatsArgs(args.rest);
    if ('error' in statsArgs) fail(`stats: ${statsArgs.error}`);
    process.exitCode = runStats(statsArgs);
    return;
  }

  if (args.command === 'shims') {
    const shimsArgs = parseShimsArgs(args.rest);
    if ('error' in shimsArgs) fail(`shims: ${shimsArgs.error}`);
    const opts = { rcPath: shimsArgs.rcPath, noRc: shimsArgs.noRc };
    const code =
      shimsArgs.action === 'install'
        ? installShims(opts)
        : shimsArgs.action === 'uninstall'
          ? uninstallShims(opts)
          : shimsStatus(opts);
    process.exitCode = code;
    return;
  }

  if (args.command === 'sync') {
    // Hard cap on the whole run: the auto-wrap hook is synchronous, so a
    // hang here would hold up a session start. Expiry is treated as success
    // (exit 0) — a slow day never costs a session, and the work is picked up
    // next start. Unref'd so it never keeps an otherwise-idle process alive.
    const timer = setTimeout(() => process.exit(0), 5_000).unref();
    try {
      process.exitCode = await speculateSync({ self: selfCommand(), mode: null });
    } catch {
      // selfCommand() throws when the entrypoint can't be located (a
      // half-removed install with the plugin still there). The hook must
      // still exit 0 silently rather than error on every launch forever.
      process.exitCode = 0;
    }
    clearTimeout(timer);
    return;
  }

  if (args.command === 'on' || args.command === 'off' || args.command === 'status') {
    let mode: 'strict' | 'annotated' | 'off' | null = null;
    for (let i = 0; i < args.rest.length; i++) {
      if (args.rest[i] === '--mode' && args.command === 'on') {
        const m = args.rest[++i];
        if (m !== 'strict' && m !== 'annotated' && m !== 'off') {
          fail(`--mode must be strict|annotated|off (got '${m ?? ''}')`);
        }
        mode = m;
      } else {
        fail(`unknown ${args.command} argument '${args.rest[i]}'`);
      }
    }
    const manageOpts = { self: selfCommand(), mode };
    const code =
      args.command === 'on'
        ? await speculateOn(manageOpts)
        : args.command === 'off'
          ? await speculateOff(manageOpts)
          : await speculateStatus(manageOpts);
    process.exitCode = code;
    return;
  }

  if (args.command === 'wrap') {
    const wrapArgs = parseWrapArgs(args.rest);
    if ('error' in wrapArgs) fail(`wrap: ${wrapArgs.error}`);
    if (wrapArgs.sniff) {
      // §13.12: decide from the first client line whether this is MCP at
      // all. Non-MCP degrades to a transparent pipe — same command, same
      // bytes, same exit code — so blind wrapping is always safe.
      const decision = await sniffFirstLine(process.stdin);
      if (!decision.mcp) {
        // The piped stdin can hold the loop open after the child exits, so
        // this is an exitWhenFlushed path (child output was inherited —
        // nothing of ours is buffered — but stderr notes might be).
        exitWhenFlushed(await runPipe(wrapArgs.command, decision.buffered, decision.ended));
        return;
      }
      // Re-inject the sniffed bytes so the proxy's transport sees the
      // stream from its true beginning (initialize included).
      if (decision.buffered.length > 0) process.stdin.unshift(decision.buffered);
      const { config: wrapConfig, stateKey } = buildWrapConfig(wrapArgs);
      await runProxy(wrapConfig, defaultStatePathForKey(stateKey), '(wrap)');
      // Sniffing left stdin explicitly paused; an explicit pause is not
      // undone by the transport attaching its 'data' listener. Resume only
      // now that the listener exists, so no byte can flow into the void.
      process.stdin.resume();
      return;
    }
    const { config: wrapConfig, stateKey } = buildWrapConfig(wrapArgs);
    await runProxy(wrapConfig, defaultStatePathForKey(stateKey), '(wrap)');
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
    // Doctor's report can exceed the pipe buffer, and probed upstreams may
    // leave handles alive — flush-gated exit covers both.
    const ok = await runDoctor(config, statePath);
    exitWhenFlushed(ok ? 0 : 1);
    return;
  }

  await runProxy(config, statePath, args.configPath);
}

async function runProxy(
  config: import('./types.js').SpeculateConfig,
  statePath: string | null,
  configLabel: string,
): Promise<void> {
  const usageRecorder = createUsageRecorder({
    source: 'mcp',
    workspace: process.cwd(),
  });
  const proxy = new SpeculateProxy(config, { statePath, usageRecorder });
  const shutdown = async (): Promise<void> => {
    try {
      const s = proxy.metrics.statsSnapshot();
      process.stderr.write(
        `[speculate] session summary: ${s.hits + s.joins} prefetch hits, ` +
          `${(s.estimatedSavedMs / 1000).toFixed(1)}s saved, ` +
          `${s.wasted} wasted speculative call(s), ${s.realCalls} upstream call(s)\n`,
      );
      await proxy.close();
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

main().catch((err) => {
  if (err instanceof ExitRequest) {
    process.exitCode = err.code;
    return; // help/version/usage errors: small writes, natural exit flushes
  }
  process.stderr.write(`[speculate] fatal: ${(err as Error).message ?? err}\n`);
  // A fatal can surface with proxy transports already attached (loop held).
  exitWhenFlushed(1);
});
