import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexSessionHook, codexSessionHookInstalled, installCodexSessionHook, removeCodexSessionHook,
  type CodexHookOptions } from '../src/codexHooks.js';
import type { CodexConfigWrite } from '../src/codexClient.js';

let root: string;
let path: string;
let config: Record<string, any>;
let revision: number;
let writes: CodexConfigWrite[];
let options: CodexHookOptions;
beforeEach(() => {
  // Native realpath also expands Windows 8.3 names before PowerShell sees cwd.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'speculate-codex-hooks-')));
  path = join(root, 'hooks.json'); config = {}; revision = 1; writes = [];
  options = { cwd: root, self: { command: process.execPath, args: [join(root, 'speculate', 'cli.js')] },
    client: { codexHome: root, bin: join(root, 'codex'),
      readConfig: async () => ({ config: structuredClone(config), origins: {}, layers: [{ name: { type: 'user', file: join(root, 'config.toml') },
        config: structuredClone(config), version: String(revision) }] }),
      writeConfig: async (params) => {
        expect(params.expectedVersion).toBe(String(revision)); writes.push(structuredClone(params));
        for (const edit of params.edits) {
          expect(edit.keyPath).toBe('hooks.SessionStart');
          config.hooks ??= {};
          if (edit.value === null) delete config.hooks.SessionStart; else config.hooks.SessionStart = structuredClone(edit.value);
        }
        return { status: 'ok', version: String(++revision), filePath: join(root, 'config.toml') };
      },
    } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function readJson() { return JSON.parse(readFileSync(path, 'utf8')); }

describe('Codex native SessionStart hook', () => {
  it('installs one background hook and leaves native trust management untouched', async () => {
    expect(await installCodexSessionHook(options)).toEqual({ changed: true, source: path });
    const json = readJson();
    expect(json.hooks.SessionStart).toHaveLength(1);
    const group = json.hooks.SessionStart[0];
    expect(group.matcher).toBe('startup|resume|clear|compact');
    expect(group.hooks).toHaveLength(1);
    expect(group.hooks[0]).toMatchObject({ type: 'command', async: true, timeout: 50 });
    expect(group.hooks[0].command).toContain('speculate-codex-auto-sync-v1');
    expect(await codexSessionHookInstalled(options)).toBe(true);
    expect(writes).toHaveLength(0);
    expect(existsSync(join(root, 'hooks-state.json'))).toBe(false);
  });

  it('keeps the exact hook definition on repeated setup, avoiding unnecessary trust prompts', async () => {
    await installCodexSessionHook(options); const original = readFileSync(path, 'utf8');
    expect((await installCodexSessionHook(options)).changed).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('preserves unrelated events, handlers, group fields, and JSON metadata', async () => {
    const original = { description: 'User lifecycle hooks', custom_metadata: { retain: true }, hooks: {
      SessionStart: [{ matcher: 'startup', custom: 12, hooks: [{ type: 'command', command: 'echo user-start' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
    } };
    writeFileSync(path, JSON.stringify(original));
    await installCodexSessionHook(options);
    expect(readJson().hooks.SessionStart).toHaveLength(2);
    expect(await removeCodexSessionHook(options)).toBe(true);
    expect(readJson()).toEqual(original);
    expect(await codexSessionHookInstalled(options)).toBe(false);
  });

  it('uses an existing inline source instead of introducing a second hook file', async () => {
    config.hooks = { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo existing' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] };
    const original = structuredClone(config);
    expect((await installCodexSessionHook(options)).source).toBe(join(root, 'config.toml'));
    expect(existsSync(path)).toBe(false);
    expect(config.hooks.SessionStart).toHaveLength(2);
    expect(await removeCodexSessionHook(options)).toBe(true);
    expect(config).toEqual(original);
    expect(writes).toHaveLength(2);
  });

  it('removes only its handler when another handler shares the same group', async () => {
    const own = codexSessionHook(options); const other = { type: 'command', command: 'echo user' };
    writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [own, other] },
      { matcher: 'resume', hooks: [own] }] } }));
    await removeCodexSessionHook(options);
    expect(readJson()).toEqual({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [other] }] } });
  });

  it('consolidates owned handlers from both hook sources while retaining unrelated inline handlers', async () => {
    await installCodexSessionHook(options);
    const own = codexSessionHook(options); const other = { type: 'command', command: 'echo inline-user' };
    config.hooks = { SessionStart: [{ matcher: 'startup', hooks: [own, other] }] };
    expect((await installCodexSessionHook(options)).changed).toBe(true);
    expect(readJson().hooks.SessionStart[0].hooks).toEqual([own]);
    expect(config.hooks).toEqual({ SessionStart: [{ matcher: 'startup', hooks: [other] }] });
    expect((await installCodexSessionHook(options)).changed).toBe(false);
  });

  it('removes a file containing only its own hook and tolerates repeated off', async () => {
    await installCodexSessionHook(options);
    expect(await removeCodexSessionHook(options)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await removeCodexSessionHook(options)).toBe(false);
  });

  it('does not mistake a user handler with the same display message for its own', async () => {
    const original = { hooks: { SessionStart: [{ hooks: [{ type: 'command', statusMessage: 'Speculate: sync MCP servers', command: 'echo user-owned' }] }] } };
    writeFileSync(path, JSON.stringify(original));
    expect(await removeCodexSessionHook(options)).toBe(false);
    expect(readJson()).toEqual(original);
  });

  it('updates its executable paths without accumulating hooks', async () => {
    await installCodexSessionHook(options);
    options.self.args = [join(root, 'new-install', 'cli.js')];
    expect((await installCodexSessionHook(options)).changed).toBe(true);
    expect(readJson().hooks.SessionStart).toHaveLength(1);
    expect(readJson().hooks.SessionStart[0].hooks).toEqual([codexSessionHook(options)]);
  });

  it('leaves malformed files byte-for-byte intact and does not leak their content', async () => {
    const malformed = '{secret-hook-command'; writeFileSync(path, malformed);
    await expect(installCodexSessionHook(options)).rejects.not.toThrow('secret-hook-command');
    expect(readFileSync(path, 'utf8')).toBe(malformed);
    expect(writes).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('does not replace dotfiles symlinks or their targets', async () => {
    const target = join(root, 'dotfiles-hooks.json'); const original = '{"description":"user dotfiles"}';
    writeFileSync(target, original); symlinkSync(target, path);
    await expect(installCodexSessionHook(options)).rejects.toThrow('symlink');
    await expect(removeCodexSessionHook(options)).rejects.toThrow('symlink');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('refuses automatic sync when hooks are disabled', async () => {
    config.features = { hooks: false };
    await expect(installCodexSessionHook(options)).rejects.toThrow('hooks are disabled');
    expect(existsSync(path)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('passes quiet sync argv, session cwd and the selected Codex home literally', () => {
    const fixture = join(root, "odd' $name (fixture).cjs");
    const output = join(root, 'captured.json');
    const cwd = join(root, 'other project'); mkdirSync(cwd);
    writeFileSync(fixture, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),codexHome:process.env.CODEX_HOME}));`);
    options.self.args = [fixture];
    const hook = codexSessionHook(options);
    const command = String(process.platform === 'win32' ? hook.commandWindows : hook.command);
    expect(execSync(command, { cwd, env: { ...process.env, CODEX_HOME: 'wrong-home' }, encoding: 'utf8' })).toBe('');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ cwd, codexHome: root,
      args: ['sync', '--client', 'codex', '--quiet', '--codex-bin', join(root, 'codex')] });
  });

  it('is silent if the installed Speculate entrypoint has been removed', () => {
    const hook = codexSessionHook(options);
    const command = String(process.platform === 'win32' ? hook.commandWindows : hook.command);
    expect(execSync(command, { encoding: 'utf8' })).toBe('');
  });
});
