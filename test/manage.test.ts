/**
 * §13.12 `speculate on`/`off`/`status`: every mutation goes through the
 * host front door (`claude mcp …`). The fake runner below implements just
 * enough of `claude mcp add-json`/`remove` semantics against the fixture
 * config files to verify the full on → off round trip, including the
 * shadow-don't-touch rule for .mcp.json and the state-less unwrap net.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  effectiveServerHash,
  execFileRunner,
  resolveClaudeBin,
  speculateOff,
  speculateOn,
  speculateStatus,
  win32ShimInvocation,
  type CmdRunner,
} from '../src/manage.js';
import { isWindows } from './platform.js';
import { WORKSPACE_SERVER_NAME, type ClaudeConfigView, type ClaudeScope } from '../src/hostConfig.js';

const SELF = { command: '/usr/bin/node', args: ['/opt/speculate/dist/src/cli.js'] };

/** The version the shipped plugin manifest declares (see the version test). */
const PLUGIN_MANIFEST: Record<string, string> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url)),
    'utf8',
  ),
);

let home: string;
let cwd: string;
let statePath: string;
let calls: string[][];
let logs: string[];
/**
 * Simulated `claude plugin` state; null = plugin CLI unavailable (old host).
 * `autowrap` simulates the (separate, task-4) `speculate-autowrap` plugin
 * being installed globally — independent of the legacy `speculate` plugin
 * `installed`/`marketplace` already track.
 */
let pluginSim: { installed: boolean; marketplace: boolean; autowrap?: boolean } | null;
/**
 * Which of the two shapes `claude plugin list --json` is known to emit this
 * host uses: a list of records, or an object KEYED by plugin id whose values
 * don't repeat the id (so only the key names the plugin).
 */
let pluginListShape: 'array' | 'id-keyed';
/** Source path of the auto-wrap marketplace, once `on` has registered it. */
let autowrapMarketplace: string;
/**
 * What `claude plugin list --json` reports for an installed auto-wrap plugin.
 * A version or an installed hook command that no longer matches what this
 * Speculate would generate is what `on`'s repair path keys off.
 */
let autowrapInstall: { version: string; installPath?: string };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-mhome-'));
  cwd = mkdtempSync(join(tmpdir(), 'speculate-mproj-'));
  statePath = join(home, 'managed.json');
  calls = [];
  logs = [];
  pluginSim = null;
  pluginListShape = 'array';
  autowrapMarketplace = '';
  autowrapInstall = { version: PLUGIN_MANIFEST.version! };
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
      if (pluginListShape === 'id-keyed') {
        const keyed: AnyRecord = {};
        // Note the values do NOT repeat the id: the KEY is the only place
        // the plugin is named, which is the shape that regresses if a
        // matcher only ever looks at record objects.
        if (pluginSim.installed) keyed['speculate@speculate'] = { version: '0.10.0' };
        if (pluginSim.autowrap) {
          keyed['speculate-autowrap@speculate-mcp'] = { version: autowrapInstall.version };
        }
        return { code: 0, stdout: JSON.stringify(keyed), stderr: '' };
      }
      // The measured shape of a real `claude plugin list --json`: an array of
      // records whose only identifier is `id`, and it is `<plugin>@<market>`.
      const list: AnyRecord[] = [];
      if (pluginSim.installed) {
        list.push({ id: 'speculate@speculate', version: '0.10.0', scope: 'local' });
      }
      if (pluginSim.autowrap) {
        list.push({
          id: 'speculate-autowrap@speculate-mcp',
          version: autowrapInstall.version,
          scope: 'user',
          ...(autowrapInstall.installPath ? { installPath: autowrapInstall.installPath } : {}),
        });
      }
      return { code: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (args[1] === 'marketplace' && args[2] === 'list') {
      return {
        code: 0,
        stdout: JSON.stringify(pluginSim.marketplace ? [{ name: 'speculate' }] : []),
        stderr: '',
      };
    }
    if (args[1] === 'marketplace' && args[2] === 'add') {
      // The auto-wrap marketplace is added by PATH (a staged directory); the
      // ≤0.10 one was only ever added by the name `speculate`. They are
      // deliberately distinct registrations, so the sim tracks them apart.
      if (args[3] !== 'speculate') {
        autowrapMarketplace = args[3] ?? '';
        return { code: 0, stdout: 'Added marketplace speculate-mcp', stderr: '' };
      }
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
      const id = args[args.length - 1] ?? '';
      if (id.startsWith('speculate-autowrap')) {
        if (!autowrapMarketplace) return { code: 1, stdout: '', stderr: 'no such marketplace' };
        pluginSim.autowrap = true;
        // A real install copies the CURRENT staged plugin, so whatever made
        // the installed copy look stale is resolved by it.
        autowrapInstall = { version: PLUGIN_MANIFEST.version! };
        return { code: 0, stdout: 'Installed speculate-autowrap@speculate-mcp', stderr: '' };
      }
      if (!pluginSim.marketplace) return { code: 1, stdout: '', stderr: 'no such marketplace' };
      pluginSim.installed = true;
      return { code: 0, stdout: 'Installed speculate@speculate', stderr: '' };
    }
    if (args[1] === 'uninstall') {
      if ((args[args.length - 1] ?? '').startsWith('speculate-autowrap')) {
        pluginSim.autowrap = false;
        return { code: 0, stdout: 'Uninstalled', stderr: '' };
      }
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

  it('on uninstalls the legacy plugin when plugin list reports it, trying the qualified id first', async () => {
    pluginSim = { installed: true, marketplace: true }; // ≤0.10 plugin still installed
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    // ≤0.10's own `on` recorded that it added the marketplace registration
    // itself — only then is it safe for cleanup to remove it. That flag is
    // host-global, so 0.10 wrote it at the top level of the state file, not
    // per-project.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: { [cwd]: { entries: [], updatedAt: Date.now() } },
        marketplaceAddedByOn: true,
      }),
    );
    const code = await speculateOn(opts());
    expect(code).toBe(0);
    // 0.10's PLUGIN_ID was the fully-qualified id; try that first.
    expect(calls).toContainEqual(['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate@speculate']);
    expect(calls).toContainEqual(['claude', 'plugin', 'marketplace', 'remove', 'speculate']);
    expect(pluginSim.installed).toBe(false);
    expect(pluginSim.marketplace).toBe(false);
    // The ownership flag is consumed: a later run must not claim ownership of
    // a marketplace registration the user re-added by hand.
    expect(JSON.parse(readFileSync(statePath, 'utf8')).marketplaceAddedByOn).toBe(false);
  });

  it('on leaves the marketplace registration alone when no state recorded owning it', async () => {
    pluginSim = { installed: true, marketplace: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    // No state file at all (or none recording marketplaceAddedByOn): the
    // marketplace registration might belong to another project or the user
    // added it by hand — cleanup must not remove it.
    const code = await speculateOn(opts());
    expect(code).toBe(0);
    expect(pluginSim.installed).toBe(false); // plugin itself is always removed
    expect(pluginSim.marketplace).toBe(true); // but the marketplace is left alone
    // (`on` does add its OWN marketplace — what must never happen is a
    // REMOVAL of a ≤0.10 registration this project's state doesn't claim.)
    expect(
      calls.some((c) => c[1] === 'plugin' && c[2] === 'marketplace' && c[3] === 'remove'),
    ).toBe(false);
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
    // Detection fired in cleanupLegacyArtifacts, so off()'s own entry
    // handling must not attempt a redundant second uninstall. The qualified
    // id (0.10's own PLUGIN_ID) is tried first and succeeds here.
    const uninstallCalls = calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall');
    expect(uninstallCalls).toEqual([['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate@speculate']]);
    expect(pluginSim.installed).toBe(false);
  });

  it('off still attempts uninstall directly when legacy detection is unavailable, and fails loud', async () => {
    // pluginSim stays null: `claude plugin` doesn't exist on this host at
    // all, so cleanupLegacyArtifacts's detection can't confirm anything —
    // it must not cause a state-recorded plugin install to be silently
    // dropped. off() has to attempt the uninstall itself and, on failure,
    // log and count it, so the exit code reflects the failure.
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
    expect(code).toBe(1);
    // Both legacy ids are tried, in order, before giving up.
    const uninstallCalls = calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall');
    expect(uninstallCalls).toEqual([
      ['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate@speculate'],
      ['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate'],
    ]);
    expect(logs.join('\n')).toContain('uninstall failed');
    // The remediation string names the id that actually failed last.
    expect(logs.join('\n')).toContain('plugin uninstall -s local speculate');
  });

  it('detects a plugin identified only by id (speculate@speculate, no bare name field)', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    let installed = true;
    const idOnlyRunner: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        calls.push([cmd, ...args]);
        return {
          code: 0,
          stdout: JSON.stringify(installed ? [{ id: 'speculate@speculate' }] : []),
          stderr: '',
        };
      }
      if (args[0] === 'plugin' && args[1] === 'uninstall') {
        calls.push([cmd, ...args]);
        installed = false;
        return { code: 0, stdout: 'Uninstalled', stderr: '' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOn({ ...opts(), runner: idOnlyRunner });
    expect(code).toBe(0);
    expect(calls).toContainEqual(['claude', 'plugin', 'uninstall', '-s', 'local', 'speculate@speculate']);
    expect(installed).toBe(false);
  });

  it('off with a ≤0.10 state entry for the leftover workspace server exits clean, not spuriously failed', async () => {
    // A ≤0.10 state file recorded the workspace server as a plain wrapped
    // ("added") entry, and the host still has it registered. cleanupLegacyArtifacts
    // removes it from the HOST; off()'s own entry handling must recognize
    // that and not re-attempt (and fail) the same removal.
    writeClaudeJson({
      projects: {
        [cwd]: {
          mcpServers: {
            [WORKSPACE_SERVER_NAME]: { command: SELF.command, args: [...SELF.args, 'wrap', '--workspace', cwd] },
          },
        },
      },
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [{ name: WORKSPACE_SERVER_NAME, scope: 'local', action: 'added' }],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const code = await speculateOff(opts());
    expect(code).toBe(0);
    const removeCalls = calls.filter(
      (c) => c[1] === 'mcp' && c[2] === 'remove' && c[3] === WORKSPACE_SERVER_NAME,
    );
    expect(removeCalls).toEqual([['claude', 'mcp', 'remove', WORKSPACE_SERVER_NAME, '-s', 'local']]);
    expect(logs.join('\n')).not.toContain('failed');
  });

  it("off's own direct-removal attempt fires when cleanup's view never saw the workspace server, but the host still has it", async () => {
    // The legacy state record survives (as in the ≤0.10 upgrade case above),
    // but this time cleanupLegacyArtifacts's own view of the host — built by
    // parsing .claude.json — never included speculate-workspace at all (a
    // stale/partial read, or a host quirk our parsing doesn't recognize), so
    // its own removal is never attempted (workspaceServerRemovalAttempted
    // stays false). The host itself, simulated here independently of that
    // file, still has the server. This is off()'s own per-entry fallback —
    // "cleanup never saw it in the host view" — which must attempt the
    // removal directly rather than silently doing nothing.
    writeClaudeJson({}); // no speculate-workspace entry visible to our parsing
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [{ name: WORKSPACE_SERVER_NAME, scope: 'local', action: 'added' }],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const hostStillHasIt: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === WORKSPACE_SERVER_NAME) {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: `Removed ${WORKSPACE_SERVER_NAME}`, stderr: '' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOff({ ...opts(), runner: hostStillHasIt });
    expect(code).toBe(0);
    // Exactly one removal attempt: cleanupLegacyArtifacts's own workspace
    // check (based on its view) never fired, so off()'s per-entry direct
    // attempt is the only one — not a redundant double-removal.
    const removeCalls = calls.filter(
      (c) => c[1] === 'mcp' && c[2] === 'remove' && c[3] === WORKSPACE_SERVER_NAME,
    );
    expect(removeCalls).toEqual([['claude', 'mcp', 'remove', WORKSPACE_SERVER_NAME, '-s', 'local']]);
    expect(logs.join('\n')).toContain(`${WORKSPACE_SERVER_NAME}: removed`);
    expect(logs.join('\n')).not.toContain('failed');
  });

  it('off\'s direct-removal attempt classifies "no such server" as success, not failure', async () => {
    // Same unreachable-from-cleanup setup as above, but the host reports the
    // server is already gone by the time off() attempts it directly (a race
    // with a prior/parallel cleanup, or simply already removed by hand).
    // That must be classified as success — the load-bearing
    // /no\s+(mcp\s+)?server/i check.
    writeClaudeJson({});
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [{ name: WORKSPACE_SERVER_NAME, scope: 'local', action: 'added' }],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const alreadyGone: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === WORKSPACE_SERVER_NAME) {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'No MCP server found named speculate-workspace' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOff({ ...opts(), runner: alreadyGone });
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('failed');
    expect(logs.join('\n')).not.toContain(`${WORKSPACE_SERVER_NAME}: removed`);
    expect(logs.join('\n')).toContain('off: done.');
  });

  it("off's direct-removal attempt still fails loud on an unrelated removal error", async () => {
    // Same setup again, but this time the direct removal fails for a reason
    // that has nothing to do with "already gone" — must be counted and
    // reported honestly, not swallowed by the success-classification regex.
    writeClaudeJson({});
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [{ name: WORKSPACE_SERVER_NAME, scope: 'local', action: 'added' }],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const unrelatedFailure: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === WORKSPACE_SERVER_NAME) {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOff({ ...opts(), runner: unrelatedFailure });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain(`${WORKSPACE_SERVER_NAME}: remove failed: permission denied`);
    expect(logs.join('\n')).toContain('off: done (1 failure(s))');
  });

  it('on strips ≤0.10 legacy entries once cleanup has actually removed them', async () => {
    // A ≤0.10 managed.json carried a leftover workspace-server entry and a
    // plugin entry. Once cleanupLegacyArtifacts has really removed them from
    // the HOST, `on` must not write these back: doing so would make a later
    // `off` chase artifacts already gone, producing spurious "remove
    // failed"/"uninstall failed" lines and a wrong exit code. (The workspace
    // server is absent from the host view here — already clean — and the
    // plugin uninstall below succeeds.)
    pluginSim = { installed: true, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [
              { name: WORKSPACE_SERVER_NAME, scope: 'local', action: 'added' },
              { name: 'speculate@speculate', scope: 'local', action: 'plugin' },
            ],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const onCode = await speculateOn(opts());
    expect(onCode).toBe(0);
    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    const names = written.projects[cwd].entries.map((e: AnyRecord) => e.name);
    expect(names).not.toContain(WORKSPACE_SERVER_NAME);
    expect(written.projects[cwd].entries.some((e: AnyRecord) => e.action === 'plugin')).toBe(false);
    expect(names).toContain('github');

    // off() against the now-pruned state must also exit clean.
    logs = [];
    const offCode = await speculateOff(opts());
    expect(offCode).toBe(0);
    expect(logs.join('\n')).not.toContain('failed');
  });

  it('on KEEPS a ≤0.10 plugin record when detection never confirmed an uninstall', async () => {
    // The plugin IS installed, but this host's `plugin list --json` errors,
    // so cleanup's detection misses and no uninstall is attempted. Pruning
    // the record here would destroy off()'s recorded-install safety net and
    // strand the retired Bash hook forever.
    pluginSim = { installed: true, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
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
    const listFails: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'unknown option --json' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOn({ ...opts(), runner: listFails });
    expect(code).toBe(0);
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall')).toEqual([]);
    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(written.projects[cwd].entries.some((e: AnyRecord) => e.action === 'plugin')).toBe(true);

    // …and because the record survived, off()'s direct-attempt fallback is
    // still reachable: the stranded plugin does get uninstalled.
    const offCode = await speculateOff({ ...opts(), runner: listFails });
    expect(offCode).toBe(0);
    expect(calls.some((c) => c[1] === 'plugin' && c[2] === 'uninstall')).toBe(true);
    expect(pluginSim.installed).toBe(false);
  });

  it('on KEEPS a ≤0.10 workspace-server record when the host removal failed', async () => {
    writeClaudeJson({
      projects: {
        [cwd]: {
          mcpServers: {
            [WORKSPACE_SERVER_NAME]: { command: SELF.command, args: [...SELF.args, 'wrap', '--workspace', cwd] },
          },
        },
      },
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {
          [cwd]: {
            entries: [{ name: WORKSPACE_SERVER_NAME, scope: 'local', action: 'added' }],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const removeFails: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === WORKSPACE_SERVER_NAME) {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      return fakeRunner(cmd, args, o);
    };
    const code = await speculateOn({ ...opts(), runner: removeFails });
    expect(code).toBe(0); // legacy cleanup failures are logged, never fatal
    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(written.projects[cwd].entries.map((e: AnyRecord) => e.name)).toContain(
      WORKSPACE_SERVER_NAME,
    );
  });

  it('does not mistake an unrelated plugin for the retired one', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    const otherPlugins: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin') {
        calls.push([cmd, ...args]);
        if (args[1] === 'list') {
          return {
            code: 0,
            stdout: JSON.stringify([
              { name: 'speculate-tools', marketplace: 'acme' },
              { id: 'my-speculate@corp', name: 'my-speculate' },
            ]),
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      return fakeRunner(cmd, args, o);
    };
    expect(await speculateOn({ ...opts(), runner: otherPlugins })).toBe(0);
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall')).toEqual([]);
    logs = [];
    expect(await speculateStatus({ ...opts(), runner: otherPlugins })).toBe(0);
    expect(logs.join('\n')).not.toContain('legacy plugin installed');
  });

  it('falls back to the bare plugin id only when a ≤0.10 record says we installed it', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    let installed = true;
    // A host that rejects the qualified id but accepts the bare one — the
    // only scenario LEGACY_PLUGIN_IDS' fallback exists for.
    const qualifiedFails: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        calls.push([cmd, ...args]);
        return {
          code: 0,
          stdout: JSON.stringify(installed ? [{ id: 'speculate@speculate' }] : []),
          stderr: '',
        };
      }
      if (args[0] === 'plugin' && args[1] === 'uninstall') {
        calls.push([cmd, ...args]);
        if (args[4] === 'speculate@speculate') return { code: 1, stdout: '', stderr: 'no such plugin' };
        installed = false;
        return { code: 0, stdout: 'Uninstalled', stderr: '' };
      }
      return fakeRunner(cmd, args, o);
    };
    // No record: the bare id can name someone else's plugin — never guessed.
    expect(await speculateOn({ ...opts(), runner: qualifiedFails })).toBe(0);
    expect(
      calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall').map((c) => c[5]),
    ).toEqual(['speculate@speculate']);
    expect(installed).toBe(true);

    // With a ≤0.10 record the fallback is ours to make — and it succeeds.
    calls = [];
    logs = [];
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
    expect(await speculateOff({ ...opts(), runner: qualifiedFails })).toBe(0);
    expect(
      calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall').map((c) => c[5]),
    ).toEqual(['speculate@speculate', 'speculate']);
    expect(installed).toBe(false);
    expect(logs.join('\n')).toContain('uninstalled the speculate plugin');
    expect(logs.join('\n')).not.toContain('uninstall failed');
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

  it('restores BOTH scopes when the same name is wrapped at user and local scope', async () => {
    // `on` wraps user-scope `gh`; the user later adds a local-scope override
    // (which now wins) and re-runs `on`. State is keyed by scope+name, so the
    // user-scope record is not overwritten — and one `off` restores both.
    writeClaudeJson({ mcpServers: { gh: { command: 'gh-user', args: ['stdio'] } } });
    expect(await speculateOn(opts())).toBe(0);
    const config = readClaudeJson();
    config.projects = { [cwd]: { mcpServers: { gh: { command: 'gh-local', args: [] } } } };
    writeClaudeJson(config);
    expect(await speculateOn(opts())).toBe(0);

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(
      state.projects[cwd].entries.map((e: AnyRecord) => `${e.scope}:${e.name}`).sort(),
    ).toEqual(['local:gh', 'user:gh']);

    logs = [];
    expect(await speculateOff(opts())).toBe(0);
    const after = readClaudeJson();
    expect(after.mcpServers.gh).toEqual({ command: 'gh-user', args: ['stdio'] });
    expect(after.projects[cwd].mcpServers.gh).toEqual({ command: 'gh-local', args: [] });
    expect(logs.join('\n')).not.toContain('failed');
  });

  it("never passes a dash-leading server name to 'claude mcp' in the no-state fallback", async () => {
    // A hand-written user-scope entry named '--help' that happens to look
    // wrapped: passing it positionally would let the host parse it as a flag.
    writeClaudeJson({
      mcpServers: {
        '--help': { command: SELF.command, args: [...SELF.args, 'wrap', '--', 'evil-server'] },
      },
    });
    const code = await speculateOff(opts()); // no state file at all
    expect(code).toBe(0);
    expect(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove' && c[3] === '--help')).toBe(false);
    expect(logs.join('\n')).toContain("--help: skipped (name starts with '-')");
    expect(readClaudeJson().mcpServers['--help']).toBeDefined();
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

  it('off records a sync opt-out for this project', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts());
    logs = [];
    const code = await speculateOff(opts());
    expect(code).toBe(0);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.syncOptOut).toEqual({ [cwd]: true });
    // No auto-wrap plugin is installed in this test — the "still installed
    // globally" message must not fire.
    expect(logs.join('\n')).not.toContain('auto-wrap is still installed globally');
  });

  it('on clears the sync opt-out for this project', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: {},
        // A prior `off` opted this project out; an unrelated project's
        // opt-out is also present and must survive untouched.
        syncOptOut: { [cwd]: true, '/some/other/project': true },
      }),
    );
    const code = await speculateOn(opts());
    expect(code).toBe(0);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.syncOptOut[cwd]).toBeUndefined();
    expect(state.syncOptOut['/some/other/project']).toBe(true);
  });

  it('detects both plugins from an id-keyed list whose values omit the id', async () => {
    // The other shape hosts emit: only the KEY names the plugin. Both
    // detectors read the same shared list, so both must handle it.
    pluginListShape = 'id-keyed';
    pluginSim = { installed: true, marketplace: false, autowrap: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });

    await speculateOff(opts());
    expect(calls.some((c) => c[1] === 'plugin' && c[2] === 'uninstall')).toBe(true);
    expect(logs.join('\n')).toContain('uninstalled the speculate plugin');
    expect(logs.join('\n')).toContain('auto-wrap is still installed globally');
  });

  it('asks the host for the plugin list exactly once per run', async () => {
    // Legacy detection and auto-wrap detection both read `plugin list
    // --json`; off used to spawn it twice for the same answer. Nothing is
    // uninstalled here, so the memoized fetch serves both.
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOff(opts());
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'list')).toHaveLength(1);
    expect(logs.join('\n')).toContain('auto-wrap is still installed globally');
  });

  it('re-reads the plugin list after an uninstall makes it stale', async () => {
    // The memo is dropped by whatever CHANGES the installed set, so no
    // detector can ever read a pre-uninstall answer — the correctness of
    // sharing one fetch doesn't rest on which ids each detector matches.
    pluginSim = { installed: true, marketplace: false, autowrap: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOff(opts());
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'list')).toHaveLength(2);
    expect(logs.join('\n')).toContain('auto-wrap is still installed globally');
  });

  it('off says auto-wrap is still active globally when the plugin is installed', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts());
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    logs = [];
    const code = await speculateOff(opts());
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('auto-wrap');
    expect(logs.join('\n')).toContain('claude plugin uninstall');
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

  it('flags a leftover ≤0.10 speculate-workspace server as legacy, not healthy', async () => {
    writeClaudeJson({
      projects: {
        [cwd]: {
          mcpServers: {
            [WORKSPACE_SERVER_NAME]: { command: SELF.command, args: [...SELF.args, 'wrap', '--workspace', cwd] },
          },
        },
      },
    });
    const code = await speculateStatus(opts());
    expect(code).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain(
      `${WORKSPACE_SERVER_NAME} (local): legacy CLI-speculation server (retired in 0.11)`,
    );
    expect(text).toContain("run 'speculate on' to remove");
    expect(text).not.toContain('wrapped (managed)');
  });

  it('flags a leftover ≤0.10 plugin install, whose Bash hook now breaks git commands', async () => {
    pluginSim = { installed: true, marketplace: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    const code = await speculateStatus(opts());
    expect(code).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('legacy plugin installed');
    expect(text).toContain("breaks 'git ...' commands");
    expect(text).toContain("run 'speculate on' to remove");
    // The plugin is still there, so this is not the stranded-marketplace case.
    expect(text).not.toContain('legacy marketplace');
  });

  it('reports a stranded ≤0.10 marketplace registration once the plugin is gone', async () => {
    // 0.11 deleted the marketplace manifest this registration resolves, and
    // cleanup only removes registrations our own ≤0.10 state claims to own —
    // so the honest move for everyone else is to name it and the fix.
    pluginSim = { installed: false, marketplace: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    const code = await speculateStatus(opts());
    expect(code).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain(
      "legacy marketplace 'speculate' registered (its source was removed in 0.11)",
    );
    expect(text).toContain('remove with: claude plugin marketplace remove speculate');
  });

  it('says nothing about the marketplace when none is registered', async () => {
    pluginSim = { installed: false, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateStatus(opts())).toBe(0);
    expect(logs.join('\n')).not.toContain('legacy marketplace');
  });
});

describe('the auto-wrap plugin', () => {
  /** Where `on` stages the plugin it hands `claude plugin marketplace add`. */
  const stagedRoot = (): string => join(home, 'autowrap');
  const stagedHooks = (): AnyRecord =>
    JSON.parse(readFileSync(join(stagedRoot(), 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  const hookEntry = (hooks: AnyRecord): AnyRecord => hooks.hooks.SessionStart[0].hooks[0];

  /** Run the shipped hook wrapper directly, exactly as the host would. */
  function runWrapper(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const wrapper = fileURLToPath(new URL('../plugin/hooks/autowrap.mjs', import.meta.url));
    return new Promise((res) => {
      execFile(
        process.execPath,
        [wrapper, ...args],
        { env: { ...process.env, ...env } },
        (err, stdout, stderr) => {
          const anyErr = err as (Error & { code?: number | string }) | null;
          res({ code: typeof anyErr?.code === 'number' ? anyErr.code : 0, stdout, stderr });
        },
      );
    });
  }

  it('on installs the auto-wrap plugin at user scope', async () => {
    pluginSim = { installed: false, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    expect(calls).toContainEqual([
      'claude',
      'plugin',
      'install',
      '-s',
      'user',
      'speculate-autowrap',
    ]);
    expect(pluginSim.autowrap).toBe(true);
    expect(logs.join('\n')).toContain('auto-wrap: installed');
  });

  it('running on twice leaves the auto-wrap plugin installed (self-uninstall guard)', async () => {
    pluginSim = { installed: false, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts());
    expect(pluginSim.autowrap).toBe(true);
    calls = [];
    logs = [];
    expect(await speculateOn(opts())).toBe(0);
    expect(pluginSim.autowrap).toBe(true);
    // Nothing may uninstall it — least of all the run that just installed it.
    expect(calls.filter((c) => c[2] === 'uninstall')).toEqual([]);
    // Already installed: no marketplace/install churn on the second run.
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'install')).toEqual([]);
  });

  it('legacy cleanup never matches the auto-wrap plugin', async () => {
    // The host reports ONLY `speculate-autowrap`. A cleanup matcher that
    // matched on a substring of 'speculate' would uninstall it here.
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall')).toEqual([]);
    expect(pluginSim.autowrap).toBe(true);
    logs = [];
    expect(await speculateStatus(opts())).toBe(0);
    expect(logs.join('\n')).not.toContain('legacy plugin installed');
  });

  it('detects the plugin from the qualified id the host really reports', async () => {
    // Measured shape of `claude plugin list --json`: an array of records whose
    // only identifier is `id`, and it is `<plugin>@<marketplace>` — a bare
    // `name` field is never emitted.
    const qualified: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        calls.push([cmd, ...args]);
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: 'speculate-autowrap@speculate-mcp',
              version: PLUGIN_MANIFEST.version,
              scope: 'user',
            },
          ]),
          stderr: '',
        };
      }
      return fakeRunner(cmd, args, o);
    };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn({ ...opts(), runner: qualified })).toBe(0);
    // Already installed: nothing installed again, and never an uninstall.
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'install')).toEqual([]);
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall')).toEqual([]);
    logs = [];
    await speculateStatus({ ...opts(), runner: qualified });
    expect(logs.join('\n')).toContain('auto-wrap: installed');
  });

  it('status reports auto-wrap when installed', async () => {
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateStatus(opts())).toBe(0);
    expect(logs.join('\n')).toContain(
      'auto-wrap: installed (new servers wrap at the next session start)',
    );
  });

  it('an install failure is logged once and never fails on', async () => {
    pluginSim = { installed: false, marketplace: false };
    const installFails: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'install') {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'marketplace unreachable' };
      }
      return fakeRunner(cmd, args, o);
    };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn({ ...opts(), runner: installFails })).toBe(0);
    expect(logs.filter((l) => l.includes('auto-wrap'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('marketplace unreachable');
    // The wrap itself still happened.
    expect(readClaudeJson().mcpServers.github.command).toBe(SELF.command);
  });

  it('the generated hook command is absolute and never a bare speculate', async () => {
    pluginSim = { installed: false, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts());
    const entry = hookEntry(stagedHooks());
    expect(entry.type).toBe('command');
    // `node` by NAME, resolved on PATH: node/node.exe is a real executable
    // (never a .cmd shim), and a baked interpreter path would break for good
    // the first time an nvm/fnm/volta user switched Node versions.
    expect(entry.command.startsWith('node ')).toBe(true);
    expect(entry.command).not.toContain(SELF.command);
    expect(entry.command).toContain(SELF.args[0]); // absolute cli entry
    // Never the npm shim: Claude Code cannot exec a .cmd hook on Windows.
    expect(entry.command).not.toMatch(/^speculate\b/);
    expect(entry.command).not.toMatch(/(^|["\s])speculate(\.cmd|\.bat)?(["\s]|$)/);
    // The wrapper is addressed through the host's own expansion for the
    // INSTALLED copy — a path into the npm package is the one that vanishes.
    expect(entry.command).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/autowrap.mjs');
    // Must outlast sync's own last-resort 60s exit, or the host kills a wrap
    // mid-flight and reopens the window the cooperative deadline closed.
    expect(entry.timeout).toBeGreaterThanOrEqual(60);
    expect(stagedHooks().hooks.SessionStart[0].matcher).toBe('startup');
    // The staged tree is what the host was pointed at, and it carries the
    // wrapper (the package dir may be root-owned or read-only).
    expect(calls).toContainEqual(['claude', 'plugin', 'marketplace', 'add', stagedRoot()]);
    expect(existsSync(join(stagedRoot(), 'plugin', 'hooks', 'autowrap.mjs'))).toBe(true);
    expect(existsSync(join(stagedRoot(), '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(stagedRoot(), 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('the hook wrapper exits 0 when the CLI path no longer exists', async () => {
    // `claude plugin install` COPIES the plugin, so it survives an `npm
    // uninstall` of Speculate. Erroring here would break every session start
    // from then on, forever.
    const res = await runWrapper([], { SPECULATE_CLI: join(home, 'gone', 'cli.js') });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('the hook wrapper exits 0 with no baked CLI path at all', async () => {
    const res = await runWrapper([], { SPECULATE_CLI: '' });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it("the hook wrapper surfaces sync's summary as a systemMessage, and nothing else", async () => {
    // On exit 0 a hook's stderr is invisible to the user, and for SessionStart
    // plain stdout is injected into the MODEL's context. `systemMessage` is
    // the documented channel for a line the user should actually see.
    const fakeCli = join(home, 'fake-cli.mjs');
    writeFileSync(
      fakeCli,
      "process.stderr.write('[speculate] wrapped 1 new server (github); speculation active next session\\n');\n",
    );
    const withSummary = await runWrapper([fakeCli]);
    expect(withSummary.code).toBe(0);
    expect(withSummary.stderr).toBe('');
    expect(JSON.parse(withSummary.stdout)).toEqual({
      systemMessage: '[speculate] wrapped 1 new server (github); speculation active next session',
    });

    // The common case — sync says nothing — must print nothing at all.
    writeFileSync(join(home, 'quiet-cli.mjs'), '\n');
    const quiet = await runWrapper([join(home, 'quiet-cli.mjs')]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe('');
    expect(quiet.stderr).toBe('');
  });

  it('the hook wrapper exits 0 when the CLI itself fails', async () => {
    const angryCli = join(home, 'angry-cli.mjs');
    writeFileSync(angryCli, 'process.exit(3);\n');
    const res = await runWrapper([angryCli]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('the hook wrapper says nothing when the CLI writes to stderr and then fails', async () => {
    // A corrupt install, a missing dependency, a stack trace: forwarding that
    // last stderr line would put a failure in front of the user at EVERY
    // session start, which is exactly what a broken install must never do.
    const brokenCli = join(home, 'broken-cli.mjs');
    writeFileSync(
      brokenCli,
      "process.stderr.write('Error: Cannot find module\\n    at ModuleJob.run\\n');\nprocess.exit(1);\n",
    );
    const res = await runWrapper([brokenCli]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it("the hook wrapper ignores stderr that isn't Speculate's own summary", async () => {
    // Node warnings and tsx notices land on the child's stderr too, and often
    // AFTER the summary — so the line is chosen by prefix, not by position.
    const noisyCli = join(home, 'noisy-cli.mjs');
    writeFileSync(
      noisyCli,
      "process.stderr.write('(node:1) ExperimentalWarning: something\\n');\n" +
        "process.stderr.write('[speculate] wrapped 1 new server (github); speculation active next session\\n');\n" +
        "process.stderr.write('(node:1) [DEP0040] DeprecationWarning: punycode\\n');\n",
    );
    const res = await runWrapper([noisyCli]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      systemMessage: '[speculate] wrapped 1 new server (github); speculation active next session',
    });

    const warningsOnly = join(home, 'warnings-cli.mjs');
    writeFileSync(warningsOnly, "process.stderr.write('(node:1) ExperimentalWarning: x\\n');\n");
    const quiet = await runWrapper([warningsOnly]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe('');
  });

  it('on reinstalls when the installed plugin version is behind the shipped one', async () => {
    // `claude plugin install` caches per version, so without this no plugin
    // change ever reaches someone who already has it installed.
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    autowrapInstall = { version: '0.0.1-old' };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    expect(calls).toContainEqual([
      'claude',
      'plugin',
      'install',
      '-s',
      'user',
      'speculate-autowrap',
    ]);
    expect(autowrapInstall.version).toBe(PLUGIN_MANIFEST.version);
    expect(logs.join('\n')).toContain('auto-wrap: refreshed');
  });

  it('on repairs an installed hook command that no longer matches this install', async () => {
    // The nvm/fnm case: the interpreter or the CLI path baked into the
    // installed copy no longer describes this Speculate.
    const installPath = join(home, 'installed-plugin');
    mkdirSync(join(installPath, 'hooks'), { recursive: true });
    writeFileSync(
      join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [
                {
                  type: 'command',
                  command: '"/old/node" "${CLAUDE_PLUGIN_ROOT}/hooks/autowrap.mjs" "/gone/cli.js"',
                  timeout: 90,
                },
              ],
            },
          ],
        },
      }),
    );
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    autowrapInstall = { version: PLUGIN_MANIFEST.version!, installPath };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    // Measured against the real host: with the plugin already installed,
    // `plugin install` no-ops and does NOT re-copy — only an uninstall first
    // replaces the stale copy, so the repair is uninstall THEN install.
    const pluginCalls = calls
      .filter((c) => c[1] === 'plugin' && (c[2] === 'install' || c[2] === 'uninstall'))
      .map((c) => [c[2], c[5]]);
    expect(pluginCalls).toEqual([
      ['uninstall', 'speculate-autowrap'],
      ['install', 'speculate-autowrap'],
    ]);
    expect(pluginSim!.autowrap).toBe(true); // and it ends up installed again
    expect(logs.join('\n')).toContain('auto-wrap: refreshed');
  });

  it('a failed refresh uninstall never leaves on claiming success', async () => {
    const installPath = join(home, 'installed-plugin');
    mkdirSync(join(installPath, 'hooks'), { recursive: true });
    writeFileSync(
      join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /gone.mjs' }] }] },
      }),
    );
    pluginSim = { installed: false, marketplace: false, autowrap: true };
    autowrapInstall = { version: PLUGIN_MANIFEST.version!, installPath };
    const uninstallFails: CmdRunner = async (cmd, args, o) => {
      if (args[0] === 'plugin' && args[1] === 'uninstall') {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      return fakeRunner(cmd, args, o);
    };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn({ ...opts(), runner: uninstallFails })).toBe(0);
    // No install is attempted on top of a failed uninstall, and the user is
    // told exactly what to run.
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'install')).toEqual([]);
    expect(logs.join('\n')).toContain('could not refresh');
    expect(logs.join('\n')).toContain('plugin uninstall -s user speculate-autowrap');
  });

  it('on leaves a matching install alone (no reinstall churn)', async () => {
    const installPath = join(home, 'installed-plugin');
    mkdirSync(join(installPath, 'hooks'), { recursive: true });
    pluginSim = { installed: false, marketplace: false };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    await speculateOn(opts()); // first run installs and stages
    // Pretend the host's copy is exactly what `on` just staged.
    copyFileSync(
      join(stagedRoot(), 'plugin', 'hooks', 'hooks.json'),
      join(installPath, 'hooks', 'hooks.json'),
    );
    autowrapInstall = { version: PLUGIN_MANIFEST.version!, installPath };
    calls = [];
    logs = [];
    expect(await speculateOn(opts())).toBe(0);
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'install')).toEqual([]);
    expect(logs.join('\n')).toContain('auto-wrap: already installed');
  });

  it('cleans up the legacy plugin while the auto-wrap plugin is installed', async () => {
    // The exact combination the self-uninstall guard exists for: both plugins
    // present in one `plugin list` payload, one of them ours to remove.
    pluginSim = { installed: true, marketplace: false, autowrap: true };
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    expect(calls.filter((c) => c[1] === 'plugin' && c[2] === 'uninstall').map((c) => c[5])).toEqual([
      'speculate@speculate',
    ]);
    expect(pluginSim.installed).toBe(false); // the retired plugin is gone
    expect(pluginSim.autowrap).toBe(true); // ours survived
    expect(logs.join('\n')).toContain('uninstalled the speculate plugin');
    expect(logs.join('\n')).toContain('auto-wrap: already installed');
  });

  it("the plugin manifest's version tracks the package version", () => {
    // `claude plugin install` caches per version: a plugin change shipped
    // without a version bump never reaches anyone who already installed it.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    expect(PLUGIN_MANIFEST.version).toBe(pkg.version);
  });

  it('the shipped hooks.json is inert until on bakes a CLI path into it', async () => {
    // Someone can install the plugin straight from the marketplace. Whatever
    // ships must not fail a session start on its own.
    const shipped = JSON.parse(
      readFileSync(fileURLToPath(new URL('../plugin/hooks/hooks.json', import.meta.url)), 'utf8'),
    );
    const entry = hookEntry(shipped);
    expect(entry.command).not.toMatch(/(^|["\s])speculate(\.cmd|\.bat)?(["\s]|$)/);
    expect(entry.command).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/autowrap.mjs');
    expect(entry.timeout).toBeGreaterThanOrEqual(60);
  });
});

describe('execFileRunner against a real Windows .cmd shim', () => {
  /**
   * Runs `fn` against a real `%*`-forwarding batch shim — the shape npm
   * installs for Claude Code. Node refuses to spawn a .cmd directly (EINVAL
   * since CVE-2024-27980), so the runner goes through cmd.exe, and the JSON
   * `mcp add-json` payload must survive that hop byte-for-byte.
   */
  function withShim(
    fn: (shim: string, dir: string) => Promise<void>,
  ): () => Promise<void> {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'speculate-shim-'));
      try {
        writeFileSync(
          join(dir, 'echo-args.mjs'),
          'console.log(JSON.stringify(process.argv.slice(2)));\n',
        );
        writeFileSync(
          join(dir, 'claude.cmd'),
          `@echo off\r\n"${process.execPath}" "%~dp0echo-args.mjs" %*\r\n`,
        );
        await fn(join(dir, 'claude.cmd'), dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it.skipIf(!isWindows)(
    'runs the shim and round-trips argv verbatim',
    withShim(async (shim, dir) => {
      const payload = JSON.stringify({
        command: 'gh server',
        args: ['stdio', 'a&b', 'c|d', 'e>f', '(g)'],
        env: { T: '1' },
      });
      const args = ['mcp', 'add-json', 'github', payload, '-s', 'user'];
      const res = await execFileRunner(shim, args, { cwd: dir });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual(args);
    }),
  );

  it.skipIf(!isWindows)(
    'carries %VAR% through literally — no expansion, no injection',
    withShim(async (shim, dir) => {
      // Windows MCP entries idiomatically hold %APPDATA%/%USERPROFILE%.
      // Expanding one here would bake the expansion into the wrapped entry,
      // so `off`'s exact restore would hand back a mangled original — and a
      // variable whose VALUE is cmd syntax would execute (verified below).
      process.env['SPECULATE_TEST_EVIL'] = '& echo PWNED > pwned.txt & rem ';
      try {
        const payload = JSON.stringify({
          command: 'gh',
          args: ['%APPDATA%\\server.js', 'C:\\x\\%APPDATA%\\y'],
          env: { HOME: '%USERPROFILE%', E: '%SPECULATE_TEST_EVIL%' },
        });
        const args = ['mcp', 'add-json', 'github', payload, '-s', 'user'];
        const res = await execFileRunner(shim, args, { cwd: dir });
        expect(res.code).toBe(0);
        // Byte-identical: nothing expanded, and the JSON is not truncated.
        expect(JSON.parse(res.stdout)).toEqual(args);
        // The injected `& echo … > pwned.txt` never ran.
        expect(existsSync(join(dir, 'pwned.txt'))).toBe(false);
      } finally {
        delete process.env['SPECULATE_TEST_EVIL'];
      }
    }),
  );

  it.skipIf(!isWindows)(
    'carries literal percents (100%, %%, bare) through unchanged',
    withShim(async (shim, dir) => {
      const args = ['mcp', 'add-json', 'p', '100%', '%%', '%', 'a\\%b', '50%off'];
      const res = await execFileRunner(shim, args, { cwd: dir });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual(args);
    }),
  );

  // Platform-independent: the escaping itself, so a non-Windows CI still
  // guards it. `%` cannot be protected with a bare `^` where it sits — a
  // caret INSIDE quotes is a literal caret (cmd only consumes carets outside
  // quotes), so the percent has to step out of the quotes to be escaped.
  it('escapes % by stepping outside the quotes, twice (once per cmd parse)', () => {
    const { args } = win32ShimInvocation('C:\\bin\\claude.cmd', ['%APPDATA%']);
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toBe('""C:\\bin\\claude.cmd" ""^^^%"APPDATA"^^^%"""');
    // A backslash run immediately before an inserted quote is doubled, or the
    // child's CommandLineToArgvW would read it as an escaped quote and eat it:
    // C:\x\%APPDATA% must not arrive as C:\x"%APPDATA%.
    const path = win32ShimInvocation('c.cmd', ['C:\\x\\%A%']);
    expect(path.args[3]).toBe('""c.cmd" "C:\\x\\\\"^^^%"A"^^^%"""');
  });
});

describe('resolveClaudeBin', () => {
  it('resolves a bare name against PATH × PATHEXT on win32, preferring .exe', () => {
    const binDir = join(home, 'bin1');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\n');
    // npm-installed Claude Code is a .cmd shim: execFile/spawn never find it.
    expect(resolveClaudeBin('claude', { platform: 'win32', pathEnv: binDir })).toBe(
      join(binDir, 'claude.cmd'),
    );
    writeFileSync(join(binDir, 'claude.exe'), '');
    expect(resolveClaudeBin('claude', { platform: 'win32', pathEnv: binDir })).toBe(
      join(binDir, 'claude.exe'),
    );
  });

  it('honors PATH order across directories', () => {
    const first = join(home, 'first');
    const second = join(home, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'claude.exe'), '');
    expect(resolveClaudeBin('claude', { platform: 'win32', pathEnv: [first, second].join(';') })).toBe(
      join(second, 'claude.exe'),
    );
    writeFileSync(join(first, 'claude.cmd'), '@echo off\r\n');
    expect(resolveClaudeBin('claude', { platform: 'win32', pathEnv: [first, second].join(';') })).toBe(
      join(first, 'claude.cmd'),
    );
  });

  it('fails soft: unchanged off win32, when nothing matches, or when already a path', () => {
    const binDir = join(home, 'bin2');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\n');
    expect(resolveClaudeBin('claude', { platform: 'darwin', pathEnv: binDir })).toBe('claude');
    expect(resolveClaudeBin('claude', { platform: 'win32', pathEnv: join(home, 'nope') })).toBe(
      'claude',
    );
    expect(resolveClaudeBin('claude', { platform: 'win32', pathEnv: '' })).toBe('claude');
    expect(
      resolveClaudeBin('C:\\tools\\claude.cmd', { platform: 'win32', pathEnv: binDir }),
    ).toBe('C:\\tools\\claude.cmd');
    expect(resolveClaudeBin('./claude', { platform: 'win32', pathEnv: binDir })).toBe('./claude');
  });
});

describe('effectiveServerHash', () => {
  /**
   * Minimal real ClaudeConfigView. Each server's own field order is
   * whatever the caller wrote in its object literal (JS preserves own-key
   * insertion order), which is exactly what the field-order tests below
   * exploit — no need to bypass this helper to get an oddly-ordered entry.
   */
  function fakeView(
    servers: Record<
      string,
      { command: string; args: string[]; env?: Record<string, string>; scope?: ClaudeScope }
    >,
  ): ClaudeConfigView {
    return {
      servers: Object.entries(servers).map(([name, { scope, ...entry }]) => ({
        name,
        scope: scope ?? 'user',
        entry,
      })),
      approvedProjectServers: new Set(),
      projectApprovalKnown: false,
      warnings: [],
    };
  }

  it('is stable across calls for identical input', () => {
    const view = fakeView({ github: { command: 'gh', args: ['stdio'] } });
    expect(effectiveServerHash(view)).toBe(effectiveServerHash(view));
  });

  it('changes when a server is added', () => {
    const a = fakeView({ github: { command: 'gh', args: ['stdio'] } });
    const b = fakeView({
      github: { command: 'gh', args: ['stdio'] },
      slack: { command: 'slack-mcp', args: [] },
    });
    expect(effectiveServerHash(a)).not.toBe(effectiveServerHash(b));
  });

  it('changes when a command line changes', () => {
    const a = fakeView({ github: { command: 'gh', args: ['stdio'] } });
    const b = fakeView({ github: { command: 'gh', args: ['stdio', '--v2'] } });
    expect(effectiveServerHash(a)).not.toBe(effectiveServerHash(b));
  });

  it('ignores key order', () => {
    const a = fakeView({ a: { command: 'x', args: [] }, b: { command: 'y', args: [] } });
    const b = fakeView({ b: { command: 'y', args: [] }, a: { command: 'x', args: [] } });
    expect(effectiveServerHash(a)).toBe(effectiveServerHash(b));
  });

  // Entries reach effectiveServerHash straight from JSON.parse of the host
  // config, and `claude mcp add-json` rewriting ~/.claude.json can reorder
  // an entry's own fields without changing what it means — the hash must
  // not misfire (and trigger a pointless sync) over that.
  it('hashes equal when an entry\'s own field order differs but content is identical', () => {
    const a = fakeView({ github: { command: 'gh', args: ['stdio'] } });
    const b = fakeView({ github: { args: ['stdio'], command: 'gh' } });
    expect(effectiveServerHash(a)).toBe(effectiveServerHash(b));
  });

  it('ignores field order inside a nested object (env)', () => {
    const a = fakeView({ github: { command: 'gh', args: [], env: { A: '1', B: '2' } } });
    const b = fakeView({ github: { command: 'gh', args: [], env: { B: '2', A: '1' } } });
    expect(effectiveServerHash(a)).toBe(effectiveServerHash(b));
  });

  // Unlike object keys, array element order IS semantically meaningful for
  // `args` (it's a command line) — canonicalization must never sort it.
  it('treats a reordered args array as a different command line', () => {
    const a = fakeView({ github: { command: 'gh', args: ['stdio', '--v2'] } });
    const b = fakeView({ github: { command: 'gh', args: ['--v2', 'stdio'] } });
    expect(effectiveServerHash(a)).not.toBe(effectiveServerHash(b));
  });

  // Approving a .mcp.json server in Claude Code writes the host's approval
  // record, NOT the server entry — so a hash over entries alone is identical
  // before and after, sync's fast path short-circuits, and the newly
  // approved server is silently never wrapped.
  it('changes when a project-scope server becomes approved', () => {
    const pending = fakeView({ team: { command: 't', args: [], scope: 'project' } });
    const approved: ClaudeConfigView = {
      ...pending,
      approvedProjectServers: new Set(['team']),
      projectApprovalKnown: true,
    };
    expect(effectiveServerHash(pending)).not.toBe(effectiveServerHash(approved));
  });

  it('ignores approval state for servers that are not project-scope', () => {
    // Only .mcp.json servers have an approval gate; a stray name in the set
    // must not perturb a user-scope server's hash.
    const plain = fakeView({ github: { command: 'gh', args: [] } });
    const noisy: ClaudeConfigView = { ...plain, approvedProjectServers: new Set(['github']) };
    expect(effectiveServerHash(plain)).toBe(effectiveServerHash(noisy));
  });

  it('hashes the same server name differently when its winning scope differs', () => {
    const a = fakeView({ github: { command: 'gh', args: ['stdio'], scope: 'user' } });
    const b = fakeView({ github: { command: 'gh', args: ['stdio'], scope: 'local' } });
    expect(effectiveServerHash(a)).not.toBe(effectiveServerHash(b));
  });
});
