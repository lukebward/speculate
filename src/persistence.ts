/**
 * On-disk persistence for learned state (DESIGN.md §13.6).
 *
 * What persists: the transition learner's model (tool names + argument
 * templates, including constant argument values) and per-rule feedback
 * counters. What NEVER persists: tool results — the speculation cache is
 * memory-only by design (§6.4) — and anything else request-scoped.
 *
 * Failure philosophy: state is an optimization, so every failure mode
 * degrades to "cold start". A missing, corrupt, or version-mismatched file
 * loads as null; a failed save logs once to stderr and the proxy carries on.
 * Writes are atomic (tmp + rename) and 0600 — argument values can be
 * private, so the file is owner-only.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mergeLatencySnapshots, type LatencySnapshot } from './latency.js';
import {
  mergeCandidateFeedbackSnapshots,
  type CandidateFeedbackSnapshot,
} from './calibration.js';

export interface RuleFeedbackSnapshot {
  hits: number;
  wasted: number;
  speculated: number;
  /** Absent in legacy snapshots, which receive one compatibility half-decay. */
  lastUpdated?: number;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  /** Hashed workspace/upstream/account identity; never contains credentials. */
  scope?: string;
  learner: unknown;
  ruleFeedback: Record<string, RuleFeedbackSnapshot>;
  /** Aggregate target latency only; no arguments, results, or cache keys. */
  latency?: LatencySnapshot;
  /** Shadow correctness by stable rule/alternative ID. */
  candidateFeedback?: Record<string, CandidateFeedbackSnapshot>;
}

const STATE_VERSION = 1 as const;

export class StateStore {
  private warnedSaveFailure = false;
  /** This process's own last-loaded/saved view, used to isolate feedback deltas. */
  private baseline: PersistedState | null = null;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly fallbackPaths: readonly string[] = [],
    private readonly expectedScope?: string,
  ) {}

  /** null on missing/corrupt/version-mismatch — cold start, never an error. */
  load(): PersistedState | null {
    for (const candidate of [this.path, ...this.fallbackPaths]) {
      const state = this.loadPath(candidate);
      if (state !== null) {
        this.baseline = state;
        return state;
      }
    }
    return null;
  }

  private loadPath(path: string): PersistedState | null {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null; // most commonly ENOENT: first run
    }
    try {
      const data = JSON.parse(text) as PersistedState;
      if (
        data === null ||
        typeof data !== 'object' ||
        data.version !== STATE_VERSION ||
        typeof data.ruleFeedback !== 'object'
      ) {
        return null;
      }
      // Missing means a legacy file: allow one migration load. A current
      // file from another workspace/account is a cold start, never imported.
      if (data.scope !== undefined && data.scope !== this.expectedScope) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Atomic write; returns false (and warns once) on failure. */
  save(state: {
    learner: unknown;
    ruleFeedback: Record<string, RuleFeedbackSnapshot>;
    latency?: LatencySnapshot;
    candidateFeedback?: Record<string, CandidateFeedbackSnapshot>;
  }): boolean {
    const incoming: PersistedState = {
      version: STATE_VERSION,
      savedAt: this.now(),
      ...(this.expectedScope !== undefined ? { scope: this.expectedScope } : {}),
      learner: state.learner,
      ruleFeedback: state.ruleFeedback,
      ...(state.latency !== undefined ? { latency: state.latency } : {}),
      ...(state.candidateFeedback !== undefined
        ? { candidateFeedback: state.candidateFeedback }
        : {}),
    };
    const tmp = `${this.path}.${process.pid}.${incoming.savedAt}.tmp`;
    const lockPath = `${this.path}.lock`;
    let lockFd: number | null = null;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      lockFd = acquireLock(lockPath, this.now);
      if (lockFd === null) throw new Error('state file is busy in another process');
      // Serialize the read/merge/rename section. Independent projects are
      // already isolated by their state keys; this preserves disjoint rules,
      // transitions, contexts, and argument sources when two sessions for the
      // same project happen to close together.
      const latest = this.loadPath(this.path);
      const full = latest === null
        ? incoming
        : mergePersistedState(latest, incoming, this.baseline ?? undefined);
      writeFileSync(tmp, JSON.stringify(full), { mode: 0o600 });
      renameSync(tmp, this.path);
      // The in-memory learner/metrics correspond to incoming, not to entities
      // unioned from another process. Keep that as the next delta baseline.
      this.baseline = incoming;
      return true;
    } catch (err) {
      if (!this.warnedSaveFailure) {
        this.warnedSaveFailure = true;
        process.stderr.write(
          `[speculate] state save failed (will keep retrying silently): ${(err as Error).message}\n`,
        );
      }
      return false;
    } finally {
      if (lockFd !== null) {
        try { closeSync(lockFd); } catch {}
        try { unlinkSync(lockPath); } catch {}
      }
      try { unlinkSync(tmp); } catch {}
    }
  }
}

const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;

/** Small bounded synchronous lock: saves happen only during periodic flush/close. */
function acquireLock(path: string, _now: () => number): number | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() <= deadline) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {}
      Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS);
    }
  }
  return null;
}

/**
 * Monotonic, fail-soft merge for concurrently saved v1 snapshots. It does
 * not attempt to reconstruct event order; it guarantees that independently
 * learned entities and richer template/context evidence are not erased by a
 * stale last writer.
 */
export function mergePersistedState(
  existing: PersistedState,
  incoming: PersistedState,
  baseline?: PersistedState,
): PersistedState {
  const savedAt = Math.max(existing.savedAt, incoming.savedAt);
  return {
    version: STATE_VERSION,
    savedAt,
    ...(incoming.scope !== undefined ? { scope: incoming.scope } : {}),
    learner: mergeLearner(existing.learner, incoming.learner),
    ruleFeedback: mergeFeedback(
      existing.ruleFeedback,
      incoming.ruleFeedback,
      baseline?.ruleFeedback,
      incoming.savedAt,
    ),
    ...(existing.latency !== undefined || incoming.latency !== undefined
      ? {
          latency: mergeLatencySnapshots(
            existing.latency,
            incoming.latency,
            baseline?.latency,
            savedAt,
          ),
        }
      : {}),
    ...(existing.candidateFeedback !== undefined || incoming.candidateFeedback !== undefined
      ? {
          candidateFeedback: mergeCandidateFeedbackSnapshots(
            existing.candidateFeedback,
            incoming.candidateFeedback,
            baseline?.candidateFeedback,
            savedAt,
          ),
        }
      : {}),
  };
}

function mergeFeedback(
  a: Record<string, RuleFeedbackSnapshot>,
  b: Record<string, RuleFeedbackSnapshot>,
  baseline: Record<string, RuleFeedbackSnapshot> | undefined,
  now: number,
): Record<string, RuleFeedbackSnapshot> {
  const out: Record<string, RuleFeedbackSnapshot> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    if (!left) out[key] = { ...right! };
    else if (!right) out[key] = { ...left };
    else if (baseline) {
      const base = baseline[key];
      const atNow = (value: RuleFeedbackSnapshot | undefined, field: 'hits' | 'wasted' | 'speculated'): number => {
        if (!value) return 0;
        const stamp = value.lastUpdated;
        const factor = typeof stamp === 'number' && Number.isFinite(stamp)
          ? Math.exp(-Math.max(0, now - stamp) / (14 * 24 * 60 * 60_000))
          : 0.5;
        return Math.max(0, numeric(value[field])) * factor;
      };
      const mergeField = (field: 'hits' | 'wasted' | 'speculated'): number =>
        atNow(left, field) + Math.max(0, numeric(right[field]) - atNow(base, field));
      out[key] = {
        hits: mergeField('hits'),
        wasted: mergeField('wasted'),
        speculated: mergeField('speculated'),
        lastUpdated: now,
      };
    } else {
      out[key] = {
        hits: Math.max(left.hits, right.hits),
        wasted: Math.max(left.wasted, right.wasted),
        speculated: Math.max(left.speculated, right.speculated),
        lastUpdated: Math.max(left.lastUpdated ?? 0, right.lastUpdated ?? 0),
      };
    }
  }
  return out;
}

interface LearnerEnvelope {
  transitions: Record<string, unknown>[];
  openers?: Record<string, unknown>[];
}

function learnerEnvelope(value: unknown): LearnerEnvelope | null {
  if (value === null || typeof value !== 'object') return null;
  const root = value as { transitions?: unknown; openers?: unknown };
  if (!Array.isArray(root.transitions)) return null;
  return {
    transitions: root.transitions.filter(isRecord),
    ...(Array.isArray(root.openers) ? { openers: root.openers.filter(isRecord) } : {}),
  };
}

function mergeLearner(a: unknown, b: unknown): unknown {
  const left = learnerEnvelope(a);
  const right = learnerEnvelope(b);
  if (!left) return b;
  if (!right) return a;
  return {
    transitions: mergeEntityList(left.transitions, right.transitions, transitionKey, mergeTransition),
    ...((left.openers?.length ?? 0) + (right.openers?.length ?? 0) > 0
      ? {
          openers: mergeEntityList(
            left.openers ?? [],
            right.openers ?? [],
            openerKey,
            preferEvidence,
          ),
        }
      : {}),
  };
}

function mergeTransition(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const winner = preferEvidence(a, b);
  const loser = winner === a ? b : a;
  const templatesA = Array.isArray(a.templates) ? a.templates.filter(isRecord) : [];
  const templatesB = Array.isArray(b.templates) ? b.templates.filter(isRecord) : [];
  const contextsA = Array.isArray(a.contexts) ? a.contexts.filter(isRecord) : [];
  const contextsB = Array.isArray(b.contexts) ? b.contexts.filter(isRecord) : [];
  return {
    ...loser,
    ...winner,
    templates: mergeEntityList(templatesA, templatesB, (item) => stringField(item, 'name'), mergeTemplate),
    ...((contextsA.length + contextsB.length) > 0
      ? { contexts: mergeEntityList(contextsA, contextsB, (item) => stringField(item, 'key'), preferEvidence) }
      : {}),
  };
}

function mergeTemplate(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const winner = numeric(a.derived) + numeric(a.missed) >= numeric(b.derived) + numeric(b.missed) ? a : b;
  const loser = winner === a ? b : a;
  const sourcesA = Array.isArray(a.sources) ? a.sources.filter(isRecord) : [];
  const sourcesB = Array.isArray(b.sources) ? b.sources.filter(isRecord) : [];
  return {
    ...loser,
    ...winner,
    derived: Math.max(numeric(a.derived), numeric(b.derived)),
    missed: Math.max(numeric(a.missed), numeric(b.missed)),
    sources: mergeEntityList(sourcesA, sourcesB, sourceKey, preferEvidence),
  };
}

function mergeEntityList(
  a: Record<string, unknown>[],
  b: Record<string, unknown>[],
  keyOf: (value: Record<string, unknown>) => string,
  merge: (a: Record<string, unknown>, b: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] {
  const out = new Map<string, Record<string, unknown>>();
  for (const value of [...a, ...b]) {
    const key = keyOf(value);
    const prior = out.get(key);
    out.set(key, prior ? merge(prior, value) : { ...value });
  }
  return [...out.values()];
}

function preferEvidence(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const evidenceA = numeric(a.count) || numeric(a.solo) || numeric(a.score);
  const evidenceB = numeric(b.count) || numeric(b.solo) || numeric(b.score);
  if (evidenceA !== evidenceB) return evidenceA > evidenceB ? a : b;
  return numeric(a.lastUpdated) >= numeric(b.lastUpdated) ? a : b;
}

function transitionKey(value: Record<string, unknown>): string {
  return `${stringField(value, 'server')}\0${stringField(value, 'prevTool')}\0${stringField(value, 'nextTool')}`;
}

function openerKey(value: Record<string, unknown>): string {
  return `${stringField(value, 'server')}\0${stringField(value, 'tool')}\0${stringField(value, 'argsRepr')}`;
}

function sourceKey(value: Record<string, unknown>): string {
  return JSON.stringify([
    value.kind,
    value.key,
    value.path,
    value.transform,
    value.prefix,
    value.suffix,
    value.repr,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Default state-file location for a given config file: one state file per
 * config (≈ per project), under XDG state dir. Moving the config starts a
 * fresh state file — acceptable for an optimization cache.
 */
export function defaultStatePath(configPath: string): string {
  const abs = isAbsolute(configPath) ? configPath : resolve(configPath);
  return defaultStatePathForKey(abs);
}

/**
 * State path for config-less runs (`speculate wrap`): keyed by whatever
 * stable identity string the caller derives (e.g. the wrapped command line).
 */
export function defaultStatePathForKey(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(defaultStateDirectory(), `state-${hash}.json`);
}

export function defaultStateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome =
    xdg && xdg.length > 0 && isAbsolute(xdg)
      ? xdg // XDG spec: relative values are to be ignored
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state');
  return join(stateHome, 'speculate');
}
