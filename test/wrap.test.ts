/**
 * wrap.ts tests (DESIGN.md §13.9): parseWrapArgs flag handling and
 * buildWrapConfig assembly (allowlist, state keys). Vetted profiles were
 * removed, so `--profile` is accepted and ignored: wrapped entries already
 * written into people's MCP config must not start failing.
 */
import { describe, expect, it, vi } from 'vitest';
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
    sniff: over.sniff ?? false,
    command: over.command ?? [],
    url: over.url ?? null,
    headers: over.headers ?? {},
  };
}

// --- parseWrapArgs -------------------------------------------------------------

describe('parseWrapArgs', () => {
  it('parses the happy path with flags before -- and a command after', () => {
    const args = ok(
      parseWrapArgs(['--mode', 'strict', '--allow', 'a, b', '--', 'github-mcp-server', 'stdio']),
    );
    expect(args).toEqual({
      mode: 'strict',
      profile: null,
      allow: ['a', 'b'],
      sniff: false,
      command: ['github-mcp-server', 'stdio'],
      url: null,
      headers: {},
    });
  });

  it('parses --sniff for wrapped commands', () => {
    expect(ok(parseWrapArgs(['--sniff', '--', 'srv'])).sniff).toBe(true);
  });

  it('defaults mode to annotated', () => {
    expect(ok(parseWrapArgs(['--', 'srv'])).mode).toBe('annotated');
  });

  it('rejects an invalid --mode value', () => {
    expect(err(parseWrapArgs(['--mode', 'fast', '--', 'srv']))).toContain(
      "--mode must be strict|annotated|off (got 'fast')",
    );
  });

  it('accepts and ignores --profile, warning once', () => {
    // A wrapped entry in someone's MCP config may still carry the flag from
    // an older install; failing the launch would take their server down.
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const args = ok(parseWrapArgs(['--profile', 'github', '--', 'srv']));
      expect(args.profile).toBeNull();
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(written.join('')).toContain('no longer exists');
  });

  it('still requires a value after --profile', () => {
    expect(err(parseWrapArgs(['--profile']))).toContain('--profile requires a name');
  });

  it('parses --allow csv: trims spaces, drops empties', () => {
    expect(ok(parseWrapArgs(['--allow', ' a , ,b,, c ', '--', 'srv'])).allow).toEqual(['a', 'b', 'c']);
  });

  it('rejects when no command is given', () => {
    expect(err(parseWrapArgs([]))).toContain("wrap needs a server command after '--'");
  });

  it('rejects an unknown flag before --', () => {
    expect(err(parseWrapArgs(['--bogus', '--', 'srv']))).toContain("unknown wrap argument '--bogus'");
  });

  it('rejects the removed --workspace flag', () => {
    const r = parseWrapArgs(['--workspace', '.']);
    expect('error' in r && r.error).toMatch(/unknown wrap argument '--workspace'/);
  });

  it('rejects the removed --commands flag', () => {
    const r = parseWrapArgs(['--commands', 'x.jsonc', '--', 'server']);
    expect('error' in r && r.error).toMatch(/unknown wrap argument '--commands'/);
  });

  it('rejects the removed --no-auto flag', () => {
    const r = parseWrapArgs(['--no-auto', '--', 'server']);
    expect('error' in r && r.error).toMatch(/unknown wrap argument '--no-auto'/);
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
  it('never writes a profile into the built config', () => {
    // Autodetect from the command line went with profiles; a wrapped
    // github-mcp-server is predicted by the learner like anything else.
    for (const command of [['github-mcp-server', 'stdio'], ['some-other-server']]) {
      const { config } = buildWrapConfig(mkArgs({ command }));
      expect('profile' in config.servers['upstream']!).toBe(false);
    }
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
});

// --- remote (http) wrapping ----------------------------------------------------

describe('wrap --url', () => {
  it('wraps a remote server with no command at all', () => {
    const args = ok(parseWrapArgs(['--url', 'https://api.example.test/mcp/']));
    expect(args.url).toBe('https://api.example.test/mcp/');
    expect(args.command).toEqual([]);
    const { config, stateKey } = buildWrapConfig(args);
    expect(config.servers['upstream']!.url).toBe('https://api.example.test/mcp/');
    expect(config.servers['upstream']!.command).toBeUndefined();
    expect(stateKey).toContain('https://api.example.test/mcp/');
  });

  it('parses repeatable --header "K: V" and resolves ${VAR} from the environment', () => {
    vi.stubEnv('SPECULATE_WRAP_TOKEN', 'tok_live_123');
    const args = ok(
      parseWrapArgs([
        '--url',
        'https://api.example.test/mcp/',
        '--header',
        'Authorization: Bearer ${SPECULATE_WRAP_TOKEN}',
        '--header',
        'X-Api-Version:2026-01-01',
      ]),
    );
    expect(args.headers).toEqual({
      Authorization: 'Bearer tok_live_123',
      'X-Api-Version': '2026-01-01',
    });
    const { config } = buildWrapConfig(args);
    expect(config.servers['upstream']!.headers).toEqual(args.headers);
  });

  it('fails loudly, naming the variable, when a header variable is unset', () => {
    vi.stubEnv('SPECULATE_WRAP_MISSING', undefined);
    const message = err(
      parseWrapArgs([
        '--url',
        'https://api.example.test/mcp/',
        '--header',
        'Authorization: Bearer ${SPECULATE_WRAP_MISSING}',
      ]),
    );
    expect(message).toMatch(/SPECULATE_WRAP_MISSING/);
    expect(message).toMatch(/not set/);
  });

  it('rejects --header without --url (stdio credentials go in env)', () => {
    expect(err(parseWrapArgs(['--header', 'Authorization: x', '--', 'srv']))).toMatch(/--url/);
  });

  it('rejects --url together with a wrapped command, and a bare --url with neither', () => {
    expect(err(parseWrapArgs(['--url', 'https://a.test/mcp', '--', 'srv']))).toMatch(/--url/);
    expect(err(parseWrapArgs([]))).toMatch(/--url/);
  });

  it('rejects a non-http --url and a malformed one', () => {
    expect(err(parseWrapArgs(['--url', 'ftp://a.test/mcp']))).toMatch(/http/);
    expect(err(parseWrapArgs(['--url', 'not a url']))).toMatch(/--url/);
  });

  it('rejects --sniff with --url (there is no command to degrade into a pipe)', () => {
    expect(err(parseWrapArgs(['--url', 'https://a.test/mcp', '--sniff']))).toMatch(/--sniff/);
  });

  it('rejects a --header with no colon', () => {
    expect(err(parseWrapArgs(['--url', 'https://a.test/mcp', '--header', 'Authorization']))).toMatch(
      /--header/,
    );
  });

  it('omits headers from the built config when none were given', () => {
    const { config } = buildWrapConfig(ok(parseWrapArgs(['--url', 'https://a.test/mcp'])));
    expect('headers' in config.servers['upstream']!).toBe(false);
  });
});
