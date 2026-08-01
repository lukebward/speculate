/**
 * Launcher shims — the opt-in, future-proof wrap seam (DESIGN.md §13.12).
 *
 * `speculate shims install` puts tiny sh shims for `npx` and `uvx` early
 * on PATH. Every MCP server any client launches through those commands —
 * including servers the user adds NEXT YEAR — gets speculation, because
 * the shim defers to `wrap --sniff`: if the first client line isn't an
 * MCP initialize, the shim collapses to `exec` of the real binary and the
 * invocation is byte-identical to an unshimmed one.
 *
 * Guards, in order: TTY on stdin/stdout (interactive use is never MCP),
 * the SPECULATE_OFF kill switch, and `speculate` actually being on PATH.
 * All three fall through to the real launcher.
 *
 * This is the ONLY Speculate feature that touches a dotfile (one marked,
 * removable PATH block), which is why it is opt-in and not part of
 * `speculate on`. Known limits, printed at install: GUI-launched clients
 * don't read shell rc files, and `npx` calls from scripts pay one extra
 * process hop.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

export const SHIMMED_LAUNCHERS = ['npx', 'uvx'] as const;

const BLOCK_START = '# >>> speculate shims >>>';
const BLOCK_END = '# <<< speculate shims <<<';

export interface ShimsArgs {
  action: 'install' | 'uninstall' | 'status';
  rcPath: string | null;
  noRc: boolean;
}

export function parseShimsArgs(argv: string[]): ShimsArgs | { error: string } {
  const action = argv[0];
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    return { error: `shims needs an action: install | uninstall | status` };
  }
  const out: ShimsArgs = { action, rcPath: null, noRc: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--rc') {
      const v = argv[++i];
      if (!v) return { error: '--rc requires a path' };
      out.rcPath = v;
    } else if (a === '--no-rc') {
      out.noRc = true;
    } else {
      return { error: `unknown shims argument '${a}'` };
    }
  }
  return out;
}

export function shimsDir(home: string = homedir()): string {
  const xdg = process.env.XDG_DATA_HOME;
  const dataHome = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return join(dataHome, 'speculate', 'shims');
}

/** The sh shim for one launcher. POSIX sh only — no bashisms. */
export function shimScript(launcher: string): string {
  return `#!/bin/sh
# speculate shim for ${launcher}: MCP servers launched through this get
# speculation automatically; everything else passes straight through
# ('wrap --sniff' degrades to a byte-transparent pipe for non-MCP use).
# Installed by 'speculate shims install'; 'speculate shims uninstall' removes it.
SPECULATE_SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
REAL=""
IFS_SAVE=$IFS
IFS=:
for d in $PATH; do
  [ "$d" = "$SPECULATE_SHIM_DIR" ] && continue
  [ -x "$d/${launcher}" ] || continue
  [ "$d/${launcher}" -ef "$0" ] && continue
  REAL="$d/${launcher}"
  break
done
IFS=$IFS_SAVE
if [ -z "$REAL" ]; then
  echo "speculate shim: real '${launcher}' not found on PATH" >&2
  exit 127
fi
if [ -t 0 ] || [ -t 1 ] || [ -n "$SPECULATE_OFF" ]; then
  exec "$REAL" "$@"
fi
if command -v speculate >/dev/null 2>&1; then
  exec speculate wrap --sniff -- "$REAL" "$@"
fi
exec "$REAL" "$@"
`;
}

/** Where the PATH line belongs for the user's shell; null → print-only. */
export function detectRcPath(home: string, shell: string | undefined): string | null {
  const name = basename(shell ?? '');
  if (name === 'zsh') return join(home, '.zshrc');
  if (name === 'bash') return join(home, '.bashrc');
  if (name === 'fish') return join(home, '.config', 'fish', 'conf.d', 'speculate.fish');
  return null;
}

function rcBlock(dir: string, fish: boolean): string {
  const line = fish
    ? `fish_add_path --prepend --move ${dir}`
    : `export PATH="${dir}:$PATH"`;
  return `${BLOCK_START}\n# MCP speculation for npx/uvx-launched servers ('speculate shims uninstall' removes this)\n${line}\n${BLOCK_END}\n`;
}

/** Insert-or-replace the marked block. Returns the new file content. */
export function upsertRcBlock(content: string, block: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + block.trimEnd() + content.slice(end + BLOCK_END.length);
  }
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}\n${block}`;
}

/** Remove the marked block. Returns null when no block exists. */
export function removeRcBlock(content: string): string | null {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return null;
  let head = content.slice(0, start);
  const tail = content.slice(end + BLOCK_END.length).replace(/^\n/, '');
  head = head.replace(/\n\n$/, '\n');
  return head + tail;
}

export interface ShimsOptions {
  home?: string;
  shell?: string;
  rcPath?: string | null;
  noRc?: boolean;
  log?: (line: string) => void;
  /** Injectable for tests; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

/**
 * The shims are `#!/bin/sh` launchers on a PATH the shell reads at startup —
 * neither exists on Windows. Say so once, plainly, instead of writing files
 * Windows can't execute and an rc line Git Bash would split on the drive
 * colon into two dead PATH entries.
 */
const WIN32_NOTE =
  '[speculate] shims are POSIX-only (sh launchers) — not supported on Windows; ' +
  "use 'speculate on' (or 'speculate try') instead";

export function installShims(opts: ShimsOptions = {}): number {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if ((opts.platform ?? process.platform) === 'win32') {
    log(WIN32_NOTE);
    return 2; // asked for something this platform cannot do — say so in $?
  }
  const dir = shimsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const launcher of SHIMMED_LAUNCHERS) {
    const path = join(dir, launcher);
    writeFileSync(path, shimScript(launcher));
    chmodSync(path, 0o755);
  }
  log(`[speculate] shims written: ${SHIMMED_LAUNCHERS.map((l) => join(dir, l)).join(', ')}`);

  const rcPath = opts.noRc ? null : (opts.rcPath ?? detectRcPath(home, opts.shell ?? process.env.SHELL));
  if (!rcPath) {
    log(`[speculate] add this yourself (shell not auto-detected or --no-rc):`);
    log(`[speculate]   export PATH="${dir}:$PATH"`);
  } else {
    const fish = rcPath.endsWith('.fish');
    mkdirSync(join(rcPath, '..'), { recursive: true });
    const existing = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';
    writeFileSync(rcPath, upsertRcBlock(existing, rcBlock(dir, fish)));
    log(`[speculate] PATH block added to ${rcPath} — restart your shell (or source it)`);
  }
  log(
    `[speculate] note: GUI-launched MCP clients don't read shell rc files; ` +
      `use 'speculate on' for those. SPECULATE_OFF=1 bypasses the shims.`,
  );
  return 0;
}

export function uninstallShims(opts: ShimsOptions = {}): number {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const dir = shimsDir(home);
  rmSync(dir, { recursive: true, force: true });
  log(`[speculate] removed ${dir}`);
  const rcPath = opts.noRc ? null : (opts.rcPath ?? detectRcPath(home, opts.shell ?? process.env.SHELL));
  if (rcPath && existsSync(rcPath)) {
    const cleaned = removeRcBlock(readFileSync(rcPath, 'utf8'));
    if (cleaned !== null) {
      writeFileSync(rcPath, cleaned);
      log(`[speculate] PATH block removed from ${rcPath}`);
    }
  }
  return 0;
}

export function shimsStatus(opts: ShimsOptions = {}): number {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    log(WIN32_NOTE);
    return 0; // an honest report is not a failure
  }
  const dir = shimsDir(home);
  const installed = SHIMMED_LAUNCHERS.filter((l) => existsSync(join(dir, l)));
  log(
    installed.length === 0
      ? `[speculate] shims not installed (dir: ${dir})`
      : `[speculate] shims installed: ${installed.join(', ')} in ${dir}`,
  );
  // Reached only on POSIX (win32 returned above), so ':' is the right
  // separator here — on Windows it never was: every entry carries a drive
  // colon, so this membership test could not match and always misreported.
  const onPath = (process.env.PATH ?? '').split(':').includes(dir);
  log(`[speculate] shim dir ${onPath ? 'IS' : 'is NOT'} on PATH in this shell`);
  return 0;
}
