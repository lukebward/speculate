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
import { execFile } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { effectiveServerHash, speculateOff, speculateOn, type CmdRunner } from '../src/manage.js';
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

  it("does not revert an 'off' that lands in another project mid-sync", async () => {
    // `on`/`off` are interactive and never take sync's lock (blocking a
    // person on a background hook would be worse), so an `off` CAN complete
    // between sync's read of the state and its write. Writing the whole
    // in-memory object back erased the opt-out `off` had just recorded AND
    // resurrected the project record it had just deleted — so the very next
    // session start re-wrapped the project the user had just turned off.
    const other = mkdtempSync(join(tmpdir(), 'speculate-sother-'));
    try {
      writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
      expect(await speculateOn({ ...opts(), cwd: other })).toBe(0); // project A
      // Project B has work to do: a server that appeared after A's `on`.
      const config = readClaudeJson();
      config.mcpServers.linear = { command: 'linear-server' };
      writeClaudeJson(config);
      calls = [];
      logs = [];

      // The interleave: B's sync has already read the state (it is past the
      // fast path and holds the lock) when A's `off` runs to completion.
      let offRan = false;
      const interleaved: CmdRunner = async (cmd, args, o) => {
        if (!offRan) {
          offRan = true;
          expect(await speculateOff({ ...opts(), cwd: other, log: () => {} })).toBe(0);
        }
        return fakeRunner(cmd, args, o);
      };
      expect(await speculateSync({ ...opts(), runner: interleaved })).toBe(0);

      const state = readState();
      expect(offRan).toBe(true);
      // A's opt-out survives …
      expect(state.syncOptOut?.[other]).toBe(true);
      // … and the record `off` deleted stays deleted (a resurrected record
      // is what would make the next session re-wrap A).
      expect(state.projects[other]).toBeUndefined();
      // B's own work is still recorded.
      expect(state.projects[cwd].entries.map((e: AnyRecord) => e.name)).toEqual(['linear']);
      expect(state.syncHashes[cwd]).toBe(currentHash());
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("another project's servers never invalidate this project's hash", async () => {
    // Local-scope servers for every project live in the SAME ~/.claude.json,
    // so another project's sync rewrites a file this one also reads. The
    // hash is per project and must cover only what this project can see.
    const other = mkdtempSync(join(tmpdir(), 'speculate-sother-'));
    try {
      writeClaudeJson({
        projects: {
          [cwd]: {
            mcpServers: {
              alpha: { command: SELF.command, args: [...SELF.args, 'wrap', '--', 'alpha-server'] },
            },
          },
          [other]: { mcpServers: { beta: { command: 'beta-server' } } },
        },
      });
      writeState({ syncHashes: { [cwd]: currentHash() } });

      const config = readClaudeJson();
      config.projects[other].mcpServers.gamma = { command: 'gamma-server' };
      writeClaudeJson(config);

      expect(await speculateSync(opts())).toBe(0);
      expect(calls).toEqual([]); // still the fast path
      expect(logs).toEqual([]);

      // … while a change to THIS project's own set does invalidate it.
      const mine = readClaudeJson();
      mine.projects[cwd].mcpServers.delta = { command: 'delta-server' };
      writeClaudeJson(mine);
      expect(await speculateSync(opts())).toBe(0);
      expect(addJsonNames()).toEqual(['delta']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('removes its own shadow when the .mcp.json approval is revoked', async () => {
    const mcpJson = { mcpServers: { team: { command: 'team-server', args: [] } } };
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(mcpJson));
    writeClaudeJson({ projects: { [cwd]: { enableAllProjectMcpServers: true } } });

    expect(await speculateSync(opts())).toBe(0);
    expect(readClaudeJson().projects[cwd].mcpServers.team.command).toBe(SELF.command);

    // The user revokes approval in Claude Code. The wrapped LOCAL shadow
    // still wins the scope contest, so the effective set looks unchanged —
    // but consent hangs on the .mcp.json entry, and local scope has no
    // approval gate at all. The hash must move, and the shadow must go.
    const config = readClaudeJson();
    config.projects[cwd].disabledMcpjsonServers = ['team'];
    writeClaudeJson(config);
    calls = [];
    logs = [];

    expect(await speculateSync(opts())).toBe(0);
    expect(calls.map((c) => `${c[2]} ${c[3]}`)).toEqual(['remove team']);
    expect(readClaudeJson().projects[cwd].mcpServers?.team).toBeUndefined();
    // .mcp.json untouched, and the pending entry is back in effect (pending).
    expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))).toEqual(mcpJson);
    // No stale record of a shadow that no longer exists.
    expect(readState().projects[cwd]).toBeUndefined();
    expect(readState().syncHashes[cwd]).toBe(currentHash());
    expect(logs.join('\n')).toContain('approval');

    // And the next session is a no-op: the removal completed the pass.
    calls = [];
    logs = [];
    expect(await speculateSync(opts())).toBe(0);
    expect(calls).toEqual([]);
  });

  it('removes its own shadow when the server disappears from .mcp.json', async () => {
    // The commoner trigger of the same family as a revoke: a git pull, a
    // branch switch, or an edit drops the server from the file. The shadow
    // wins the scope contest, so nothing else would ever notice — Claude Code
    // would keep launching a server the project no longer declares.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: { team: { command: 'team-server', args: [] }, other: { command: 'other' } },
      }),
    );
    writeClaudeJson({ projects: { [cwd]: { enabledMcpjsonServers: ['team'] } } });
    expect(await speculateSync(opts())).toBe(0);
    expect(readClaudeJson().projects[cwd].mcpServers.team.command).toBe(SELF.command);

    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    calls = [];
    logs = [];

    expect(await speculateSync(opts())).toBe(0);
    expect(calls.map((c) => `${c[2]} ${c[3]}`)).toEqual(['remove team']);
    expect(readClaudeJson().projects[cwd].mcpServers?.team).toBeUndefined();
    expect(readState().projects[cwd]).toBeUndefined();
  });

  it('removes its own shadow when .mcp.json is deleted entirely', async () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { command: 'team-server', args: [] } } }),
    );
    writeClaudeJson({ projects: { [cwd]: { enableAllProjectMcpServers: true } } });
    expect(await speculateSync(opts())).toBe(0);
    expect(readClaudeJson().projects[cwd].mcpServers.team.command).toBe(SELF.command);

    rmSync(join(cwd, '.mcp.json'));
    calls = [];
    logs = [];

    expect(await speculateSync(opts())).toBe(0);
    expect(calls.map((c) => `${c[2]} ${c[3]}`)).toEqual(['remove team']);
    expect(readClaudeJson().projects[cwd].mcpServers?.team).toBeUndefined();
  });

  it('says nothing at all on a partly failed pass, removals included', async () => {
    // The wrap line is gated on a clean pass; the removal line must be too,
    // or a run that failed half its work still reports the half it liked.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { command: 'team-server', args: [] } } }),
    );
    writeClaudeJson({ projects: { [cwd]: { enableAllProjectMcpServers: true } } });
    expect(await speculateSync(opts())).toBe(0);
    const hashBefore = readState().syncHashes[cwd];

    // Approval revoked AND a new user-scope server that the host refuses to
    // wrap: one removal succeeds, one wrap fails, in the same pass.
    const config = readClaudeJson();
    config.projects[cwd].disabledMcpjsonServers = ['team'];
    config.mcpServers = { slack: { command: 'slack-server' } };
    writeClaudeJson(config);
    calls = [];
    logs = [];
    const failsToWrap: CmdRunner = async (cmd, args, o) => {
      if (args[1] === 'add-json' && args[3]!.includes('"wrap"')) {
        calls.push([cmd, ...args]);
        return { code: 1, stdout: '', stderr: 'host is having a bad day' };
      }
      return fakeRunner(cmd, args, o);
    };

    expect(await speculateSync({ ...opts(), runner: failsToWrap })).toBe(0);
    expect(logs).toEqual([]);
    // The removal still happened — consent is not negotiable on a bad day.
    expect(readClaudeJson().projects[cwd].mcpServers?.team).toBeUndefined();
    // … and an unfinished pass never claims "nothing changed": the stored
    // hash is still the stale one, so the next session retries slack.
    expect(readState().syncHashes[cwd]).toBe(hashBefore);
    expect(readState().syncHashes[cwd]).not.toBe(currentHash());
  });

  it('leaves a local shadow it did not create alone', async () => {
    // Same revoke, but the wrapped local entry is the USER's own (no managed
    // record of a shadow Speculate created). Never remove what we didn't add.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { command: 'team-server', args: [] } } }),
    );
    const theirs = { command: SELF.command, args: [...SELF.args, 'wrap', '--', 'their-server'] };
    writeClaudeJson({
      projects: {
        [cwd]: { disabledMcpjsonServers: ['team'], mcpServers: { team: theirs } },
      },
    });

    expect(await speculateSync(opts())).toBe(0);
    expect(calls).toEqual([]);
    expect(readClaudeJson().projects[cwd].mcpServers.team).toEqual(theirs);
  });

  it("seeds the hash on 'on' so the very next session takes the fast path", async () => {
    writeClaudeJson({ mcpServers: { github: { command: 'gh-server' } } });
    expect(await speculateOn(opts())).toBe(0);
    expect(readState().syncHashes[cwd]).toBe(currentHash());

    calls = [];
    logs = [];
    expect(await speculateSync(opts())).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('speculate sync (CLI grammar)', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  it('rejects an unknown argument instead of exiting 0 quietly', async () => {
    // `sync` owns its whole argv (REST_COMMANDS) but read none of it, so a
    // typo'd flag was silently ignored — unlike every sibling command. The
    // failure happens during argument parsing, so nothing is ever synced.
    const stateHome = mkdtempSync(join(tmpdir(), 'speculate-scli-'));
    try {
      const res = await new Promise<{ code: number; stderr: string }>((done) => {
        execFile(
          process.execPath,
          [TSX_CLI, join(ROOT, 'src', 'cli.ts'), 'sync', '--nope'],
          { env: { ...process.env, XDG_STATE_HOME: stateHome }, encoding: 'utf8' },
          (error, _stdout, stderr) => {
            const code =
              error && typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : error
                  ? 1
                  : 0;
            done({ code, stderr });
          },
        );
      });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("unknown sync argument '--nope'");
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  }, 30_000);
});
