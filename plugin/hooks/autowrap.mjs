#!/usr/bin/env node
/**
 * Speculate's auto-wrap hook: run `speculate sync` at session start, and never
 * fail one.
 *
 * `speculate on` bakes the absolute CLI invocation into this plugin's
 * hooks.json at install time and passes it here as argv (SPECULATE_CLI is
 * honoured too). It is baked, not looked up on PATH, because Claude Code
 * cannot exec a `.cmd` shim as a hook on Windows and npm installs `speculate`
 * as exactly that.
 *
 * `claude plugin install` COPIES the plugin into the user's plugin cache, so
 * this file OUTLIVES an `npm uninstall` of Speculate while the baked path does
 * not. Hence the first thing it does is check that path still exists and exit
 * 0 in silence when it doesn't — otherwise a removed install would error on
 * every session start, forever.
 *
 * Why spawn the CLI rather than import it: the baked argv is whatever
 * `selfCommand()` resolved — `<cli.js>` for a built install, `<tsx> <cli.ts>`
 * for a source checkout — and spawning is the one shape that runs both. It
 * also inherits the CLI's own last-resort exit cap instead of re-inventing it.
 *
 * Why the summary goes to stdout as a `systemMessage` JSON object: on exit 0 a
 * hook's stderr is invisible to the user, and for SessionStart plain stdout is
 * injected into the MODEL's context. `systemMessage` is the documented channel
 * for a line the USER should see. It is emitted only when `sync` actually
 * wrapped something, which is rare; the fast path prints nothing at all.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2).filter((a) => a.length > 0);
const fromEnv = process.env.SPECULATE_CLI ?? '';
const cli = argv.length > 0 ? argv : fromEnv.length > 0 ? [fromEnv] : [];

// Speculate is gone (or the plugin was installed without `speculate on` ever
// baking a path in): cost nothing, say nothing, and above all exit 0.
if (cli.length === 0 || !cli.every((p) => existsSync(p))) process.exit(0);

let child;
try {
  child = spawn(process.execPath, [...cli, 'sync'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
} catch {
  process.exit(0); // unspawnable (EINVAL, ENOENT): still not the session's problem
}

let note = '';
child.stderr?.on('data', (chunk) => {
  if (note.length < 4096) note += String(chunk);
});
child.on('error', () => process.exit(0));
child.on('close', () => {
  // `sync` is silent unless it wrapped something; its summary is one line.
  const line = note
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (line) process.stdout.write(`${JSON.stringify({ systemMessage: line })}\n`);
  // No process.exit(): returning lets the write flush, and the exit code is
  // 0 regardless of how the child fared.
});
