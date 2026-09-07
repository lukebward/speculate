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
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mergeLatencySnapshots, type LatencySnapshot } from './latency.js';
import {
  mergeCandidateFeedbackSnapshots,
  type CandidateFeedbackSnapshot,
} from './calibration.js';
import { createSecretGuard, sanitizeLearnerState, type SecretGuard } from './privacy.js';

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_STATE_BYTES = 8_388_608;

export interface PersistencePolicy {
  retentionDays?: number;
  maxBytes?: number;
  /** Resolved credentials used only for exact in-memory filtering/redaction. */
  secretValues?: readonly string[] | (() => readonly string[]);
}

export interface MemoryDiagnostics {
  removedSensitive: number;
  removedExpired: number;
  removedInvalid: number;
  trimmedForSize: number;
  oversizedReads: number;
  staleGenerationSaves: number;
}

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
  /** Aggregate privacy/retention actions only; never includes removed data. */
  memory?: Pick<MemoryDiagnostics, 'removedSensitive' | 'removedExpired' | 'removedInvalid' | 'trimmedForSize'> & {
    retentionDays?: number;
    maxBytes?: number;
  };
}

const STATE_VERSION = 1 as const;

export class StateStore {
  private warnedSaveFailure = false;
  /** This process's own last-loaded/saved view, used to isolate feedback deltas. */
  private baseline: PersistedState | null = null;
  private generation: string | null = null;
  private directoryGeneration: string | null = null;
  private readonly retentionMs: number;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly secretValues: readonly string[] | (() => readonly string[]);
  private readonly knownSecretValues: string[] = [];
  readonly diagnostics: MemoryDiagnostics = {
    removedSensitive: 0,
    removedExpired: 0,
    removedInvalid: 0,
    trimmedForSize: 0,
    oversizedReads: 0,
    staleGenerationSaves: 0,
  };

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly fallbackPaths: readonly string[] = [],
    private readonly expectedScope?: string,
    policy: PersistencePolicy = {},
  ) {
    const retentionDays = validRetentionDays(policy.retentionDays);
    this.retentionDays = retentionDays;
    this.retentionMs = retentionDays * 24 * 60 * 60_000;
    this.maxBytes = validMaxBytes(policy.maxBytes);
    this.secretValues = policy.secretValues ?? [];
  }

  /** null on missing/corrupt/version-mismatch — cold start, never an error. */
  load(): PersistedState | null {
    this.generation = readStateGeneration(this.path);
    this.directoryGeneration = readStateDirectoryGeneration(dirname(this.path));
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
      if (statSync(path).size > this.maxBytes) {
        this.diagnostics.oversizedReads++;
        return null;
      }
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
      return this.sanitize(data);
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
    if (this.generation === null) this.generation = readStateGeneration(this.path);
    if (this.directoryGeneration === null) {
      this.directoryGeneration = readStateDirectoryGeneration(dirname(this.path));
    }
    if (readStateGeneration(this.path) !== this.generation ||
      readStateDirectoryGeneration(dirname(this.path)) !== this.directoryGeneration) {
      this.diagnostics.staleGenerationSaves++;
      return true;
    }
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const lockPath = `${this.path}.lock`;
    let lockFd: number | null = null;
    const directoryLockPath = stateDirectoryLockPath(dirname(this.path));
    let directoryLockFd: number | null = null;
    try {
      const incoming = this.sanitize({
        version: STATE_VERSION,
        savedAt: this.now(),
        ...(this.expectedScope !== undefined ? { scope: this.expectedScope } : {}),
        learner: state.learner,
        ruleFeedback: state.ruleFeedback,
        ...(state.latency !== undefined ? { latency: state.latency } : {}),
        ...(state.candidateFeedback !== undefined
          ? { candidateFeedback: state.candidateFeedback }
          : {}),
      });
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      directoryLockFd = acquireLock(directoryLockPath, this.now);
      if (directoryLockFd === null) throw new Error('state directory is busy in another process');
      lockFd = acquireLock(lockPath, this.now);
      if (lockFd === null) throw new Error('state file is busy in another process');
      if (readStateGeneration(this.path) !== this.generation ||
        readStateDirectoryGeneration(dirname(this.path)) !== this.directoryGeneration) {
        this.diagnostics.staleGenerationSaves++;
        return true;
      }
      // Serialize the read/merge/rename section. Independent projects are
      // already isolated by their state keys; this preserves disjoint rules,
      // transitions, contexts, and argument sources when two sessions for the
      // same project happen to close together.
      const latest = this.loadPath(this.path);
      const merged = latest === null
        ? incoming
        : mergePersistedState(latest, incoming, this.baseline ?? undefined);
      const full = this.fit(this.sanitize(merged));
      const serialized = JSON.stringify(full);
      writeFileSync(tmp, serialized, { mode: 0o600 });
      renameSync(tmp, this.path);
      // The in-memory learner/metrics correspond to incoming, not to entities
      // unioned from another process. Keep that as the next delta baseline.
      this.baseline = incoming;
      return true;
    } catch (err) {
      if (!this.warnedSaveFailure) {
        this.warnedSaveFailure = true;
        const code = (err as NodeJS.ErrnoException).code;
        process.stderr.write(
          `[speculate] state save failed${code ? ` (${code})` : ''}; will keep retrying silently\n`,
        );
      }
      return false;
    } finally {
      if (lockFd !== null) {
        try { closeSync(lockFd); } catch {}
        try { unlinkSync(lockPath); } catch {}
      }
      if (directoryLockFd !== null) {
        try { closeSync(directoryLockFd); } catch {}
        try { unlinkSync(directoryLockPath); } catch {}
      }
      try { unlinkSync(tmp); } catch {}
    }
  }

  private sanitize(state: PersistedState): PersistedState {
    const beforeExpired = this.diagnostics.removedExpired;
    const beforeInvalid = this.diagnostics.removedInvalid;
    const now = this.now();
    const cutoff = now - this.retentionMs;
    const fallbackStamp = finiteStamp(state.savedAt) ? state.savedAt : now;
    const currentSecrets = typeof this.secretValues === 'function'
      ? this.secretValues()
      : this.secretValues;
    for (const secret of currentSecrets) {
      if (!this.knownSecretValues.includes(secret)) this.knownSecretValues.push(secret);
    }
    if (this.knownSecretValues.length > 1_024) {
      this.knownSecretValues.splice(0, this.knownSecretValues.length - 1_024);
    }
    const guard = createSecretGuard(this.knownSecretValues);
    const learner = sanitizeLearnerState(state.learner, {
      guard,
      now,
      cutoff,
      fallbackTimestamp: fallbackStamp,
    });
    this.diagnostics.removedSensitive += learner.removedSensitive;
    this.diagnostics.removedExpired += learner.removedExpired;
    this.diagnostics.removedInvalid += learner.removedInvalid;
    const ruleFeedback = sanitizeRuleFeedback(
      state.ruleFeedback, cutoff, fallbackStamp, this.diagnostics, guard,
    );
    const latency = sanitizeLatency(state.latency, cutoff, fallbackStamp, this.diagnostics, guard);
    const candidateFeedback = sanitizeCandidateFeedback(
      state.candidateFeedback,
      cutoff,
      fallbackStamp,
      this.diagnostics,
      guard,
    );
    const prior = state.memory;
    return {
      version: STATE_VERSION,
      savedAt: finiteStamp(state.savedAt) ? state.savedAt : now,
      ...(state.scope !== undefined ? { scope: state.scope } : {}),
      learner: learner.value,
      ruleFeedback,
      ...(latency !== undefined ? { latency: latency as LatencySnapshot } : {}),
      ...(Object.keys(candidateFeedback).length > 0 ? { candidateFeedback } : {}),
      memory: {
        removedSensitive: Math.max(0, numeric(prior?.removedSensitive)) + learner.removedSensitive,
        removedExpired: Math.max(0, numeric(prior?.removedExpired)) +
          (this.diagnostics.removedExpired - beforeExpired),
        removedInvalid: Math.max(0, numeric(prior?.removedInvalid)) +
          (this.diagnostics.removedInvalid - beforeInvalid),
        trimmedForSize: Math.max(0, numeric(prior?.trimmedForSize)),
        retentionDays: this.retentionDays,
        maxBytes: this.maxBytes,
      },
    };
  }

  private fit(state: PersistedState): PersistedState {
    const size = (): number => Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (size() <= this.maxBytes) return state;
    const learner = state.learner as { transitions: Record<string, unknown>[]; openers: Record<string, unknown>[] };
    const candidates: Array<{ stamp: number; score: number; key: string; remove: () => void }> = [];
    learner.transitions.forEach((item) => candidates.push({
      stamp: numeric(item['lastUpdated']), score: numeric(item['score']) || numeric(item['count']),
      key: `transition:${String(item['server'])}:${String(item['prevTool'])}:${String(item['nextTool'])}`,
      remove: () => { const index = learner.transitions.indexOf(item); if (index >= 0) learner.transitions.splice(index, 1); },
    }));
    learner.openers.forEach((item, index) => candidates.push({
      stamp: numeric(item['lastUpdated']), score: numeric(item['score']) || numeric(item['count']),
      key: `opener:${String(item['server'])}:${String(item['tool'])}:${index}`,
      remove: () => { const at = learner.openers.indexOf(item); if (at >= 0) learner.openers.splice(at, 1); },
    }));
    for (const [key, value] of Object.entries(state.ruleFeedback)) candidates.push({
      stamp: value.lastUpdated ?? state.savedAt, score: value.hits + value.speculated,
      key: `feedback:${key}`, remove: () => { delete state.ruleFeedback[key]; },
    });
    for (const [key, value] of Object.entries(state.candidateFeedback ?? {})) candidates.push({
      stamp: value.lastUpdated, score: value.evaluated,
      key: `candidate:${key}`, remove: () => { delete state.candidateFeedback?.[key]; },
    });
    candidates.sort((a, b) => a.score - b.score || a.stamp - b.stamp || a.key.localeCompare(b.key));
    // Removal closures find the same object again after earlier array removals.
    for (const candidate of candidates) {
      if (size() <= this.maxBytes) break;
      candidate.remove();
      this.diagnostics.trimmedForSize++;
      if (state.memory) state.memory.trimmedForSize++;
    }
    // Latency is useful but optional; if all prediction entities were not enough,
    // discard it as one deterministic block before falling back to empty memory.
    if (size() > this.maxBytes && state.latency !== undefined) {
      delete state.latency;
      this.diagnostics.trimmedForSize++;
      if (state.memory) state.memory.trimmedForSize++;
    }
    if (size() > this.maxBytes) {
      learner.transitions = [];
      learner.openers = [];
      state.ruleFeedback = {};
      delete state.candidateFeedback;
    }
    return state;
  }
}

function validRetentionDays(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 1 && value! <= 3650 ? value! : DEFAULT_RETENTION_DAYS;
}

function validMaxBytes(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 65_536 && value! <= 67_108_864
    ? value!
    : DEFAULT_MAX_STATE_BYTES;
}

function finiteStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sanitizeRuleFeedback(
  raw: unknown,
  cutoff: number,
  fallback: number,
  diagnostics: MemoryDiagnostics,
  guard: SecretGuard,
): Record<string, RuleFeedbackSnapshot> {
  if (!isRecord(raw)) return {};
  const out: Record<string, RuleFeedbackSnapshot> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || key.length === 0 || key.length > 2048 || guard.isSensitive(key)) {
      if (guard.isSensitive(key)) diagnostics.removedSensitive++; else diagnostics.removedInvalid++;
      continue;
    }
    const stamp = finiteStamp(value['lastUpdated']) ? value['lastUpdated'] : fallback;
    if (stamp < cutoff) { diagnostics.removedExpired++; continue; }
    if (!finiteStamp(value['hits']) || !finiteStamp(value['wasted']) || !finiteStamp(value['speculated'])) {
      diagnostics.removedInvalid++;
      continue;
    }
    out[key] = {
      hits: value['hits'], wasted: value['wasted'], speculated: value['speculated'],
      ...(finiteStamp(value['lastUpdated']) ? { lastUpdated: stamp } : {}),
    };
  }
  return out;
}

function sanitizeCandidateFeedback(
  raw: unknown,
  cutoff: number,
  fallback: number,
  diagnostics: MemoryDiagnostics,
  guard: SecretGuard,
): Record<string, CandidateFeedbackSnapshot> {
  if (!isRecord(raw)) return {};
  const out: Record<string, CandidateFeedbackSnapshot> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || key.length === 0 || key.length > 2048 || guard.isSensitive(key)) {
      if (guard.isSensitive(key)) diagnostics.removedSensitive++; else diagnostics.removedInvalid++;
      continue;
    }
    const stamp = finiteStamp(value['lastUpdated']) ? value['lastUpdated'] : fallback;
    if (stamp < cutoff) { diagnostics.removedExpired++; continue; }
    if (!finiteStamp(value['correct']) || !finiteStamp(value['evaluated']) ||
      value['correct'] > value['evaluated'] || !finiteStamp(value['lastUpdated'])) {
      diagnostics.removedInvalid++;
      continue;
    }
    out[key] = { correct: value['correct'], evaluated: value['evaluated'], lastUpdated: stamp };
  }
  return out;
}

function sanitizeLatency(
  raw: unknown,
  cutoff: number,
  fallback: number,
  diagnostics: MemoryDiagnostics,
  guard: SecretGuard,
): unknown {
  if (!isRecord(raw) || raw['version'] !== 1) return undefined;
  const clean = (values: unknown, tool: boolean): Record<string, unknown>[] => (Array.isArray(values) ? values : [])
    .filter((entry): entry is Record<string, unknown> => {
      if (!isRecord(entry) || typeof entry['server'] !== 'string' ||
        (tool && typeof entry['tool'] !== 'string') || guard.isSensitive(entry['server']) ||
        (tool && guard.isSensitive(entry['tool']))) {
        diagnostics.removedInvalid++;
        return false;
      }
      for (const field of ['weight', 'meanMs', 'm2Ms2', 'observations']) {
        if (!finiteStamp(entry[field])) { diagnostics.removedInvalid++; return false; }
      }
      const keep = (finiteStamp(entry['lastUpdated']) ? entry['lastUpdated'] : fallback) >= cutoff;
      if (!keep) diagnostics.removedExpired++;
      return keep;
    })
    .map((entry) => ({
      server: entry['server'],
      ...(tool ? { tool: entry['tool'] } : {}),
      weight: entry['weight'], meanMs: entry['meanMs'], m2Ms2: entry['m2Ms2'],
      observations: entry['observations'],
      lastUpdated: finiteStamp(entry['lastUpdated']) ? entry['lastUpdated'] : fallback,
    }));
  return { version: 1, tools: clean(raw['tools'], true), servers: clean(raw['servers'], false) };
}

const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;

export function stateGenerationPath(path: string): string {
  return `${path}.generation`;
}

export function readStateGeneration(path: string): string {
  return readGenerationMarker(stateGenerationPath(path));
}

export function stateDirectoryGenerationPath(directory: string): string {
  return join(directory, '.generation');
}

export function stateDirectoryLockPath(directory: string): string {
  return join(directory, '.memory.lock');
}

export function readStateDirectoryGeneration(directory: string): string {
  return readGenerationMarker(stateDirectoryGenerationPath(directory));
}

function readGenerationMarker(marker: string): string {
  try {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024) return `invalid:${stat.size}:${stat.mtimeMs}`;
    return readFileSync(marker, 'utf8');
  } catch {
    return '';
  }
}

/** Hold the state-directory writer lock and advance its clear generation. */
export function clearPersistedStateDirectory<T>(
  directory: string,
  action: () => T,
): { acquired: true; value: T } | { acquired: false; error: string } {
  const marker = stateDirectoryGenerationPath(directory);
  const markerTmp = `${marker}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let lockFd: number | null = null;
  try {
    if (!safeStateParent(directory)) {
      return { acquired: false, error: 'state directory is linked or invalid' };
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(marker)) {
      const stat = lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { acquired: false, error: 'directory generation marker is not a regular file' };
      }
    }
    lockFd = acquireLock(stateDirectoryLockPath(directory), Date.now);
    if (lockFd === null) return { acquired: false, error: 'state directory is busy' };
    if (existsSync(marker)) {
      const stat = lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { acquired: false, error: 'directory generation marker is not a regular file' };
      }
    }
    // Prepare the new generation before mutation so an inability to create it
    // leaves the old state untouched.
    writeFileSync(markerTmp, randomUUID(), { flag: 'wx', mode: 0o600 });
    const value = action();
    try { unlinkSync(marker); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    renameSync(markerTmp, marker);
    return { acquired: true, value };
  } catch (error) {
    return { acquired: false, error: (error as Error).message };
  } finally {
    try { unlinkSync(markerTmp); } catch {}
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch {}
      try { unlinkSync(stateDirectoryLockPath(directory)); } catch {}
    }
  }
}

export interface ClearStateResult {
  cleared: boolean;
  skipped: boolean;
  error?: string;
}

/** Clear one exact regular state file and invalidate stores that loaded it. */
export function clearPersistedState(path: string): ClearStateResult {
  const lockPath = `${path}.lock`;
  let lockFd: number | null = null;
  const marker = stateGenerationPath(path);
  const markerTmp = `${marker}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    if (!safeStateParent(dirname(path))) {
      return { cleared: false, skipped: true, error: 'state parent is linked or not a directory' };
    }
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return { cleared: false, skipped: true, error: 'not a regular file' };
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(marker)) {
      const markerStat = lstatSync(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        return { cleared: false, skipped: true, error: 'generation marker is not a regular file' };
      }
    }
    lockFd = acquireLock(lockPath, Date.now);
    if (lockFd === null) return { cleared: false, skipped: true, error: 'state file is busy' };
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { cleared: false, skipped: true, error: 'not a regular file' };
      }
    }
    if (existsSync(marker)) {
      const markerStat = lstatSync(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        return { cleared: false, skipped: true, error: 'generation marker is not a regular file' };
      }
    }
    // Prepare the replacement before deleting state. If the directory cannot
    // create a secure marker, the old state remains intact.
    writeFileSync(markerTmp, randomUUID(), { flag: 'wx', mode: 0o600 });
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { unlinkSync(marker); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    renameSync(markerTmp, marker);
    const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tmpPattern = new RegExp(
      `^${escaped}(?:\\.\\d+\\.\\d+(?:\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?)?\\.tmp$`,
      'i',
    );
    for (const entry of readdirSync(dirname(path))) {
      if (!tmpPattern.test(entry)) continue;
      try {
        const candidate = join(dirname(path), entry);
        const stat = lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(candidate);
      } catch {}
    }
    return { cleared: true, skipped: false };
  } catch (error) {
    return { cleared: false, skipped: false, error: (error as Error).message };
  } finally {
    try { unlinkSync(markerTmp); } catch {}
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

function safeStateParent(path: string): boolean {
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const stat = lstatSync(existing);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const actual = realpathSync(existing);
    return process.platform === 'win32'
      ? actual.toLowerCase() === existing.toLowerCase()
      : actual === existing;
  } catch {
    return false;
  }
}

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
    ...((existing.memory !== undefined || incoming.memory !== undefined)
      ? {
          memory: {
            removedSensitive: Math.max(existing.memory?.removedSensitive ?? 0, incoming.memory?.removedSensitive ?? 0),
            removedExpired: Math.max(existing.memory?.removedExpired ?? 0, incoming.memory?.removedExpired ?? 0),
            removedInvalid: Math.max(existing.memory?.removedInvalid ?? 0, incoming.memory?.removedInvalid ?? 0),
            trimmedForSize: Math.max(existing.memory?.trimmedForSize ?? 0, incoming.memory?.trimmedForSize ?? 0),
            retentionDays: incoming.memory?.retentionDays ?? existing.memory?.retentionDays,
            maxBytes: incoming.memory?.maxBytes ?? existing.memory?.maxBytes,
          },
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
    value.sourceTool,
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
