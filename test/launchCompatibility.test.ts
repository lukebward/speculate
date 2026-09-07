/** Old PATH shims still call wrap --sniff; retirement must not break their commands. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(ROOT, 'src', 'cli.ts');
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'speculate-launch-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function launch(args: string[]) {
  return spawn(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function output(child: ReturnType<typeof launch>) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(),
    }));
  });
}

describe('retired launch commands', () => {
  it.each([['try'], ['shims', 'install'], ['shims', 'status']])(
    '%j exits with actionable guidance and no writes',
    async (...args) => {
      const child = launch(args);
      const done = output(child);
      child.stdin.end();
      const result = await done;
      expect(result.code).toBe(2);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr).toContain('retired');
      expect(result.stderr).toContain('speculate on');
      expect(result.stderr).toContain('speculate wrap');
      expect(readdirSync(home)).toEqual([]);
    }, 30_000,
  );

  it('shows supported launch paths and shim cleanup in help', async () => {
    const child = launch(['--help']);
    const done = output(child);
    child.stdin.end();
    const result = await done;
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toContain('speculate shims uninstall');
    expect(result.stdout.toString()).not.toMatch(/speculate try|shims install|--sniff/);
  }, 30_000);
});

describe('wrap --sniff compatibility', () => {
  it('passes all bytes through, including MCP initialize, without learner writes', async () => {
    const child = launch([
      'wrap', '--sniff', '--', process.execPath, '-e',
      'process.stdin.pipe(process.stdout)',
    ]);
    const done = output(child);
    const input = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n'),
      Buffer.from([0, 255, 13, 10]),
      Buffer.from('last line without newline'),
    ]);
    child.stdin.end(input);
    const result = await done;
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual(input);
    expect(result.stderr).toContain('speculate shims uninstall');
    expect(readdirSync(home)).toEqual([]);
  }, 30_000);

  it('launches commands with quiet, still-open stdin and preserves argv and exit status', async () => {
    const child = launch([
      'wrap', '--sniff', '--', process.execPath, '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exitCode = 23',
      '--', 'space separated', '$literal', '--flag',
    ]);
    const result = await output(child);
    expect(result.code).toBe(23);
    expect(JSON.parse(result.stdout.toString())).toEqual(['space separated', '$literal', '--flag']);
  }, 30_000);

  it('reports a missing launcher with exit 127', async () => {
    mkdirSync(join(home, 'missing-bin'));
    const child = launch(['wrap', '--sniff', '--', join(home, 'missing-bin', 'no-launcher')]);
    const done = output(child);
    child.stdin.end();
    const result = await done;
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('cannot run');
    expect(result.stdout.length).toBe(0);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('forwards termination to the wrapped child', async () => {
    const child = launch([
      'wrap', '--sniff', '--', process.execPath, '-e',
      'process.on("SIGTERM", () => process.exit(19)); process.stdout.write("ready"); setInterval(() => {}, 1000)',
    ]);
    const done = output(child);
    child.stdout.once('data', () => child.kill('SIGTERM'));
    child.stdin.end();
    const result = await done;
    expect(result.code).toBe(19);
    expect(result.stdout.toString()).toBe('ready');
  }, 30_000);
});
