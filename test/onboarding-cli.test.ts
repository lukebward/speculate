import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn().mockResolvedValue(0),
  runOnboarding: vi.fn().mockResolvedValue(0),
}));

vi.mock('../src/onboarding.js', () => ({ runOnboarding: mocks.runOnboarding }));
vi.mock('../src/runAgent.js', async (original) => ({
  ...await original<typeof import('../src/runAgent.js')>(),
  runAgent: mocks.runAgent,
}));

let argv: string[];
let exitCode: typeof process.exitCode;

beforeEach(() => {
  argv = process.argv;
  exitCode = process.exitCode;
  process.exitCode = undefined;
  mocks.runAgent.mockReset().mockResolvedValue(0);
  mocks.runOnboarding.mockReset().mockResolvedValue(0);
  vi.resetModules();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<void> {
  process.argv = [process.execPath, '/speculate/cli.js', ...args];
  await import('../src/cli.js');
  await vi.waitFor(() => expect(process.exitCode).toBeDefined());
}

describe('zero-argument onboarding CLI routing', () => {
  it('delegates only the bare command and preserves its exit code', async () => {
    mocks.runOnboarding.mockResolvedValue(23);

    await run([]);

    expect(mocks.runOnboarding).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(23);
  });

  it.each([
    ['--help'],
    ['--version'],
    ['--config'],
  ])('does not intercept nonempty argv: %j', async (...args) => {
    await run(args);

    expect(mocks.runOnboarding).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it('preserves explicit native launch parsing and routing', async () => {
    await run(['run', 'claude', '--observe', 'off', '--', '--print', 'hello']);

    expect(mocks.runOnboarding).not.toHaveBeenCalled();
    expect(mocks.runAgent).toHaveBeenCalledWith({
      agent: 'claude',
      clientArgs: ['--print', 'hello'],
      configPath: null,
      jsonReport: null,
      observe: 'off',
    });
  });
});
