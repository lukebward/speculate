/**
 * `speculate sync` — the unattended wrap the auto-wrap session-start hook
 * runs (docs/superpowers/specs/2026-08-02-auto-wrap-design.md).
 *
 * Same fake-runner harness as manage.test.ts (just enough `claude mcp` to
 * mutate the fixture config), because sync's whole point is that it goes
 * through the SAME front door as `on` while being fast, silent and
 * fail-open. The assertions therefore lean on `calls` as much as on the
 * resulting config: the unchanged case must spawn nothing at all, and no
 * failure path may print or throw.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveServerHash, speculateOn, type CmdRunner } from '../src/manage.js';
import { speculateSync } from '../src/sync.js';
import { readClaudeServers } from '../src/hostConfig.js';

const SELF = { command: '/usr/bin/node', args: ['/opt/speculate/dist/src/cli.js'] };

let home: string;
let cwd: string;
let statePath: string;
let lockPath: string;
let calls: string[][];
let logs: string[];
/** Simulates a host where every `claude` invocation fails (not installed). */
let hostBroken: boolean;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'speculate-shome-'));
  cwd = mkdtempSync(join(tmpdir(), 'speculate-sproj-'));
  statePath = join(home, 'managed.json');
  lockPath = join(home, 'sync.lock');
  calls = [];
  logs = [];
  hostBroken = false;
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
function writeState(extra: AnyRecord): void {
  writeFileSync(statePath, JSON.stringify({ version: 1, projects: {}, ...extra }));
}
function readState(): AnyRecord {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
/** The hash sync would compute for the config as it stands right now. */
function currentHash(): string {
  return effectiveServerHash(readClaudeServers({ home, cwd }));
}
function addJsonNames(): string[] {
  return calls.filter((c) => c[1] === 'mcp' && c[2] === 'add-json').map((c) => c[3]!);
}

/** Just enough `claude mcp` to mutate the fixture ~/.claude.json. */
const fakeRunner: CmdRunner = async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (hostBroken) return { code: 127, stdout: '', stderr: 'claude: not found' };
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
    const map = scope === 'user' ? config.mcpServers : config.projects?.[cwd]?.mcpServers;
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
  lockPath,
  log: (l: string) => logs.push(l),
});

describe('speculate sync', () => {
  it('is a no-op with zero runner calls when the hash is unchanged', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server', args: ['stdio'] } } });
    writeState({ syncHashes: { [cwd]: currentHash() } });

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    // The fast path is the whole reason a per-session hook is viable: no
    // subprocess, no output.
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('wraps a newly added server and reports the one-session lag', async () => {
    writeClaudeJson({ mcpServers: { slack: { command: 'slack-server', args: ['stdio'] } } });
    writeState({ syncHashes: { [cwd]: 'stale-hash-from-before-slack-existed' } });

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    expect(addJsonNames()).toEqual(['slack']);
    const wrapped = readClaudeJson().mcpServers.slack;
    expect(wrapped.command).toBe(SELF.command);
    expect(wrapped.args).toContain('wrap');
    expect(wrapped.args.slice(-2)).toEqual(['slack-server', 'stdio']);
    // Exactly one line, and it states the lag: Claude Code snapshots MCP
    // config BEFORE session-start hooks run, so this wrap lands next session.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/wrapped 1 new server \(slack\).*next session/);
  });

  it('spawns only the wrap itself — no front-door probe, no legacy cleanup', async () => {
    writeClaudeJson({ mcpServers: { slack: { command: 'slack-server' } } });
    await speculateSync(opts());
    expect(calls.map((c) => `${c[1]} ${c[2]}`)).toEqual(['mcp remove', 'mcp add-json']);
  });

  it('skips a project that opted out', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeState({ syncOptOut: { [cwd]: true } });

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    // `off` left it unwrapped; sync must leave it that way.
    expect(readClaudeJson().mcpServers.github.command).toBe('gh-server');
  });

  it('still syncs projects another project opted out of', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeState({ syncOptOut: { '/some/other/project': true } });

    expect(await speculateSync(opts())).toBe(0);
    expect(addJsonNames()).toEqual(['github']);
  });

  it('skips an unapproved .mcp.json server', async () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { command: 'team-server', args: [] } } }),
    );
    writeClaudeJson({ projects: { [cwd]: { enabledMcpjsonServers: ['other'] } } });

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    expect(addJsonNames()).toEqual([]);
    // The per-server skip line goes to the SILENCED ctx logger: a session
    // start must not be sprayed with per-server diagnostics.
    expect(logs).toEqual([]);
  });

  it('shadows an approved .mcp.json server at local scope', async () => {
    const mcpJson = { mcpServers: { team: { command: 'team-server', args: [] } } };
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(mcpJson));
    writeClaudeJson({ projects: { [cwd]: { enableAllProjectMcpServers: true } } });

    expect(await speculateSync(opts())).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))).toEqual(mcpJson);
    const local = readClaudeJson().projects[cwd].mcpServers;
    expect(local.team.command).toBe(SELF.command);
    expect(local.team.args.slice(-1)).toEqual(['team-server']);
  });

  it('leaves an already-wrapped server alone', async () => {
    writeClaudeJson({
      mcpServers: {
        github: { command: SELF.command, args: [...SELF.args, 'wrap', '--', 'gh-server'] },
      },
    });

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    expect(addJsonNames()).toEqual([]); // never wrap a wrap
    expect(logs).toEqual([]);
  });

  it('exits 0 and silent when the host CLI is missing', async () => {
    hostBroken = true;
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    expect(logs).toEqual([]);
    expect(readClaudeJson().mcpServers.github.command).toBe('gh-server');
    // Nothing was wrapped, so nothing may claim "nothing changed".
    expect(readState().syncHashes?.[cwd]).toBeUndefined();
  });

  it('leaves the stored hash alone when a wrap fails, so the next session retries', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeState({ syncHashes: { [cwd]: 'hash-of-an-older-server-set' } });
    // The remove succeeds and the original is restored, so the config ends up
    // byte-identical — exactly the shape a transient host failure takes, and
    // the shape that would make a stored hash skip this server forever.
    const failsToWrap: CmdRunner = async (cmd, args, o) => {
      if (args[1] === 'add-json' && args[3]!.includes('"wrap"')) {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'host is having a bad day' };
      }
      return fakeRunner(cmd, args, o);
    };

    expect(await speculateSync({ ...opts(), runner: failsToWrap })).toBe(0);
    expect(logs).toEqual([]);
    expect(readState().syncHashes[cwd]).toBe('hash-of-an-older-server-set');
    expect(readClaudeJson().mcpServers.github.command).toBe('gh-server');

    // Next session, host healthy again: it retries rather than fast-pathing.
    calls = [];
    logs = [];
    expect(await speculateSync(opts())).toBe(0);
    expect(addJsonNames()).toEqual(['github']);
    expect(logs).toHaveLength(1);
    expect(readState().syncHashes[cwd]).toBe(currentHash());
  });

  it('exits 0 and silent when the runner throws outright', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    const throwing: CmdRunner = () => {
      throw new Error('spawn EINVAL');
    };
    expect(await speculateSync({ ...opts(), runner: throwing })).toBe(0);
    expect(logs).toEqual([]);
  });

  it('exits 0 and silent when the state file is unwritable', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    // A path whose parent is a FILE: mkdirSync/writeFileSync both fail.
    const brokenState = join(home, '.claude.json', 'managed.json');
    expect(await speculateSync({ ...opts(), statePath: brokenState })).toBe(0);
    expect(logs).toEqual([]);
  });

  it('updates the stored hash after a successful wrap', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });

    expect(await speculateSync(opts())).toBe(0);
    // Recomputed from the config AS WRAPPED — storing the pre-wrap hash
    // would make the very next session sync all over again.
    expect(readState().syncHashes[cwd]).toBe(currentHash());

    calls = [];
    logs = [];
    expect(await speculateSync(opts())).toBe(0);
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('records what it wrapped so off can restore the original', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server', args: ['stdio'] } } });

    expect(await speculateSync(opts())).toBe(0);
    expect(readState().projects[cwd].entries).toEqual([
      {
        name: 'github',
        scope: 'user',
        action: 'rewrote',
        original: { command: 'gh-server', args: ['stdio'] },
      },
    ]);
  });

  it("keeps the entries a previous 'on' recorded", async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    const config = readClaudeJson();
    config.mcpServers.linear = { command: 'linear-server' };
    writeClaudeJson(config);
    calls = [];
    logs = [];

    expect(await speculateSync(opts())).toBe(0);
    expect(addJsonNames()).toEqual(['linear']);
    const names = readState().projects[cwd].entries.map((e: AnyRecord) => e.name);
    expect(names.sort()).toEqual(['github', 'linear']);
  });

  it('leaves no state record for a project it never changed', async () => {
    writeClaudeJson({ mcpServers: { github: { command: SELF.command, args: [...SELF.args, 'wrap', '--', 'gh'] } } });
    expect(await speculateSync(opts())).toBe(0);
    // Only the hash: an empty managed record would make `status` report
    // drift "since 'speculate on'" in a project where `on` never ran.
    expect(readState().projects[cwd]).toBeUndefined();
    expect(readState().syncHashes[cwd]).toBe(currentHash());
  });

  it('exits quietly when another session holds the lock', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeFileSync(lockPath, '4242'); // fresh lock: a live session owns it

    const code = await speculateSync(opts());
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    expect(readClaudeJson().mcpServers.github.command).toBe('gh-server');
    // No hash written: the next session must still pick this up.
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true); // the holder's lock is untouched
  });

  it('takes over a stale lock and releases its own', async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    writeFileSync(lockPath, '4242');
    const longAgo = Date.now() / 1000 - 600;
    utimesSync(lockPath, longAgo, longAgo);

    expect(await speculateSync(opts())).toBe(0);
    expect(addJsonNames()).toEqual(['github']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('stops BETWEEN servers when the session-start budget is spent', async () => {
    writeClaudeJson({
      mcpServers: {
        alpha: { command: 'alpha-server' },
        beta: { command: 'beta-server' },
      },
    });
    const slow: CmdRunner = async (cmd, args, o) => {
      await new Promise((r) => setTimeout(r, 120));
      return fakeRunner(cmd, args, o);
    };

    expect(await speculateSync({ ...opts(), runner: slow, timeoutMs: 60 })).toBe(0);
    // alpha's remove AND its add-json both ran: the budget is checked
    // between servers, never between a server's remove and its re-add —
    // that window is where a hard process exit would leave the host with
    // the server deleted, no restore, and no state record.
    expect(calls.map((c) => `${c[2]} ${c[3]}`)).toEqual(['remove alpha', 'add-json alpha']);
    expect(readClaudeJson().mcpServers.alpha.command).toBe(SELF.command);
    expect(readClaudeJson().mcpServers.beta.command).toBe('beta-server');
    // What did get wrapped is recorded, so `off` can still restore it …
    expect(readState().projects[cwd].entries.map((e: AnyRecord) => e.name)).toEqual(['alpha']);
    // … and an unfinished pass never claims "nothing changed".
    expect(readState().syncHashes?.[cwd]).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('wraps a .mcp.json server once it is approved, though its entry never changed', async () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { command: 'team-server', args: [] } } }),
    );
    writeClaudeJson({ projects: { [cwd]: { enabledMcpjsonServers: ['other'] } } });

    // First session: not approved, so it is skipped — and the hash stored.
    expect(await speculateSync(opts())).toBe(0);
    expect(addJsonNames()).toEqual([]);
    expect(readState().syncHashes[cwd]).toBeDefined();

    // The user approves it in Claude Code. That writes the host's APPROVAL
    // record; the .mcp.json entry itself is untouched. A hash over entries
    // alone would be unchanged, the fast path would fire, and this server
    // would never be wrapped.
    writeClaudeJson({ projects: { [cwd]: { enableAllProjectMcpServers: true } } });
    calls = [];
    logs = [];

    expect(await speculateSync(opts())).toBe(0);
    expect(addJsonNames()).toEqual(['team']);
    expect(logs).toHaveLength(1);
  });

  it('never writes its summary to stdout (a hook\'s stdout is session context)', async () => {
    writeClaudeJson({ mcpServers: { slack: { command: 'slack-server' } } });
    const { log: _log, ...noLogSink } = opts(); // exercise the DEFAULT report sink
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let code: number;
    let onStdout: string[] = [];
    let onStderr: string[] = [];
    try {
      code = await speculateSync(noLogSink);
    } finally {
      // Read the history BEFORE restoring: mockRestore() clears it.
      onStdout = stdout.mock.calls.map((c) => String(c[0]));
      onStderr = stderr.mock.calls.map((c) => String(c[0]));
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(code).toBe(0);
    expect(onStdout).toEqual([]);
    expect(onStderr).toEqual([
      '[speculate] wrapped 1 new server (slack); speculation active next session\n',
    ]);
  });
});
