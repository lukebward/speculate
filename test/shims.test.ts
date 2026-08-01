/**
 * §13.12 launcher shims: the generated sh script resolves the REAL
 * launcher (skipping itself), defers to `wrap --sniff` only for
 * non-interactive use with the CLI installed, and the rc block is
 * marker-managed and idempotent.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { hasPosixShell } from './platform.js';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installShims,
  removeRcBlock,
  shimScript,
  shimsDir,
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
    installShims({ home, noRc: true, log });
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
    installShims({ home, rcPath, log });
    const rc = readFileSync(rcPath, 'utf8');
    expect(rc).toContain('# existing config');
    expect(rc).toContain(shimsDir(home));
    uninstallShims({ home, rcPath, log });
    expect(readFileSync(rcPath, 'utf8')).not.toContain('speculate');
    expect(existsSync(shimsDir(home))).toBe(false);
  });
});
