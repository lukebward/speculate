import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexClient, readCodexMcpStatus, resolveCodexBin, startCodexClient, type CodexSpawner } from '../src/codexClient.js';

type Request = { id?: number; method: string; params: Record<string, unknown> };
const fixtureConfig = {
  config: { mcp_servers: { fixture: { command: 'cat', required: true, tools: { read: { approval_mode: 'prompt' } } } } },
  layers: [{ name: { type: 'user', file: '/fixture/config.toml' }, version: 'sha256:fixture', config: { mcp_servers: { fixture: { command: 'cat', unknown: 'preserve' } } } }],
  origins: {},
};
const clients: CodexClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeProcess(respond?: (request: Request, output: PassThrough) => void) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  const requests: Request[] = [];
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const request = JSON.parse(buffer.slice(0, index)) as Request;
      buffer = buffer.slice(index + 1);
      requests.push(request);
      if (request.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { codexHome: '/fixture/codex' } })}\n`);
      } else if (request.method !== 'initialized') {
        respond?.(request, child.stdout as PassThrough);
      }
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
  const spawner = vi.fn(() => child) as unknown as CodexSpawner;
  return { child, requests, spawner };
}

async function start(respond?: Parameters<typeof fakeProcess>[0], options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const fake = fakeProcess(respond);
  const client = await startCodexClient({ bin: process.execPath, spawn: fake.spawner, ...options });
  clients.push(client);
  return { client, ...fake };
}

describe('Codex configuration transport', () => {
  it('only initializes the config service and preserves raw layer and policy data', async () => {
    const { client, requests, spawner } = await start((request, out) => {
      const response = Buffer.from(`${JSON.stringify({ id: request.id, result: fixtureConfig })}\n`);
      out.write('{"method":"unrelated/notification","params":{}}\n');
      out.write(response.subarray(0, 17));
      out.write(response.subarray(17));
    });
    expect(await client.readConfig('/fixture/project')).toEqual(fixtureConfig);
    expect(client.codexHome).toBe('/fixture/codex');
    expect(spawner).toHaveBeenCalledWith(process.execPath, ['app-server', '--stdio'], expect.objectContaining({ windowsHide: true }));
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'config/read']);
    expect(requests[2]!.params).toEqual({ cwd: '/fixture/project', includeLayers: true });
  });

  it('passes null deletions, quoted names, and the expected version intact', async () => {
    const { client, requests } = await start((request, out) => {
      out.write(`${JSON.stringify({ id: request.id, result: { status: 'ok', version: 'next', filePath: '/fixture/config.toml' } })}\n`);
    });
    const update = {
      filePath: '/fixture/config.toml', expectedVersion: 'original',
      edits: [{ keyPath: 'mcp_servers."a.b".url', value: null, mergeStrategy: 'replace' as const }],
    };
    expect((await client.writeConfig(update)).version).toBe('next');
    expect(requests.at(-1)).toMatchObject({ method: 'config/batchWrite', params: update });
  });

  it('matches concurrent responses by request id', async () => {
    const held: Request[] = [];
    const { client } = await start((request, out) => {
      held.push(request);
      if (held.length === 2) {
        for (const item of held.reverse()) out.write(`${JSON.stringify({ id: item.id, result: { ...fixtureConfig, config: { cwd: item.params.cwd } } })}\n`);
      }
    });
    const results = await Promise.all([client.readConfig('/first'), client.readConfig('/second')]);
    expect(results.map((result) => result.config.cwd)).toEqual(['/first', '/second']);
  });

  it.each(['configVersionConflict', 'configLayerReadonly'])('returns a safe %s without credential-bearing diagnostics', async (code) => {
    const { client, child } = await start((request, out) => {
      out.write(`${JSON.stringify({ id: request.id, error: { code: -32600, message: 'secret-token-123', data: { config_write_error_code: code } } })}\n`);
    });
    child.stderr.emit('data', Buffer.from('stderr secret-token-123'));
    await expect(client.writeConfig({ filePath: '/fixture', expectedVersion: 'old', edits: [] })).rejects.toMatchObject({ code });
    await expect(client.readConfig(null)).rejects.not.toThrow('secret-token-123');
  });

  it('does not include arbitrary error data or messages in the error', async () => {
    const { client } = await start((request, out) => {
      out.write(`${JSON.stringify({ id: request.id, error: { message: 'secret-token', data: { config_write_error_code: 'secret-token' } } })}\n`);
    });
    await expect(client.readConfig(null)).rejects.toMatchObject({ code: 'requestFailed' });
    await expect(client.readConfig(null)).rejects.not.toThrow('secret-token');
  });

  it('rejects incomplete source metadata instead of accepting a lossy config read', async () => {
    const { client } = await start((request, out) => {
      out.write(`${JSON.stringify({ id: request.id, result: { ...fixtureConfig, layers: [{ config: {} }] } })}\n`);
    });
    await expect(client.readConfig(null)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('bounds output even when the response never ends with a newline', async () => {
    const { client } = await start((_request, out) => out.write('secret'.repeat(100)), { maxOutputBytes: 256 });
    await expect(client.readConfig(null)).rejects.toMatchObject({ code: 'outputLimit' });
    await client.close();
  });

  it('rejects malformed protocol output without exposing its contents', async () => {
    const { client } = await start((_request, out) => out.write('secret-invalid-json\n'));
    await expect(client.readConfig(null)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('times out and closes pending requests without retrying a write', async () => {
    const { client, requests } = await start(() => {}, { timeoutMs: 20 });
    await expect(client.writeConfig({ filePath: '/fixture', expectedVersion: 'old', edits: [] })).rejects.toMatchObject({ code: 'timeout' });
    await client.close();
    expect(requests.filter((request) => request.method === 'config/batchWrite')).toHaveLength(1);
    await expect(client.readConfig(null)).rejects.toMatchObject({ code: 'connectionClosed' });
  });

  it('rejects interrupted requests and handles repeated close calls', async () => {
    const { client, child } = await start(() => {});
    const pending = client.readConfig(null);
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({ code: 'connectionClosed' });
    await Promise.all([client.close(), client.close()]);
  });

  it('sanitizes synchronous and asynchronous spawn failures', async () => {
    await expect(startCodexClient({ bin: process.execPath, spawn: () => { throw new Error('secret'); } })).rejects.not.toThrow('secret');
    const fake = fakeProcess();
    const spawner: CodexSpawner = () => {
      queueMicrotask(() => fake.child.emit('error', new Error('secret')));
      return fake.child;
    };
    await expect(startCodexClient({ bin: process.execPath, spawn: spawner })).rejects.toMatchObject({ code: 'connectionClosed' });
  });
});

describe('Codex executable discovery', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'speculate-codex-bin-'));
    dirs.push(root);
    return root;
  }

  it('resolves PATH to an absolute executable and ignores directories', () => {
    const root = fixture();
    const first = join(root, 'first'); const second = join(root, 'second');
    mkdirSync(join(first, 'fixture-codex'), { recursive: true }); mkdirSync(second);
    const executable = join(second, 'fixture-codex'); writeFileSync(executable, 'fixture'); chmodSync(executable, 0o755);
    expect(resolveCodexBin('fixture-codex', { pathEnv: [first, second].join(':'), platform: 'linux', home: root })).toBe(executable);
  });

  it('finds npm Windows shims and prefers executable files in the same directory', () => {
    const root = fixture();
    const cmd = join(root, 'codex.cmd'); writeFileSync(cmd, 'fixture');
    expect(resolveCodexBin('codex', { pathEnv: root, platform: 'win32', home: root })).toBe(cmd);
    const exe = join(root, 'codex.exe'); writeFileSync(exe, 'fixture');
    expect(resolveCodexBin('codex', { pathEnv: root, platform: 'win32', home: root })).toBe(exe);
  });

  it('resolves explicit relative paths and checks the usual local installation directory', () => {
    const root = fixture(); const bin = join(root, '.local', 'bin'); mkdirSync(bin, { recursive: true });
    const executable = join(bin, 'fixture-codex'); writeFileSync(executable, 'fixture'); chmodSync(executable, 0o755);
    expect(resolveCodexBin('./fixture-codex', { cwd: root })).toBe(join(root, 'fixture-codex'));
    expect(resolveCodexBin('fixture-codex', { pathEnv: '', platform: 'linux', home: root })).toBe(executable);
  });

  it('fails clearly without leaking the supplied executable name', () => {
    expect(() => resolveCodexBin('missing-secret-executable', { pathEnv: '', home: fixture() })).toThrow('SPECULATE_CODEX_BIN');
    expect(() => resolveCodexBin('missing-secret-executable', { pathEnv: '', home: fixture() })).not.toThrow('missing-secret-executable');
  });

  it('runs Node launchers for both native reads with an empty GUI PATH', async () => {
    const root = fixture(); const launcher = join(root, 'codex.mjs');
    writeFileSync(launcher, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv.includes('mcp')) {
  process.stdout.write(JSON.stringify([{name:'fixture',enabled:true,disabled_reason:null,transport:{env:{TOKEN:'discard-me'}}}]));
} else {
  const lines = createInterface({input:process.stdin});
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({id:request.id,result:{codexHome:'fixture-home'}})+'\\n');
    else if (request.method === 'config/read') process.stdout.write(JSON.stringify({id:request.id,result:{config:{},layers:[],origins:{}}})+'\\n');
  });
}
`);
    const client = await startCodexClient({ bin: launcher, env: { ...process.env, PATH: '' } });
    clients.push(client);
    expect((await client.readConfig(null)).config).toEqual({});
    expect(await client.listServers()).toEqual([{ name: 'fixture', enabled: true, disabledReason: null }]);
  });

  it('uses the adjacent npm launcher instead of a Windows batch shim when available', async () => {
    const root = fixture(); const shim = join(root, 'codex.cmd'); writeFileSync(shim, 'fixture');
    const npmDir = join(root, 'node_modules', '@openai', 'codex', 'bin'); mkdirSync(npmDir, { recursive: true });
    const launcher = join(npmDir, 'codex.js'); writeFileSync(launcher, 'fixture');
    const fake = fakeProcess();
    const client = await startCodexClient({ bin: shim, platform: 'win32', spawn: fake.spawner });
    clients.push(client);
    expect(fake.spawner).toHaveBeenCalledWith(process.execPath, [launcher, 'app-server', '--stdio'], expect.objectContaining({ windowsHide: true }));
  });

  it('preserves a selected custom Windows wrapper despite an adjacent npm installation', async () => {
    const root = fixture(); const shim = join(root, 'codex-custom.cmd');
    writeFileSync(shim, '@set CODEX_HOME=C:\\custom-codex-home\r\n@codex %*\r\n');
    const npmDir = join(root, 'node_modules', '@openai', 'codex', 'bin'); mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, 'codex.js'), 'fixture');
    const fake = fakeProcess();
    const client = await startCodexClient({ bin: shim, platform: 'win32', spawn: fake.spawner });
    clients.push(client);
    expect(fake.spawner).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['/d', '/s', '/c']),
      expect.objectContaining({ windowsVerbatimArguments: true }));
    expect((fake.spawner as ReturnType<typeof vi.fn>).mock.calls[0]![1].at(-1)).toContain('codex-custom.cmd');
  });
});

describe('native MCP status without server connections', () => {
  function statusSpawner(output: string, code = 0) {
    const fake = fakeProcess();
    fake.child.stdin.removeAllListeners('finish');
    const spawner: CodexSpawner = () => {
      queueMicrotask(() => { fake.child.stdout.write(output); fake.child.emit('close', code); });
      return fake.child;
    };
    return { ...fake, spawner };
  }

  it('discards transport credentials and returns managed disablement', async () => {
    const fake = statusSpawner(JSON.stringify([{ name: 'fixture', enabled: false,
      disabled_reason: 'requirements', transport: { env: { TOKEN: 'secret-token' } } }]));
    expect(await readCodexMcpStatus({ bin: process.execPath, spawn: fake.spawner })).toEqual([
      { name: 'fixture', enabled: false, disabledReason: 'requirements' },
    ]);
  });

  it('rejects malformed and failed status responses without printing contents', async () => {
    for (const [output, code] of [['secret-token', 0], ['[{"name":"secret-token"}]', 0], ['secret-token', 1]] as const) {
      const fake = statusSpawner(output, code);
      await expect(readCodexMcpStatus({ bin: process.execPath, spawn: fake.spawner })).rejects.not.toThrow('secret-token');
    }
  });

  it('bounds status output and terminates oversized processes', async () => {
    const fake = statusSpawner('secret'.repeat(100));
    await expect(readCodexMcpStatus({ bin: process.execPath, spawn: fake.spawner, maxOutputBytes: 64 })).rejects.toMatchObject({ code: 'outputLimit' });
    expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
