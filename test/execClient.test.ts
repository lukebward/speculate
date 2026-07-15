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
      usageRecorder: null,
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

describe('CLI output integrity under backpressure', () => {
  // Regression for the truncation bug family: process.exit() (or any
  // flush-with-timeout) after writing a payload larger than the OS pipe
  // buffer hands a slow reader exit 0 with partial bytes. The CLI must
  // instead block until the reader has taken everything — like any
  // ordinary command would.
  it('delivers a >pipe-buffer payload completely to a reader that starts 3s late', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'speculate-execbig-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: fixture, env: FIXTURE_GIT_ENV, stdio: 'pipe' });
    };
    git('init', '-b', 'main');
    git('config', 'user.email', 'itest@example.invalid');
    git('config', 'user.name', 'Speculate ITest');
    // ~280 KB committed file so `git show HEAD` (vetted, daemon-served —
    // the bytes come back over the socket and through OUR stdout writes)
    // far exceeds the 64 KB pipe buffer.
    const bigBody = Array.from({ length: 6000 }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n') + '\n';
    writeFileSync(join(fixture, 'big.txt'), bigBody);
    git('add', '-A');
    git('commit', '-m', 'big');

    const real = execFileSync('git', ['show', 'HEAD'], {
      cwd: fixture,
      env: FIXTURE_GIT_ENV,
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(real.length).toBeGreaterThan(64 * 1024); // exceeds the OS pipe buffer
    expect(real.length).toBeLessThan(512 * 1024); // stays under the daemon output cap → daemon-served

    // Run a resident daemon as a SEPARATE process at the client's socket
    // path, so the spawned `exec` connects and is served within ~1 s — the
    // reader's absence overlaps a flush timer, not daemon startup.
    const daemonProc = spawn(
      TSX,
      [CLI, 'exec-daemon', '--cwd', fixture, '--idle-ms', '20000', '--no-persist'],
      {
        env: { ...process.env, SPECULATE_USAGE_OFF: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    await new Promise((r) => setTimeout(r, 2_500)); // let it bind
    try {
      const child = spawn(TSX, [CLI, 'exec', '--cwd', fixture, '--', 'git', 'show', 'HEAD'], {
        env: { ...process.env, SPECULATE_USAGE_OFF: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Capture exit immediately (a buggy early exit must not be missed),
      // but do NOT drain stdout yet: the daemon serves ~350 KB, the CLI
      // writes it, the pipe fills at ~64 KB, and the write stalls on
      // backpressure. A flush *timeout* (the old 2 s cap) expires here and
      // process.exit mid-write — exit 0 with a truncated payload (proven:
      // buggy build exits ~2.6 s having delivered only the pipe-buffer's
      // worth). The correct build keeps the child alive until we read.
      const exited = new Promise<number>((resolve) =>
        child.on('exit', (c) => resolve(c ?? -1)),
      );
      await new Promise((r) => setTimeout(r, 5_000));
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c)); // start draining now
      const code = await exited;
      await new Promise((r) => setTimeout(r, 500)); // let any tail bytes arrive
      const got = Buffer.concat(chunks);
      expect(code).toBe(0);
      expect(got.length).toBe(real.length); // a truncating exit fails HERE
      expect(got.equals(real)).toBe(true);
    } finally {
      daemonProc.kill();
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('spawn-on-demand through the real CLI', () => {
  it('starts a daemon, serves, and honors --stop', async () => {
    const fixture = makeFixtureRepo();
    const env = {
      ...process.env,
      SPECULATE_EXEC_IDLE_MS: '5000',
      SPECULATE_USAGE_OFF: '1',
    };
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
