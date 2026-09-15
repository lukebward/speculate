import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.env.SPECULATE_INSTALLED_PACKAGE_ROOT
  ? pathToFileURL(`${realpathSync.native(resolve(process.env.SPECULATE_INSTALLED_PACKAGE_ROOT))}${sep}`)
  : new URL('..', import.meta.url);
const directories: string[] = [];

function commandArguments(command: string): string[] {
  return [...command.matchAll(/'((?:'\\''|[^'])*)'/g)]
    .map((match) => match[1]!.replaceAll("'\\''", "'"));
}

async function builtHookCommands(): Promise<{ claude: string; codex: string }> {
  const claudeUrl = new URL('dist/src/agentAdapters/claude.js', root).href;
  const codexUrl = new URL('dist/src/agentAdapters/codex.js', root).href;
  const script = [
    `const claude = await import(${JSON.stringify(claudeUrl)});`,
    `const codex = await import(${JSON.stringify(codexUrl)});`,
    'process.stdout.write(JSON.stringify({',
    '  claude: claude.claudeObserverHookCommand(),',
    '  codex: codex.codexObserverHookCommand(),',
    '}));',
  ].join('\n');
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
  });
  return JSON.parse(output.toString('utf8')) as { claude: string; codex: string };
}

async function receiveHook(script: string, hostClient: 'claude' | 'codex') {
  const directory = mkdtempSync(join(tmpdir(), 'speculate-installed-hook-'));
  directories.push(directory);
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\speculate-installed-hook-${randomUUID()}`
    : join(directory, 'observer.sock');
  let resolveReceived!: (value: unknown) => void;
  let rejectReceived!: (error: Error) => void;
  const received = new Promise<unknown>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });
  const server = createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      try { resolveReceived(JSON.parse(text.slice(0, newline)) as unknown); }
      catch (error) { rejectReceived(error instanceof Error ? error : new Error(String(error))); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      SPECULATE_OBSERVER_SOCKET: socketPath,
      SPECULATE_OBSERVER_CAPABILITY: 'installed-capability',
      SPECULATE_OBSERVER_LAUNCH_ID: 'installed-launch',
      SPECULATE_OBSERVER_CLIENT: hostClient,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'installed-session' }));
  let timeout: NodeJS.Timeout | undefined;
  try {
    const payload = await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('hook delivery timed out')), 3_000);
      }),
    ]);
    const code = await closed;
    return { payload, code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
      await closed.catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('installed observer hook resource', () => {
  it('resolves and delivers events from both compiled adapter commands', async () => {
    const commands = await builtHookCommands();
    const expectedHook = fileURLToPath(new URL('plugin/hooks/session-observer.mjs', root));
    const paths = Object.fromEntries(Object.entries(commands).map(([client, command]) => {
      const [node, script] = commandArguments(command);
      expect(node).toBe(process.execPath);
      expect(script).toBe(expectedHook);
      if (!script) throw new Error(`${client} hook command omitted its script`);
      expect(existsSync(script)).toBe(true);
      return [client, script];
    })) as Record<'claude' | 'codex', string>;

    for (const hostClient of ['claude', 'codex'] as const) {
      await expect(receiveHook(paths[hostClient], hostClient)).resolves.toEqual({
        payload: {
          type: 'hook',
          capability: 'installed-capability',
          launchId: 'installed-launch',
          hostClient,
          payload: { hook_event_name: 'SessionStart', session_id: 'installed-session' },
        },
        code: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
    }
  }, 15_000);
});
