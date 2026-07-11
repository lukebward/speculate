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
  WORKSPACE_SERVER_NAME,
  effectiveServers,
  isStdioEntry,
  isWrappedEntry,
  readClaudeServers,
  unwrapEntry,
  wrapEntry,
} from '../src/hostConfig.js';
import { buildTryConfig, parseTryArgs } from '../src/tryRun.js';

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

describe('buildTryConfig', () => {
  it('wraps stdio servers, passes through http, adds the workspace server', () => {
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
    expect(plan.mcpServers[WORKSPACE_SERVER_NAME]!.args).toContain('--workspace');
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

  it('leaves already-wrapped entries alone and honors --no-workspace', () => {
    writeClaudeJson({
      mcpServers: {
        github: {
          command: '/usr/bin/node',
          args: ['/opt/speculate/dist/src/cli.js', 'wrap', '--', 'github-mcp-server'],
        },
      },
    });
    const plan = buildTryConfig({ home, cwd, self: SELF, noWorkspace: true });
    expect(plan.passedThrough).toEqual(['github']);
    expect(plan.mcpServers[WORKSPACE_SERVER_NAME]).toBeUndefined();
  });
});

describe('parseTryArgs', () => {
  it('parses flags and client args', () => {
    const t = parseTryArgs(['--no-workspace', '--mode', 'strict', '--', '--continue']);
    expect(t).toEqual({ noWorkspace: true, mode: 'strict', clientArgs: ['--continue'] });
  });
  it('rejects unknown flags', () => {
    expect(parseTryArgs(['--frobnicate'])).toHaveProperty('error');
  });
});
