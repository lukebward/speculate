import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeClientInvocation,
  parseRunArgs,
  prepareAgentRun,
  runAgent,
  SessionMeasurementCollector,
  type PreparedAgentRun,
} from '../src/runAgent.js';
import { buildLaunchPlan as buildClaudeLaunchPlan } from '../src/agentAdapters/claude.js';
import { buildLaunchPlan as buildCodexLaunchPlan, codexProxyOverrideIsVerifiable } from '../src/agentAdapters/codex.js';
import { extractCodexConfigInvocation } from '../src/codexClient.js';
import { projectCodexPolicy } from '../src/codexPolicy.js';
import { projectClaudeMcpPolicy, verifyClaudeMcpPreauthorization } from '../src/claudePermission.js';
import { wrapLaunchEntry } from '../src/hostConfig.js';
import { connectSessionBridgeOwner } from '../src/sessionBridge.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const session = {
  socketPath: '/private/session.sock',
  capability: 'owner-capability',
  launchId: 'launch',
};
const hook = {
  socketPath: '/private/session.sock',
  capability: 'hook-capability',
  launchId: 'launch',
};

describe('native launch plans', () => {
  it('preserves every existing wrapper flag and upstream argument while adding launch ownership', () => {
    const original = {
      command: '/usr/bin/node',
      args: ['/old/speculate-cli.js', 'wrap', '--mode', 'strict', '--allow', 'read', '--cwd', '/work', '--', '/bin/server', '--literal'],
      env: { TOKEN: 'kept' },
    };
    const wrapped = wrapLaunchEntry('files', original, { command: '/new/node', args: ['/new/speculate-cli.js'] }, {
      hostClient: 'claude', ...session,
    });
    expect(wrapped).toEqual({ entry: expect.objectContaining({
      command: '/new/node',
      env: expect.objectContaining({ TOKEN: 'kept', SPECULATE_SESSION_CAPABILITY: session.capability }),
      args: [
        '/new/speculate-cli.js', 'wrap', '--host-client', 'claude', '--host-server', 'files',
        '--mode', 'strict', '--allow', 'read', '--cwd', '/work', '--', '/bin/server', '--literal',
      ],
    }) });
  });

  it('builds a temporary Claude layer without changing inherited configuration', async () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    const original = JSON.stringify({
      mcpServers: {
        files: { command: '/bin/files', args: ['--native'], env: { TOKEN: 'kept' } },
        collision: { command: '/bin/collision', env: { SPECULATE_OBSERVER_SOCKET: 'reserved' } },
      },
    });
    writeFileSync(join(home, '.claude.json'), original);

    const plan = await buildClaudeLaunchPlan({
      cwd,
      home,
      env: { HOME: home, PATH: process.env.PATH },
      clientArgs: ['--model', 'selected'],
      observe: 'proxy',
      relayBaseUrl: 'http://127.0.0.1:43123',
      session,
      hook,
      self: { command: '/opt/speculate/node', args: ['/opt/speculate/cli.js'] },
      clientBin: '/opt/claude',
    });
    const mcpPath = plan.args.find((arg) => arg.startsWith('--mcp-config='))!.slice('--mcp-config='.length);
    const settingsPath = plan.args[plan.args.indexOf('--settings') + 1]!;
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(plan.command).toBe('/opt/claude');
    expect(plan.args.slice(-2)).toEqual(['--model', 'selected']);
    expect(plan.args).not.toContain('--strict-mcp-config');
    expect(mcp.mcpServers.files).toMatchObject({
      command: '/opt/speculate/node',
      env: {
        TOKEN: 'kept',
        SPECULATE_SESSION_SOCKET: session.socketPath,
        SPECULATE_SESSION_CAPABILITY: session.capability,
        SPECULATE_SESSION_LAUNCH_ID: session.launchId,
      },
    });
    expect(mcp.mcpServers.collision).toBeUndefined();
    expect(Object.values(settings.hooks).every((groups: any) => groups[0].hooks[0].command === settings.hooks.UserPromptSubmit[0].hooks[0].command)).toBe(true);
    expect(plan.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
      SPECULATE_OBSERVER_CAPABILITY: hook.capability,
      SPECULATE_OBSERVER_CLIENT: 'claude',
    });
    expect(plan.env.SPECULATE_SESSION_CAPABILITY).toBeUndefined();
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(original);
    await plan.cleanup();
    expect(existsSync(mcpPath)).toBe(false);
  });

  it('keeps observer-off launches wrapped while disabling only new observer signals', async () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { files: { command: '/bin/files' } } }));
    const plan = await buildClaudeLaunchPlan({
      cwd, home, env: { HOME: home }, clientArgs: [], observe: 'off', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/claude',
    });
    expect(plan.args.some((arg) => arg.startsWith('--mcp-config='))).toBe(true);
    expect(plan.args).not.toContain('--settings');
    expect(plan.env.SPECULATE_OBSERVER_SOCKET).toBeUndefined();
    expect(plan.env.ANTHROPIC_BASE_URL).toBeUndefined();
    await plan.cleanup();
  });

  it('merges a supported Claude settings argument into the temporary hook layer', async () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    const originalSettings = join(root, 'settings.json');
    writeFileSync(originalSettings, JSON.stringify({
      permissions: { allow: ['mcp__files__read'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/kept' }] }] },
    }));
    const plan = await buildClaudeLaunchPlan({
      cwd, home, env: { HOME: home }, clientArgs: ['--settings', originalSettings, '--model', 'selected'],
      observe: 'hooks', relayBaseUrl: null, session, hook,
      self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/claude',
    });
    const at = plan.args.indexOf('--settings');
    expect(plan.args.filter((arg) => arg === '--settings')).toHaveLength(1);
    const merged = JSON.parse(readFileSync(plan.args[at + 1]!, 'utf8'));
    expect(merged.permissions.allow).toEqual(['mcp__files__read']);
    expect(merged.hooks.SessionStart[0].hooks[0].command).toBe('/kept');
    expect(plan.args.slice(-2)).toEqual(['--model', 'selected']);
    await plan.cleanup();
  });

  it.each(['file', 'inline'] as const)('wraps effective Claude aliases from an exact per-run %s MCP source', async (sourceKind) => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        files: { command: '/bin/durable' },
        durableOnly: { command: '/bin/durable-only' },
      },
    }));
    const source = {
      mcpServers: {
        files: { command: '/bin/per-run', args: ['--kept'] },
        synthetic: { command: '/bin/synthetic' },
        remote: { type: 'http', url: 'https://example.invalid/mcp' },
      },
    };
    const value = sourceKind === 'inline' ? JSON.stringify(source) : join(root, 'session-mcp.json');
    if (sourceKind === 'file') writeFileSync(value, JSON.stringify(source));
    const originalFlag = `--mcp-config=${value}`;
    const plan = await buildClaudeLaunchPlan({
      cwd, home, env: { HOME: home }, clientArgs: [originalFlag, '--model', 'chosen'],
      observe: 'hooks', relayBaseUrl: null, session, hook,
      self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/claude',
    });
    expect(plan.args).not.toContain(originalFlag);
    const configFlag = plan.args.find((arg) => arg.startsWith('--mcp-config='))!;
    const config = JSON.parse(readFileSync(configFlag.slice('--mcp-config='.length), 'utf8'));
    expect(config.mcpServers.files.args).toContain('/bin/per-run');
    expect(config.mcpServers.synthetic.args).toContain('/bin/synthetic');
    expect(config.mcpServers.durableOnly.args).toContain('/bin/durable-only');
    expect(config.mcpServers.remote.args).toContain(source.mcpServers.remote.url);
    expect(plan.args.slice(-2)).toEqual(['--model', 'chosen']);
    await plan.cleanup();
  });

  it('keeps strict Claude launches limited to the explicit per-run MCP source', async () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { ambient: { command: '/bin/ambient' } },
    }));
    const source = join(root, 'strict-mcp.json');
    writeFileSync(source, JSON.stringify({ mcpServers: { explicit: { command: '/bin/explicit' } } }));

    const plan = await buildClaudeLaunchPlan({
      cwd, home, env: { HOME: home }, clientArgs: ['--strict-mcp-config', '--mcp-config', source],
      observe: 'hooks', relayBaseUrl: null, session, hook,
      self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/claude',
    });
    const configFlag = plan.args.find((arg) => arg.startsWith('--mcp-config='))!;
    const config = JSON.parse(readFileSync(configFlag.slice('--mcp-config='.length), 'utf8'));
    expect(plan.args).toContain('--strict-mcp-config');
    expect(config.mcpServers.explicit.args).toContain('/bin/explicit');
    expect(config.mcpServers.ambient).toBeUndefined();
    await plan.cleanup();
  });

  it('preserves strict Claude arguments and adds no ambient source when no MCP source was provided', async () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { ambient: { command: '/bin/ambient' } },
    }));
    const clientArgs = ['--strict-mcp-config', '--model', 'chosen'];

    const plan = await buildClaudeLaunchPlan({
      cwd, home, env: { HOME: home }, clientArgs, observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/claude',
    });
    expect(plan.args.slice(-clientArgs.length)).toEqual(clientArgs);
    expect(plan.args.some((arg) => arg.startsWith('--mcp-config='))).toBe(false);
    expect(plan.disabledCapabilities).toContain('owned-mcp:strict-without-config-source');
    await plan.cleanup();
  });

  it.each(['unreadable', 'ambiguous'] as const)('leaves native Claude MCP arguments unchanged when their source is %s', async (kind) => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { files: { command: '/bin/durable' } } }));
    const clientArgs = kind === 'unreadable'
      ? ['--mcp-config', join(root, 'missing.json'), '--model', 'chosen']
      : ['--mcp-config', join(root, 'first.json'), '--mcp-config', join(root, 'second.json'), '--model', 'chosen'];
    const plan = await buildClaudeLaunchPlan({
      cwd, home, env: { HOME: home }, clientArgs, observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/claude',
    });
    expect(plan.args.slice(-clientArgs.length)).toEqual(clientArgs);
    expect(plan.args.filter((arg) => arg.startsWith('--mcp-config='))).toEqual([]);
    expect(plan.disabledCapabilities).toContain('owned-mcp:unverifiable-config-source');
  });

  it('replays Codex config arguments in order and preserves native args after generated overrides', () => {
    expect(extractCodexConfigInvocation([
      'exec', '--enable=hooks', '-c', 'model="selected"', '--profile', 'work', '--disable', 'feature_x', '--', 'prompt',
    ])).toEqual({
      globalArgs: ['--enable=hooks', '-c', 'model="selected"', '--profile', 'work', '--disable', 'feature_x'],
      verifiable: true,
    });
    expect(extractCodexConfigInvocation(['--ignore-user-config', 'exec'])).toMatchObject({ verifiable: false });
    expect(extractCodexConfigInvocation(['-c'])).toMatchObject({ verifiable: false });
    expect(extractCodexConfigInvocation(['exec', '-C', '../other', '--', '-c', 'prompt data'])).toEqual({
      globalArgs: ['-C', '../other'], cwd: '../other', verifiable: true,
    });
    expect(extractCodexConfigInvocation(['exec', 'prompt text', '-c', 'literal prompt data'])).toEqual({
      globalArgs: [], verifiable: true,
    });
  });

  it('builds Codex session overrides from one effective config without persisting it', async () => {
    const root = directory();
    const config = {
      config: {
        model_provider: 'openai',
        model: 'selected',
        mcp_servers: {
          speculate_smoke: {
            command: '/bin/files', args: ['--native'], env: { TOKEN: 'kept' }, enabled: true,
            enabled_tools: ['read'], tools: { read: { approval_mode: 'auto' } },
          },
          remote: { url: 'https://example.invalid/mcp' },
          collision: { command: '/bin/collision', env: { SPECULATE_SESSION_SOCKET: 'reserved' } },
        },
        hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo kept' }] }] },
      },
      layers: [],
      origins: {},
    };
    const original = structuredClone(config);
    const nativeGlobalArgs = [
      '-c', 'mcp_servers.speculate_smoke.command="/bin/files"',
      '-c', 'mcp_servers.speculate_smoke.args=["--native"]',
      '-c', 'mcp_servers.speculate_smoke.enabled=true',
      '-c', 'mcp_servers.speculate_smoke.enabled_tools=["read"]',
      '-c', 'mcp_servers.speculate_smoke.tools.read.approval_mode="auto"',
    ];
    const clientArgs = [
      ...nativeGlobalArgs,
      'exec', '--ephemeral', '--skip-git-repo-check', '--json', '--ignore-rules', 'inspect',
    ];
    const plan = await buildCodexLaunchPlan({
      cwd: root,
      env: { PATH: process.env.PATH },
      clientArgs,
      observe: 'proxy',
      relayBaseUrl: 'http://127.0.0.1:43123',
      session,
      hook,
      self: { command: '/opt/node', args: ['/opt/cli.js'] },
      clientBin: '/opt/codex',
      nativeConfig: config,
      nativeUpstreamBaseUrl: 'https://chatgpt.com/backend-api/codex',
      nativeGlobalArgs,
    });
    expect(plan.command).toBe('/opt/codex');
    expect(plan.args.slice(0, clientArgs.length)).toEqual(clientArgs);
    const generated = plan.args.slice(clientArgs.length).join('\n');
    expect(generated).toContain('mcp_servers.speculate_smoke.command');
    expect(generated).not.toContain('mcp_servers."speculate_smoke"');
    expect(generated).not.toContain('mcp_servers.remote.command');
    expect(generated).not.toContain('mcp_servers.collision.command');
    expect(generated).not.toContain('enabled_tools');
    expect(generated).not.toContain('approval_mode');
    expect(generated).toContain('openai_base_url');
    expect(generated).toContain('hooks');
    expect(plan.env).toMatchObject({
      SPECULATE_OBSERVER_CAPABILITY: hook.capability,
      SPECULATE_OBSERVER_CLIENT: 'codex',
    });
    expect(plan.env.SPECULATE_SESSION_CAPABILITY).toBeUndefined();
    expect(config).toEqual(original);
    await plan.cleanup();
  });

  it('leaves unsupported Codex entries native without leaking partial overrides', async () => {
    const root = directory();
    const config = {
      config: {
        model_provider: 'openai',
        mcp_servers: {
          unsupported: { command: '/bin/server', args: ['kept'], env: { VALUE: null } },
          'unsafe.alias': { command: '/bin/unsafe', args: ['kept'] },
          files: { command: '/bin/files', args: ['--native'] },
        },
      },
      layers: [], origins: {},
    };
    const clientArgs = ['exec', '--model', 'selected'];
    const plan = await buildCodexLaunchPlan({
      cwd: root, env: {}, clientArgs, observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: config, nativeUpstreamBaseUrl: 'https://api.openai.com/v1',
    });
    const generated = plan.args.slice(clientArgs.length).join('\n');
    expect(generated).not.toContain('mcp_servers.unsupported');
    expect(generated).not.toContain('mcp_servers."unsafe.alias"');
    expect(generated).not.toContain('mcp_servers.unsafe.alias');
    expect(generated).toContain('mcp_servers.files.command');
    expect(plan.disabledCapabilities).toEqual(expect.arrayContaining([
      'owned-mcp:unsupported-entry',
      'owned-mcp:unsupported-alias',
    ]));
  });

  it('keeps a Codex launch usable when native hook values cannot be projected', async () => {
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs: ['exec'], observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: {
        config: { model_provider: 'openai', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: null }] }] } },
        layers: [], origins: {},
      },
      nativeUpstreamBaseUrl: 'https://api.openai.com/v1',
    });
    expect(plan.args.join('\n')).not.toContain('hooks=');
    expect(plan.disabledCapabilities).toContain('hook-observation:unsupported-settings');
  });

  it('preserves an unverifiable custom Codex provider in hook mode', async () => {
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs: ['exec'], observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: { config: { model_provider: 'custom' }, layers: [], origins: {} },
      nativeUpstreamBaseUrl: null,
    });
    expect(plan.command).toBe('/opt/codex');
    expect(plan.args[0]).toBe('exec');
  });

  it('does not claim ownership when later native Codex config arguments replace temporary controls', async () => {
    const clientArgs = ['resume', '-c', 'mcp_servers.files.command="/bin/native"', '-c', 'hooks.SessionStart=[]'];
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs, observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: {
        config: { model_provider: 'openai', mcp_servers: { files: { command: '/bin/native' } }, hooks: {} },
        layers: [], origins: {},
      },
      nativeUpstreamBaseUrl: 'https://api.openai.com/v1',
      nativeGlobalArgs: ['-c', 'mcp_servers.files.command="/bin/native"', '-c', 'hooks.SessionStart=[]'],
    });
    const generated = plan.args.slice(0, -clientArgs.length).join('\n');
    expect(generated).not.toContain('mcp_servers.files');
    expect(generated).not.toContain('hooks=');
    expect(plan.disabledCapabilities).toEqual(expect.arrayContaining([
      'owned-mcp:config-override-precedence',
      'hook-observation:config-override-precedence',
    ]));
  });

  it('keeps per-run Codex tool policy under the launch-owned native reader', async () => {
    const policy = 'mcp_servers.files.tools.read.approval_mode="prompt"';
    const clientArgs = ['exec', '-c', policy, 'inspect'];
    const effective = {
      model_provider: 'openai',
      mcp_servers: { files: { command: '/bin/files', tools: { read: { approval_mode: 'prompt' } } } },
    };
    expect(projectCodexPolicy(effective, 'files')).toMatchObject({ allowTools: null, denyTools: ['read'] });
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs, observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: {
        config: effective,
        layers: [], origins: {},
      },
      nativeUpstreamBaseUrl: 'https://api.openai.com/v1',
      nativeGlobalArgs: ['-c', policy],
    });
    expect(plan.args.join('\n')).toContain('mcp_servers.files.command');
    expect(plan.disabledCapabilities).not.toContain('owned-mcp:config-override-precedence');
    expect(plan.args.slice(0, clientArgs.length)).toEqual(clientArgs);
  });

  it('places verified Codex exec overrides last while preserving the native sentinel tail', async () => {
    const clientArgs = ['exec', '--model', 'selected', '--', 'prompt'];
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs, observe: 'proxy', relayBaseUrl: 'http://127.0.0.1:43123',
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: { config: { model_provider: 'openai' }, layers: [], origins: {} },
      nativeUpstreamBaseUrl: 'https://api.openai.com/v1', nativeGlobalArgs: [],
    });
    const sentinel = plan.args.indexOf('--');
    expect(plan.args.slice(sentinel)).toEqual(['--', 'prompt']);
    expect(plan.args.slice(0, sentinel)).toContain('openai_base_url="http://127.0.0.1:43123"');
    expect(plan.args.slice(0, 3)).toEqual(['exec', '--model', 'selected']);
  });

  it('rejects native Codex provider overrides that would bypass the relay', () => {
    expect(codexProxyOverrideIsVerifiable(
      { model_provider: 'openai', openai_base_url: 'https://native.invalid' },
      ['-c', 'openai_base_url="https://native.invalid"'],
    )).toBe(false);
    expect(codexProxyOverrideIsVerifiable(
      { model_provider: 'custom' },
      ['--config=model_providers.custom.base_url="https://native.invalid"'],
    )).toBe(false);
    expect(codexProxyOverrideIsVerifiable(
      { model_provider: 'custom' },
      ['-c', 'model="kept"'],
    )).toBe(true);
    expect(codexProxyOverrideIsVerifiable(
      { model_provider: 'openai' },
      ['-c', 'openai_base_url="https://native.invalid"'],
      ['exec', 'prompt'],
    )).toBe(true);
    expect(codexProxyOverrideIsVerifiable(
      { model_provider: 'custom.provider' },
      [],
      ['exec', 'prompt'],
    )).toBe(false);
  });

  it('uses the same safe bare key segment for a custom Codex provider relay', async () => {
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs: ['exec'], observe: 'proxy', relayBaseUrl: 'http://127.0.0.1:43123',
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: {
        config: {
          model_provider: 'custom_provider',
          model_providers: { custom_provider: { base_url: 'https://native.invalid' } },
        },
        layers: [], origins: {},
      },
      nativeUpstreamBaseUrl: 'https://native.invalid', nativeGlobalArgs: [],
    });
    const generated = plan.args.join('\n');
    expect(generated).toContain('model_providers.custom_provider.base_url="http://127.0.0.1:43123"');
    expect(generated).not.toContain('model_providers."custom_provider"');
  });

  it.each([
    ['--model', 'exec'],
    ['--add-dir', 'exec'],
  ])('does not treat exec used as the %s option value as the Codex subcommand', async (...optionArgs) => {
    const clientArgs = [
      ...optionArgs,
      '-c', 'openai_base_url="https://native.invalid"',
      '-c', 'mcp_servers.files.command="/bin/native"',
      '-c', 'hooks.SessionStart=[]',
    ];
    const nativeGlobalArgs = clientArgs.slice(2);
    expect(codexProxyOverrideIsVerifiable(
      { model_provider: 'openai', openai_base_url: 'https://native.invalid' },
      nativeGlobalArgs,
      clientArgs,
    )).toBe(false);
    const plan = await buildCodexLaunchPlan({
      cwd: directory(), env: {}, clientArgs, observe: 'hooks', relayBaseUrl: null,
      session, hook, self: { command: '/opt/node', args: ['/opt/cli.js'] }, clientBin: '/opt/codex',
      nativeConfig: {
        config: {
          model_provider: 'openai', openai_base_url: 'https://native.invalid',
          mcp_servers: { files: { command: '/bin/native' } }, hooks: {},
        },
        layers: [], origins: {},
      },
      nativeUpstreamBaseUrl: 'https://native.invalid', nativeGlobalArgs,
    });
    const generated = plan.args.slice(0, -clientArgs.length).join('\n');
    expect(generated).not.toContain('mcp_servers.files');
    expect(generated).not.toContain('hooks=');
    expect(plan.disabledCapabilities).toEqual(expect.arrayContaining([
      'owned-mcp:config-override-precedence',
      'hook-observation:config-override-precedence',
    ]));
  });
});

describe('Claude launch permission verification', () => {
  it.each([
    ['allowed', { allow: ['mcp__files__read'] }, ['read']],
    ['denied', { allow: ['mcp__files__read'], deny: ['mcp__files__read'] }, []],
    ['approval-required', { allow: ['mcp__files__read'], ask: ['mcp__files__read'] }, []],
  ] as const)('projects exact %s permission onto every launch-owned prediction source', (_label, permissions, expected) => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, '.claude', 'remote-settings.json'), '{}');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions }));

    expect(projectClaudeMcpPolicy({
      cwd, home, env: { HOME: home }, clientArgs: [], observerCommand: '/observer',
    }, 'files')).toEqual({ enabled: true, allowTools: expected, denyTools: [] });
  });

  it('serves the exact Claude policy projection to the launch-owned wrapper', async () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, '.claude', 'remote-settings.json'), '{}');
    const settingsPath = join(home, '.claude', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['mcp__files__read'], ask: ['mcp__files__other'] },
    }));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { files: { command: process.execPath } } }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SPECULATE_CLAUDE_BIN', process.execPath);
    const prepared = await prepareAgentRun({ agent: 'claude', observe: 'off', clientArgs: [], jsonReport: null });
    const mcpPath = prepared.plan.args.find((arg) => arg.startsWith('--mcp-config='))!.slice('--mcp-config='.length);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    const owner = await connectSessionBridgeOwner({
      socketPath: mcp.mcpServers.files.env.SPECULATE_SESSION_SOCKET,
      capability: mcp.mcpServers.files.env.SPECULATE_SESSION_CAPABILITY,
      launchId: mcp.mcpServers.files.env.SPECULATE_SESSION_LAUNCH_ID,
    }, { hostClient: 'claude', hostServerAlias: 'files', onCandidates: () => {} });
    expect(await owner.readStartupPolicy()).toEqual({ enabled: true, allowTools: ['read'], denyTools: [] });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['mcp__files__read'], ask: ['mcp__files__read'] },
    }));
    expect(await owner.readStartupPolicy()).toEqual({ enabled: true, allowTools: [], denyTools: [] });
    await owner.close();
    await prepared.close();
  });

  it('authorizes only an exact allow and changes the context when its source changes', () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, '.claude', 'remote-settings.json'), '{}');
    const path = join(home, '.claude', 'settings.json');
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['mcp__files__read'] } }));
    const input = { cwd, home, env: { HOME: home }, clientArgs: [], observerCommand: '/observer' };
    const first = verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' });
    expect(first).toMatchObject({ decision: 'allowed' });
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['mcp__files__read', 'mcp__files__other'] } }));
    const second = verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' });
    expect(second).toMatchObject({ decision: 'allowed' });
    expect(second.permissionContext).not.toBe(first.permissionContext);
    expect(verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'other' })).toMatchObject({ decision: 'allowed' });
  });

  it('lets deny, ask, and non-observer hooks block an exact allow', () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, '.claude', 'remote-settings.json'), '{}');
    const path = join(home, '.claude', 'settings.json');
    const input = { cwd, home, env: { HOME: home }, clientArgs: [], observerCommand: '/observer' };
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['mcp__files__read'], deny: ['mcp__files__*'] } }));
    expect(verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' }).decision).toBe('denied');
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['mcp__files__read'], ask: ['mcp__*'] } }));
    expect(verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' }).decision).toBe('approval-required');
    writeFileSync(path, JSON.stringify({
      permissions: { allow: ['mcp__files__read'] },
      hooks: { PreToolUse: [{ matcher: 'mcp__files__*', hooks: [{ type: 'command', command: '/other' }] }] },
    }));
    expect(verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' })).toMatchObject({
      decision: 'unverifiable', reason: 'blocking-hook',
    });
  });

  it('does not use a wildcard or an untrusted project allow as authorization', () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'remote-settings.json'), '{}');
    const input = { cwd, home, env: { HOME: home }, clientArgs: [], observerCommand: '/observer' };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__files__*'] } }));
    expect(verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' }).decision).toBe('unverifiable');
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__files__read'] } }));
    expect(verifyClaudeMcpPreauthorization(input, { alias: 'files', tool: 'read' }).decision).toBe('unverifiable');
  });

  it.skipIf(process.platform === 'win32')('treats an unreadable present permission source as unverifiable', () => {
    const root = directory();
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, '.claude', 'remote-settings.json'), '{}');
    const path = join(home, '.claude', 'settings.json');
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['mcp__files__read'] } }));
    chmodSync(path, 0o000);
    try {
      expect(verifyClaudeMcpPreauthorization(
        { cwd, home, env: { HOME: home }, clientArgs: [], observerCommand: '/observer' },
        { alias: 'files', tool: 'read' },
      )).toMatchObject({ decision: 'unverifiable', reason: 'unreadable-policy-source' });
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'speculate-run-agent-'));
  directories.push(value);
  return value;
}

describe('run argument parser', () => {
  it.each(['claude', 'codex'] as const)('parses %s symmetrically', (agent) => {
    expect(parseRunArgs([agent, '--observe', 'proxy', '--', '--help'])).toEqual({
      agent,
      observe: 'proxy',
      clientArgs: ['--help'],
      jsonReport: null,
    });
  });

  it.each(['off', 'hooks', 'proxy'] as const)('accepts observer mode %s', (observe) => {
    expect(parseRunArgs(['claude', '--observe', observe])).toEqual({
      agent: 'claude', observe, clientArgs: [], jsonReport: null,
    });
  });

  it.each(['claude', 'codex'] as const)('defaults %s to proxy and preserves every argument after the separator', (agent) => {
    expect(parseRunArgs([agent, '--json-report', '/tmp/report.json', '--', '-c', 'model="chosen"', '--profile', 'work'])).toEqual({
      agent,
      observe: 'proxy',
      clientArgs: ['-c', 'model="chosen"', '--profile', 'work'],
      jsonReport: '/tmp/report.json',
    });
  });

  it.each([
    [[], 'expected claude or codex'],
    [['other'], 'expected claude or codex'],
    [['claude', '--observe', 'invalid'], '--observe must be off, hooks, or proxy'],
    [['codex', '--json-report'], '--json-report requires a path'],
    [['codex', '--wat'], "unknown run argument '--wat'"],
  ])('rejects invalid arguments %#', (argv, message) => {
    expect(parseRunArgs(argv)).toEqual({ error: message });
  });
});

describe('session measurements', () => {
  it('namespaces reused executor issue ids by authenticated route generation', () => {
    const collector = new SessionMeasurementCollector();
    const event = (type: 'speculated' | 'hit', routeId: string) => ({
      type,
      timestamp: 1,
      ruleId: 'observer:claude:intent',
      issueId: 'observer-issue:1',
      observerAttribution: { client: 'claude' as const, source: 'intent' as const, routeId, generation: 1, candidateCreatedAt: 1 },
    });
    collector.record(event('speculated', 'route-a'));
    collector.record(event('speculated', 'route-b'));
    collector.record(event('hit', 'route-a'));
    collector.record(event('hit', 'route-b'));
    expect(collector.snapshot({ requests: 0, failures: 0 }).sources.intent).toEqual({
      issued: 2, used: 2, wasted: 0, suppressed: 0,
    });
  });
});

describe('public run command', () => {
  it('launches the real client process through the distinct public command and writes an aggregate report', () => {
    const root = directory();
    const home = join(root, 'home');
    mkdirSync(home);
    const client = join(root, 'fake-claude.mjs');
    const report = join(root, 'report.json');
    writeFileSync(client, '#!/usr/bin/env node\nprocess.exit(7)\n');
    chmodSync(client, 0o700);
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'src', 'cli.ts'),
      'run', 'claude', '--observe', 'off', '--json-report', report, '--', '--model', 'kept',
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, SPECULATE_CLAUDE_BIN: client },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('launching claude (observer: off');
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      client: 'claude',
      requestedMode: 'off',
      activeMode: 'off',
      measurements: { sources: {}, transport: { requests: 0, failures: 0 } },
      exit: { code: 7, signal: null },
    });
    expect(readFileSync(report, 'utf8')).not.toContain('--model');
    expect(readFileSync(report, 'utf8')).not.toContain('kept');
  });

  it('uses model proxy observation by default for a supported Claude route', () => {
    const root = directory();
    const home = join(root, 'home');
    mkdirSync(home);
    const client = join(root, 'fake-claude.mjs');
    const report = join(root, 'report.json');
    writeFileSync(client, '#!/usr/bin/env node\nprocess.exit(7)\n');
    chmodSync(client, 0o700);
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'src', 'cli.ts'),
      'run', 'claude', '--json-report', report,
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, SPECULATE_CLAUDE_BIN: client },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('launching claude (observer: proxy');
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      client: 'claude', requestedMode: 'proxy', activeMode: 'proxy', transport: 'messages',
    });
  });

  it('falls back from implicit Claude proxy observation with a bounded provider reason', () => {
    const root = directory();
    const home = join(root, 'home');
    mkdirSync(home);
    const client = join(root, 'fake-claude.mjs');
    const report = join(root, 'report.json');
    writeFileSync(client, '#!/usr/bin/env node\nprocess.exit(7)\n');
    chmodSync(client, 0o700);
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'src', 'cli.ts'),
      'run', 'claude', '--json-report', report,
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, SPECULATE_CLAUDE_BIN: client, CLAUDE_CODE_USE_BEDROCK: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('model-observation:unsupported-provider');
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      client: 'claude', requestedMode: 'proxy', activeMode: 'hooks',
    });
  });

  it.each([
    ['an unverified account route', {}, 'model-observation:unverified-account-route'],
    [
      'an unsupported custom-provider key',
      {
        model_provider: 'custom.provider',
        model_providers: { 'custom.provider': { base_url: 'https://native.invalid' } },
      },
      'model-observation:config-override-precedence',
    ],
  ])('launches Codex through the same public command and reports %s', (_case, config, disabledReason) => {
    const root = directory();
    const home = join(root, 'home');
    mkdirSync(home);
    const client = join(root, 'fake-codex.mjs');
    const report = join(root, 'report.json');
    writeFileSync(client, `#!/usr/bin/env node
import readline from 'node:readline';
if (!process.argv.includes('app-server')) process.exit(6);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { codexHome: ${JSON.stringify(home)} }
    : message.method === 'config/read'
      ? { config: ${JSON.stringify(config)}, layers: [], origins: {} }
      : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`);
    chmodSync(client, 0o700);
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'src', 'cli.ts'),
      'run', 'codex', '--json-report', report, '--', 'exec', '--model', 'kept',
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, SPECULATE_CODEX_BIN: client },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(6);
    expect(result.stderr).toContain('launching codex (observer: hooks');
    expect(result.stderr).toContain(disabledReason);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      schemaVersion: 1, client: 'codex', requestedMode: 'proxy', activeMode: 'hooks', transport: 'responses',
      disabledCapabilities: expect.arrayContaining([disabledReason]),
      exit: { code: 6, signal: null },
    });
  });

  it('uses model proxy observation by default for a verified Codex upstream', () => {
    const root = directory();
    const home = join(root, 'home');
    mkdirSync(home);
    const client = join(root, 'fake-codex.mjs');
    const report = join(root, 'report.json');
    writeFileSync(client, `#!/usr/bin/env node
import readline from 'node:readline';
if (!process.argv.includes('app-server')) process.exit(6);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { codexHome: ${JSON.stringify(home)} }
    : message.method === 'config/read'
      ? { config: { model_provider: 'openai', openai_base_url: 'https://api.openai.com/v1' }, layers: [], origins: {} }
      : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`);
    chmodSync(client, 0o700);
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'src', 'cli.ts'),
      'run', 'codex', '--json-report', report, '--', 'exec', '--model', 'kept',
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, SPECULATE_CODEX_BIN: client },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(6);
    expect(result.stderr).toContain('launching codex (observer: proxy');
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      client: 'codex', requestedMode: 'proxy', activeMode: 'proxy', transport: 'responses',
    });
  });
});

describe('native client invocation', () => {
  it.each(['claude', 'codex'] as const)('runs a %s Node launcher through the current Node executable', (agent) => {
    expect(nativeClientInvocation(agent, 'C:\\fixture\\client.mjs', ['--literal'], 'win32')).toEqual({
      file: process.execPath,
      args: ['C:\\fixture\\client.mjs', '--literal'],
    });
  });

  it('runs a Claude Windows shim through cmd.exe', () => {
    const invocation = nativeClientInvocation('claude', 'C:\\fixture\\claude.cmd', ['--literal'], 'win32');
    expect(invocation.file).toBe(process.env.COMSPEC ?? 'cmd.exe');
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });
});

function prepared(script: string, args: string[] = []): { value: PreparedAgentRun; cleanup: ReturnType<typeof vi.fn> } {
  const cleanup = vi.fn(async () => {});
  return {
    cleanup,
    value: {
      plan: {
        command: process.execPath,
        args: ['-e', script, '--', ...args],
        env: { ...process.env },
        upstreamBaseUrl: 'https://example.invalid',
        transport: 'messages',
        cleanup,
      },
      mode: 'hooks',
      transport: 'messages',
      registeredRoutes: () => 0,
      disabledCapabilities: () => [],
      measurements: () => ({ sources: {}, transport: { requests: 0, failures: 0 } }),
      close: cleanup,
    },
  };
}

describe('agent process lifecycle', () => {
  it.each(['claude', 'codex'] as const)('launches a real %s client process and preserves native arguments', async (agent) => {
    const root = directory();
    const output = join(root, 'argv.json');
    const fake = prepared(
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)))`,
      ['--model', 'selected', '--provider', 'native'],
    );
    const prepare = vi.fn(async () => fake.value);

    expect(await runAgent({ agent, observe: 'hooks', clientArgs: ['--model', 'selected', '--provider', 'native'], jsonReport: null }, { prepare })).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['--model', 'selected', '--provider', 'native']);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ agent, clientArgs: ['--model', 'selected', '--provider', 'native'] }));
    expect(fake.cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns 127 for a missing executable and still cleans launch resources', async () => {
    const fake = prepared('');
    fake.value.plan.command = join(directory(), 'missing-client');
    expect(await runAgent({ agent: 'claude', observe: 'hooks', clientArgs: [], jsonReport: null }, { prepare: async () => fake.value, log: () => {} })).toBe(127);
    expect(fake.cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves child exit status', async () => {
    const fake = prepared('process.exitCode = 23');
    expect(await runAgent({ agent: 'codex', observe: 'off', clientArgs: [], jsonReport: null }, { prepare: async () => fake.value })).toBe(23);
    expect(fake.cleanup).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('forwards owned signals and cleans after the child exits', async () => {
    const fake = prepared(`process.on('SIGTERM', () => process.exit(19)); process.stdout.write('ready'); setInterval(() => {}, 1000)`);
    const emitter = new EventEmitter();
    setTimeout(() => emitter.emit('SIGTERM'), 100);
    expect(await runAgent(
      { agent: 'claude', observe: 'hooks', clientArgs: [], jsonReport: null },
      { prepare: async () => fake.value, signalSource: emitter },
    ).then((code) => code)).toBe(19);
    expect(fake.cleanup).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('writes an aggregate-only owner-readable JSON report', async () => {
    const root = directory();
    const reportPath = join(root, 'report.json');
    const fake = prepared('process.exitCode = 0');
    fake.value.measurements = () => ({
      sources: { intent: { issued: 1, used: 1, wasted: 0, suppressed: 0 } },
      transport: { requests: 2, failures: 0 },
    });
    expect(await runAgent({ agent: 'claude', observe: 'hooks', clientArgs: ['secret-argument'], jsonReport: reportPath }, { prepare: async () => fake.value })).toBe(0);
    const text = readFileSync(reportPath, 'utf8');
    const report = JSON.parse(text);
    expect(report).toMatchObject({
      schemaVersion: 1,
      client: 'claude',
      requestedMode: 'hooks',
      activeMode: 'hooks',
      transport: 'messages',
      exit: { code: 0, signal: null },
    });
    expect(text).not.toContain('secret-argument');
  });
});
