#!/usr/bin/env node
/**
 * speculate: installs the Speculate mod into Claude Code from npm.
 *
 *   speculate [install]   install the mod (restoring any 0.x wrapping first)
 *   speculate uninstall   remove it
 *   speculate wrap ...    0.x compatibility (below)
 *   speculate off         0.x compatibility: restore wrapped registrations
 *
 * WHY THIS FILE LIVES AT dist/src/cli.js. Speculate 0.x rewrote MCP server
 * registrations to launch `node <global>/speculate-mcp/dist/src/cli.js wrap
 * -- <original command>`. `npm update -g speculate-mcp` replaces the package
 * in place, so this exact path must keep answering `wrap`, or every server a
 * 0.x install wrapped would fail to start until its registration is restored.
 * A stdio `wrap` therefore runs the original command unchanged, as a plain
 * pass-through with no proxying. A remote (`--url`) wrap cannot be passed
 * through without a proxy, so it explains how to restore the registration.
 *
 * Restoring is delegated to 0.25.0's own `off`, which is the tested restore
 * (it handles Claude Code and Codex, every scope, and later edits), through
 * `npx speculate-mcp@0.25.0`. This file has no dependencies: npm installs it
 * as is.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEGACY = 'speculate-mcp@0.25.0';
const GITHUB_MARKETPLACE = 'lukebward/speculate';
const PLUGIN = 'speculate';
const isWindows = process.platform === 'win32';

const HELP = `speculate: install the Speculate mod into Claude Code

  speculate [install]   install the mod for every Claude Code session
  speculate uninstall   remove it

Inside Claude Code, /speculate shows what was served and saved, and
/speculate forget clears what was learned. Docs: https://lukebward.github.io/speculate/`;

const [command = 'install', ...rest] = process.argv.slice(2);

switch (command) {
  case 'install':
    process.exit(install());
    break;
  case 'uninstall':
    process.exit(uninstall());
    break;
  case 'wrap':
    wrap(rest);
    break;
  case 'off':
    process.exit(restoreLegacy() ? 0 : 1);
    break;
  case '--version':
  case '-v':
    console.log(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  default:
    console.error(`speculate: unknown command "${command}"\n\n${HELP}`);
    process.exit(2);
}

function install() {
  if (!claudeAvailable()) {
    console.error('speculate: Claude Code (`claude`) is not on PATH. Install it first: https://code.claude.com');
    return 1;
  }
  const wrapped = findLegacyWrapping();
  if (wrapped.length > 0) {
    console.log(`Speculate 0.x wrapped ${wrapped.length} MCP server registration(s):`);
    for (const where of wrapped) console.log(`  ${where}`);
    console.log(`Restoring them with ${LEGACY}'s own \`off\` before installing the mod...\n`);
    if (!restoreLegacy()) {
      console.error(`\nspeculate: the restore did not finish. Run \`npx -y ${LEGACY} off\` yourself, then \`speculate install\` again.`);
      return 1;
    }
    const left = findLegacyWrapping();
    if (left.length > 0) {
      // `off` restores what 0.x recorded; an entry with no record (its state
      // was deleted, or it was copied by hand) stays wrapped. The pass-through
      // keeps a stdio one working, so this is a warning, not a stop.
      console.log('\nThese registrations are still wrapped, so 0.x had no record of them:');
      for (const where of left) console.log(`  ${where}`);
      console.log('A local (stdio) one keeps working through a plain pass-through. To restore it, re-add the');
      console.log('server with its original command: everything after `--` in its args.');
    }
    console.log('');
  }
  // 0.x's session-start re-wrap hook is a plugin of its own; 1.0 replaces it.
  removeLegacyPlugin();
  const source = marketplaceSource();
  console.log(`Installing the Speculate mod from ${source === PACKAGE_ROOT ? 'this npm package' : source}...`);
  const ran = run('claude', ['plugin', 'install', PLUGIN, '--marketplace', source, '--scope', 'user']);
  if (ran !== 0) return ran;
  console.log([
    '',
    'Speculate is installed for every Claude Code session. In a running session,',
    'run /reload-plugins to start it there. /speculate shows what it saved.',
    source === PACKAGE_ROOT
      ? 'It runs from this npm package: `npm update -g speculate-mcp` updates it.'
      : '',
  ].filter(Boolean).join('\n'));
  return 0;
}

function uninstall() {
  if (!claudeAvailable()) {
    console.error('speculate: Claude Code (`claude`) is not on PATH.');
    return 1;
  }
  const ran = run('claude', ['plugin', 'uninstall', PLUGIN, '--scope', 'user']);
  run('claude', ['plugin', 'marketplace', 'remove', PLUGIN]);
  if (ran === 0) console.log('Speculate is uninstalled. `npm uninstall -g speculate-mcp` removes this command.');
  return ran;
}

/**
 * A global install is a stable folder, so Claude Code reads the mod straight
 * from it and `npm update` updates the mod. An npx run lives in a cache that
 * npm may delete, so it installs from GitHub instead.
 */
function marketplaceSource() {
  const ephemeral = PACKAGE_ROOT.split(sep).includes('_npx');
  return ephemeral ? GITHUB_MARKETPLACE : PACKAGE_ROOT;
}

/** The registrations 0.x wrapped, as `<file>: <server>` lines. */
function findLegacyWrapping() {
  const found = [];
  // Claude Code keeps it beside its other settings when CLAUDE_CONFIG_DIR is set.
  const claudeJson = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
  const config = readJson(claudeJson);
  if (config) {
    for (const name of wrappedNames(config.mcpServers)) found.push(`${claudeJson}: ${name}`);
    for (const [project, entry] of Object.entries(config.projects ?? {})) {
      for (const name of wrappedNames(entry?.mcpServers)) found.push(`${claudeJson} (${project}): ${name}`);
      const shared = join(project, '.mcp.json');
      for (const name of wrappedNames(readJson(shared)?.mcpServers)) found.push(`${shared}: ${name}`);
    }
  }
  const codex = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  try {
    const text = readFileSync(codex, 'utf8');
    if (/speculate/i.test(text) && /["']wrap["']/.test(text)) found.push(`${codex}: one or more servers`);
  } catch {}
  return found;
}

function wrappedNames(servers) {
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers)
    .filter(([, entry]) => {
      const args = Array.isArray(entry?.args) ? entry.args : [];
      const at = args.indexOf('wrap');
      return at !== -1 && /speculate/i.test([entry.command ?? '', ...args.slice(0, at)].join(' '));
    })
    .map(([name]) => name);
}

/** Uninstalls 0.x's auto-wrap plugin and its marketplace, if present. */
function removeLegacyPlugin() {
  const quiet = { stdio: 'ignore', shell: isWindows };
  const gone = spawnSync('claude', ['plugin', 'uninstall', 'speculate-autowrap@speculate-mcp', '--scope', 'user'], quiet);
  spawnSync('claude', ['plugin', 'marketplace', 'remove', 'speculate-mcp'], quiet);
  if (gone.status === 0) console.log("Removed Speculate 0.x's auto-wrap plugin.");
}

function restoreLegacy() {
  return run(isWindows ? 'npx.cmd' : 'npx', ['-y', LEGACY, 'off']) === 0;
}

/**
 * 0.x compatibility. `wrap [flags] -- <command> <args...>` runs the original
 * server as is, its stdio, environment and exit status passed straight
 * through; nothing is proxied. `wrap --url ...` cannot be passed through.
 */
function wrap(args) {
  const dash = args.indexOf('--');
  const flags = dash === -1 ? args : args.slice(0, dash);
  if (dash === -1 || dash + 1 >= args.length) {
    process.stderr.write(
      flags.includes('--url')
        ? `[speculate] Speculate 1.0 no longer proxies remote MCP servers, so this wrapped server cannot start.\n` +
          `[speculate] Restore its original registration: run \`speculate install\` (or \`npx -y ${LEGACY} off\`).\n`
        : `[speculate] nothing to run: \`wrap\` expects \`-- <command> [args...]\`\n`,
    );
    process.exit(1);
  }
  const [file, ...fileArgs] = args.slice(dash + 1);
  process.stderr.write('[speculate] passing through a server wrapped by Speculate 0.x; run `speculate install` to restore its registration\n');
  const child = spawn(file, fileArgs, { stdio: 'inherit', shell: isWindows && /\.(cmd|bat)$/i.test(file) });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (err) => {
    process.stderr.write(`[speculate] could not start ${file}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

function claudeAvailable() {
  return spawnSync('claude', ['--version'], { stdio: 'ignore', shell: isWindows }).status === 0;
}

function run(file, args) {
  const ran = spawnSync(file, args, { stdio: 'inherit', shell: isWindows });
  return ran.status ?? 1;
}

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}
