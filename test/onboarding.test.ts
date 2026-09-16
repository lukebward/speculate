import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOnboarding } from '../src/onboarding.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'speculate-onboarding-'));
  roots.push(root);
  return root;
}

function executable(path: string, mode = 0o700): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/usr/bin/env node\n');
  chmodSync(path, mode);
}

function dependencies(input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  interactive?: boolean;
  answer?: string | null;
} = {}) {
  const output: string[] = [];
  const launch = vi.fn(async () => 7);
  const prompt = vi.fn(async () => input.answer ?? null);
  return {
    value: {
      env: input.env ?? { PATH: '' },
      platform: input.platform ?? 'linux' as NodeJS.Platform,
      home: input.home ?? fixture(),
      cwd: process.cwd(),
      isInteractive: () => input.interactive ?? false,
      prompt,
      write: (text: string) => output.push(text),
      launch,
    },
    output,
    launch,
    prompt,
  };
}

describe('native client onboarding', () => {
  it('launches the only installed client through the existing proxy-default path', async () => {
    const root = fixture();
    executable(join(root, 'claude'));
    const test = dependencies({ env: { PATH: root, SPECULATE_CODEX_BIN: join(root, 'missing-codex') } });

    await expect(runOnboarding(test.value)).resolves.toBe(7);
    expect(test.launch).toHaveBeenCalledWith({
      agent: 'claude', observe: 'proxy', clientArgs: [], jsonReport: null,
    });
    expect(test.prompt).not.toHaveBeenCalled();
  });

  it('honors a readable JavaScript entrypoint override without requiring an executable bit', async () => {
    const root = fixture();
    const codex = join(root, 'codex.mjs');
    executable(codex, 0o600);
    const test = dependencies({
      env: { PATH: '', SPECULATE_CLAUDE_BIN: join(root, 'missing-claude'), SPECULATE_CODEX_BIN: codex },
    });

    await expect(runOnboarding(test.value)).resolves.toBe(7);
    expect(test.launch).toHaveBeenCalledWith({
      agent: 'codex', observe: 'proxy', clientArgs: [], jsonReport: null,
    });
  });

  it('accepts a readable Claude JavaScript entrypoint that the launcher runs through Node', async () => {
    const root = fixture();
    const claude = join(root, 'claude.mjs');
    executable(claude, 0o600);
    const test = dependencies({
      env: { PATH: '', SPECULATE_CLAUDE_BIN: claude, SPECULATE_CODEX_BIN: join(root, 'missing-codex') },
    });

    await expect(runOnboarding(test.value)).resolves.toBe(7);
    expect(test.launch).toHaveBeenCalledWith({
      agent: 'claude', observe: 'proxy', clientArgs: [], jsonReport: null,
    });
  });

  it('prints guidance for both clients when neither is installed', async () => {
    const home = fixture();
    const test = dependencies({
      env: {
        PATH: '',
        SPECULATE_CLAUDE_BIN: join(home, 'missing-claude'),
        SPECULATE_CODEX_BIN: join(home, 'missing-codex'),
      },
      home,
    });

    await expect(runOnboarding(test.value)).resolves.toBe(2);
    expect(test.launch).not.toHaveBeenCalled();
    expect(test.prompt).not.toHaveBeenCalled();
    expect(test.output.join('')).toContain('SPECULATE_CLAUDE_BIN');
    expect(test.output.join('')).toContain('SPECULATE_CODEX_BIN');
    expect(test.output.join('')).toContain('sign-in prompt');
    expect(test.output.join('')).toContain('speculate run claude');
    expect(test.output.join('')).toContain('speculate run codex');
  });

  it('never reads stdin when both clients are installed noninteractively', async () => {
    const root = fixture();
    executable(join(root, 'claude'));
    executable(join(root, 'codex'));
    const test = dependencies({ env: { PATH: root }, interactive: false });

    await expect(runOnboarding(test.value)).resolves.toBe(2);
    expect(test.prompt).not.toHaveBeenCalled();
    expect(test.launch).not.toHaveBeenCalled();
    expect(test.output.join('')).toContain('speculate run claude');
    expect(test.output.join('')).toContain('speculate run codex');
  });

  it.each([
    ['1', 'claude'],
    ['claude', 'claude'],
    ['2', 'codex'],
    ['CoDeX', 'codex'],
  ] as const)('launches interactive choice %s as %s', async (answer, agent) => {
    const root = fixture();
    executable(join(root, 'claude'));
    executable(join(root, 'codex'));
    const test = dependencies({ env: { PATH: root }, interactive: true, answer });

    await expect(runOnboarding(test.value)).resolves.toBe(7);
    expect(test.prompt).toHaveBeenCalledOnce();
    expect(test.launch).toHaveBeenCalledWith({ agent, observe: 'proxy', clientArgs: [], jsonReport: null });
  });

  it.each([null, '', '3', 'other'])('fails closed for a missing or invalid choice %#', async (answer) => {
    const root = fixture();
    executable(join(root, 'claude'));
    executable(join(root, 'codex'));
    const test = dependencies({ env: { PATH: root }, interactive: true, answer });

    await expect(runOnboarding(test.value)).resolves.toBe(2);
    expect(test.launch).not.toHaveBeenCalled();
  });

  it('closes an interactive prompt on EOF without launching', async () => {
    const root = fixture();
    executable(join(root, 'claude'));
    executable(join(root, 'codex'));
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();
    const launch = vi.fn(async () => 7);

    await expect(runOnboarding({
      env: { PATH: root },
      home: root,
      stdin: input as unknown as NodeJS.ReadStream,
      stderr: output as unknown as NodeJS.WriteStream,
      isInteractive: () => true,
      launch,
    })).resolves.toBe(2);
    expect(launch).not.toHaveBeenCalled();
  });

  it('detects Windows command shims without invoking them', async () => {
    const root = fixture();
    executable(join(root, 'claude.cmd'), 0o600);
    const test = dependencies({
      env: { PATH: root, SPECULATE_CODEX_BIN: join(root, 'missing-codex') },
      platform: 'win32',
    });

    await expect(runOnboarding(test.value)).resolves.toBe(7);
    expect(test.launch).toHaveBeenCalledWith({
      agent: 'claude', observe: 'proxy', clientArgs: [], jsonReport: null,
    });
  });

  it('uses the existing GUI fallback directories for both clients', async () => {
    const home = fixture();
    executable(join(home, '.claude', 'local', 'claude'));
    executable(join(home, '.codex', 'bin', 'codex'));
    const test = dependencies({ env: { PATH: '' }, home, interactive: true, answer: 'codex' });

    await expect(runOnboarding(test.value)).resolves.toBe(7);
    expect(test.launch).toHaveBeenCalledWith({
      agent: 'codex', observe: 'proxy', clientArgs: [], jsonReport: null,
    });
  });
});
