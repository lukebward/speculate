import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSessionConfig, parseConfig } from '../src/config.js';

const directories: string[] = [];

function writeConfig(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'semantic-config-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('semantic ranking configuration', () => {
  it('leaves semantic ranking disabled when the optional block is absent', () => {
    expect(parseConfig({ servers: { workspace: { command: 'server' } } }).semanticRanking)
      .toBeUndefined();
  });

  it('applies the bounded defaults when the block is present', () => {
    expect(parseConfig({
      semanticRanking: {},
      servers: { workspace: { command: 'server' } },
    }).semanticRanking).toEqual({
      mode: 'off',
      model: 'jev-1.13.0',
      timeoutMs: 150,
      maxCandidates: 16,
      horizonMs: 30_000,
      maxRequestsPerMinute: 60,
      maxRequestsPerSession: 1_000,
    });
  });

  it('loads a session-only configuration without proxy servers', () => {
    const parsed = loadSessionConfig(writeConfig({ semanticRanking: { mode: 'shadow' }, servers: {} }));
    expect(parsed.semanticRanking?.mode).toBe('shadow');
    expect(parsed.servers).toEqual({});
  });

  it.each([
    ['mode', 'enabled'],
    ['model', ''],
    ['model', '   '],
    ['model', 'jev-latest'],
    ['model', 'other-1.2.3'],
    ['model', 'x'.repeat(129)],
    ['timeoutMs', 0],
    ['timeoutMs', 501],
    ['maxCandidates', 0],
    ['maxCandidates', 17],
    ['horizonMs', 0],
    ['horizonMs', 30_001],
    ['maxRequestsPerMinute', 0],
    ['maxRequestsPerMinute', 61],
    ['maxRequestsPerSession', 0],
    ['maxRequestsPerSession', 1_001],
  ])('rejects an unsafe %s value', (field, value) => {
    expect(() => parseConfig({
      semanticRanking: { [field]: value },
      servers: { workspace: { command: 'server' } },
    })).toThrow(`semanticRanking.${field}`);
  });
});
