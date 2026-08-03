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

  it('loads a pre-0.14 config (no headers anywhere) unchanged', () => {
    const path = writeConfig({
      servers: {
        github: { command: 'gh-server', args: ['stdio'], profile: 'github' },
        remote: { url: 'https://example.test/mcp' },
      },
    });
    const cfg = loadConfig(path);
    expect(cfg.servers['github']?.headers).toBeUndefined();
    expect(cfg.servers['remote']?.headers).toBeUndefined();
    expect(cfg.servers['remote']?.url).toBe('https://example.test/mcp');
  });
});

describe('loadConfig: authenticated http upstreams (headers)', () => {
  it('resolves ${VAR} in a header VALUE from the environment at load', () => {
    vi.stubEnv('SPECULATE_TEST_TOKEN', 'ghp_secret_value');
    const path = writeConfig({
      servers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${SPECULATE_TEST_TOKEN}' },
        },
      },
    });
    const cfg = loadConfig(path);
    expect(cfg.servers['remote']?.headers).toEqual({
      Authorization: 'Bearer ghp_secret_value',
    });
  });

  it('resolves several placeholders in one value, and several headers', () => {
    vi.stubEnv('SPECULATE_TEST_A', 'aaa');
    vi.stubEnv('SPECULATE_TEST_B', 'bbb');
    const path = writeConfig({
      servers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: {
            Authorization: '${SPECULATE_TEST_A}-${SPECULATE_TEST_B}',
            'X-Api-Version': '2024-01-01',
          },
        },
      },
    });
    expect(loadConfig(path).servers['remote']?.headers).toEqual({
      Authorization: 'aaa-bbb',
      'X-Api-Version': '2024-01-01',
    });
  });

  it('fails loudly, naming the variable, when it is unset, never sending the literal', () => {
    vi.stubEnv('SPECULATE_TEST_MISSING', undefined);
    const path = writeConfig({
      servers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${SPECULATE_TEST_MISSING}' },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow(/SPECULATE_TEST_MISSING/);
    expect(() => loadConfig(path)).toThrow(/servers\.remote\.headers\.Authorization/);
    expect(() => loadConfig(path)).toThrow(/not set/);
  });

  it('treats an empty environment variable as unset (an empty token is a bug)', () => {
    vi.stubEnv('SPECULATE_TEST_EMPTY', '');
    const path = writeConfig({
      servers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${SPECULATE_TEST_EMPTY}' },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow(/SPECULATE_TEST_EMPTY/);
  });

  it('never leaks the resolved value into the error message', () => {
    vi.stubEnv('SPECULATE_TEST_TOKEN', 'ghp_secret_value');
    const path = writeConfig({
      servers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { 'Bad Name': 'Bearer ${SPECULATE_TEST_TOKEN}' },
        },
      },
    });
    let message = '';
    try {
      loadConfig(path);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Bad Name/);
    expect(message).not.toContain('ghp_secret_value');
  });

  it('rejects headers on a stdio server, like the command/url refinement', () => {
    const path = writeConfig({
      servers: { github: { command: 'gh-server', headers: { Authorization: 'x' } } },
    });
    expect(() => loadConfig(path)).toThrow(/headers/);
    expect(() => loadConfig(path)).toThrow(/url/);
  });

  it('rejects a header value carrying CR/LF (response-splitting guard)', () => {
    const path = writeConfig({
      servers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { 'X-Evil': 'a\r\nAuthorization: stolen' },
        },
      },
    });
    expect(() => loadConfig(path)).toThrow(/servers\.remote\.headers\.X-Evil/);
  });

  it('leaves a value with no placeholder exactly as written', () => {
    const path = writeConfig({
      servers: {
        remote: { url: 'https://example.test/mcp', headers: { 'X-Trace': 'literal $ value' } },
      },
    });
    expect(loadConfig(path).servers['remote']?.headers).toEqual({
      'X-Trace': 'literal $ value',
    });
  });
});
