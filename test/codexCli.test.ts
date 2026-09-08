/** Management routing must never select another client's configuration by accident. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

const calls = vi.hoisted(() => ({
  codexOn: vi.fn().mockResolvedValue(0),
  codexOff: vi.fn().mockResolvedValue(0),
  codexStatus: vi.fn().mockResolvedValue(0),
  codexSync: vi.fn().mockResolvedValue(0),
  codexAuth: vi.fn().mockResolvedValue(0),
  claudeOn: vi.fn().mockResolvedValue(0),
  claudeProjectOn: vi.fn().mockResolvedValue(0),
  claudeOff: vi.fn().mockResolvedValue(0),
  claudeStatus: vi.fn().mockResolvedValue(0),
  claudeGlobal: vi.fn().mockResolvedValue(0),
  claudeSync: vi.fn().mockResolvedValue(0),
  claudeHookSync: vi.fn().mockResolvedValue(0),
  claudeAuth: vi.fn().mockResolvedValue(0),
}));
const state = vi.hoisted(() => ({ globallyEnabled: false, projectManaged: false }));
vi.mock('../src/codexManage.js', () => ({
  speculateCodexOn: calls.codexOn,
  speculateCodexOff: calls.codexOff,
  speculateCodexStatus: calls.codexStatus,
  speculateCodexSync: calls.codexSync,
  speculateCodexAuth: calls.codexAuth,
}));
vi.mock('../src/manage.js', () => ({
  speculateOn: calls.claudeProjectOn,
  speculateOnGlobal: calls.claudeOn,
  speculateOffGlobal: calls.claudeOff,
  speculateStatus: calls.claudeStatus,
  speculateStatusGlobal: calls.claudeGlobal,
  projectIsManaged: () => state.projectManaged,
  claudeIsGloballyEnabled: () => state.globallyEnabled,
}));
vi.mock('../src/sync.js', () => ({ speculateSync: calls.claudeHookSync, speculateSyncGlobal: calls.claudeSync }));
vi.mock('../src/authCommand.js', () => ({ speculateAuth: calls.claudeAuth }));
vi.mock('../src/hostConfig.js', async (original) => ({
  ...await original<typeof import('../src/hostConfig.js')>(),
  selfCommand: () => ({ command: '/node', args: ['/speculate/cli.js'] }),
}));

let argv: string[];
let exitCode: typeof process.exitCode;
beforeEach(() => {
  argv = process.argv;
  exitCode = process.exitCode;
  process.exitCode = undefined;
  for (const call of Object.values(calls)) call.mockReset().mockResolvedValue(0);
  state.globallyEnabled = false;
  state.projectManaged = false;
  vi.resetModules();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

async function run(args: string[]) {
  process.argv = [process.execPath, '/speculate/cli.js', ...args];
  await import('../src/cli.js');
  await vi.waitFor(() => expect(process.exitCode).toBeDefined());
}

function expectNoClaudeCalls() {
  for (const [name, call] of Object.entries(calls)) {
    if (name.startsWith('claude')) expect(call, name).not.toHaveBeenCalled();
  }
}

describe('Codex management CLI routing', () => {
  it('routes Codex on with mode and executable, regardless of flag order', async () => {
    await run(['on', '--codex-bin', '/custom/codex', '--mode', 'strict', '--client', 'codex']);
    expect(calls.codexOn).toHaveBeenCalledWith(expect.objectContaining({
      self: { command: '/node', args: ['/speculate/cli.js'] },
      mode: 'strict', codexBin: '/custom/codex', onNeedsAuth: expect.any(Function),
    }));
    expectNoClaudeCalls();
    expect(process.exitCode).toBe(0);
  });

  it('routes Codex status paths as the inspection directory', async () => {
    await run(['status', 'nested/project', '--client', 'codex']);
    expect(calls.codexStatus).toHaveBeenCalledWith(expect.objectContaining({
      cwd: resolve('nested/project'),
    }));
    expectNoClaudeCalls();
  });

  it.each(['off', 'sync'] as const)('routes Codex %s without invoking Claude hooks', async (command) => {
    await run([command, '--client', 'codex']);
    expect(command === 'off' ? calls.codexOff : calls.codexSync).toHaveBeenCalledOnce();
    expectNoClaudeCalls();
  });

  it('routes auth target and forget to Codex only', async () => {
    await run(['auth', '--client', 'codex', 'remote-server', '--forget']);
    expect(calls.codexAuth).toHaveBeenCalledWith(expect.objectContaining({
      target: 'remote-server', forget: true,
    }));
    expect(calls.codexOn).not.toHaveBeenCalled();
    expectNoClaudeCalls();
  });

  it.each([
    ['on', '--client', 'unknown'],
    ['on', '--client'],
    ['off', '--client', 'claude', '--codex-bin', '/custom/codex'],
    ['on', '--client', 'codex', '--client', 'claude'],
    ['on', '--client', 'codex', '--scope', 'project'],
    ['sync', '--client', 'codex', '--claude-bin', '/custom/claude'],
    ['sync', '--client', 'both', '--quiet'],
    ['on', '--client', 'both', '--mode', 'bad'],
    ['off', '--client', 'both', '--mode', 'strict'],
    ['auth', '--client', 'both', 'one', 'two'],
    ['status', '--client', 'both', '--quiet'],
    ['sync', '--client', 'both', '--claude-bin'],
    ['auth', '--forget'],
    ['auth', '--client', 'both', '--forget'],
    ['auth', '--client', 'codex', '--forget'],
  ])('rejects unsupported selection or scope before management: %j', async (...args) => {
    await run(args);
    expect(process.exitCode).toBe(2);
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['on', 'claudeOn', 'codexOn'],
    ['off', 'claudeOff', 'codexOff'],
    ['status', 'claudeGlobal', 'codexStatus'],
    ['sync', 'claudeSync', 'codexSync'],
    ['auth', 'claudeAuth', 'codexAuth'],
  ] as const)('defaults %s to both clients', async (command, claude, codex) => {
    await run([command]);
    expect(calls[claude]).toHaveBeenCalledOnce();
    expect(calls[codex]).toHaveBeenCalledOnce();
    expect(calls[claude].mock.invocationCallOrder[0]).toBeLessThan(calls[codex].mock.invocationCallOrder[0]!);
    expect(process.exitCode).toBe(0);
  });

  it('supports explicit both, forwarding mode to both and executable only to Codex', async () => {
    await run(['on', '--client', 'both', '--mode', 'strict', '--codex-bin', '/custom/codex']);
    expect(calls.claudeOn).toHaveBeenCalledWith(expect.objectContaining({ mode: 'strict' }));
    expect(calls.claudeOn.mock.calls[0]![0]).not.toHaveProperty('codexBin');
    expect(calls.codexOn).toHaveBeenCalledWith(expect.objectContaining({ mode: 'strict', codexBin: '/custom/codex' }));
  });

  it('accepts a Codex executable override with the default selection', async () => {
    await run(['on', '--codex-bin', '/custom/codex']);
    expect(calls.claudeOn).toHaveBeenCalledOnce();
    expect(calls.codexOn).toHaveBeenCalledWith(expect.objectContaining({ codexBin: '/custom/codex' }));
  });

  it('forwards a status path to both selected clients', async () => {
    await run(['status', 'nested/project']);
    expect(calls.claudeStatus).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve('nested/project') }));
    expect(calls.codexStatus).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve('nested/project') }));
    expect(calls.claudeGlobal).not.toHaveBeenCalled();
  });

  it('can disable Claude alone without changing Codex', async () => {
    await run(['off', '--client', 'claude']);
    expect(calls.claudeOff).toHaveBeenCalledOnce();
    expect(calls.codexOff).not.toHaveBeenCalled();
  });

  it.each(['claudeOn', 'codexOn'] as const)('reports partial failure when %s returns an error', async (failed) => {
    calls[failed].mockResolvedValue(1);
    await run(['on']);
    expect(calls.claudeOn).toHaveBeenCalledOnce();
    expect(calls.codexOn).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    const output = vi.mocked(process.stderr.write).mock.calls.flat().join('');
    expect(output).toContain('completed');
    expect(output).toContain('failed');
  });

  it.each(['claudeOn', 'codexOn'] as const)('continues the other client when %s throws without leaking error contents', async (failed) => {
    calls[failed].mockRejectedValue(new Error('private-credential'));
    await run(['on']);
    expect(calls.claudeOn).toHaveBeenCalledOnce();
    expect(calls.codexOn).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toContain('private-credential');
  });

  it('reports both failures without claiming successful setup', async () => {
    calls.claudeOn.mockRejectedValue(new Error('missing Claude'));
    calls.codexOn.mockResolvedValue(1);
    await run(['on']);
    expect(calls.codexOn).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toContain('completed');
  });

  it('routes the same auth target and forget option independently to both clients', async () => {
    await run(['auth', 'remote', '--forget']);
    expect(calls.claudeAuth).toHaveBeenCalledWith({ target: 'remote', forget: true });
    expect(calls.codexAuth).toHaveBeenCalledWith(expect.objectContaining({ target: 'remote', forget: true }));
  });

  it('retains Claude-only forgetting of all saved logins', async () => {
    await run(['auth', '--client', 'claude', '--forget']);
    expect(calls.claudeAuth).toHaveBeenCalledWith({ target: undefined, forget: true });
    expect(calls.codexAuth).not.toHaveBeenCalled();
  });

  it('finishes newly authorized Claude setup without opting an unmanaged project in', async () => {
    state.globallyEnabled = true;
    await run(['auth', '--client', 'claude']);
    expect(calls.claudeSync).toHaveBeenCalledOnce();
    expect(calls.claudeOn).not.toHaveBeenCalled();
    expect(calls.codexAuth).not.toHaveBeenCalled();
  });

  it('supports explicit Claude selection', async () => {
    await run(['status', '.', '--client', 'claude']);
    expect(calls.claudeStatus).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve('.') }));
    expect(calls.codexStatus).not.toHaveBeenCalled();
  });

  it('keeps explicit Claude hooks quiet and scoped to the current session', async () => {
    await run(['sync', '--client', 'claude', '--quiet', '--claude-bin', process.execPath]);
    expect(calls.claudeHookSync).toHaveBeenCalledWith(expect.objectContaining({
      claudeBin: process.execPath,
      log: expect.any(Function),
    }));
    expect(calls.claudeSync).not.toHaveBeenCalled();
    expect(calls.codexSync).not.toHaveBeenCalled();
  });

  it('preserves old Claude hooks that have a baked executable without a client flag', async () => {
    await run(['sync', '--claude-bin', process.execPath]);
    expect(calls.claudeHookSync).toHaveBeenCalledWith(expect.objectContaining({ claudeBin: process.execPath }));
    expect(calls.claudeSync).not.toHaveBeenCalled();
    expect(calls.codexSync).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)('keeps %s hook errors silent and successful', async (client) => {
    const call = client === 'claude' ? calls.claudeHookSync : calls.codexSync;
    call.mockRejectedValue(new Error('private-credential'));
    await run(['sync', '--client', client, '--quiet']);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ log: expect.any(Function) }));
    expect(process.exitCode).toBe(0);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('uses the global pass for an explicit manual Claude sync', async () => {
    await run(['sync', '--client', 'claude']);
    expect(calls.claudeSync).toHaveBeenCalledOnce();
    expect(calls.claudeHookSync).not.toHaveBeenCalled();
    expect(calls.codexSync).not.toHaveBeenCalled();
  });
});
