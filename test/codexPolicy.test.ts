import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { applyCodexPolicy } from '../src/codexPolicy.js';
import { startCodexClient } from '../src/codexClient.js';
import { SafetyPolicy } from '../src/policy.js';
import type { SpeculateConfig } from '../src/types.js';
import { buildWrapConfig, type WrapArgs } from '../src/wrap.js';

vi.mock('../src/codexClient.js', () => ({ startCodexClient: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const args: WrapArgs = {
  mode: 'annotated', profile: null, allow: [], legacyPassthrough: false,
  command: ['server'], url: null, headers: {},
  codexServer: 'files', codexBin: '/bin/codex', codexHome: '/home/codex', cwd: '/server/data',
};

function config(): SpeculateConfig {
  return buildWrapConfig(args).config;
}

function readPolicy(server: Record<string, unknown>) {
  return async () => ({ mcp_servers: { files: server } });
}

function eligible(cfg: SpeculateConfig, tool: string, readOnlyHint = true): boolean {
  const upstream = cfg.servers.upstream!;
  const policy = new SafetyPolicy(cfg.mode, {
    upstream: { allowlist: upstream.allowTools, denylist: upstream.denyTools },
  });
  policy.updateTools('upstream', [{ name: tool, inputSchema: { type: 'object' }, annotations: { readOnlyHint } }]);
  return policy.eligibility('upstream', tool).eligible;
}

describe('applyCodexPolicy', () => {
  it('retains readOnlyHint requirements when Codex permits automatic calls', async () => {
    for (const default_tools_approval_mode of [undefined, null, 'auto', 'writes']) {
      const cfg = config();
      await applyCodexPolicy(cfg, args, { readConfig: readPolicy({ default_tools_approval_mode }) });
      expect(eligible(cfg, 'read_file')).toBe(true);
      expect(eligible(cfg, 'write_file', false)).toBe(false);
    }
  });

  it('constrains annotated mode to enabled tools and gives disabled tools priority', async () => {
    const cfg = config();
    await applyCodexPolicy(cfg, args, { readConfig: readPolicy({
      enabled_tools: ['read_file', 'list_files'], disabled_tools: ['list_files'],
    }) });
    expect(eligible(cfg, 'read_file')).toBe(true);
    expect(eligible(cfg, 'list_files')).toBe(false);
    expect(eligible(cfg, 'search')).toBe(false);
    expect(cfg.mode).toBe('strict');
  });

  it('intersects the existing strict allowlist and retains the existing denylist', async () => {
    const cfg = config();
    cfg.mode = 'strict';
    cfg.servers.upstream!.allowTools = ['read_file', 'list_files', 'search'];
    cfg.servers.upstream!.denyTools = ['read_file'];
    await applyCodexPolicy(cfg, args, { readConfig: readPolicy({ enabled_tools: ['read_file', 'list_files', 'extra'] }) });
    expect(eligible(cfg, 'list_files')).toBe(true);
    for (const tool of ['read_file', 'search', 'extra']) expect(eligible(cfg, tool)).toBe(false);
  });

  it('does not populate an empty strict allowlist from Codex permissions', async () => {
    const cfg = config();
    cfg.mode = 'strict';
    await applyCodexPolicy(cfg, args, { readConfig: readPolicy({ enabled_tools: ['read_file'] }) });
    expect(eligible(cfg, 'read_file')).toBe(false);
  });

  it('requires explicit permissive overrides for prompt and ambiguous approve defaults', async () => {
    for (const mode of ['prompt', 'approve']) {
      const cfg = config();
      await applyCodexPolicy(cfg, args, { readConfig: readPolicy({
        default_tools_approval_mode: mode,
        tools: {
          read_file: { approval_mode: 'auto', output_token_limit: 200 },
          list_files: { approval_mode: 'writes' },
          search: { approval_mode: 'prompt' },
          inherited: { output_token_limit: 500 },
        },
      }) });
      expect(eligible(cfg, 'read_file')).toBe(true);
      expect(eligible(cfg, 'list_files')).toBe(true);
      for (const tool of ['search', 'inherited', 'unconfigured']) expect(eligible(cfg, tool)).toBe(false);
    }
  });

  it('blocks prompt and approve overrides under an automatic default', async () => {
    const cfg = config();
    await applyCodexPolicy(cfg, args, { readConfig: readPolicy({ tools: {
      search: { approval_mode: 'prompt' }, read_file: { approval_mode: 'approve' },
    } }) });
    expect(eligible(cfg, 'list_files')).toBe(true);
    expect(eligible(cfg, 'search')).toBe(false);
    expect(eligible(cfg, 'read_file')).toBe(false);
  });

  it('does not let permissive overrides bypass an enabled-tools restriction', async () => {
    const cfg = config();
    await applyCodexPolicy(cfg, args, { readConfig: readPolicy({
      enabled_tools: ['search'], default_tools_approval_mode: 'prompt',
      tools: { read_file: { approval_mode: 'auto' } },
    }) });
    expect(eligible(cfg, 'read_file')).toBe(false);
    expect(eligible(cfg, 'search')).toBe(false);
  });

  it('disables speculation for a disabled server and for an empty enabled list', async () => {
    for (const server of [{ enabled: false }, { enabled_tools: [] }]) {
      const cfg = config();
      const log = vi.fn();
      await applyCodexPolicy(cfg, args, { readConfig: readPolicy(server), log });
      expect(eligible(cfg, 'read_file')).toBe(false);
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('rereads the project policy at each startup, independently of the server cwd', async () => {
    const readConfig = vi.fn()
      .mockResolvedValueOnce({ mcp_servers: { files: {} } })
      .mockResolvedValueOnce({ mcp_servers: { files: { default_tools_approval_mode: 'prompt' } } });
    const first = config();
    const second = config();
    await applyCodexPolicy(first, args, { readConfig });
    await applyCodexPolicy(second, args, { readConfig });
    expect(readConfig).toHaveBeenNthCalledWith(1, process.cwd(), args);
    expect(readConfig).toHaveBeenNthCalledWith(2, process.cwd(), args);
    expect(eligible(first, 'read_file')).toBe(true);
    expect(eligible(second, 'read_file')).toBe(false);
    expect(second.servers.upstream!.cwd).toBe(resolve(process.cwd(), '/server/data'));
  });

  it('fails closed on malformed or unknown policy without logging its contents', async () => {
    const malformed = [
      { enabled: 'private-secret' }, { enabled_tools: 'private-secret' }, { disabled_tools: [42] },
      { default_tools_approval_mode: 'private-secret' }, { tools: [] },
      { tools: { read_file: 'private-secret' } },
      { tools: { read_file: { approval_mode: 'private-secret' } } },
      { tools: { read_file: { future_policy: 'private-secret' } } },
      { tools: { read_file: { output_token_limit: -1 } } },
    ];
    for (const server of malformed) {
      const cfg = config();
      const log = vi.fn();
      await applyCodexPolicy(cfg, args, { readConfig: readPolicy(server), log });
      expect(cfg.mode).toBe('off');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).not.toContain('private-secret');
    }
  });

  it('leaves the upstream intact when configuration cannot be read or the server disappears', async () => {
    for (const readConfig of [
      async () => { throw new Error('private-secret'); },
      async () => ({ mcp_servers: {} }),
      async () => ({}),
    ]) {
      const cfg = config();
      const upstream = structuredClone(cfg.servers.upstream);
      const log = vi.fn();
      await applyCodexPolicy(cfg, args, { readConfig, log });
      expect(cfg.mode).toBe('off');
      expect(cfg.servers.upstream).toEqual(upstream);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).not.toContain('private-secret');
    }
  });

  it('does not read Codex for ordinary wrapping or when speculation is already off', async () => {
    const readConfig = vi.fn();
    await applyCodexPolicy(config(), { ...args, codexServer: undefined }, { readConfig });
    const cfg = config();
    cfg.mode = 'off';
    await applyCodexPolicy(cfg, args, { readConfig });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('uses the selected Codex binary and home and closes the native client even on failure', async () => {
    for (const fails of [false, true]) {
      const close = vi.fn().mockResolvedValue(undefined);
      const readConfig = fails
        ? vi.fn().mockRejectedValue(new Error('private-secret'))
        : vi.fn().mockResolvedValue({ config: { mcp_servers: { files: {} } } });
      vi.mocked(startCodexClient).mockResolvedValue({ readConfig, close } as never);
      const cfg = config();
      const log = vi.fn();
      await applyCodexPolicy(cfg, args, { log });
      expect(startCodexClient).toHaveBeenLastCalledWith({
        bin: args.codexBin, cwd: process.cwd(), env: { ...process.env, CODEX_HOME: args.codexHome },
      });
      expect(readConfig).toHaveBeenCalledWith(process.cwd());
      expect(close).toHaveBeenCalledTimes(1);
      expect(cfg.mode).toBe(fails ? 'off' : 'annotated');
    }
  });
});
