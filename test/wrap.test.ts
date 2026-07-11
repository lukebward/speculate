/**
 * wrap.ts tests (DESIGN.md §13.9): parseWrapArgs flag handling and
 * buildWrapConfig assembly (profile autodetect, allowlist, state keys,
 * workspace mode).
 */
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWrapConfig, parseWrapArgs, type WrapArgs } from '../src/wrap.js';

// --- helpers -----------------------------------------------------------------

function ok(r: WrapArgs | { error: string }): WrapArgs {
  if ('error' in r) throw new Error(`expected success, got error: ${r.error}`);
  return r;
}

function err(r: WrapArgs | { error: string }): string {
  if (!('error' in r)) throw new Error('expected an error result');
  return r.error;
}

function mkArgs(over: Partial<WrapArgs> = {}): WrapArgs {
  return {
    mode: over.mode ?? 'annotated',
    profile: over.profile ?? null,
    allow: over.allow ?? [],
    workspace: over.workspace ?? null,
    command: over.command ?? [],
  };
}

// --- parseWrapArgs -------------------------------------------------------------

describe('parseWrapArgs', () => {
  it('parses the happy path with flags before -- and a command after', () => {
    const args = ok(
      parseWrapArgs(['--mode', 'strict', '--profile', 'github', '--allow', 'a, b', '--', 'github-mcp-server', 'stdio']),
    );
    expect(args).toEqual({
      mode: 'strict',
      profile: 'github',
      allow: ['a', 'b'],
      workspace: null,
      command: ['github-mcp-server', 'stdio'],
    });
  });

  it('defaults mode to annotated', () => {
    expect(ok(parseWrapArgs(['--', 'srv'])).mode).toBe('annotated');
  });

  it('rejects an invalid --mode value', () => {
    expect(err(parseWrapArgs(['--mode', 'fast', '--', 'srv']))).toContain(
      "--mode must be strict|annotated|off (got 'fast')",
    );
  });

  it('rejects an unknown --profile and lists the available ones', () => {
    const e = err(parseWrapArgs(['--profile', 'gitlab', '--', 'srv']));
    expect(e).toContain("unknown profile 'gitlab'");
    expect(e).toContain('github');
    expect(e).toContain('shell');
  });

  it('parses --allow csv: trims spaces, drops empties', () => {
    expect(ok(parseWrapArgs(['--allow', ' a , ,b,, c ', '--', 'srv'])).allow).toEqual(['a', 'b', 'c']);
  });

  it('resolves a relative --workspace to an absolute path', () => {
    const ws = ok(parseWrapArgs(['--workspace', 'some/dir'])).workspace;
    expect(ws).toBe(resolve('some/dir'));
    expect(isAbsolute(ws!)).toBe(true);
  });

  it('rejects --workspace combined with a wrapped command', () => {
    expect(err(parseWrapArgs(['--workspace', '.', '--', 'srv']))).toContain('mutually exclusive');
  });

  it('rejects neither --workspace nor a command', () => {
    expect(err(parseWrapArgs([]))).toContain("wrap needs a server command after '--'");
  });

  it('rejects an unknown flag before --', () => {
    expect(err(parseWrapArgs(['--bogus', '--', 'srv']))).toContain("unknown wrap argument '--bogus'");
  });

  it("leaves flag-looking tokens after -- to the wrapped command", () => {
    const args = ok(parseWrapArgs(['--', 'server', '--mode', 'x']));
    expect(args.command).toEqual(['server', '--mode', 'x']);
    expect(args.mode).toBe('annotated'); // wrap's own default, untouched
    expect(args.profile).toBeNull();
  });
});

// --- buildWrapConfig ------------------------------------------------------------

describe('buildWrapConfig', () => {
  it('auto-detects the github profile from github-mcp-server anywhere in the command line', () => {
    const { config } = buildWrapConfig(
      mkArgs({ command: ['docker', 'run', 'ghcr.io/github/github-mcp-server', 'stdio'] }),
    );
    expect(config.servers['upstream']!.profile).toBe('github');
  });

  it('auto-detects the shell profile from speculate-shell in the command line', () => {
    const { config } = buildWrapConfig(mkArgs({ command: ['node', '/opt/speculate-shell.js'] }));
    expect(config.servers['upstream']!.profile).toBe('shell');
  });

  it('sets no profile when nothing matches', () => {
    const { config } = buildWrapConfig(mkArgs({ command: ['my-server', 'stdio'] }));
    expect('profile' in config.servers['upstream']!).toBe(false);
  });

  it('lets an explicit --profile win over autodetect', () => {
    const { config } = buildWrapConfig(
      mkArgs({ profile: 'shell', command: ['github-mcp-server', 'stdio'] }),
    );
    expect(config.servers['upstream']!.profile).toBe('shell');
  });

  it('places the allow list in allowTools (and omits the key when empty)', () => {
    const withAllow = buildWrapConfig(mkArgs({ allow: ['a', 'b'], command: ['srv'] }));
    expect(withAllow.config.servers['upstream']!.allowTools).toEqual(['a', 'b']);
    const without = buildWrapConfig(mkArgs({ command: ['srv'] }));
    expect('allowTools' in without.config.servers['upstream']!).toBe(false);
  });

  it('splits the command into command and args', () => {
    const { config } = buildWrapConfig(mkArgs({ command: ['npx', '-y', 'srv', 'stdio'] }));
    expect(config.servers['upstream']!.command).toBe('npx');
    expect(config.servers['upstream']!.args).toEqual(['-y', 'srv', 'stdio']);
  });

  it('derives a stateKey stable for the same command and distinct for different ones', () => {
    const a1 = buildWrapConfig(mkArgs({ command: ['srv', 'stdio'] })).stateKey;
    const a2 = buildWrapConfig(mkArgs({ command: ['srv', 'stdio'] })).stateKey;
    const b = buildWrapConfig(mkArgs({ command: ['other', 'stdio'] })).stateKey;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('defaults to annotated mode end to end (parse → build)', () => {
    const { config } = buildWrapConfig(ok(parseWrapArgs(['--', 'srv'])));
    expect(config.mode).toBe('annotated');
  });

  describe('workspace mode', () => {
    // resolveShellServerCommand touches the filesystem, so only the
    // profile / '--cwd' tail / stateKey are asserted, not the command path.
    const abs = resolve('some-ws');

    it('configures a shell-profile workspace server with a --cwd tail', () => {
      const { config } = buildWrapConfig(mkArgs({ workspace: abs }));
      const server = config.servers['workspace']!;
      expect(server.profile).toBe('shell');
      expect(server.args!.slice(-2)).toEqual(['--cwd', abs]);
    });

    it('keys state by the workspace path', () => {
      const { stateKey } = buildWrapConfig(mkArgs({ workspace: abs }));
      expect(stateKey).toBe(`wrap-workspace:${abs}`);
    });

    it('passes mode and allow list through', () => {
      const { config } = buildWrapConfig(mkArgs({ workspace: abs, mode: 'strict', allow: ['run'] }));
      expect(config.mode).toBe('strict');
      expect(config.servers['workspace']!.allowTools).toEqual(['run']);
    });
  });
});
