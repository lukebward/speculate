import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexClientError, type CodexConfigLayer, type CodexConfigRead, type CodexConfigWrite } from '../src/codexClient.js';
import { speculateCodexAuth, speculateCodexOff, speculateCodexOn, speculateCodexStatus, speculateCodexSync, type CodexManageOptions } from '../src/codexManage.js';
import { writeOAuthRecord } from '../src/oauthStore.js';

type Entry = Record<string, any>;
let root: string;
let statePath: string;
let configPath: string;
let config: Entry;
let extraLayers: CodexConfigLayer[];
let revision: number;
let writes: CodexConfigWrite[];
let logs: string[];
let beforeWrite: (() => void) | undefined;
let failure: 'before' | 'after' | undefined;
let options: CodexManageOptions;
let closes: number;

function merge(base: Entry, override: Entry): Entry {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(out[key] ?? {}, value) : structuredClone(value);
  }
  return out;
}
function readState(): Entry { return JSON.parse(readFileSync(statePath, 'utf8')); }
function server(name = 'fixture'): Entry { return config.mcp_servers[name]; }
function raw(entries: Entry): void { config = { model: 'fixture-model', mcp_servers: structuredClone(entries) }; }
function editUser(edit: (config: Entry) => void): void { edit(config); revision++; }
function project(entries: Entry, disabled = false): void {
  extraLayers.push({ name: { type: 'project', dotCodexFolder: join(root, '.codex') }, version: 'project-version',
    config: { mcp_servers: entries }, ...(disabled ? { disabledReason: 'untrusted project' } : {}) });
}
async function fakeRead(): Promise<CodexConfigRead> {
  let effective = structuredClone(config);
  for (const layer of extraLayers) if (!layer.disabledReason) effective = merge(effective, layer.config);
  return { config: effective, origins: {}, layers: [
    ...structuredClone(extraLayers),
    { name: { type: 'user', file: configPath, profile: null }, version: String(revision), config: structuredClone(config) },
  ] };
}
async function fakeWrite(request: CodexConfigWrite) {
  writes.push(structuredClone(request));
  beforeWrite?.();
  if (request.expectedVersion !== String(revision) || failure === 'before') {
    failure = undefined;
    throw new CodexClientError('Codex configuration changed during this operation. Run the command again.', 'configVersionConflict');
  }
  const next = structuredClone(config);
  for (const edit of request.edits) {
    const match = /^mcp_servers\.("(?:[^"\\]|\\.)*")\.("(?:[^"\\]|\\.)*")$/s.exec(edit.keyPath);
    if (!match) throw new Error('Fixture rejected invalid quoted edit path');
    const name = JSON.parse(match[1]!); const key = JSON.parse(match[2]!);
    expect(edit.mergeStrategy).toBe('replace');
    if (edit.value === null) delete next.mcp_servers[name][key];
    else Object.defineProperty(next.mcp_servers[name], key, { value: structuredClone(edit.value), enumerable: true, configurable: true, writable: true });
  }
  config = next; revision++;
  if (failure === 'after') {
    failure = undefined;
    throw new CodexClientError('Codex configuration request timed out. Check status before retrying.', 'timeout');
  }
  return { status: 'ok', version: String(revision), filePath: configPath };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speculate-codex-manage-'));
  configPath = join(root, 'config.toml'); statePath = join(root, 'state', 'managed.json');
  revision = 1; writes = []; logs = []; extraLayers = []; beforeWrite = undefined; failure = undefined; closes = 0;
  raw({ fixture: { command: 'node', args: ['upstream.js'], env: { TOKEN: 'fixture-secret' }, required: true,
    env_vars: ['EXTRA_TOKEN'], startup_timeout_sec: 12, tool_timeout_sec: 90,
    enabled_tools: ['read'], disabled_tools: ['delete'], tools: { read: { approval_mode: 'auto' } },
    future_field: { retain: 'all values' } } });
  options = {
    self: { command: process.execPath, args: [join(root, 'speculate', 'dist', 'src', 'cli.js')] },
    cwd: root, statePath, oauthStorePath: join(root, 'oauth.json'), log: (line) => logs.push(line),
    probeRemote: vi.fn(async () => ({ kind: 'ok' })),
    startClient: async () => ({ bin: join(root, 'codex'), codexHome: root,
      readConfig: fakeRead, writeConfig: fakeWrite, close: async () => { closes++; } }),
  };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('native Codex registration', () => {
  it('changes only the launch fields and preserves all policies, env, and unknown settings', async () => {
    const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.edits.map((edit) => edit.keyPath)).toEqual(['mcp_servers."fixture"."command"', 'mcp_servers."fixture"."args"']);
    expect(server().args).toEqual([...options.self.args, 'wrap', '--mode', 'annotated', '--codex-server', 'fixture',
      '--codex-bin', join(root, 'codex'), '--codex-home', root, '--', 'node', 'upstream.js']);
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
    expect(readState()).toMatchObject({ enabled: false, entries: {} });
    expect(closes).toBe(2);
    expect(logs.join('\n')).not.toContain('fixture-secret');
  });

  it('writes a restrictive recovery journal before the host mutation', async () => {
    beforeWrite = () => {
      expect(readState()).toMatchObject({ enabled: true, entries: { fixture: {
        before: { command: 'node', args: ['upstream.js'] }, after: { command: options.self.command },
      } } });
      if (process.platform !== 'win32') expect(statSync(statePath).mode & 0o777).toBe(0o600);
    };
    expect(await speculateCodexOn(options)).toBe(0);
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('is idempotent and sync only wraps newly added user servers', async () => {
    expect(await speculateCodexOn(options)).toBe(0);
    const wrapped = structuredClone(server());
    expect(await speculateCodexOn(options)).toBe(0);
    expect(await speculateCodexSync(options)).toBe(0);
    expect(writes).toHaveLength(1);
    editUser((data) => { data.mcp_servers.new_server = { command: 'cat' }; });
    expect(await speculateCodexSync(options)).toBe(0);
    expect(writes).toHaveLength(2);
    expect(server()).toEqual(wrapped);
    expect(server('new_server').args).toContain('--codex-server');
  });

  it('does not activate sync before on or after off', async () => {
    expect(await speculateCodexSync(options)).toBe(0);
    expect(writes).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
    await speculateCodexOn(options); await speculateCodexOff(options);
    editUser((data) => { data.mcp_servers.new_server = { command: 'cat' }; });
    expect(await speculateCodexSync(options)).toBe(0);
    expect(server('new_server')).toEqual({ command: 'cat' });
  });

  it('updates the mode without nesting wrappers or changing the original restore point', async () => {
    const original = structuredClone(config);
    await speculateCodexOn(options);
    expect(await speculateCodexOn({ ...options, mode: 'strict' })).toBe(0);
    expect(server().args.filter((arg: string) => arg === 'wrap')).toHaveLength(1);
    expect(server().args).toContain('strict');
    expect(readState().entries.fixture.mode).toBe('strict');
    await speculateCodexSync(options);
    expect(server().args).toContain('strict');
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('moves an upstream cwd into wrapper arguments and restores it exactly', async () => {
    const upstreamCwd = join(root, 'upstream'); server().cwd = upstreamCwd;
    const original = structuredClone(config);
    await speculateCodexOn(options);
    expect(server()).not.toHaveProperty('cwd');
    expect(server().args).toContain('--cwd');
    expect(server().args[server().args.indexOf('--cwd') + 1]).toBe(upstreamCwd);
    await speculateCodexOff(options);
    expect(config).toEqual(original);
  });

  it('preserves policy, environment, and unrelated config edits made after setup', async () => {
    await speculateCodexOn(options);
    editUser((data) => {
      data.model = 'new-user-choice'; data.mcp_servers.fixture.env.TOKEN = 'new-secret';
      data.mcp_servers.fixture.env.ADDED = 'user-value';
      data.mcp_servers.fixture.disabled_tools = ['read', 'delete'];
      data.mcp_servers.fixture.tools.read.approval_mode = 'prompt';
      data.mcp_servers.fixture.future_field = { changed: true };
    });
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config.model).toBe('new-user-choice');
    expect(server()).toMatchObject({ command: 'node', args: ['upstream.js'], env: { TOKEN: 'new-secret', ADDED: 'user-value' },
      disabled_tools: ['read', 'delete'], tools: { read: { approval_mode: 'prompt' } }, future_field: { changed: true } });
    expect(logs.join('\n')).not.toContain('new-secret');
  });

  it('handles dotted, quoted, and prototype-like server names as literal keys', async () => {
    raw(JSON.parse('{"a.b\\\"c":{"command":"cat"},"__proto__":{"command":"cat"},"constructor":{"command":"cat"}}'));
    const original = structuredClone(config);
    await speculateCodexOn(options);
    expect(Object.keys(readState().entries)).toHaveLength(3);
    await speculateCodexOff(options);
    expect(config).toEqual(original);
  });
});

describe('transaction recovery and conflicts', () => {
  it('retains the inverse on a CAS rejection and allows setup retry', async () => {
    const original = structuredClone(config); failure = 'before';
    expect(await speculateCodexOn(options)).toBe(1);
    expect(config).toEqual(original);
    expect(readState().entries.fixture.before.command).toBe('node');
    expect(existsSync(`${statePath}.lock`)).toBe(false);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('recovers when the host committed setup but its response was lost', async () => {
    const original = structuredClone(config); failure = 'after';
    expect(await speculateCodexOn(options)).toBe(1);
    expect(server().args).toContain('wrap');
    expect(readState().entries.fixture).toBeDefined();
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('keeps the inverse until off is acknowledged and reconciles a lost restore response', async () => {
    const original = structuredClone(config); await speculateCodexOn(options);
    beforeWrite = () => { expect(readState().entries.fixture).toBeDefined(); };
    failure = 'after';
    expect(await speculateCodexOff(options)).toBe(1);
    expect(config).toEqual(original);
    expect(readState().entries.fixture).toBeDefined();
    beforeWrite = undefined;
    expect(await speculateCodexOff(options)).toBe(0);
    expect(readState().entries).toEqual({});
  });

  it('retains known previous wrappers when a mode-update CAS fails', async () => {
    const original = structuredClone(config); await speculateCodexOn(options);
    failure = 'before';
    expect(await speculateCodexOn({ ...options, mode: 'strict' })).toBe(1);
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('does not overwrite a transport the user changed after setup', async () => {
    await speculateCodexOn(options);
    editUser((data) => { data.mcp_servers.fixture.command = 'user-replacement'; });
    const changed = structuredClone(config);
    expect(await speculateCodexOff(options)).toBe(1);
    expect(config).toEqual(changed);
    expect(readState().entries.fixture).toBeDefined();
    expect(logs.join('\n')).toContain('transport changed');
  });

  it('does not resurrect a server deleted after setup', async () => {
    await speculateCodexOn(options);
    editUser((data) => { delete data.mcp_servers.fixture; });
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config.mcp_servers).toEqual({});
    expect(readState().entries).toEqual({});
  });

  it('rejects corrupt restore records before mutating configuration', async () => {
    await speculateCodexOn(options);
    writeFileSync(statePath, '{bad fixture-secret');
    const current = structuredClone(config); const count = writes.length;
    expect(await speculateCodexOff(options)).toBe(1);
    expect(config).toEqual(current); expect(writes).toHaveLength(count);
    expect(logs.join('\n')).not.toContain('fixture-secret');
  });

  it('rejects an oversized mode-update journal while keeping the previous restore point usable', async () => {
    const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    const wrapped = structuredClone(config);
    const saved = readFileSync(statePath, 'utf8');
    const previousWrites = writes.length;
    expect(await speculateCodexOn({ ...options, mode: 'strict', self: {
      ...options.self, args: [...options.self.args, 'x'.repeat(8 * 1024 * 1024)],
    } })).toBe(1);
    expect(config).toEqual(wrapped);
    expect(writes).toHaveLength(previousWrites);
    expect(readFileSync(statePath, 'utf8')).toBe(saved);
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('does not replace another live setup lock', async () => {
    await speculateCodexOn(options);
    writeFileSync(`${statePath}.lock`, String(process.pid));
    expect(await speculateCodexOff(options)).toBe(1);
    expect(readFileSync(`${statePath}.lock`, 'utf8')).toBe(String(process.pid));
  });
});

describe('managed Codex launch restrictions', () => {
  function status(reader: () => Promise<{ name: string; enabled: boolean; disabledReason: string | null }[]>) {
    const start = options.startClient!;
    options.startClient = async () => ({ ...await start(), listServers: reader });
  }

  it('does not wrap a server disabled by native managed policy', async () => {
    status(async () => [{ name: 'fixture', enabled: false, disabledReason: 'managed restriction' }]);
    const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(config).toEqual(original); expect(writes).toHaveLength(0);
  });

  it('undoes registrations rejected by the native command identity allowlist', async () => {
    const original = structuredClone(config);
    status(async () => [{ name: 'fixture', enabled: server().command === 'node', disabledReason: server().command === 'node' ? null : 'managed restriction' }]);
    expect(await speculateCodexOn(options)).toBe(1);
    expect(config).toEqual(original); expect(writes).toHaveLength(2);
    expect(readState().entries).toEqual({});
    expect(logs.join('\n')).toContain('undone');
  });

  it('also rolls back an enabled entry with a native disabled reason', async () => {
    const original = structuredClone(config);
    status(async () => [{ name: 'fixture', enabled: true, disabledReason: server().command === 'node' ? null : 'managed restriction' }]);
    expect(await speculateCodexOn(options)).toBe(1);
    expect(config).toEqual(original);
  });

  it('restores the prior wrapper and journal after a rejected mode change', async () => {
    const original = structuredClone(config); await speculateCodexOn(options);
    const priorWrapper = structuredClone(config);
    status(async () => [{ name: 'fixture', enabled: !server().args.includes('strict'), disabledReason: null }]);
    expect(await speculateCodexOn({ ...options, mode: 'strict' })).toBe(1);
    expect(config).toEqual(priorWrapper);
    expect(readState().entries.fixture.mode).toBe('annotated');
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('preserves unrelated user edits while undoing a disallowed registration', async () => {
    let calls = 0;
    status(async () => {
      if (++calls === 2) editUser((data) => { data.mcp_servers.fixture.env.TOKEN = 'new-user-token'; data.model = 'new-model'; });
      return [{ name: 'fixture', enabled: calls === 1, disabledReason: null }];
    });
    expect(await speculateCodexOn(options)).toBe(1);
    expect(server()).toMatchObject({ command: 'node', args: ['upstream.js'], env: { TOKEN: 'new-user-token' } });
    expect(config.model).toBe('new-model');
    expect(logs.join('\n')).not.toContain('new-user-token');
  });

  it('retains recovery records when transport edits prevent automatic rollback', async () => {
    let calls = 0;
    status(async () => {
      if (++calls === 2) editUser((data) => { data.mcp_servers.fixture.command = 'user-replacement'; });
      return [{ name: 'fixture', enabled: calls === 1, disabledReason: null }];
    });
    expect(await speculateCodexOn(options)).toBe(1);
    expect(server().command).toBe('user-replacement');
    expect(readState().entries.fixture).toBeDefined();
    expect(await speculateCodexOff(options)).toBe(1);
    expect(server().command).toBe('user-replacement');
  });

  it('rolls back if status cannot be verified and never prints the native error', async () => {
    const original = structuredClone(config); let calls = 0;
    status(async () => {
      if (++calls === 2) throw new Error('native-status-secret');
      return [{ name: 'fixture', enabled: true, disabledReason: null }];
    });
    expect(await speculateCodexOn(options)).toBe(1);
    expect(config).toEqual(original);
    expect(logs.join('\n')).not.toContain('native-status-secret');
  });
});

describe('Codex server ownership and status', () => {
  it('skips disabled, project-only, and transport-shadowed servers', async () => {
    raw({ disabled: { command: 'cat', enabled: false }, shadowed: { command: 'cat' }, fixture: { command: 'cat' } });
    project({ project_only: { command: 'cat' }, shadowed: { args: ['project-args'] } });
    const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(server('disabled')).toEqual(original.mcp_servers.disabled);
    expect(server('shadowed')).toEqual(original.mcp_servers.shadowed);
    expect(config.mcp_servers).not.toHaveProperty('project_only');
    expect(server().args).toContain('wrap');
    expect(logs.join('\n')).toContain('outside user configuration');
  });

  it('ignores transport overrides from an untrusted project layer', async () => {
    project({ fixture: { command: 'untrusted' } }, true);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(server().args.at(-2)).toBe('node');
  });

  it('keeps unowned preexisting wrappers unchanged', async () => {
    raw({ fixture: { command: 'speculate', args: ['wrap', '--', 'cat'] } });
    const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(config).toEqual(original); expect(writes).toHaveLength(0);
    expect(logs.join('\n')).toContain('no Codex restore record');
  });

  it('reports failure when off finds a Codex wrapper without a restore record', async () => {
    await speculateCodexOn(options);
    rmSync(statePath);
    const wrapped = structuredClone(config);
    expect(await speculateCodexOff(options)).toBe(1);
    expect(config).toEqual(wrapped);
    expect(logs.join('\n')).toContain('restore record');
  });

  it('status reads configuration without writing state or starting probes', async () => {
    expect(await speculateCodexStatus(options)).toBe(0);
    expect(writes).toHaveLength(0); expect(existsSync(statePath)).toBe(false);
    expect(options.probeRemote).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('unwrapped');
    await speculateCodexOn(options); logs = [];
    expect(await speculateCodexStatus(options)).toBe(0);
    expect(logs.join('\n')).toContain('wrapped');
    expect(logs.join('\n')).not.toContain('fixture-secret');
  });
});

describe('Codex HTTP registration', () => {
  it('probes resolved headers but keeps environment references and literal values in registrations', async () => {
    vi.stubEnv('SPECULATE_FIXTURE_TOKEN', 'resolved-secret');
    vi.stubEnv('SPECULATE_FIXTURE_HEADER', 'resolved-header');
    raw({ fixture: { url: 'https://example.invalid/mcp', bearer_token_env_var: 'SPECULATE_FIXTURE_TOKEN',
      http_headers: { 'X-Literal': '${KEEP_LITERAL}' }, env_http_headers: { 'X-Env': 'SPECULATE_FIXTURE_HEADER' },
      required: true, tool_timeout_sec: 90, enabled_tools: ['read'] } });
    const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(options.probeRemote).toHaveBeenCalledWith('https://example.invalid/mcp', {
      'X-Literal': '${KEEP_LITERAL}', 'X-Env': 'resolved-header', Authorization: 'Bearer resolved-secret',
    });
    expect(server().args).toContain('Authorization: Bearer ${SPECULATE_FIXTURE_TOKEN}');
    expect(server().args).toContain('X-Env: ${SPECULATE_FIXTURE_HEADER}');
    expect(server().args).toContain('--literal-header');
    expect(server().args).toContain('X-Literal: ${KEEP_LITERAL}');
    expect(server().env_vars).toEqual(['SPECULATE_FIXTURE_HEADER', 'SPECULATE_FIXTURE_TOKEN']);
    expect(server()).not.toHaveProperty('url');
    expect(JSON.stringify(server())).not.toContain('resolved-secret');
    expect(readFileSync(statePath, 'utf8')).not.toContain('resolved-secret');
    expect(logs.join('\n')).not.toContain('resolved-secret');
    expect(await speculateCodexOff(options)).toBe(0);
    expect(config).toEqual(original);
  });

  it('stores existing inline credentials for restoration without printing them', async () => {
    raw({ fixture: { url: 'https://example.invalid/mcp', http_headers: { Authorization: 'Bearer inline-secret' } } });
    await speculateCodexOn(options); await speculateCodexStatus(options); await speculateCodexOff(options);
    expect(server().http_headers.Authorization).toBe('Bearer inline-secret');
    expect(logs.join('\n')).not.toContain('inline-secret');
  });

  it.each([
    ['helper', { url: 'https://example.invalid/mcp', http_headers_helper: 'credential-command' }],
    ['ChatGPT auth', { url: 'https://example.invalid/mcp', auth: 'chatgpt' }],
    ['custom OAuth', { url: 'https://example.invalid/mcp', oauth: { client_id: 'fixture' } }],
    ['OAuth scopes', { url: 'https://example.invalid/mcp', scopes: ['read'] }],
    ['remote executor', { command: 'cat', environment_id: 'remote' }],
    ['remote env', { command: 'cat', env_vars: [{ name: 'TOKEN', source: 'remote' }] }],
    ['ambiguous transport', { command: 'cat', url: 'https://example.invalid/mcp' }],
    ['URL credentials', { url: 'https://user:url-secret@example.invalid/mcp' }],
  ])('leaves unsupported %s settings unchanged', async (_name, entry) => {
    raw({ fixture: entry }); const original = structuredClone(config);
    expect(await speculateCodexOn(options)).toBe(0);
    expect(config).toEqual(original); expect(writes).toHaveLength(0);
    expect(options.probeRemote).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('url-secret');
  });

  it('leaves unreachable and unauthorized servers unchanged with useful guidance', async () => {
    raw({ fixture: { url: 'https://example.invalid/mcp' } }); const original = structuredClone(config);
    options.probeRemote = vi.fn(async () => ({ kind: 'needs-auth' }));
    expect(await speculateCodexOn(options)).toBe(0);
    expect(config).toEqual(original);
    expect(logs.join('\n')).toContain('auth --client codex fixture');
    options.probeRemote = vi.fn(async () => ({ kind: 'unreachable', reason: 'secret-network-error' }));
    expect(await speculateCodexOn(options)).toBe(0);
    expect(config).toEqual(original);
    expect(logs.join('\n')).not.toContain('secret-network-error');
  });

  it('runs login outside the transaction lock and retries after it succeeds', async () => {
    raw({ fixture: { url: 'https://example.invalid/mcp' } });
    options.probeRemote = vi.fn(async () => ({ kind: 'needs-auth' }));
    options.onNeedsAuth = async (servers) => {
      expect(existsSync(`${statePath}.lock`)).toBe(false);
      expect(servers).toEqual([{ name: 'fixture', url: 'https://example.invalid/mcp' }]);
      writeOAuthRecord(options.oauthStorePath!, 'https://example.invalid/mcp', {
        serverUrl: 'https://example.invalid/mcp', client: { client_id: 'fixture' },
        tokens: { access_token: 'stored-secret', token_type: 'Bearer' },
      });
      return true;
    };
    expect(await speculateCodexOn(options)).toBe(0);
    expect(server().args).toContain('--url');
    expect(logs.join('\n')).not.toContain('stored-secret');
  });

  it('does not print unexpected credential-bearing probe exceptions', async () => {
    raw({ fixture: { url: 'https://example.invalid/mcp' } });
    options.probeRemote = async () => { throw new Error('unexpected-token-secret'); };
    expect(await speculateCodexOn(options)).toBe(1);
    expect(writes).toHaveLength(0);
    expect(logs.join('\n')).not.toContain('unexpected-token-secret');
  });

  it('forgets shared-URL OAuth only after restoring every affected wrapper in one transaction', async () => {
    const url = 'https://example.invalid/mcp';
    raw({ one: { url }, two: { url } }); const original = structuredClone(config);
    writeOAuthRecord(options.oauthStorePath!, url, { serverUrl: url, client: { client_id: 'fixture' },
      tokens: { access_token: 'stored-secret', token_type: 'Bearer' } });
    await speculateCodexOn(options);
    const previousWrites = writes.length;
    expect(await speculateCodexAuth({ ...options, target: url, forget: true })).toBe(0);
    expect(writes).toHaveLength(previousWrites + 1);
    expect(config).toEqual(original);
    expect(readState().entries).toEqual({});
    expect(logs.join('\n')).not.toContain('stored-secret');
  });
});
