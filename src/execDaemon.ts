/**
 * Per-workspace CLI speculation daemon (DESIGN.md §13.12, Tier B).
 *
 * A small resident process, one per workspace, that serves vetted
 * read-only command lines byte-faithfully from a single-use TTL cache and
 * prefetches the likely next commands using the same transition learner
 * the MCP proxy uses (server label 'cli'). Spawned on demand by
 * `speculate exec`, exits after an idle period.
 *
 * Safety inherits the shell-server posture (§13.8): fixed binaries via
 * execFile, no shell, hardened git invocations (hooks/fsmonitor/pager
 * disabled, optional locks off), 10 s timeouts, 512 KB output caps —
 * and only table-vetted argvs (execTable.ts) ever execute here. Results
 * live in daemon memory only; the persisted learner state contains
 * command shapes, never output (§6.4 still holds).
 *
 * Protocol: newline-delimited JSON over a 0700-dir unix socket.
 *   → {id, op:'exec', argv: string[]}   | {id, op:'stats'} | {id, op:'ping'}
 *   ← {id, ok:true, served, code, stdoutB64, stderrB64, durationMs}
 *   ← {id, ok:false, error: 'unsupported' | '...'}
 * 'unsupported' and infra failures make the CLIENT run the command
 * itself — the daemon never executes anything outside the table.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, watch } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TransitionLearner } from './learner.js';
import { StateStore, defaultStatePathForKey } from './persistence.js';
import { ExecCache, type ExecOutcome } from './execCache.js';
import {
  CLI_PRIMES,
  CLI_SERVER,
  cacheKey,
  classify,
  materialize,
  type ClassifiedCommand,
} from './execTable.js';
import type { ObservedCall } from './types.js';

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const WATCH_DEBOUNCE_MS = 300;
const MAX_SPECULATIONS_PER_TRIGGER = 2;
const DEFAULT_IDLE_EXIT_MS = 15 * 60_000;
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;

/** Deterministic rendezvous point for a workspace. */
export function execSocketPath(root: string): string {
  const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base =
    xdg && isAbsolute(xdg) ? xdg : join(tmpdir(), `speculate-${userInfo().uid ?? 'user'}`);
  return join(base, 'speculate', `exec-${hash}.sock`);
}

// -- hardened execution ---------------------------------------------------------

let emptyHooksDir: string | null = null;
function hooksDir(): string {
  if (!emptyHooksDir) emptyHooksDir = mkdtempSync(join(tmpdir(), 'speculate-nohooks-'));
  return emptyHooksDir;
}

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

/**
 * The command we actually run. Hardening must hold for real serves AND
 * speculative runs alike (identical bytes either way): git hooks,
 * fsmonitor, pagers, and external diff drivers are config-driven code
 * execution, so they are disabled per invocation.
 */
export function hardenedArgv(cls: ClassifiedCommand): { bin: string; args: string[] } {
  const [bin, ...rest] = cls.argv;
  if (bin === 'git') {
    const args = [
      '-c',
      `core.hooksPath=${hooksDir()}`,
      '-c',
      'core.fsmonitor=false',
      '--no-pager',
      ...rest,
    ];
    if (cls.tool === 'git_diff' || cls.tool === 'git_show') {
      const subIdx = args.indexOf(cls.tool === 'git_diff' ? 'diff' : 'show');
      args.splice(subIdx + 1, 0, '--no-ext-diff');
    }
    return { bin: 'git', args };
  }
  return { bin: bin!, args: rest };
}

/** Resolves with the outcome (any exit code); rejects only on infra failure. */
function runCommand(cls: ClassifiedCommand, root: string): Promise<ExecOutcome> {
  const { bin, args } = hardenedArgv(cls);
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: root,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, ...(bin === 'git' ? GIT_ENV : {}) },
        windowsHide: true,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number | string; killed?: boolean }) | null;
        if (anyErr && (anyErr.killed || anyErr.code === 'ETIMEDOUT')) {
          reject(new Error(`timeout after ${EXEC_TIMEOUT_MS} ms`));
          return;
        }
        if (anyErr && typeof anyErr.code !== 'number' && anyErr.code !== undefined) {
          reject(new Error(anyErr.message)); // ENOENT, maxBuffer, ...
          return;
        }
        resolvePromise({
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ?? Buffer.alloc(0),
          code: typeof anyErr?.code === 'number' ? anyErr.code : anyErr ? 1 : 0,
          durationMs: Date.now() - started,
        });
      },
    );
  });
}

// -- learner plumbing -------------------------------------------------------------

/** Structured view of an outcome for argument-template mining. */
function parsedFor(cls: ClassifiedCommand, outcome: ExecOutcome): unknown {
  const parsed: Record<string, unknown> = { exitCode: outcome.code };
  if (cls.tool === 'git_log' || cls.tool === 'git_show') {
    const text = outcome.stdout.subarray(0, 64 * 1024).toString('utf8');
    const shas = [...text.matchAll(/\b[0-9a-f]{40}\b/g)].slice(0, 3).map((m) => m[0]);
    if (shas.length) parsed.shas = shas;
  }
  return parsed;
}

export interface DaemonStats {
  hits: number;
  joins: number;
  misses: number;
  unsupported: number;
  speculated: number;
  wasted: number;
  estimatedSavedMs: number;
}

export interface DaemonOptions {
  root: string;
  socketPath?: string;
  idleExitMs?: number;
  watch?: boolean;
  persist?: boolean;
  log?: (line: string) => void;
  /** Called when the idle timer fires, after close(). CLI exits here. */
  onIdle?: () => void;
}

export interface DaemonHandle {
  socketPath: string;
  stats(): DaemonStats;
  close(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly socketPath: string) {
    super(`another speculate exec daemon is serving ${socketPath}`);
  }
}

/** Probe an existing socket: is a live daemon behind it? */
function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const sock = connect(path);
    const done = (alive: boolean): void => {
      sock.destroy();
      resolvePromise(alive);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

export async function startExecDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const root = resolve(opts.root);
  if (!existsSync(root)) throw new Error(`workspace does not exist: ${root}`);
  const socketPath = opts.socketPath ?? execSocketPath(root);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    if (await probeSocket(socketPath)) throw new DaemonAlreadyRunningError(socketPath);
    unlinkSync(socketPath); // stale socket from a dead daemon
  }

  const cache = new ExecCache();
  const learner = new TransitionLearner();
  for (const [prev, next] of CLI_PRIMES) learner.prime(CLI_SERVER, prev, next);

  const store =
    opts.persist === false ? null : new StateStore(defaultStatePathForKey(`exec:${root}`));
  if (store) {
    const state = store.load();
    if (state) learner.importState(state.learner);
  }
  let savedRevision = learner.revision;
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (!store || saveTimer || learner.revision === savedRevision) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (store.save({ learner: learner.exportState(), ruleFeedback: {} })) {
        savedRevision = learner.revision;
      }
    }, 1_000);
    saveTimer.unref();
  };

  const stats: DaemonStats = {
    hits: 0,
    joins: 0,
    misses: 0,
    unsupported: 0,
    speculated: 0,
    wasted: 0,
    estimatedSavedMs: 0,
  };

  let lastActivity = Date.now();

  // Freshness: any workspace change flushes everything staged (§13.8's
  // watcher, same debounce). Failure degrades to TTL-only, never fatal.
  let watcher: ReturnType<typeof watch> | null = null;
  if (opts.watch !== false) {
    try {
      let timer: NodeJS.Timeout | null = null;
      watcher = watch(root, { recursive: true }, () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          cache.invalidateAll();
        }, WATCH_DEBOUNCE_MS);
        timer.unref();
      });
    } catch (err) {
      log(`[speculate-exec] fs watch unavailable (${(err as Error).message}); TTLs only`);
    }
  }

  const speculate = (call: ObservedCall): void => {
    const predictions = learner.predict(call).slice(0, MAX_SPECULATIONS_PER_TRIGGER);
    for (const p of predictions) {
      const cls = materialize(p.tool, p.args, root);
      if (!cls) continue; // fail closed: templates the table won't re-vet
      const key = cacheKey(root, cls.argv);
      if (cache.has(key)) continue;
      stats.speculated++;
      cache.beginSpeculative(key, cls.ttlMs, () => runCommand(cls, root));
    }
  };

  const observeAndSpeculate = (cls: ClassifiedCommand, outcome: ExecOutcome): void => {
    // rg exits 1 on "no matches" — a valid result, not a failure.
    const ok = outcome.code === 0 || (cls.tool === 'rg' && outcome.code === 1);
    if (!ok) return;
    const call: ObservedCall = {
      server: CLI_SERVER,
      tool: cls.tool,
      args: cls.args,
      result: { content: [] },
      parsed: parsedFor(cls, outcome),
      timestamp: Date.now(),
      latencyMs: outcome.durationMs,
    };
    learner.observe(call);
    scheduleSave();
    speculate(call);
  };

  interface Request {
    id?: unknown;
    op?: unknown;
    argv?: unknown;
  }

  const handleExec = async (
    argv: string[],
  ): Promise<Record<string, unknown>> => {
    const cls = classify(argv, root);
    if (!cls) {
      stats.unsupported++;
      return { ok: false, error: 'unsupported' };
    }
    const key = cacheKey(root, cls.argv);
    const found = cache.lookup(key);
    let outcome: ExecOutcome | null = null;
    let served: 'hit' | 'join' | 'miss' = 'miss';
    if (found.kind === 'hit') {
      outcome = found.outcome;
      served = 'hit';
      stats.hits++;
      stats.estimatedSavedMs += found.outcome.durationMs;
    } else if (found.kind === 'join') {
      const joinedAt = Date.now();
      outcome = await found.promise;
      if (outcome) {
        served = 'join';
        stats.joins++;
        stats.estimatedSavedMs += Math.max(0, joinedAt - found.issuedAt);
      }
    }
    if (!outcome) {
      stats.misses++;
      try {
        outcome = await runCommand(cls, root);
      } catch (err) {
        return { ok: false, error: `exec-failed: ${(err as Error).message}` };
      }
    }
    observeAndSpeculate(cls, outcome);
    return {
      ok: true,
      served,
      code: outcome.code,
      stdoutB64: outcome.stdout.toString('base64'),
      stderrB64: outcome.stderr.toString('base64'),
      durationMs: outcome.durationMs,
    };
  };

  const handleLine = async (line: string): Promise<Record<string, unknown>> => {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      return { ok: false, error: 'bad-json' };
    }
    const id = req.id;
    if (req.op === 'ping') return { id, ok: true, pong: true, root };
    if (req.op === 'shutdown') {
      setImmediate(() => void close().then(() => opts.onIdle?.()));
      return { id, ok: true, stopping: true };
    }
    if (req.op === 'stats') {
      return { id, ok: true, stats: { ...stats, wasted: stats.wasted + cache.wasted } };
    }
    if (req.op === 'exec') {
      if (!Array.isArray(req.argv) || !req.argv.every((t) => typeof t === 'string')) {
        return { id, ok: false, error: 'bad-argv' };
      }
      return { id, ...(await handleExec(req.argv as string[])) };
    }
    return { id, ok: false, error: 'bad-op' };
  };

  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      lastActivity = Date.now();
      buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (buf.length > MAX_REQUEST_LINE_BYTES) {
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        void handleLine(line)
          .then((res) => {
            if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
          })
          .catch(() => {
            if (!sock.destroyed) sock.write(`${JSON.stringify({ ok: false, error: 'internal' })}\n`);
          });
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolvePromise());
  });

  const sweeper = setInterval(() => cache.sweep(), 5_000);
  sweeper.unref();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(sweeper);
    clearInterval(idleTimer);
    if (saveTimer) clearTimeout(saveTimer);
    if (store && learner.revision !== savedRevision) {
      store.save({ learner: learner.exportState(), ruleFeedback: {} });
    }
    watcher?.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    try {
      unlinkSync(socketPath);
    } catch {
      // already gone
    }
  };

  const idleExitMs = opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleExitMs) {
      void close().then(() => opts.onIdle?.());
    }
  }, Math.min(30_000, Math.max(50, idleExitMs / 4)));
  idleTimer.unref();

  log(`[speculate-exec] serving ${root} on ${socketPath}`);
  return {
    socketPath,
    stats: () => ({ ...stats, wasted: stats.wasted + cache.wasted }),
    close,
  };
}

/** CLI flag grammar for `speculate exec-daemon`. */
export function parseDaemonArgs(argv: string[]):
  | { root: string; socketPath?: string; idleExitMs?: number; watch: boolean; persist: boolean }
  | { error: string } {
  let root = process.cwd();
  let socketPath: string | undefined;
  let idleExitMs: number | undefined;
  let watchFs = true;
  let persist = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--cwd') {
      const v = argv[++i];
      if (!v) return { error: '--cwd requires a path' };
      root = v;
    } else if (a === '--socket') {
      const v = argv[++i];
      if (!v) return { error: '--socket requires a path' };
      socketPath = v;
    } else if (a === '--idle-ms') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1_000) return { error: '--idle-ms requires ms ≥ 1000' };
      idleExitMs = v;
    } else if (a === '--no-watch') {
      watchFs = false;
    } else if (a === '--no-persist') {
      persist = false;
    } else {
      return { error: `unknown exec-daemon argument '${a}'` };
    }
  }
  return { root, socketPath, idleExitMs, watch: watchFs, persist };
}
