/**
 * Capability probes for the test suite.
 *
 * Parts of Speculate depend on POSIX primitives that have no direct Windows
 * equivalent, and one tool surface depends on ripgrep being installed. The
 * tests covering those are skipped — explicitly, with the reason named at
 * each call site — rather than weakened, so a run on a machine lacking the
 * capability reports honestly instead of erroring or silently passing.
 *
 * See DESIGN.md "Platform support" for what is still POSIX-only and why.
 */
import { execFileSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';

/**
 * POSIX file-mode bits: 0700 state dirs, 0600 snapshots, and the 0o111
 * execute bit the plugin hook uses to resolve `speculate` on PATH. Windows
 * expresses all of this through ACLs and PATHEXT instead.
 */
export const hasPosixFileModes = !isWindows;

/**
 * Unix-domain sockets whose parent directory is verified 0700-and-owned-by-us
 * before binding (src/execDaemon.ts). The exec daemon is POSIX-only until
 * that guard has a reviewed Windows named-pipe equivalent.
 */
export const hasUnixSockets = !isWindows;

/** POSIX sh, for the generated launcher shims and the sh stubs some tests plant. */
export const hasPosixShell = !isWindows;

/**
 * Whether CLI speculation can actually land a prefetch hit.
 *
 * KNOWN WINDOWS LIMITATION. The workspace watcher (shell/speculate-shell.ts,
 * src/execDaemon.ts) invalidates the buffer on any event under the workspace
 * root, `.git` included. On Windows git rewrites `.git/index` as a side
 * effect of the very reads the shell server serves, so every prefetch is
 * flushed before the agent asks for it and the profile rules record zero
 * hits. Reproduced by re-running the shell integration suite with
 * `--no-watch`, which passes.
 *
 * Not fixed by simply ignoring `.git`: `git add` changes what git_status and
 * git_diff return without touching the working tree, so that would trade a
 * missed prefetch for a stale result. Needs a freshness design that tells an
 * index refresh apart from a real staging change.
 */
export const cliSpeculationLandsHits = !isWindows;

/**
 * ripgrep on PATH. The shell server only exposes its `search` tool when rg is
 * present, so the fixed-surface and search tests require it.
 */
export const hasRipgrep = ((): boolean => {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
