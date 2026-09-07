/** Migration cleanup must preserve unrelated shell configuration. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShimsArgs, removeRcBlock, shimsDir, uninstallShims } from '../src/shims.js';

let home: string;
const BLOCK = '# >>> speculate shims >>>\nexport PATH="/legacy/shims:$PATH"\n# <<< speculate shims <<<\n';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-shims-'));
  vi.stubEnv('XDG_DATA_HOME', join(home, 'data'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('retired shim commands', () => {
  it.each(['install', 'status', ''])('gives migration guidance for %s', (action) => {
    const result = parseShimsArgs([action]);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('shims uninstall');
    expect((result as { error: string }).error).toContain('speculate on');
  });

  it('accepts removal options and rejects unknown arguments', () => {
    expect(parseShimsArgs(['uninstall', '--rc', '/tmp/custom', '--no-rc'])).toEqual({
      rcPath: '/tmp/custom', noRc: true,
    });
    expect(parseShimsArgs(['uninstall', '--rc'])).toHaveProperty('error');
    expect(parseShimsArgs(['uninstall', '--unknown'])).toHaveProperty('error');
  });
});

describe('rc block removal', () => {
  it.each(['\n', '\r\n'])('preserves surrounding shell content with %j line endings', (nl) => {
    const before = ['# user settings', '', 'export EDITOR=vim', ''].join(nl);
    const after = ['alias ll="ls -l"', '', '# trailing comment', ''].join(nl);
    expect(removeRcBlock(before + BLOCK.replaceAll('\n', nl) + after)).toBe(before + after);
  });

  it('leaves unmatched markers and inline mentions untouched', () => {
    for (const content of [
      '# my config\n',
      '# >>> speculate shims >>>\nexport KEEP=yes\n',
      'echo "# >>> speculate shims >>>"\nexport KEEP=yes\n# <<< speculate shims <<<\n',
    ]) expect(removeRcBlock(content)).toBeNull();
  });

  it('removes duplicate complete installer blocks', () => {
    expect(removeRcBlock(BLOCK + 'export KEEP=yes\n' + BLOCK)).toBe('export KEEP=yes\n');
  });
});

describe('uninstall migration', () => {
  it('removes existing shims and only the shell installer block; repeating is safe', () => {
    const dir = shimsDir(home);
    mkdirSync(dir, { recursive: true });
    for (const launcher of ['npx', 'uvx']) writeFileSync(join(dir, launcher), '# legacy shim');
    const rcPath = join(home, '.bashrc');
    const before = '# personal config\n\n';
    const after = 'export KEEP=yes\n';
    writeFileSync(rcPath, before + BLOCK + after);
    const opts = { home, shell: '/bin/bash', log: () => {} };
    expect(uninstallShims(opts)).toBe(0);
    expect(readFileSync(rcPath, 'utf8')).toBe(before + after);
    expect(existsSync(dir)).toBe(false);
    expect(uninstallShims(opts)).toBe(0);
    expect(readFileSync(rcPath, 'utf8')).toBe(before + after);
  });

  it('honors custom rc paths and --no-rc', () => {
    const rcPath = join(home, 'custom.rc');
    writeFileSync(rcPath, BLOCK);
    uninstallShims({ home, rcPath, noRc: true, log: () => {} });
    expect(readFileSync(rcPath, 'utf8')).toBe(BLOCK);
    uninstallShims({ home, rcPath, log: () => {} });
    expect(readFileSync(rcPath, 'utf8')).toBe('');
  });
});
