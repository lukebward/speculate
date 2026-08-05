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
 * for text the USER should see. It is emitted only when `sync` actually
 * changed something, which is rare; the fast path prints nothing at all.
 *
 * And ONLY then. The child's stderr also carries Node warnings, tsx notices
 * and, on a broken install, stack traces — none of which a user should meet at
 * every session start. So the lines are taken by prefix rather than by
 * position, and only from a run that exited 0. Every matching line is kept:
 * `sync` emits up to two (a wrap and a shadow removal can happen in one pass),
 * and forwarding only the last silently swallowed the other.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Heartbeat first, before anything can bail: `speculate status` reads this
// to tell "the hook never fires" (a GUI-launched host with no usable PATH,
// a dead matcher) apart from "no session has started" — the one failure mode
// that is otherwise perfectly silent. Same XDG resolution as the CLI's
// managedStatePath, duplicated because this file is deliberately
// dependency-free (plugins install as checkouts; there is nothing to import
// from). The filename is pinned to manage.ts's AUTOWRAP_HEARTBEAT_FILE by a
// test. Best-effort in every direction: a heartbeat must never fail a
// session start.
try {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome =
    xdg && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state');
  const dir = join(stateHome, 'speculate');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'hook-heartbeat.json'), `${JSON.stringify({ at: Date.now() })}\n`, {
    mode: 0o600,
  });
} catch {
  // never the session's problem
}

const raw = process.argv.slice(2).filter((a) => a.length > 0);
// Everything before `--` is the baked CLI invocation (existence-checked);
// everything after it is passed to `sync` verbatim — today, `--claude-bin`,
// the absolute host CLI a GUI-launched session may not find on PATH.
const sep = raw.indexOf('--');
const argv = sep === -1 ? raw : raw.slice(0, sep);
const extra = sep === -1 ? [] : raw.slice(sep + 1);
const fromEnv = process.env.SPECULATE_CLI ?? '';
const cli = argv.length > 0 ? argv : fromEnv.length > 0 ? [fromEnv] : [];

// Speculate is gone (or the plugin was installed without `speculate on` ever
// baking a path in): cost nothing, say nothing, and above all exit 0.
if (cli.length === 0 || !cli.every((p) => existsSync(p))) process.exit(0);

let child;
try {
  child = spawn(process.execPath, [...cli, 'sync', ...extra], {
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
child.on('close', (code) => {
  // A run that failed has nothing to tell the user: it is a bug report, not a
  // status line, and `speculate status` is where diagnosis lives.
  if (code !== 0) return;
  // `sync` is silent unless it changed something, and every line it writes is
  // prefixed. There can be MORE THAN ONE — a single pass can both wrap new
  // servers and remove a shadow whose .mcp.json licence is gone — so every
  // matching line is kept and joined. Taking the last one dropped the "wrapped
  // N new servers" notice in exactly the session it was earned.
  const lines = note
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('[speculate]'));
  if (lines.length > 0) {
    process.stdout.write(`${JSON.stringify({ systemMessage: lines.join('\n') })}\n`);
  }
  // No process.exit(): returning lets the write flush, and the exit code is
  // 0 regardless of how the child fared.
});
