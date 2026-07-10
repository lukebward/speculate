#!/usr/bin/env node
/**
 * Speculate CLI: `speculate --config speculate.config.json`
 *
 * Speaks MCP over stdio to the host (stdout is protocol; all diagnostics go
 * to stderr).
 */
import { loadConfig } from './config.js';
import { SpeculateProxy } from './proxy.js';

function usage(): never {
  process.stderr.write(
    `usage: speculate --config <path> [--mode strict|annotated|off]\n`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let configPath: string | null = null;
  let modeOverride: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') configPath = argv[++i] ?? null;
    else if (a === '--mode') modeOverride = argv[++i] ?? null;
    else if (a === '--version') {
      process.stderr.write('speculate 0.1.0\n');
      process.exit(0);
    } else usage();
  }
  if (!configPath) usage();

  const config = loadConfig(configPath);
  if (modeOverride) {
    if (!['strict', 'annotated', 'off'].includes(modeOverride)) usage();
    config.mode = modeOverride as typeof config.mode;
  }

  const proxy = new SpeculateProxy(config);
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
  process.stderr.write(
    `[speculate] proxying ${Object.keys(config.servers).join(', ')} (mode: ${config.mode})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[speculate] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
