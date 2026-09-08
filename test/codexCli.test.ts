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
  claudeOff: vi.fn().mockResolvedValue(0),
  claudeStatus: vi.fn().mockResolvedValue(0),
  claudeGlobal: vi.fn().mockResolvedValue(0),
  claudeSync: vi.fn().mockResolvedValue(0),
  claudeAuth: vi.fn().mockResolvedValue(0),
}));
vi.mock('../src/codexManage.js', () => ({
  speculateCodexOn: calls.codexOn,
  speculateCodexOff: calls.codexOff,
  speculateCodexStatus: calls.codexStatus,
  speculateCodexSync: calls.codexSync,
  speculateCodexAuth: calls.codexAuth,
}));
vi.mock('../src/manage.js', () => ({
  speculateOn: calls.claudeOn,
  speculateOff: calls.claudeOff,
  speculateStatus: calls.claudeStatus,
  speculateStatusGlobal: calls.claudeGlobal,
  projectIsManaged: () => false,
}));
vi.mock('../src/sync.js', () => ({ speculateSync: calls.claudeSync }));
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
  vi.clearAllMocks();
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
    ['off', '--codex-bin', '/custom/codex'],
    ['on', '--client', 'codex', '--client', 'claude'],
    ['on', '--client', 'codex', '--scope', 'project'],
    ['sync', '--client', 'codex', '--claude-bin', '/custom/claude'],
  ])('rejects unsupported selection or scope before management: %j', async (...args) => {
    await run(args);
    expect(process.exitCode).toBe(2);
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it('keeps Claude as the default', async () => {
    await run(['on']);
    expect(calls.claudeOn).toHaveBeenCalledOnce();
    expect(calls.codexOn).not.toHaveBeenCalled();
  });

  it('supports explicit Claude selection', async () => {
    await run(['status', '.', '--client', 'claude']);
    expect(calls.claudeStatus).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve('.') }));
    expect(calls.codexStatus).not.toHaveBeenCalled();
  });

  it('preserves Claude sync baked-executable compatibility', async () => {
    await run(['sync', '--client', 'claude', '--claude-bin', process.execPath]);
    expect(calls.claudeSync).toHaveBeenCalledWith(expect.objectContaining({
      claudeBin: process.execPath,
    }));
    expect(calls.codexSync).not.toHaveBeenCalled();
  });
});
