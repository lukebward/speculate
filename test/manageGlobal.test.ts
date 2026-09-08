import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireManagementLock,
  loadManagedState,
  speculateOffGlobal,
  speculateOnGlobal,
  type CmdRunner,
} from '../src/manage.js';
import { speculateSync, speculateSyncGlobal } from '../src/sync.js';
import { isWrappedEntry } from '../src/hostConfig.js';

let root: string;
let home: string;
let cwd: string;
let other: string;
let statePath: string;
let logs: string[];
let calls: Array<{ args: string[]; cwd: string }>;
let failRestore: boolean;
const self = { command: '/node', args: ['/opt/speculate/dist/src/cli.js'] };
const read = (): any => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
const write = (value: unknown): void => writeFileSync(join(home, '.claude.json'), JSON.stringify(value));
const runner: CmdRunner = async (_cmd, args, options) => {
  calls.push({ args, cwd: options.cwd });
  if (args[0] !== 'mcp') return { code: 2, stdout: '', stderr: 'unknown command' };
  if (args[1] === 'list') return { code: 0, stdout: '', stderr: '' };
  const config = read();
  const scope = args[args.indexOf('-s') + 1];
  config.projects ??= {};
  config.projects[options.cwd] ??= {};
  const target = scope === 'user' ? config : config.projects[options.cwd];
  target.mcpServers ??= {};
  const name = args[2]!;
  if (args[1] === 'remove') {
    if (!(name in target.mcpServers)) return { code: 1, stdout: '', stderr: 'No server' };
    delete target.mcpServers[name];
  } else if (args[1] === 'add-json') {
    const entry = JSON.parse(args[3]!);
    if (failRestore && !isWrappedEntry(entry)) return { code: 1, stdout: '', stderr: 'restore failed' };
    target.mcpServers[name] = entry;
  }
  write(config);
  return { code: 0, stdout: '', stderr: '' };
};
const opts = () => ({ home, cwd, statePath, self, runner, claudeBin: 'claude', oauthStorePath: join(home, 'oauth.json'), log: (line: string) => logs.push(line) });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speculate-global-'));
  home = join(root, 'home'); cwd = join(root, 'one'); other = join(root, 'two');
  for (const dir of [home, cwd, other]) mkdirSync(dir);
  for (const dir of [cwd, other]) mkdirSync(join(dir, '.git'));
  statePath = join(home, 'managed.json'); logs = []; calls = []; failRestore = false;
  write({});
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('global Claude activation', () => {
  it('wraps hidden user registrations and every known project, then restores from anywhere', async () => {
    const original = {
      mcpServers: { same: { command: 'global-server', env: { TOKEN: 'kept-private' } } },
      projects: {
        [cwd]: { mcpServers: { same: { command: 'local-server' } } },
        [other]: { mcpServers: { second: { command: 'second-server' } }, enabledMcpjsonServers: ['approved'] },
      },
    };
    const projectFile = { mcpServers: { approved: { command: 'approved-server' }, pending: { command: 'pending-server' } } };
    write(original);
    writeFileSync(join(other, '.mcp.json'), JSON.stringify(projectFile));
    expect(await speculateOnGlobal(opts())).toBe(0);
    const wrapped = read();
    expect(isWrappedEntry(wrapped.mcpServers.same)).toBe(true);
    expect(isWrappedEntry(wrapped.projects[cwd].mcpServers.same)).toBe(true);
    expect(isWrappedEntry(wrapped.projects[other].mcpServers.second)).toBe(true);
    expect(isWrappedEntry(wrapped.projects[other].mcpServers.approved)).toBe(true);
    expect(wrapped.projects[other].mcpServers.pending).toBeUndefined();
    expect(JSON.parse(readFileSync(join(other, '.mcp.json'), 'utf8'))).toEqual(projectFile);
    expect(loadManagedState(statePath).global?.enabled).toBe(true);
    expect(await speculateOffGlobal({ ...opts(), cwd: home })).toBe(0);
    expect(read().mcpServers).toEqual(original.mcpServers);
    expect(read().projects[cwd].mcpServers).toEqual(original.projects[cwd].mcpServers);
    expect(read().projects[other].mcpServers).toEqual(original.projects[other].mcpServers);
    expect(loadManagedState(statePath).projects).toEqual({});
    calls = [];
    expect(await speculateSync({ ...opts(), cwd: other })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('clears old project opt-outs and uses the selected mode in future unseen projects', async () => {
    write({ projects: { [other]: { mcpServers: { known: { command: 'known' } } } } });
    writeFileSync(statePath, JSON.stringify({ version: 1, projects: {}, syncOptOut: { [other]: true } }));
    expect(await speculateOnGlobal({ ...opts(), mode: 'strict' })).toBe(0);
    expect(loadManagedState(statePath).syncOptOut).toEqual({});
    const future = join(root, 'future'); mkdirSync(future);
    const config = read();
    config.mcpServers = { hidden: { command: 'new-user' } };
    config.projects[future] = { mcpServers: { hidden: { command: 'new-local' } } };
    write(config);
    expect(await speculateSync({ ...opts(), cwd: future })).toBe(0);
    expect(read().mcpServers.hidden.args).toContain('strict');
    expect(read().projects[future].mcpServers.hidden.args).toContain('strict');
    expect(logs.join('\n')).toContain('active next session');
  });

  it('updates owned modes across projects while preserving exact originals', async () => {
    const original = { command: 'global-server', args: ['--argument'] };
    write({ mcpServers: { server: original }, projects: { [other]: {} } });
    expect(await speculateOnGlobal({ ...opts(), mode: 'annotated' })).toBe(0);
    expect(await speculateOnGlobal({ ...opts(), cwd: other, mode: 'strict' })).toBe(0);
    expect(read().mcpServers.server.args).toContain('strict');
    expect(read().mcpServers.server.args).not.toContain('annotated');
    expect(await speculateOffGlobal(opts())).toBe(0);
    expect(read().mcpServers.server).toEqual(original);
  });

  it('does not adopt a separate child repository when invoked from its parent directory', async () => {
    write({ projects: { [cwd]: { mcpServers: { local: { command: 'original' } } } } });
    expect(await speculateOnGlobal(opts())).toBe(0);
    expect(await speculateOnGlobal({ ...opts(), cwd: root })).toBe(0);
    expect(loadManagedState(statePath).projects[cwd]!.entries[0]!.original).toEqual({ command: 'original' });
    expect(loadManagedState(statePath).projects[root]!.entries).toEqual([]);
    expect(await speculateOffGlobal({ ...opts(), cwd: root })).toBe(0);
    expect(read().projects[cwd].mcpServers.local).toEqual({ command: 'original' });
  });

  it('keeps changed configuration and recovery records, without allowing later hooks to rewrap', async () => {
    write({ mcpServers: { server: { command: 'original' } } });
    expect(await speculateOnGlobal(opts())).toBe(0);
    const config = read();
    config.mcpServers.server.env = { LATER_EDIT: 'preserved' };
    write(config);
    expect(await speculateOffGlobal({ ...opts(), cwd: other })).toBe(1);
    expect(read().mcpServers.server).toEqual(config.mcpServers.server);
    expect(loadManagedState(statePath).projects[cwd]!.entries).toHaveLength(1);
    expect(logs.join('\n')).toContain('configuration changed');
    calls = [];
    expect(await speculateSync({ ...opts(), cwd: other })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('restores shared user entries from deleted projects while retaining inaccessible local records', async () => {
    write({ mcpServers: { global: { command: 'global' } }, projects: { [other]: { mcpServers: { local: { command: 'local' } } } } });
    expect(await speculateOnGlobal({ ...opts(), cwd: other })).toBe(0);
    rmSync(other, { recursive: true });
    expect(await speculateOffGlobal(opts())).toBe(1);
    expect(read().mcpServers.global).toEqual({ command: 'global' });
    const pending = loadManagedState(statePath).projects[other]!.entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scope).toBe('local');
    expect(existsSync(other)).toBe(false);
  });

  it('can retry a restore that removed the wrapper before the host rejected its original', async () => {
    write({ mcpServers: { server: { command: 'original' } } });
    await speculateOnGlobal(opts());
    failRestore = true;
    expect(await speculateOffGlobal(opts())).toBe(1);
    expect(read().mcpServers.server).toBeUndefined();
    expect(loadManagedState(statePath).projects[cwd]!.entries[0]!.restorePending).toBe(true);
    failRestore = false;
    expect(await speculateOffGlobal(opts())).toBe(0);
    expect(read().mcpServers.server).toEqual({ command: 'original' });
  });

  it('manual sync requires opt-in and never reinstalls the auto-wrap hook', async () => {
    write({ mcpServers: { server: { command: 'original' } } });
    expect(await speculateSyncGlobal(opts())).toBe(0);
    expect(calls).toEqual([]);
    expect(read().mcpServers.server.command).toBe('original');
    await speculateOnGlobal(opts()); calls = [];
    const config = read(); config.mcpServers.new = { command: 'new' }; write(config);
    expect(await speculateSyncGlobal(opts())).toBe(0);
    expect(isWrappedEntry(read().mcpServers.new)).toBe(true);
    expect(calls.some(({ args }) => args[0] === 'plugin' && args[1] === 'install')).toBe(false);
  });

  it('serializes an in-flight hook before global off so no server is resurrected', async () => {
    await speculateOnGlobal(opts());
    write({ mcpServers: { server: { command: 'original' } } });
    let resume!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((done) => { started = done; });
    const gate = new Promise<void>((done) => { resume = done; });
    const held: CmdRunner = async (cmd, args, options) => {
      if (args[1] === 'remove') { started(); await gate; }
      return runner(cmd, args, options);
    };
    const sync = speculateSync({ ...opts(), runner: held });
    await blocked;
    const off = speculateOffGlobal(opts());
    resume();
    expect(await sync).toBe(0);
    expect(await off).toBe(0);
    expect(read().mcpServers.server).toEqual({ command: 'original' });
    expect(loadManagedState(statePath).global?.enabled).toBe(false);
  });

  it('recovers a dead stale recovery guard but never steals a live old owner', () => {
    const lock = join(home, 'sync.lock');
    const stale = new Date(Date.now() - 600_000);
    writeFileSync(lock, '2147483647'); utimesSync(lock, stale, stale);
    writeFileSync(`${lock}.reclaim`, '2147483647'); utimesSync(`${lock}.reclaim`, stale, stale);
    const release = acquireManagementLock(lock);
    expect(release).not.toBeNull(); release?.();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
    writeFileSync(lock, String(process.pid)); utimesSync(lock, stale, stale);
    expect(acquireManagementLock(lock)).toBeNull();
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  });
});
