/**
 * §13.12 `speculate on`/`off`/`status`: every mutation goes through the
 * host front door (`claude mcp …`). The fake runner below implements just
 * enough of `claude mcp add-json`/`remove` semantics against the fixture
 * config files to verify the full on → off round trip, including the
 * shadow-don't-touch rule for .mcp.json and the state-less unwrap net.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speculateOff, speculateOn, speculateStatus, type CmdRunner } from '../src/manage.js';
import { WORKSPACE_SERVER_NAME } from '../src/hostConfig.js';

const SELF = { command: '/usr/bin/node', args: ['/opt/speculate/dist/src/cli.js'] };

let home: string;
let cwd: string;
let statePath: string;
let calls: string[][];
let logs: string[];
/** Simulated `claude plugin` state; null = plugin CLI unavailable (old host). */
let pluginSim: { installed: boolean; marketplace: boolean } | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-mhome-'));
  cwd = mkdtempSync(join(tmpdir(), 'speculate-mproj-'));
  statePath = join(home, 'managed.json');
  calls = [];
  logs = [];
  pluginSim = null;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

type AnyRecord = Record<string, any>;

function readClaudeJson(): AnyRecord {
  try {
    return JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  } catch {
    return {};
  }
}
function writeClaudeJson(data: AnyRecord): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify(data));
}

/** Just enough `claude mcp`/`claude plugin` to test against. */
const fakeRunner: CmdRunner = async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (args[0] === 'plugin') {
    if (!pluginSim) return { code: 2, stdout: '', stderr: 'unknown command plugin' };
    if (args[1] === 'list') {
      return {
        code: 0,
        stdout: JSON.stringify(
          pluginSim.installed ? [{ name: 'speculate', marketplace: 'speculate' }] : [],
        ),
        stderr: '',
      };
    }
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const already = pluginSim.marketplace;
      pluginSim.marketplace = true;
      return already
        ? { code: 1, stdout: '', stderr: 'Marketplace speculate already exists' }
        : { code: 0, stdout: 'Added marketplace speculate', stderr: '' };
    }
    if (args[1] === 'marketplace' && args[2] === 'remove') {
      pluginSim.marketplace = false;
      return { code: 0, stdout: 'Removed', stderr: '' };
    }
    if (args[1] === 'install') {
      if (!pluginSim.marketplace) return { code: 1, stdout: '', stderr: 'no such marketplace' };
      pluginSim.installed = true;
      return { code: 0, stdout: 'Installed speculate@speculate', stderr: '' };
    }
    if (args[1] === 'uninstall') {
      pluginSim.installed = false;
      return { code: 0, stdout: 'Uninstalled', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: 'unknown plugin subcommand' };
  }
  if (args[0] !== 'mcp') return { code: 2, stdout: '', stderr: 'unknown command' };
  if (args[1] === 'list') return { code: 0, stdout: 'usage', stderr: '' };
  const config = readClaudeJson();
  if (args[1] === 'add-json') {
    const [name, json] = [args[2]!, args[3]!];
    const scope = args[args.indexOf('-s') + 1];
    const entry = JSON.parse(json);
    if (scope === 'user') {
      config.mcpServers = { ...config.mcpServers, [name]: entry };
    } else if (scope === 'local') {
      config.projects ??= {};
      config.projects[cwd] ??= {};
      config.projects[cwd].mcpServers = { ...config.projects[cwd].mcpServers, [name]: entry };
    } else {
      return { code: 1, stdout: '', stderr: `unsupported scope ${scope}` };
    }
    writeClaudeJson(config);
    return { code: 0, stdout: `Added ${name}`, stderr: '' };
  }
  if (args[1] === 'remove') {
    const name = args[2]!;
    const scope = args[args.indexOf('-s') + 1];
    const map =
      scope === 'user' ? config.mcpServers : config.projects?.[cwd]?.mcpServers;
    if (!map || !(name in map)) return { code: 1, stdout: '', stderr: `No server ${name}` };
    delete map[name];
    writeClaudeJson(config);
    return { code: 0, stdout: `Removed ${name}`, stderr: '' };
  }
  return { code: 2, stdout: '', stderr: 'unknown mcp subcommand' };
};

const opts = () => ({
  home,
  cwd,
  self: SELF,
  runner: fakeRunner,
  claudeBin: 'claude',
  statePath,
  log: (l: string) => logs.push(l),
});

describe('speculate on', () => {
  it('wraps user-scope servers in place', async () => {
    writeClaudeJson({
      mcpServers: { github: { command: 'gh-server', args: ['stdio'], env: { T: '1' } } },
    });
    const code = await speculateOn(opts());
    expect(code).toBe(0);

    const config = readClaudeJson();
    const wrapped = config.mcpServers.github;
    expect(wrapped.command).toBe(SELF.command);
    expect(wrapped.args).toContain('wrap');
    expect(wrapped.args.slice(-2)).toEqual(['gh-server', 'stdio']);
    expect(wrapped.env).toEqual({ T: '1' });
    // State file records it.
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const actions = Object.fromEntries(
      state.projects[cwd].entries.map((e: AnyRecord) => [e.name, e.action]),
    );
    expect(actions).toEqual({ github: 'rewrote' });
  });

  it('shadows approved .mcp.json servers at local scope, never touching the file', async () => {
    const mcpJson = { mcpServers: { team: { command: 'team-server', args: [] } } };
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(mcpJson));
    writeClaudeJson({ projects: { [cwd]: { enableAllProjectMcpServers: true } } });

    const code = await speculateOn(opts());
    expect(code).toBe(0);
    // .mcp.json byte-identical.
    expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))).toEqual(mcpJson);
    // Wrapped shadow lives at local scope.
    const local = readClaudeJson().projects[cwd].mcpServers;
    expect(local.team.command).toBe(SELF.command);
    expect(local.team.args.slice(-1)).toEqual(['team-server']);
  });

  it('skips unapproved .mcp.json servers', async () => {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { team: { command: 't' } } }));
    writeClaudeJson({ projects: { [cwd]: { enabledMcpjsonServers: ['other'] } } });
    await speculateOn(opts());
    expect(readClaudeJson().projects[cwd].mcpServers?.team).toBeUndefined();
    expect(logs.join('\n')).toContain('not approved');
  });

  it('skips .mcp.json servers when approval state is unknown (never widens consent)', async () => {
    // Fresh clone: .mcp.json exists but the host has no approval record at
    // all (the common case). Wrapping it would register it at local scope,
    // where it runs with no approval gate — consent-widening. Must skip.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { command: 't', args: [] } } }),
    );
    writeClaudeJson({}); // no projects[cwd] record → projectApprovalKnown is false
    const code = await speculateOn(opts());
    expect(code).toBe(0);
    // The pending server was NOT registered at local scope.
    expect(readClaudeJson().projects?.[cwd]?.mcpServers?.team).toBeUndefined();
    expect(logs.join('\n')).toContain('not approved');
  });

  it('is idempotent: a second run changes nothing further', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts());
    const after1 = readClaudeJson();
    calls = [];
    await speculateOn(opts());
    expect(readClaudeJson()).toEqual(after1);
    // Only the availability probe ran — no add/remove.
    expect(calls.filter((c) => c[1] === 'add-json' || c[1] === 'remove')).toEqual([]);
  });

  it('passes http servers through untouched', async () => {
    writeClaudeJson({ mcpServers: { sentry: { url: 'https://mcp.sentry.dev', type: 'http' } } });
    await speculateOn(opts());
    expect(readClaudeJson().mcpServers.sentry).toEqual({
      url: 'https://mcp.sentry.dev',
      type: 'http',
    });
  });
});

describe('legacy artifact cleanup', () => {
  it('on removes a leftover speculate-workspace server', async () => {
    // A ≤0.10 install left the workspace server registered at local scope.
    writeClaudeJson({
      projects: {
        [cwd]: {
          mcpServers: {
            [WORKSPACE_SERVER_NAME]: { command: SELF.command, args: [...SELF.args, 'wrap', '--workspace', cwd] },
          },
        },
      },
    });
    const code = await speculateOn(opts());
    expect(code).toBe(0);
    expect(calls).toContainEqual(['claude', 'mcp', 'remove', WORKSPACE_SERVER_NAME, '-s', 'local']);
    expect(readClaudeJson().projects?.[cwd]?.mcpServers?.[WORKSPACE_SERVER_NAME]).toBeUndefined();
  });

  it('on uninstalls the legacy plugin when plugin list reports it', async () => {
    pluginSim = { installed: true, marketplace: true }; // ≤0.10 plugin still installed
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    const code = await speculateOn(opts());
    expect(code).toBe(0);
    expect(calls).toContainEqual(['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate']);
    expect(pluginSim.installed).toBe(false);
    expect(pluginSim.marketplace).toBe(false);
  });

  it('cleanup failures are logged, never fatal', async () => {
    pluginSim = { installed: true, marketplace: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    const failingRunner: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'uninstall') {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'boom' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOn({ ...opts(), runner: failingRunner });
    expect(code).toBe(0); // the unrelated github wrap still succeeded
    expect(logs.join('\n')).toContain('plugin uninstall failed');
    expect(readClaudeJson().mcpServers.github.command).toBe(SELF.command);
  });

  it('off with a ≤0.10 state file containing action:"plugin" still uninstalls', async () => {
    pluginSim = { installed: true, marketplace: true };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [{ name: 'speculate@speculate', scope: 'local', action: 'plugin' }],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const code = await speculateOff(opts());
    expect(code).toBe(0);
    expect(calls).toContainEqual(['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate']);
    expect(pluginSim.installed).toBe(false);
  });
});

describe('speculate off', () => {
  it('restores the exact original config (on → off round trip)', async () => {
    const original = {
      mcpServers: { github: { command: 'gh-server', args: ['stdio'], env: { T: '1' } } },
    };
    writeClaudeJson(original);
    await speculateOn(opts());
    const code = await speculateOff(opts());
    expect(code).toBe(0);

    const config = readClaudeJson();
    expect(config.mcpServers).toEqual(original.mcpServers);
    expect(config.projects?.[cwd]?.mcpServers ?? {}).toEqual({});
    // State record cleared.
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.projects[cwd]).toBeUndefined();
  });

  it('unwraps in place even with no state file (self-describing entries)', async () => {
    writeClaudeJson({
      mcpServers: {
        github: {
          command: SELF.command,
          args: [...SELF.args, 'wrap', '--', 'gh-server', 'stdio'],
          env: { T: '1' },
        },
      },
    });
    const code = await speculateOff(opts()); // statePath never written
    expect(code).toBe(0);
    expect(readClaudeJson().mcpServers.github).toEqual({
      command: 'gh-server',
      args: ['stdio'],
      env: { T: '1' },
    });
  });

  it('with no state file, removes a .mcp.json shadow instead of leaking a local copy', async () => {
    // A wrapped LOCAL entry shadowing a same-named .mcp.json (project) server.
    // Losing the state file must not turn the shadow into a permanent
    // unwrapped local copy — that would leak an approval-free server.
    const mcpJson = { mcpServers: { team: { command: 'team-server', args: [] } } };
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(mcpJson));
    writeClaudeJson({
      projects: {
        [cwd]: {
          mcpServers: {
            team: { command: SELF.command, args: [...SELF.args, 'wrap', '--', 'team-server'] },
          },
        },
      },
    });
    const code = await speculateOff(opts()); // statePath never written
    expect(code).toBe(0);
    // The local shadow is gone entirely — no unwrapped copy left behind.
    expect(readClaudeJson().projects[cwd].mcpServers?.team).toBeUndefined();
    // .mcp.json untouched; the project entry is back in effect.
    expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))).toEqual(mcpJson);
    expect(logs.join('\n')).toContain('shadow removed');
  });
});

describe('speculate status', () => {
  it('reports wrapped, unwrapped, and drift since on', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts());
    // A server added after `on` ran:
    const config = readClaudeJson();
    config.mcpServers.linear = { command: 'linear-server' };
    writeClaudeJson(config);

    logs = [];
    await speculateStatus(opts());
    const text = logs.join('\n');
    expect(text).toContain('github (user): wrapped (managed)');
    expect(text).toContain('linear (user): NOT wrapped');
    expect(text).toContain("run it again");
  });
});
