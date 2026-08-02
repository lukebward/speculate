/**
 * §13.12 launcher shims: the generated sh script resolves the REAL
 * launcher (skipping itself), defers to `wrap --sniff` only for
 * non-interactive use with the CLI installed, and the rc block is
 * marker-managed and idempotent.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { hasPosixShell, isWindows } from './platform.js';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installShims,
  removeRcBlock,
  shimScript,
  shimsDir,
  shimsStatus,
  uninstallShims,
  upsertRcBlock,
} from '../src/shims.js';

let home: string;
let logs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-shims-'));
  logs = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const log = (l: string): void => {
  logs.push(l);
};

function makeFakeBin(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), script);
  chmodSync(join(dir, name), 0o755);
}

function runShim(
  shimPath: string,
  args: string[],
  path: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      shimPath,
      args,
      { env: { ...process.env, PATH: path, ...env } },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code?: number }).code ?? 1)
            : err
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('shim script behavior', () => {
  let shimDir: string;
  let realDir: string;
  let specDir: string;

  beforeEach(() => {
    // platform is pinned so the POSIX behavior under test is exercised on
    // every OS in the matrix (installShims degrades on win32 — see below).
    installShims({ home, noRc: true, log, platform: 'linux' });
    shimDir = shimsDir(home);
    realDir = join(home, 'realbin');
    specDir = join(home, 'specbin');
    makeFakeBin(realDir, 'npx', '#!/bin/sh\necho "real-npx $@"\n');
    makeFakeBin(specDir, 'speculate', '#!/bin/sh\necho "speculate-called $@"\n');
  });

  it.skipIf(!hasPosixShell)('resolves and execs the real launcher when speculate is not installed', async () => {
    const res = await runShim(join(shimDir, 'npx'), ['-y', 'pkg'], `${shimDir}:${realDir}`);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('real-npx -y pkg\n');
  });

  it.skipIf(!hasPosixShell)('routes through speculate wrap --sniff when available and non-interactive', async () => {
    const res = await runShim(
      join(shimDir, 'npx'),
      ['-y', 'some-mcp-server'],
      `${shimDir}:${specDir}:${realDir}`,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(
      `speculate-called wrap --sniff -- ${join(realDir, 'npx')} -y some-mcp-server\n`,
    );
  });

  it.skipIf(!hasPosixShell)('honors the SPECULATE_OFF kill switch', async () => {
    const res = await runShim(
      join(shimDir, 'npx'),
      ['x'],
      `${shimDir}:${specDir}:${realDir}`,
      { SPECULATE_OFF: '1' },
    );
    expect(res.stdout).toBe('real-npx x\n');
  });

  it.skipIf(!hasPosixShell)('fails with 127 when no real launcher exists anywhere', async () => {
    const res = await runShim(join(shimDir, 'npx'), [], shimDir);
    expect(res.code).toBe(127);
  });

  it('generates POSIX sh scripts for every launcher', () => {
    for (const l of ['npx', 'uvx']) {
      const s = shimScript(l);
      expect(s.startsWith('#!/bin/sh\n')).toBe(true);
      expect(s).toContain(`'${l}' not found`);
      expect(s).toContain('wrap --sniff --');
      expect(existsSync(join(shimDir, l))).toBe(true);
    }
  });
});

describe('rc block management', () => {
  it('inserts, replaces idempotently, and removes the marked block', () => {
    const block = '# >>> speculate shims >>>\nexport PATH="/x:$PATH"\n# <<< speculate shims <<<\n';
    const once = upsertRcBlock('# my rc\n', block);
    expect(once).toContain('/x');
    const twice = upsertRcBlock(once, block);
    expect(twice.split('speculate shims >>>').length).toBe(2); // exactly one block
    const removed = removeRcBlock(twice)!;
    expect(removed).not.toContain('speculate');
    expect(removed).toContain('# my rc');
    expect(removeRcBlock('# nothing here\n')).toBeNull();
  });

  it('install/uninstall edit the rc file via markers', () => {
    const rcPath = join(home, '.zshrc');
    writeFileSync(rcPath, '# existing config\n');
    installShims({ home, rcPath, log, platform: 'linux' });
    const rc = readFileSync(rcPath, 'utf8');
    expect(rc).toContain('# existing config');
    expect(rc).toContain(shimsDir(home));
    uninstallShims({ home, rcPath, log, platform: 'linux' });
    expect(readFileSync(rcPath, 'utf8')).not.toContain('speculate');
    expect(existsSync(shimsDir(home))).toBe(false);
  });
});

describe('win32 degradation', () => {
  it('install writes nothing and says why (sh shims cannot run on Windows)', () => {
    const rcPath = join(home, '.bashrc');
    writeFileSync(rcPath, '# existing config\n');
    const code = installShims({ home, rcPath, log, platform: 'win32' });
    expect(code).toBe(2); // asked to do something it cannot do
    expect(logs.join('\n')).toContain('not supported on Windows');
    expect(existsSync(join(shimsDir(home), 'npx'))).toBe(false);
    // Git Bash would parse a drive-colon PATH entry into two dead components.
    expect(readFileSync(rcPath, 'utf8')).toBe('# existing config\n');
  });

  it('status reports the platform instead of misreading PATH', () => {
    const code = shimsStatus({ home, log, platform: 'win32' });
    expect(code).toBe(0); // a status report is not a failure
    expect(logs.join('\n')).toContain('not supported on Windows');
    expect(logs.join('\n')).not.toContain('on PATH in this shell');
  });

  it.skipIf(isWindows)('reports PATH membership honestly on POSIX', () => {
    installShims({ home, noRc: true, log, platform: process.platform });
    const previous = process.env.PATH;
    process.env.PATH = [shimsDir(home), '/usr/bin'].join(':');
    try {
      logs = [];
      shimsStatus({ home, log, platform: process.platform });
    } finally {
      process.env.PATH = previous;
    }
    expect(logs.join('\n')).toContain('shim dir IS on PATH');
  });
});
