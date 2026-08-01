/**
 * Config loading: a ≤0.10 config naming the retired 'shell' profile must
 * degrade to a profile-less server (its healthy siblings keep working), while
 * a genuinely typo'd profile still fails loudly at load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const dirs: string[] = [];

function writeConfig(data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-config-'));
  dirs.push(dir);
  const path = join(dir, 'speculate.config.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it("degrades a retired 'shell' profile instead of failing the whole config", () => {
    const path = writeConfig({
      servers: {
        github: { command: 'gh-server', profile: 'github' },
        workspace: { command: 'speculate-shell', profile: 'shell' },
      },
    });
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    });

    const cfg = loadConfig(path);

    expect(Object.keys(cfg.servers).sort()).toEqual(['github', 'workspace']);
    expect(cfg.servers['workspace']?.profile).toBeUndefined();
    expect(cfg.servers['github']?.profile).toBe('github'); // healthy sibling intact
    expect(written.join('')).toContain("profile 'shell'");
    expect(written.join('')).toContain('retired in 0.11');
  });

  it('still rejects a genuinely unknown profile', () => {
    const path = writeConfig({ servers: { github: { command: 'gh', profile: 'gitlab' } } });
    expect(() => loadConfig(path)).toThrow(/unknown profile 'gitlab'/);
  });
});
