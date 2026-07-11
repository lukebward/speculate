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
import { writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { defaultStatePath, defaultStatePathForKey } from './persistence.js';
import { SpeculateProxy } from './proxy.js';
import { runDoctor } from './doctor.js';
import { buildWrapConfig, parseWrapArgs } from './wrap.js';
import { runPipe, sniffFirstLine } from './sniff.js';
import { selfCommand } from './hostConfig.js';
import { parseTryArgs, runTry } from './tryRun.js';
import { speculateOff, speculateOn, speculateStatus } from './manage.js';
import { parseExecArgs, runExec } from './execClient.js';
import {
  DaemonAlreadyRunningError,
  parseDaemonArgs,
  startExecDaemon,
} from './execDaemon.js';
import { installShims, parseShimsArgs, shimsStatus, uninstallShims } from './shims.js';
import { VERSION } from './version.js';

const HELP = `speculate ${VERSION} — speculative-prefetching MCP proxy

install-and-it-works (no config files edited by hand):
  speculate try [-- <claude args...>]      zero-write trial: launch Claude Code with every
                                           MCP server wrapped + CLI speculation, this session only
  speculate on [--mode <mode>]             wrap this project's servers persistently, via
                                           'claude mcp' (the host's own CLI); adds CLI speculation
  speculate off                            undo everything 'on' did (exact restore)
  speculate status                         what's wrapped here, and what drifted since 'on'
  speculate shims install|uninstall|status opt-in: sniffing npx/uvx shims — wraps every MCP
                                           server any client launches, even ones added later

manual wrapping:
  speculate wrap [flags] -- <server command...>              zero config: wrap any MCP server
  speculate wrap --workspace <dir>                           zero config: CLI speculation for a repo
  speculate --config <path> [--mode strict|annotated|off]    run the proxy from a config file
  speculate init [path]                                      write a starter config
  speculate doctor --config <path>                           connect upstreams, explain
                                                             per-tool speculation eligibility
  speculate validate --config <path>                         validate the config and exit

CLI speculation (used by the Claude Code plugin's Bash hook):
  speculate exec [--cwd <dir>] -- <command...>   serve a vetted read-only command from the
                                                 per-workspace daemon cache (fail-open)
  speculate exec --stats                         daemon hit-rate for this workspace

wrap flags (before the '--'):
  --mode <mode>       strict|annotated|off (default for wrap: annotated)
  --profile <name>    force a vetted profile (auto-detected for known servers)
  --allow <t1,t2>     extra read-only allowlist entries
  --workspace <dir>   speculate the bundled read-only shell server for <dir>
  --sniff             engage only if the client speaks MCP; else byte-transparent pipe

options:
  --config <path>   path to speculate config (JSON with comments allowed)
  --mode <mode>     override the config's speculation mode for this run
  --version         print version and exit
  --help            show this help
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
    // CLI speculation for a repo (git status/diff/log, ls, ripgrep):
    // "workspace": { "command": "speculate-shell", "args": ["--cwd", "/path/to/repo"], "profile": "shell" },
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
    | 'exec'
    | 'exec-daemon'
    | 'shims';
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
  'exec',
  'exec-daemon',
  'shims',
] as const);

function fail(message: string): never {
  process.stderr.write(`speculate: ${message}\nRun 'speculate --help' for usage.\n`);
  process.exit(2);
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
      process.exit(0);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      fail(`unknown argument '${a}'`);
    }
  }
  if (!configPath) fail('--config is required');
  return { command, configPath, modeOverride, rest: [] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
    process.exit(await runTry(tryArgs));
  }

  if (args.command === 'exec') {
    const execArgs = parseExecArgs(args.rest);
    if ('error' in execArgs) fail(`exec: ${execArgs.error}`);
    process.exit(await runExec(execArgs));
  }

  if (args.command === 'exec-daemon') {
    const daemonArgs = parseDaemonArgs(args.rest);
    if ('error' in daemonArgs) fail(`exec-daemon: ${daemonArgs.error}`);
    try {
      await startExecDaemon({ ...daemonArgs, onIdle: () => process.exit(0) });
    } catch (err) {
      if (err instanceof DaemonAlreadyRunningError) return; // rendezvous won
      throw err;
    }
    return; // stays alive serving the socket
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
    process.exit(code);
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
    process.exit(code);
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
        process.exit(await runPipe(wrapArgs.command, decision.buffered, decision.ended));
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
    const ok = await runDoctor(config, statePath);
    process.exit(ok ? 0 : 1);
  }

  await runProxy(config, statePath, args.configPath);
}

async function runProxy(
  config: import('./types.js').SpeculateConfig,
  statePath: string | null,
  configLabel: string,
): Promise<void> {
  const proxy = new SpeculateProxy(config, { statePath });
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
      process.exit(0);
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
    process.exit(1);
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
  process.stderr.write(`[speculate] fatal: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
