/**
 * Learned memory, encoded for the plugin store (DESIGN.md §13.6).
 *
 * What persists: the transition learner's model (tool names + argument
 * templates, including constant argument values), per-rule feedback, latency
 * aggregates, and what each tool turned out to be (read-only or not, and the
 * argument key shapes it was called with). What NEVER persists: tool results.
 * The speculation cache is memory-only by design (§6.4).
 *
 * The codec is pure: the mod hands it whatever `$.store` returned and writes
 * whatever it returns. Every malformed input decodes as a cold start, never
 * an error. Concurrent sessions share one store value, so a save merges into
 * the latest stored value instead of overwriting another session's learning.
 */
import { mergeLatencySnapshots, type LatencySnapshot } from './latency.js';
import {
  mergeCandidateFeedbackSnapshots,
  type CandidateFeedbackSnapshot,
} from './calibration.js';
import { createSecretGuard, sanitizeLearnerState, type SecretGuard } from './privacy.js';
import { mergeToolFacts, sanitizeToolFacts, type ToolFacts } from './tools.js';

export const DEFAULT_RETENTION_DAYS = 30;
/** The plugin store holds 4 MiB in all; learned memory keeps headroom under it. */
export const DEFAULT_MAX_STATE_BYTES = 3_145_728;

export interface PersistencePolicy {
  retentionDays?: number;
  maxBytes?: number;
}

export interface MemoryDiagnostics {
  removedSensitive: number;
  removedExpired: number;
  removedInvalid: number;
  trimmedForSize: number;
  oversizedReads: number;
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
  learner: unknown;
  ruleFeedback: Record<string, RuleFeedbackSnapshot>;
  /** Aggregate target latency only; no arguments, results, or cache keys. */
  latency?: LatencySnapshot;
  /** Shadow correctness by stable rule/alternative ID. */
  candidateFeedback?: Record<string, CandidateFeedbackSnapshot>;
  /** Read-only verdicts and argument key shapes per tool; never values. */
  tools?: ToolFacts;
  /** Aggregate privacy/retention actions only; never includes removed data. */
  memory?: Pick<MemoryDiagnostics, 'removedSensitive' | 'removedExpired' | 'removedInvalid' | 'trimmedForSize'> & {
    retentionDays?: number;
    maxBytes?: number;
  };
}

/** What a session hands the codec to save. */
export interface MemorySnapshot {
  learner: unknown;
  ruleFeedback: Record<string, RuleFeedbackSnapshot>;
  latency?: LatencySnapshot;
  candidateFeedback?: Record<string, CandidateFeedbackSnapshot>;
  tools?: ToolFacts;
}

const STATE_VERSION = 1 as const;

export class MemoryCodec {
  /** This session's own last-loaded/saved view, used to isolate feedback deltas. */
  private baseline: PersistedState | null = null;
  private readonly retentionMs: number;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  readonly diagnostics: MemoryDiagnostics = {
    removedSensitive: 0,
    removedExpired: 0,
    removedInvalid: 0,
    trimmedForSize: 0,
    oversizedReads: 0,
  };

  constructor(
    private readonly now: () => number = Date.now,
    policy: PersistencePolicy = {},
  ) {
    const retentionDays = validRetentionDays(policy.retentionDays);
    this.retentionDays = retentionDays;
    this.retentionMs = retentionDays * 24 * 60 * 60_000;
    this.maxBytes = validMaxBytes(policy.maxBytes);
  }

  /** Decodes a stored value and adopts it as this session's baseline. */
  load(raw: unknown): PersistedState | null {
    this.baseline = this.decode(raw);
    return this.baseline;
  }

  /**
   * The value to store: this session's snapshot merged into `latest`, the
   * value the store holds now (another session may have saved since load).
   */
  encode(snapshot: MemorySnapshot, latest: unknown): PersistedState {
    const incoming = this.sanitize({
      version: STATE_VERSION,
      savedAt: this.now(),
      ...snapshot,
    });
    const stored = this.decode(latest);
    const merged = stored === null
      ? incoming
      : mergePersistedState(stored, incoming, this.baseline ?? undefined);
    // The in-memory learner corresponds to incoming, not to entities unioned
    // from another session. Keep that as the next delta baseline.
    this.baseline = incoming;
    return this.fit(this.sanitize(merged));
  }

  private decode(raw: unknown): PersistedState | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const data = raw as PersistedState;
    if (
      data.version !== STATE_VERSION ||
      data.ruleFeedback === null ||
      typeof data.ruleFeedback !== 'object' ||
      Array.isArray(data.ruleFeedback)
    ) {
      return null;
    }
    try {
      if (byteLength(data) > this.maxBytes * 2) {
        this.diagnostics.oversizedReads++;
        return null;
      }
      return this.sanitize(data);
    } catch {
      return null;
    }
  }

  private sanitize(state: PersistedState): PersistedState {
    const beforeSensitive = this.diagnostics.removedSensitive;
    const beforeExpired = this.diagnostics.removedExpired;
    const beforeInvalid = this.diagnostics.removedInvalid;
    const now = this.now();
    const cutoff = now - this.retentionMs;
    const fallbackStamp = finiteStamp(state.savedAt) ? state.savedAt : now;
    const guard = createSecretGuard();
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
    const tools = sanitizeToolFacts(state.tools, cutoff, guard);
    this.diagnostics.removedSensitive += tools.removedSensitive;
    this.diagnostics.removedExpired += tools.removedExpired;
    const prior = state.memory;
    return {
      version: STATE_VERSION,
      savedAt: finiteStamp(state.savedAt) ? state.savedAt : now,
      learner: learner.value,
      ruleFeedback,
      ...(latency !== undefined ? { latency: latency as LatencySnapshot } : {}),
      ...(Object.keys(candidateFeedback).length > 0 ? { candidateFeedback } : {}),
      ...(Object.keys(tools.value).length > 0 ? { tools: tools.value } : {}),
      memory: {
        removedSensitive: Math.max(0, numeric(prior?.removedSensitive)) +
          (this.diagnostics.removedSensitive - beforeSensitive),
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
    const size = (): number => byteLength(state);
    if (size() <= this.maxBytes) return state;
    const learner = state.learner as { transitions: Record<string, unknown>[]; openers: Record<string, unknown>[] };
    // Each candidate carries its own serialized size, so trimming subtracts
    // instead of re-serializing the whole state after every removal (which
    // is quadratic, and runs inside a hook's time budget). Array entries are
    // marked and filtered once at the end for the same reason.
    const candidates: Array<{ stamp: number; score: number; key: string; bytes: number; remove: () => void }> = [];
    const dropped = new Set<Record<string, unknown>>();
    learner.transitions.forEach((item) => candidates.push({
      stamp: numeric(item['lastUpdated']), score: numeric(item['score']) || numeric(item['count']),
      key: `transition:${String(item['server'])}:${String(item['prevTool'])}:${String(item['nextTool'])}`,
      bytes: byteLength(item), remove: () => { dropped.add(item); },
    }));
    learner.openers.forEach((item, index) => candidates.push({
      stamp: numeric(item['lastUpdated']), score: numeric(item['score']) || numeric(item['count']),
      key: `opener:${String(item['server'])}:${String(item['tool'])}:${index}`,
      bytes: byteLength(item), remove: () => { dropped.add(item); },
    }));
    for (const [key, value] of Object.entries(state.ruleFeedback)) candidates.push({
      stamp: value.lastUpdated ?? state.savedAt, score: value.hits + value.speculated,
      key: `feedback:${key}`, bytes: byteLength(key) + byteLength(value),
      remove: () => { delete state.ruleFeedback[key]; },
    });
    for (const [key, value] of Object.entries(state.candidateFeedback ?? {})) candidates.push({
      stamp: value.lastUpdated, score: value.evaluated,
      key: `candidate:${key}`, bytes: byteLength(key) + byteLength(value),
      remove: () => { delete state.candidateFeedback?.[key]; },
    });
    // A tool fact is cheap and re-learned on the tool's next real call, so it
    // goes before anything with evidence behind it, least recently seen first.
    for (const [server, byTool] of Object.entries(state.tools ?? {})) {
      for (const [tool, fact] of Object.entries(byTool)) candidates.push({
        stamp: fact.lastSeen, score: 0,
        key: `tool:${server}:${tool}`, bytes: byteLength(tool) + byteLength(fact),
        remove: () => {
          const tools = state.tools;
          if (!tools?.[server]) return;
          delete tools[server][tool];
          if (Object.keys(tools[server]).length === 0) delete tools[server];
        },
      });
    }
    candidates.sort((a, b) => a.score - b.score || a.stamp - b.stamp || a.key.localeCompare(b.key));
    // `estimate` never falls below the true size: removing an entry shrinks
    // the JSON by at least the entry's own bytes. So stopping only once the
    // exact size confirms it never stops early.
    let estimate = size();
    for (const candidate of candidates) {
      if (estimate <= this.maxBytes) {
        if (dropped.size > 0) {
          learner.transitions = learner.transitions.filter((item) => !dropped.has(item));
          learner.openers = learner.openers.filter((item) => !dropped.has(item));
          dropped.clear();
        }
        estimate = size();
        if (estimate <= this.maxBytes) break;
      }
      candidate.remove();
      estimate -= candidate.bytes;
      this.diagnostics.trimmedForSize++;
      if (state.memory) state.memory.trimmedForSize++;
    }
    if (dropped.size > 0) {
      learner.transitions = learner.transitions.filter((item) => !dropped.has(item));
      learner.openers = learner.openers.filter((item) => !dropped.has(item));
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
      delete state.tools;
      this.diagnostics.trimmedForSize++;
      if (state.memory) state.memory.trimmedForSize++;
    }
    return state;
  }
}

function validRetentionDays(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 1 && value! <= 3650 ? value! : DEFAULT_RETENTION_DAYS;
}

function validMaxBytes(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 65_536 && value! <= DEFAULT_MAX_STATE_BYTES
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
    ...(existing.tools !== undefined || incoming.tools !== undefined
      ? { tools: mergeToolFacts(existing.tools, incoming.tools) }
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

/** UTF-8 size of the value's JSON text. */
export function byteLength(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
