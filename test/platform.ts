/**
 * Capability probes for the test suite.
 *
 * Parts of Speculate depend on POSIX primitives that have no direct Windows
 * equivalent. The tests covering those are skipped — explicitly, with the
 * reason named at each call site — rather than weakened, so a run on a
 * machine lacking the capability reports honestly instead of erroring or
 * silently passing.
 */

export const isWindows = process.platform === 'win32';

/**
 * POSIX file-mode bits: 0700 state/usage directories and 0600 snapshots.
 * Windows expresses the same intent through ACLs instead.
 */
export const hasPosixFileModes = !isWindows;

/** POSIX sh, for the generated launcher shims and the sh stubs some tests plant. */
export const hasPosixShell = !isWindows;
