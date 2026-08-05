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
import { createInterface } from 'node:readline/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadConfig } from './config.js';
import { defaultStatePath, defaultStatePathForKey } from './persistence.js';
import { SpeculateProxy } from './proxy.js';
import { runDoctor } from './doctor.js';
import { buildWrapConfig, parseWrapArgs } from './wrap.js';
import { runPipe, sniffFirstLine } from './sniff.js';
import { selfCommand } from './hostConfig.js';
import { nodeSignalNumber, parseTryArgs, runTry } from './tryRun.js';
import { projectIsManaged, speculateOff, speculateOn, speculateStatus } from './manage.js';
import { speculateSync } from './sync.js';
import { installShims, parseShimsArgs, shimsStatus, uninstallShims } from './shims.js';
import { parseStatsArgs, runStats } from './stats.js';
import { speculateAuth } from './authCommand.js';
import { attachStoredOAuth } from './oauthProvider.js';
import { oauthStorePath } from './oauthStore.js';
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
  speculate auth [server]                  authorize Speculate with remote servers that need a
                                           login (no argument: every one that does)
  speculate shims install|uninstall|status opt-in: sniffing npx/uvx shims — wraps every MCP
                                           server any client launches, even ones added later

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
  --sniff             engage only if the client speaks MCP; else byte-transparent pipe
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
  speculate exec [--cwd <dir>] -- <command...>   run <command> verbatim; kept only so a
                                                stranded ≤0.10 Bash hook still works (removed in 0.13)
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
  'shims',
  'auth',
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
 * pass-through: no shell, no rewriting, the child's own exit code. 0.12 kept
 * it (a ≤0.10 hook can still sit in a project nobody has run `on` in yet);
 * removal moves to 0.13.
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
    // `--claude-bin <abs>` is baked into the auto-wrap hook command at
    // install time: `on` runs in a terminal where `claude` is on PATH, and
    // this carries that knowledge into GUI-launched sessions whose minimal
    // OS PATH has neither node's version-manager shims nor the host CLI.
    // Used only while the baked path still exists — a stale bake (the CLI
    // moved or was uninstalled) silently falls back to normal resolution,
    // because a hook argument must never turn into a session-start error.
    const rest = [...args.rest];
    let claudeBin: string | undefined;
    const binIdx = rest.indexOf('--claude-bin');
    if (binIdx !== -1) {
      const value = rest[binIdx + 1];
      rest.splice(binIdx, value !== undefined ? 2 : 1);
      if (value !== undefined && isAbsolute(value) && existsSync(value)) claudeBin = value;
    }
    if (rest.length > 0) fail(`unknown sync argument '${rest[0]}'`);
    // The real budget is COOPERATIVE and lives in speculateSync, which stops
    // BETWEEN servers so a wrap is never cut in half. This timer is only the
    // last resort for a hang no layer below can end (every `claude mcp` call
    // already carries its own 30s execFile timeout): far enough out that it
    // does not fire in the window between a server's `mcp remove` and the
    // `mcp add-json` that puts it back — killing the process THERE would
    // leave the server deleted with no restore and no state record. 120s is
    // the 5s budget plus three 30s execFile timeouts, with slack because that
    // 30s is NOT a hard bound: execFile's timeout sends SIGTERM and then
    // waits for stdio to close, so a child that ignores SIGTERM stretches
    // past it (60s, then 100s, were both close enough to the arithmetic to
    // put the hard exit back inside the restore window). Unref'd so it never
    // keeps an idle process alive.
    //
    // Arithmetic is the weak form of this guarantee. The strong one is a
    // marker file (or an in-memory flag plus a crash-recovery pass) held
    // across the remove→add pair, so the exit can simply refuse to fire while
    // one is open, and the restore is replayable if the process dies anyway.
    // That is the right long-term fix; this timer is the interim.
    const timer = setTimeout(() => process.exit(0), 120_000).unref();
    try {
      process.exitCode = await speculateSync({
        self: selfCommand(),
        mode: null,
        ...(claudeBin !== undefined ? { claudeBin } : {}),
      });
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
    const manageOpts = { self: selfCommand(), mode, onNeedsAuth };
    const code =
      args.command === 'on'
        ? await speculateOn(manageOpts)
        : args.command === 'off'
          ? await speculateOff(manageOpts)
          : await speculateStatus(manageOpts);
    process.exitCode = code;
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
    const code = await speculateAuth({ target, forget });
    // Finish the job rather than leaving a second command as homework: a
    // server authorized just now is still unwrapped until a wrap pass runs.
    // Only where `on` was already run, though -- wrapping a project that
    // never opted in would be a config change nobody asked for.
    if (code === 0 && !forget && projectIsManaged()) {
      await speculateOn({ self: selfCommand(), mode: null });
    }
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
    applyStoredOAuth(config);
    // Doctor's report can exceed the pipe buffer, and probed upstreams may
    // leave handles alive — flush-gated exit covers both.
    const ok = await runDoctor(config, statePath);
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
async function onNeedsAuth(servers: { name: string; url: string }[]): Promise<boolean> {
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
    if ((await speculateAuth({ target: server.url })) === 0) authorized = true;
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
  const usageRecorder = createUsageRecorder({
    source: 'mcp',
    workspace: process.cwd(),
  });
  const proxy = new SpeculateProxy(config, { statePath, usageRecorder });
  const shutdown = async (): Promise<void> => {
    try {
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
