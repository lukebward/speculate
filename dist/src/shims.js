/** Removal support for the PATH shims retired after v0.19. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
export function parseShimsArgs(argv) {
    if (argv[0] !== 'uninstall') {
        return {
            error: "PATH shims were retired. Run 'speculate shims uninstall' to remove an existing installation; use 'speculate on' or explicit 'speculate wrap' for MCP servers.",
        };
    }
    const out = { rcPath: null, noRc: false };
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--rc') {
            const v = argv[++i];
            if (!v)
                return { error: '--rc requires a path' };
            out.rcPath = v;
        }
        else if (a === '--no-rc') {
            out.noRc = true;
        }
        else {
            return { error: `unknown shims uninstall argument '${a}'` };
        }
    }
    return out;
}
export function shimsDir(home = homedir()) {
    const xdg = process.env.XDG_DATA_HOME;
    const dataHome = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
    return join(dataHome, 'speculate', 'shims');
}
/** Where the PATH line belongs for the user's shell; null → print-only. */
export function detectRcPath(home, shell) {
    const name = basename(shell ?? '');
    if (name === 'zsh')
        return join(home, '.zshrc');
    if (name === 'bash')
        return join(home, '.bashrc');
    if (name === 'fish')
        return join(home, '.config', 'fish', 'conf.d', 'speculate.fish');
    return null;
}
/** Remove only complete, line-delimited installer blocks, preserving other text. */
export function removeRcBlock(content) {
    const block = /^# >>> speculate shims >>>\r?\n[\s\S]*?^# <<< speculate shims <<<(?:\r?\n|$)/gm;
    const cleaned = content.replace(block, '');
    return cleaned === content ? null : cleaned;
}
export function uninstallShims(opts = {}) {
    const home = opts.home ?? homedir();
    const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
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
