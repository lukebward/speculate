/**
 * §13.12 exec cache semantics + the daemon end to end: a real git fixture,
 * a real unix socket, real subprocesses. The primed status→diff pair must
 * produce a byte-faithful prefetch hit by the third command of the
 * canonical workflow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { ExecCache, type ExecOutcome } from '../src/execCache.js';
import { startExecDaemon, type DaemonHandle } from '../src/execDaemon.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const outcome = (text: string, durationMs = 100): ExecOutcome => ({
  stdout: Buffer.from(text),
  stderr: Buffer.alloc(0),
  code: 0,
  durationMs,
});

describe('ExecCache', () => {
  it('serves a speculative result once, then misses (single-use)', async () => {
    let t = 0;
    const cache = new ExecCache({ now: () => t });
    cache.beginSpeculative('k', 1_000, async () => outcome('data'));
    await sleep(0);
    const first = cache.lookup('k');
    expect(first.kind).toBe('hit');
    expect((first as { outcome: ExecOutcome }).outcome.stdout.toString()).toBe('data');
    expect(cache.lookup('k').kind).toBe('miss');
  });

  it('expires by TTL and counts the waste', async () => {
    let t = 0;
    const cache = new ExecCache({ now: () => t });
    cache.beginSpeculative('k', 1_000, async () => outcome('data'));
    await sleep(0);
    t = 2_000;
    expect(cache.lookup('k').kind).toBe('miss');
    expect(cache.wasted).toBe(1);
  });

  it('joins an in-flight execution', async () => {
    const cache = new ExecCache();
    let release!: (o: ExecOutcome) => void;
    cache.beginSpeculative('k', 1_000, () => new Promise((r) => (release = r)));
    const found = cache.lookup('k');
    expect(found.kind).toBe('join');
    release(outcome('slow'));
    const joined = await (found as { promise: Promise<ExecOutcome | null> }).promise;
    expect(joined!.stdout.toString()).toBe('slow');
  });

  it('dooms in-flight work across an invalidation (generation stamp)', async () => {
    const cache = new ExecCache();
    let release!: (o: ExecOutcome) => void;
    cache.beginSpeculative('k', 60_000, () => new Promise((r) => (release = r)));
    cache.invalidateAll();
    release(outcome('stale'));
    await sleep(0);
    expect(cache.lookup('k').kind).toBe('miss'); // never deposited
    expect(cache.wasted).toBeGreaterThan(0);
  });

  it('drops failed executions without caching', async () => {
    const cache = new ExecCache();
    cache.beginSpeculative('k', 1_000, async () => {
      throw new Error('spawn failed');
    });
    await sleep(0);
    expect(cache.lookup('k').kind).toBe('miss');
    expect(cache.wasted).toBe(1);
  });

  it('deduplicates via has()', async () => {
    const cache = new ExecCache();
    let runs = 0;
    const exec = async (): Promise<ExecOutcome> => {
      runs++;
      return outcome('x');
    };
    cache.beginSpeculative('k', 1_000, exec);
    cache.beginSpeculative('k', 1_000, exec);
    await sleep(0);
    expect(runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------

const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speculate-execd-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, env: FIXTURE_GIT_ENV, stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'itest@example.invalid');
  git('config', 'user.name', 'Speculate ITest');
  writeFileSync(join(dir, 'notes.txt'), 'alpha\nbeta\n');
  git('add', '-A');
  git('commit', '-m', 'c1');
  appendFileSync(join(dir, 'notes.txt'), 'dirty-line-92c1\n');
  return dir;
}

describe('exec daemon end to end', () => {
  let fixture: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    fixture = makeFixtureRepo();
    daemon = await startExecDaemon({
      root: fixture,
      socketPath: join(mkdtempSync(join(tmpdir(), 'speculate-sock-')), 'd.sock'),
      persist: false,
      watch: false, // deterministic: no fs-event flushes mid-test
      log: () => {},
    });
  });
  afterAll(async () => {
    await daemon.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  function send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = connect(daemon.socketPath);
      let buf = '';
      sock.on('connect', () => sock.write(`${JSON.stringify(payload)}\n`));
      sock.on('data', (c) => {
        buf += c.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          sock.destroy();
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('daemon response timeout')), 15_000);
    });
  }

  const exec = (argv: string[]) => send({ id: 1, op: 'exec', argv });

  it('serves vetted commands byte-faithfully', async () => {
    const res = await exec(['git', 'status', '--porcelain=v2']);
    expect(res.ok).toBe(true);
    expect(res.served).toBe('miss');
    expect(res.code).toBe(0);
    const got = Buffer.from(String(res.stdoutB64), 'base64').toString();
    const real = execFileSync('git', ['status', '--porcelain=v2'], {
      cwd: fixture,
      env: FIXTURE_GIT_ENV,
    }).toString();
    expect(got).toBe(real);
  });

  it('refuses anything outside the table', async () => {
    const res = await exec(['git', 'push', 'origin', 'main']);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unsupported');
  });

  it('prefetches the primed status→diff transition and serves identical bytes', async () => {
    // Arm the primed pair with one real sighting, then re-trigger.
    await exec(['git', 'status']); // observed: status
    await exec(['git', 'diff']); // observed: status→diff (primed: arms now)
    await exec(['git', 'status']); // predicts diff → speculative run starts
    await sleep(400); // let the prefetch land

    const res = await exec(['git', 'diff']);
    expect(res.ok).toBe(true);
    expect(['hit', 'join']).toContain(res.served);
    const got = Buffer.from(String(res.stdoutB64), 'base64').toString();
    const real = execFileSync('git', ['diff', '--no-ext-diff'], {
      cwd: fixture,
      env: FIXTURE_GIT_ENV,
    }).toString();
    expect(got).toBe(real);
    expect(got).toContain('dirty-line-92c1');

    const stats = daemon.stats();
    expect(stats.hits + stats.joins).toBeGreaterThanOrEqual(1);
    expect(stats.speculated).toBeGreaterThanOrEqual(1);
  });

  it('serves rg WITH a path quickly and byte-faithfully (stdin never consulted)', async () => {
    // rg given an explicit path searches files, not stdin, so it is
    // unambiguous to serve — and must not hang on the daemon's closed stdin.
    const started = Date.now();
    const res = await exec(['rg', '--line-number', 'dirty-line-92c1', '.']);
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(elapsed).toBeLessThan(5_000); // nowhere near the 10 s stdin timeout
    const got = Buffer.from(String(res.stdoutB64), 'base64').toString();
    expect(got).toContain('notes.txt');
    expect(got).toContain('dirty-line-92c1');
  });

  it('leaves path-less rg to passthrough (stdin semantics are the shell’s job)', async () => {
    // A bare `rg PATTERN` would search stdin, not the tree; serving it could
    // yield a wrong "no match". The table declines it so the real shell runs
    // it with the caller's own stdin.
    const res = await exec(['rg', 'dirty-line-92c1']);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unsupported');
  });

  it('answers stats and ping', async () => {
    const ping = await send({ id: 9, op: 'ping' });
    expect(ping.ok).toBe(true);
    const stats = await send({ id: 10, op: 'stats' });
    expect(stats.ok).toBe(true);
    expect(stats.stats).toHaveProperty('hits');
  });

  it('rejects malformed requests without dying', async () => {
    const bad = await send({ id: 11, op: 'exec', argv: 'git status' });
    expect(bad.ok).toBe(false);
    // Daemon still alive:
    const ping = await send({ id: 12, op: 'ping' });
    expect(ping.ok).toBe(true);
  });
});
