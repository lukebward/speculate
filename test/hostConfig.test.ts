/**
 * §13.12 host-config discovery and entry wrapping: scope precedence,
 * consent preservation for .mcp.json servers, wrap/unwrap round-trips,
 * and the `try` plan builder that composes them.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_ENV_PLACEHOLDER,
  HOST_HEADER_NAME,
  effectiveServers,
  isStdioEntry,
  isWrappedEntry,
  planRemoteWrap,
  readClaudeServers,
  resolveWrapHeaders,
  unwrapEntry,
  wrapEntry,
} from '../src/hostConfig.js';
import { ENV_PLACEHOLDER, HEADER_NAME } from '../src/config.js';
import { buildTryConfig, parseTryArgs, tryClientEnv } from '../src/tryRun.js';

const SELF = { command: '/usr/bin/node', args: ['/opt/speculate/dist/src/cli.js'] };

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'speculate-proj-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeClaudeJson(data: unknown): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify(data));
}
function writeMcpJson(data: unknown): void {
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(data));
}

describe('readClaudeServers + effectiveServers', () => {
  describe('finding this project in the host config', () => {
    // An exact string match on the project key silently lost every
    // LOCAL-scope server on Windows: `claude mcp add-json` writes the key with
    // forward slashes (C:/Users/...) while `resolve()` returns backslashes
    // (C:\Users\...). `status` then reported "no MCP servers visible" for a
    // server the user had just added, and `on` skipped it without a word.
    const localServer = { mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp' } } };
    const findsIt = (key: string) => {
      writeClaudeJson({ projects: { [key]: localServer } });
      const found = readClaudeServers({ home, cwd }).servers;
      return found.length === 1 && found[0]!.name === 'github' && found[0]!.scope === 'local';
    };

    it('matches the key the host actually wrote', () => {
      expect(findsIt(cwd)).toBe(true);
    });

    it('matches when the key uses forward slashes', () => {
      // A no-op on POSIX (no backslashes to swap), the real case on Windows.
      expect(findsIt(cwd.split('\\').join('/'))).toBe(true);
    });

    it('matches through a trailing slash', () => {
      expect(findsIt(`${cwd}/`)).toBe(true);
    });

    it.runIf(process.platform === 'win32')('folds case on Windows only', () => {
      expect(findsIt(cwd.toUpperCase())).toBe(true);
    });

    it('still ignores a genuinely different project', () => {
      expect(findsIt(join(cwd, 'somewhere-else'))).toBe(false);
    });
  });

  it('reads all three scopes and resolves local > project > user', () => {
    writeClaudeJson({
      mcpServers: { github: { command: 'gh-user', args: [] }, solo: { command: 'solo' } },
      projects: {
        [cwd]: {
          mcpServers: { github: { command: 'gh-local', args: [] } },
          enableAllProjectMcpServers: true,
        },
      },
    });
    writeMcpJson({ mcpServers: { github: { command: 'gh-project' }, team: { command: 'team' } } });

    const view = readClaudeServers({ home, cwd });
    expect(view.warnings).toEqual([]);
    expect(view.servers).toHaveLength(5);

    const eff = effectiveServers(view.servers);
    expect(eff.get('github')!.entry.command).toBe('gh-local');
    expect(eff.get('github')!.scope).toBe('local');
    expect(eff.get('team')!.scope).toBe('project');
    expect(eff.get('solo')!.scope).toBe('user');
  });

  it('tracks project-scope approval from the host records', () => {
    writeClaudeJson({
      projects: {
        [cwd]: { enabledMcpjsonServers: ['approved'], disabledMcpjsonServers: ['denied'] },
      },
    });
    writeMcpJson({
      mcpServers: {
        approved: { command: 'a' },
        denied: { command: 'd' },
        pending: { command: 'p' },
      },
    });
    const view = readClaudeServers({ home, cwd });
    expect(view.projectApprovalKnown).toBe(true);
    expect(view.approvedProjectServers.has('approved')).toBe(true);
    expect(view.approvedProjectServers.has('denied')).toBe(false);
    expect(view.approvedProjectServers.has('pending')).toBe(false);
  });

  it('survives missing and corrupt files', () => {
    writeFileSync(join(home, '.claude.json'), '{not json');
    const view = readClaudeServers({ home, cwd });
    expect(view.servers).toEqual([]);
    expect(view.warnings).toHaveLength(1);
  });
});

describe('entry classification and wrapping', () => {
  it('classifies stdio vs url vs typed entries', () => {
    expect(isStdioEntry({ command: 'x' })).toBe(true);
    expect(isStdioEntry({ command: 'x', type: 'stdio' })).toBe(true);
    expect(isStdioEntry({ url: 'https://mcp.example.com' })).toBe(false);
    expect(isStdioEntry({ command: 'x', type: 'http' })).toBe(false);
    expect(isStdioEntry({})).toBe(false);
  });

  it('wraps preserving env and unwraps back to the exact original', () => {
    const original = {
      command: 'github-mcp-server',
      args: ['stdio', '--flag'],
      env: { TOKEN: 'secret' },
    };
    const wrapped = wrapEntry(original, SELF);
    expect(wrapped.command).toBe(SELF.command);
    expect(wrapped.args).toEqual([
      ...SELF.args,
      'wrap',
      '--',
      'github-mcp-server',
      'stdio',
      '--flag',
    ]);
    expect(wrapped.env).toEqual({ TOKEN: 'secret' });
    expect(isWrappedEntry(wrapped)).toBe(true);
    expect(isWrappedEntry(original)).toBe(false);

    const back = unwrapEntry(wrapped);
    expect(back).toEqual(original);
  });

  it('keeps a wrapped command whose own args contain --', () => {
    const original = { command: 'srv', args: ['--', 'inner'] };
    const back = unwrapEntry(wrapEntry(original, SELF));
    expect(back).toEqual(original);
  });

  it('honors a mode override in the wrapped invocation', () => {
    const wrapped = wrapEntry({ command: 'srv' }, SELF, { mode: 'strict' });
    expect(wrapped.args).toEqual([...SELF.args, 'wrap', '--mode', 'strict', '--', 'srv']);
  });

  it('does not mistake unrelated wrap tokens for our wrapper', () => {
    expect(isWrappedEntry({ command: 'other-tool', args: ['wrap', '--', 'x'] })).toBe(false);
    expect(
      isWrappedEntry({ command: 'npx', args: ['-y', 'github:lukebward/speculate', 'wrap', '--', 'x'] }),
    ).toBe(true);
  });
});

describe('remote (http) entries', () => {
  const URL_ = 'https://api.example.com/mcp/';

  it('is not a remote entry at all when there is no url', () => {
    expect(planRemoteWrap({ command: 'srv' })).toBeNull();
    expect(planRemoteWrap({})).toBeNull();
  });

  it('wraps a streamable-http entry, with or without a declared type', () => {
    for (const entry of [
      { url: URL_ },
      { url: URL_, type: 'http' },
      { url: URL_, type: 'streamable-http' },
    ]) {
      const plan = planRemoteWrap(entry);
      expect(plan).toMatchObject({ wrappable: true, url: URL_, headers: [] });
    }
  });

  it('wraps an unauthenticated remote server (a self-hosted one on a trusted network)', () => {
    const wrapped = wrapEntry({ url: 'http://10.0.0.4:9000/mcp' }, SELF);
    expect(wrapped.args).toEqual([...SELF.args, 'wrap', '--url', 'http://10.0.0.4:9000/mcp']);
    expect(wrapped.url).toBeUndefined();
  });

  it('never wraps an sse entry: Speculate speaks streamable HTTP only', () => {
    const plan = planRemoteWrap({ url: URL_, type: 'sse' });
    expect(plan).toEqual({ wrappable: false, reason: expect.stringContaining('sse') });
  });

  it('never wraps a non-http url scheme, which `wrap --url` would reject at launch', () => {
    expect(planRemoteWrap({ url: 'ws://example.com/mcp' })).toMatchObject({ wrappable: false });
    expect(planRemoteWrap({ url: 'not a url' })).toMatchObject({ wrappable: false });
  });

  it('never wraps headers it cannot carry through argv verbatim', () => {
    // A non-string value, a name `wrap --header` would reject, and a value
    // carrying the CR/LF that `--header` parsing (and HTTP) forbid.
    expect(planRemoteWrap({ url: URL_, headers: { A: 1 } })).toMatchObject({ wrappable: false });
    expect(planRemoteWrap({ url: URL_, headers: { 'A B': 'x' } })).toMatchObject({ wrappable: false });
    expect(planRemoteWrap({ url: URL_, headers: { A: 'x\ny' } })).toMatchObject({ wrappable: false });
    expect(planRemoteWrap({ url: URL_, headers: ['a'] })).toMatchObject({ wrappable: false });
  });

  it('a skip reason never quotes a header value', () => {
    const plan = planRemoteWrap({ url: URL_, headers: { 'A B': 's3cret-token-value' } });
    expect(plan).toMatchObject({ wrappable: false });
    expect((plan as { reason: string }).reason).not.toContain('s3cret-token-value');
  });

  it('pins the header-name rule to the one `wrap --header` enforces', () => {
    // hostConfig deliberately does not import config.ts (zod + every profile)
    // into the session-start `sync` path, so the rule is duplicated. If they
    // ever drift, `on` wraps a server `wrap` then refuses to start.
    expect(HOST_HEADER_NAME.source).toBe(HEADER_NAME.source);
    expect(HOST_HEADER_NAME.flags).toBe(HEADER_NAME.flags);
  });

  it('pins the ${VAR} rule to the one the proxy resolves with', () => {
    // Duplicated for the same reason, and with a sharper failure mode: if
    // these drift, the probe resolves a placeholder the proxy does not (or
    // vice versa), so `on` decides wrappability from credentials the running
    // proxy will never send.
    expect(HOST_ENV_PLACEHOLDER.source).toBe(ENV_PLACEHOLDER.source);
    expect(HOST_ENV_PLACEHOLDER.flags).toBe(ENV_PLACEHOLDER.flags);
  });

  describe('resolveWrapHeaders', () => {
    it('resolves ${VAR} from the environment', () => {
      const out = resolveWrapHeaders([['Authorization', 'Bearer ${TOK}']], { TOK: 'abc123' });
      expect(out).toEqual({ ok: true, headers: { Authorization: 'Bearer abc123' } });
    });

    it('passes a literal value through untouched', () => {
      const out = resolveWrapHeaders([['X-Api-Version', '2024-01-01']], {});
      expect(out).toEqual({ ok: true, headers: { 'X-Api-Version': '2024-01-01' } });
    });

    it('reports an unset or empty variable by NAME, never substituting silently', () => {
      // Substituting nothing would probe with `Authorization: Bearer `, earn a
      // 401, and make `on` report "needs an OAuth login" for what is really a
      // missing environment variable.
      expect(resolveWrapHeaders([['Authorization', 'Bearer ${TOK}']], {})).toEqual({
        ok: false,
        missing: 'TOK',
      });
      expect(resolveWrapHeaders([['Authorization', 'Bearer ${TOK}']], { TOK: '' })).toEqual({
        ok: false,
        missing: 'TOK',
      });
    });

    it('never returns a resolved value alongside a failure', () => {
      // The failure branch is logged; a partially-resolved map reaching it
      // would put a real token into that log line.
      const out = resolveWrapHeaders(
        [
          ['X-First', '${PRESENT}'],
          ['X-Second', '${ABSENT}'],
        ],
        { PRESENT: 'secret-value-here' },
      );
      expect(out).toEqual({ ok: false, missing: 'ABSENT' });
      expect(JSON.stringify(out)).not.toContain('secret-value-here');
    });
  });

  it('wraps and unwraps a remote entry, headers and unknown fields intact', () => {
    const original = {
      type: 'http',
      url: URL_,
      headers: { Authorization: 'Bearer ${API_TOKEN}', 'X-Api-Version': '2024-01-01' },
      somethingTheHostAdded: { nested: true },
    };
    const wrapped = wrapEntry(original, SELF, { mode: 'strict' });
    expect(wrapped.command).toBe(SELF.command);
    expect(wrapped.args).toEqual([
      ...SELF.args,
      'wrap',
      '--mode',
      'strict',
      '--url',
      URL_,
      '--header',
      'Authorization: Bearer ${API_TOKEN}',
      '--header',
      'X-Api-Version: 2024-01-01',
    ]);
    // The transport fields must NOT survive on the wrapped entry: the host
    // picks http over stdio whenever it sees a url, and the token must exist
    // in exactly one place, not two.
    expect(wrapped.url).toBeUndefined();
    expect(wrapped.type).toBeUndefined();
    expect(wrapped.headers).toBeUndefined();
    expect(wrapped.somethingTheHostAdded).toEqual({ nested: true });
    expect(isWrappedEntry(wrapped)).toBe(true);

    expect(unwrapEntry(wrapped)).toEqual(original);
  });

  it('carries a ${VAR} placeholder through unresolved, so no token is copied anywhere', () => {
    process.env.SPECULATE_TEST_TOKEN = 'tok-must-not-appear';
    try {
      const wrapped = wrapEntry(
        { url: URL_, headers: { Authorization: 'Bearer ${SPECULATE_TEST_TOKEN}' } },
        SELF,
      );
      expect(JSON.stringify(wrapped)).not.toContain('tok-must-not-appear');
    } finally {
      delete process.env.SPECULATE_TEST_TOKEN;
    }
  });

  it('reconstructs a remote entry from the wrap invocation alone (no state file)', () => {
    const wrapped = wrapEntry({ url: URL_, headers: { Authorization: 'Bearer x' } }, SELF);
    // The no-state net cannot know whether `type` was written out, so it
    // states the transport it was actually speaking.
    expect(unwrapEntry(wrapped)).toEqual({
      type: 'http',
      url: URL_,
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('keeps a header value containing colons whole', () => {
    const original = { type: 'http', url: URL_, headers: { 'X-Trace': 'a:b:c' } };
    expect(unwrapEntry(wrapEntry(original, SELF))).toEqual(original);
  });
});

describe('buildTryConfig', () => {
  it('wraps stdio servers, passes through http, and nothing else', () => {
    writeClaudeJson({
      mcpServers: {
        github: { command: 'github-mcp-server', args: ['stdio'] },
        sentry: { url: 'https://mcp.sentry.dev/mcp', type: 'http' },
      },
    });
    const plan = buildTryConfig({ home, cwd, self: SELF });
    expect(plan.wrapped).toEqual(['github']);
    expect(plan.passedThrough).toEqual(['sentry']);
    expect(plan.mcpServers.github!.command).toBe(SELF.command);
    expect(plan.mcpServers.sentry).toEqual({ url: 'https://mcp.sentry.dev/mcp', type: 'http' });
    expect(Object.keys(plan.mcpServers).sort()).toEqual(['github', 'sentry']);
  });

  it('never turns pending .mcp.json approval into running servers', () => {
    writeMcpJson({ mcpServers: { team: { command: 'team-server' } } });
    const plan = buildTryConfig({ home, cwd, self: SELF });
    expect(plan.mcpServers.team).toBeUndefined();
    expect(plan.skipped.map((s) => s.name)).toEqual(['team']);
  });

  it('includes approved .mcp.json servers, wrapped', () => {
    writeClaudeJson({ projects: { [cwd]: { enabledMcpjsonServers: ['team'] } } });
    writeMcpJson({ mcpServers: { team: { command: 'team-server' } } });
    const plan = buildTryConfig({ home, cwd, self: SELF });
    expect(plan.wrapped).toEqual(['team']);
  });

  it('leaves already-wrapped entries alone', () => {
    writeClaudeJson({
      mcpServers: {
        github: {
          command: '/usr/bin/node',
          args: ['/opt/speculate/dist/src/cli.js', 'wrap', '--', 'github-mcp-server'],
        },
      },
    });
    const plan = buildTryConfig({ home, cwd, self: SELF });
    expect(plan.passedThrough).toEqual(['github']);
    expect(Object.keys(plan.mcpServers)).toEqual(['github']);
  });
});

describe('parseTryArgs', () => {
  it('parses flags and client args', () => {
    const t = parseTryArgs(['--mode', 'strict', '--', '--continue']);
    expect(t).toEqual({ mode: 'strict', clientArgs: ['--continue'] });
  });
  it('rejects unknown flags', () => {
    expect(parseTryArgs(['--frobnicate'])).toHaveProperty('error');
  });
  it('rejects --no-workspace as an unknown flag', () => {
    const t = parseTryArgs(['--no-workspace']);
    expect(t).toHaveProperty('error');
    expect((t as { error: string }).error).toMatch(/--no-workspace/);
  });
});

describe('tryClientEnv', () => {
  it('disables durable usage', () => {
    expect(tryClientEnv({ KEEP: 'yes' })).toEqual({
      KEEP: 'yes',
      SPECULATE_USAGE_OFF: '1',
    });
  });
});
