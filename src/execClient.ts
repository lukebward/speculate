/**
 * `speculate exec -- <command...>` — the client half of CLI speculation
 * (DESIGN.md §13.12). This is what the Claude Code plugin's Bash hook
 * rewrites read-only commands into.
 *
 * Fail open, always: anything that isn't table-vetted, any daemon
 * hiccup, any timeout — the command just runs directly, exactly as it
 * would have without Speculate. The only observable difference on the
 * happy path is that prefetched commands return in ~2 ms.
 */
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { selfCommand } from './hostConfig.js';
import { execSocketPath, socketDirTrust } from './execDaemon.js';
import { classify } from './execTable.js';

const CONNECT_TIMEOUT_MS = 250;
const SPAWN_RETRY_MS = 60;
const SPAWN_DEADLINE_MS = 1_500;
const RESPONSE_TIMEOUT_MS = 15_000;

export interface ExecCliArgs {
  cwd: string | null;
  stats: boolean;
  stop: boolean;
  argv: string[];
}

export function parseExecArgs(argv: string[]): ExecCliArgs | { error: string } {
  const out: ExecCliArgs = { cwd: null, stats: false, stop: false, argv: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.argv = argv.slice(i + 1);
      break;
    }
    if (a === '--cwd') {
      const v = argv[++i];
      if (!v) return { error: '--cwd requires a path' };
      out.cwd = v;
    } else if (a === '--stats') {
      out.stats = true;
    } else if (a === '--stop') {
      out.stop = true;
    } else if (a.startsWith('-')) {
      return { error: `unknown exec argument '${a}' (the command goes after '--')` };
    } else {
      out.argv = argv.slice(i); // bare command without '--'
      break;
    }
  }
  if (!out.stats && !out.stop && out.argv.length === 0) {
    return { error: "exec needs a command after '--' (or --stats / --stop)" };
  }
  return out;
}

/** Run the command directly, exactly as the shell would have. */
function passthrough(argv: string[], cwd?: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
    child.on('error', (err) => {
      process.stderr.write(`speculate exec: ${argv[0]}: ${err.message}\n`);
      resolvePromise(127);
    });
    child.on('exit', (code, signal) => resolvePromise(signal ? 1 : (code ?? 0)));
  });
}

function tryConnect(path: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolvePromise) => {
    const sock = connect(path);
    const timer = setTimeout(() => {
      sock.destroy();
      resolvePromise(null);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolvePromise(sock);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
  });
}

async function connectOrSpawn(root: string): Promise<Socket | null> {
  const path = execSocketPath(root);
  const first = await tryConnect(path, CONNECT_TIMEOUT_MS);
  if (first) return first;
  // No daemon yet: start one, detached, and give it a moment to bind.
  try {
    const self = selfCommand();
    const idleMs = process.env.SPECULATE_EXEC_IDLE_MS; // mainly for tests
    const child = spawn(
      self.command,
      [
        ...self.args,
        'exec-daemon',
        '--cwd',
        root,
        ...(idleMs ? ['--idle-ms', idleMs] : []),
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch {
    return null;
  }
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SPAWN_RETRY_MS));
    const sock = await tryConnect(path, CONNECT_TIMEOUT_MS);
    if (sock) return sock;
  }
  return null;
}

/** One request, one line back. Null on any transport failure or timeout. */
function request(
  sock: Socket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolvePromise) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);
    const finish = (value: Record<string, unknown> | null): void => {
      clearTimeout(timer);
      sock.destroy();
      resolvePromise(value);
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      try {
        finish(JSON.parse(buf.subarray(0, nl).toString('utf8')) as Record<string, unknown>);
      } catch {
        finish(null);
      }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    sock.write(`${JSON.stringify(payload)}\n`);
  });
}

export async function runExec(args: ExecCliArgs): Promise<number> {
  const root = resolve(args.cwd ?? process.cwd());

  if (args.stats || args.stop) {
    const sock = await tryConnect(execSocketPath(root), CONNECT_TIMEOUT_MS);
    if (!sock) {
      process.stdout.write('no exec daemon running for this workspace\n');
      return 1;
    }
    if (args.stop) {
      const res = await request(sock, { id: 1, op: 'shutdown' });
      process.stdout.write(res?.ok === true ? 'daemon stopping\n' : 'shutdown failed\n');
      return res?.ok === true ? 0 : 1;
    }
    const res = await request(sock, { id: 1, op: 'stats' });
    process.stdout.write(`${JSON.stringify(res?.stats ?? null, null, 2)}\n`);
    return res ? 0 : 1;
  }

  const argv = args.argv;
  // Passthrough must run in the SAME directory the daemon would have used
  // (root = resolved --cwd), or a hit and its fallback could disagree.
  if (process.env.SPECULATE_EXEC_OFF === '1') return passthrough(argv, root);
  if (!classify(argv, root)) return passthrough(argv, root); // not ours: run as-is
  // A tampered rendezvous directory means someone may be squatting our
  // socket path; never trust it — run the command ourselves.
  if (socketDirTrust(execSocketPath(root)) === 'unsafe') return passthrough(argv, root);

  const sock = await connectOrSpawn(root);
  if (!sock) return passthrough(argv, root);
  const res = await request(sock, { id: 1, op: 'exec', argv });
  if (!res || res.ok !== true) return passthrough(argv, root);

  const stdout = Buffer.from(String(res.stdoutB64 ?? ''), 'base64');
  const stderr = Buffer.from(String(res.stderrB64 ?? ''), 'base64');
  if (stdout.length) process.stdout.write(stdout);
  if (stderr.length) process.stderr.write(stderr);
  return typeof res.code === 'number' ? res.code : 0;
}
