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
import { loadConfig } from './config.js';
import { defaultStatePath } from './persistence.js';
import { SpeculateProxy } from './proxy.js';
import { runDoctor } from './doctor.js';
import { VERSION } from './version.js';

const HELP = `speculate ${VERSION} — speculative-prefetching MCP proxy

usage:
  speculate --config <path> [--mode strict|annotated|off]   run the proxy (stdio MCP)
  speculate doctor --config <path>                          connect upstreams, explain
                                                            per-tool speculation eligibility
  speculate validate --config <path>                        validate the config and exit

options:
  --config <path>   path to speculate.config.json (required)
  --mode <mode>     override the config's speculation mode for this run
  --version         print version and exit
  --help            show this help
`;

interface Args {
  command: 'run' | 'doctor' | 'validate';
  configPath: string;
  modeOverride: 'strict' | 'annotated' | 'off' | null;
}

function fail(message: string): never {
  process.stderr.write(`speculate: ${message}\nRun 'speculate --help' for usage.\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let command: Args['command'] = 'run';
  let configPath: string | null = null;
  let modeOverride: Args['modeOverride'] = null;
  let i = 0;
  if (argv[0] === 'doctor' || argv[0] === 'validate') {
    command = argv[0];
    i = 1;
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
  return { command, configPath, modeOverride };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  const proxy = new SpeculateProxy(config, { statePath });
  const shutdown = async (): Promise<void> => {
    try {
      await proxy.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await proxy.start();
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
