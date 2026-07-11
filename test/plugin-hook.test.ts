/**
 * §13.12 plugin Bash hook: the rewrite fires only for safe, table-shaped,
 * metachar-free commands with the CLI installed — and stays silent
 * (fail-open) in every other case.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../plugin/hooks/bash-rewrite.mjs', import.meta.url).pathname;

let binDir: string;

beforeAll(() => {
  // A PATH entry that contains an executable `speculate`.
  binDir = mkdtempSync(join(tmpdir(), 'speculate-hookbin-'));
  writeFileSync(join(binDir, 'speculate'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'speculate'), 0o755);
});
afterAll(() => rmSync(binDir, { recursive: true, force: true }));

function runHook(
  input: unknown,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString() }));
    child.stdin.end(JSON.stringify(input));
  });
}

const bash = (command: string) => ({
  tool_name: 'Bash',
  tool_input: { command, description: 'test' },
});

describe('bash-rewrite hook', () => {
  it('rewrites a table-shaped read-only command, preserving other input fields', async () => {
    const { code, stdout } = await runHook(bash('git status'));
    expect(code).toBe(0);
    const res = JSON.parse(stdout);
    expect(res.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(res.hookSpecificOutput.updatedInput.command).toBe('speculate exec -- git status');
    expect(res.hookSpecificOutput.updatedInput.description).toBe('test');
  });

  it.each([
    ['git diff --cached', 'speculate exec -- git diff --cached'],
    ['rg -n needle src', 'speculate exec -- rg -n needle src'],
    ['ls -la', 'speculate exec -- ls -la'],
    ['git log --oneline -n 5', 'speculate exec -- git log --oneline -n 5'],
  ])('%s → %s', async (command, rewritten) => {
    const { stdout } = await runHook(bash(command));
    expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.command).toBe(rewritten);
  });

  it('stays silent for commands with shell syntax that a prefix would break', async () => {
    for (const cmd of [
      'git status && git diff',
      'git log | head -3',
      'git status; rm -rf /',
      'git diff > out.txt',
      'echo $(git status)',
      "git log --format='%H'",
      'git show `git rev-parse HEAD`',
    ]) {
      const { code, stdout } = await runHook(bash(cmd));
      expect(code, cmd).toBe(0);
      expect(stdout, cmd).toBe('');
    }
  });

  it('stays silent for non-table commands, other tools, and rewritten input', async () => {
    expect((await runHook(bash('git push origin main'))).stdout).toBe('');
    expect((await runHook(bash('npm install'))).stdout).toBe('');
    expect((await runHook(bash('speculate exec -- git status'))).stdout).toBe('');
    expect(
      (await runHook({ tool_name: 'Read', tool_input: { file_path: '/x' } })).stdout,
    ).toBe('');
  });

  it('stays silent when the CLI is not on PATH or the kill switch is set', async () => {
    expect((await runHook(bash('git status'), { PATH: '/nonexistent' })).stdout).toBe('');
    expect((await runHook(bash('git status'), { SPECULATE_HOOK_OFF: '1' })).stdout).toBe('');
  });

  it('never crashes on malformed input', async () => {
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('this is not json');
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    expect(code).toBe(0);
  });
});
