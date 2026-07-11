/**
 * §13.12 `speculate exec` client: fail-open passthrough for anything the
 * table doesn't vet, daemon round trip for what it does, and the
 * spawn-on-demand path through the real CLI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExecArgs, runExec } from '../src/execClient.js';
import { execSocketPath, startExecDaemon, type DaemonHandle } from '../src/execDaemon.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(ROOT, 'src', 'cli.ts');

const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-execc-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, env: FIXTURE_GIT_ENV, stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'itest@example.invalid');
  git('config', 'user.name', 'Speculate ITest');
  writeFileSync(join(dir, 'notes.txt'), 'alpha\n');
  git('add', '-A');
  git('commit', '-m', 'c1');
  appendFileSync(join(dir, 'notes.txt'), 'dirty\n');
  return dir;
}

describe('parseExecArgs', () => {
  it('parses --cwd, --, and bare commands', () => {
    expect(parseExecArgs(['--cwd', '/x', '--', 'git', 'status'])).toEqual({
      cwd: '/x',
      stats: false,
      stop: false,
      argv: ['git', 'status'],
    });
    expect(parseExecArgs(['git', 'status'])).toMatchObject({ argv: ['git', 'status'] });
    expect(parseExecArgs(['--stats'])).toMatchObject({ stats: true });
    expect(parseExecArgs([])).toHaveProperty('error');
    expect(parseExecArgs(['--bogus'])).toHaveProperty('error');
  });
});

describe('runExec', () => {
  let fixture: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    fixture = makeFixtureRepo();
    // Bind the daemon at the client's rendezvous path so runExec connects
    // instead of spawning.
    daemon = await startExecDaemon({
      root: fixture,
      socketPath: execSocketPath(fixture),
      persist: false,
      watch: false,
      log: () => {},
    });
  });
  afterAll(async () => {
    await daemon.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  function captureStdout(): { restore: () => string } {
    const chunks: Buffer[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(Buffer.from(chunk as Uint8Array));
      return true;
    }) as typeof process.stdout.write;
    return {
      restore: () => {
        process.stdout.write = original;
        return Buffer.concat(chunks).toString();
      },
    };
  }

  it('serves a vetted command through the daemon, byte-faithfully', async () => {
    const cap = captureStdout();
    let code: number;
    try {
      code = await runExec({
        cwd: fixture,
        stats: false,
        stop: false,
        argv: ['git', 'status', '--porcelain=v2'],
      });
    } finally {
      // restore before asserting so failures print normally
    }
    const out = cap.restore();
    expect(code!).toBe(0);
    const real = execFileSync('git', ['status', '--porcelain=v2'], {
      cwd: fixture,
      env: FIXTURE_GIT_ENV,
    }).toString();
    expect(out).toBe(real);
  });

  it('passes through non-vetted commands directly (fail open)', async () => {
    const ok = await runExec({ cwd: fixture, stats: false, stop: false, argv: ['true'] });
    expect(ok).toBe(0);
    const bad = await runExec({ cwd: fixture, stats: false, stop: false, argv: ['false'] });
    expect(bad).toBe(1);
  });

  it('reports stats from the daemon', async () => {
    const cap = captureStdout();
    const code = await runExec({ cwd: fixture, stats: true, stop: false, argv: [] });
    const out = cap.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out)).toHaveProperty('hits');
  });
});

describe('spawn-on-demand through the real CLI', () => {
  it('starts a daemon, serves, and honors --stop', async () => {
    const fixture = makeFixtureRepo();
    const env = { ...process.env, SPECULATE_EXEC_IDLE_MS: '5000' };
    const run = (args: string[]): Promise<{ code: number; stdout: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(TSX, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.on('error', reject);
        child.on('exit', (code) =>
          resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString() }),
        );
      });

    try {
      const first = await run(['exec', '--cwd', fixture, '--', 'git', 'status', '--porcelain=v2']);
      expect(first.code).toBe(0);
      const real = execFileSync('git', ['status', '--porcelain=v2'], {
        cwd: fixture,
        env: FIXTURE_GIT_ENV,
      }).toString();
      expect(first.stdout).toBe(real);

      const stats = await run(['exec', '--cwd', fixture, '--stats']);
      expect(stats.code).toBe(0);

      const stop = await run(['exec', '--cwd', fixture, '--stop']);
      expect(stop.code).toBe(0);
    } finally {
      // Even if --stop failed, the 5s idle override reaps the daemon.
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
