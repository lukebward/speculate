/**
 * Tier 2 — learned transition model (DESIGN.md §5.3).
 *
 * A session-scoped, in-memory, server-agnostic model of tool-call
 * transitions: it watches the stream of served real calls, learns which
 * tool tends to follow which (per server), and learns how the next call's
 * arguments derive from the previous call (argument templates). Works on
 * any MCP server with zero configuration; cold-start is simply "no
 * predictions yet".
 *
 * Fail-closed by construction: an argument whose provenance can't be
 * derived consistently poisons its transition, and predict() never emits
 * partially materialized args. Neither observe() nor predict() ever
 * throws — weird result shapes degrade to fewer/no candidates.
 *
 * Dependency-free besides types.js/keys.js. No metrics, no logging.
 */
import { stableStringify } from './keys.js';
import type { ObservedCall, Prediction } from './types.js';

export interface TransitionLearnerOptions {
  /** Injectable clock (LRU recency only — gap math uses call timestamps). */
  now?: () => number;
  /** Max prev→next spacing (ms, by call timestamps) to count as a transition. */
  maxGapMs?: number;
  /** Observations of a transition required before it may predict. */
  minObservations?: number;
  /** Cap on predictions returned per trigger call. */
  maxPredictionsPerTrigger?: number;
  /** LRU cap on tracked transitions. */
  maxTransitions?: number;
}

const DEFAULT_MAX_GAP_MS = 120_000;
const DEFAULT_MIN_OBSERVATIONS = 2;
const DEFAULT_MAX_PREDICTIONS_PER_TRIGGER = 3;
const DEFAULT_MAX_TRANSITIONS = 500;
/** Persisted observation counts are clamped here on import (sanity bound). */
const MAX_IMPORTED_COUNT = 10_000;

// -- persistence shapes (DESIGN.md §13.6) --------------------------------------
//
// What persists: transition structure — tool names and argument TEMPLATES
// (including constant argument values via their canonical repr). What never
// persists: tool results, the per-server chain heads (session-local), and
// LRU clocks (recency resets on load).

export interface SerializedSource {
  kind: 'arg' | 'parsed' | 'const';
  key?: string;
  path?: string[];
  /** For 'const': the stableStringify repr; the value is rebuilt from it. */
  repr?: string;
}

export interface SerializedTransition {
  server: string;
  prevTool: string;
  nextTool: string;
  count: number;
  templates: Array<{ name: string; underivable: boolean; sources: SerializedSource[] }>;
}

export interface SerializedLearner {
  transitions: SerializedTransition[];
}

/**
 * Where a next-call argument value came from, relative to the previous
 * call. Stored in priority order within a template: arg-copy sources
 * first, then parsed-path sources, then the const fallback.
 */
type Source =
  | { kind: 'arg'; key: string }
  | { kind: 'parsed'; path: string[] }
  | { kind: 'const'; value: unknown; repr: string };

interface ArgTemplate {
  /** Poisoned: no consistent derivation exists. Sticky once set. */
  underivable: boolean;
  /** Surviving candidate sources, in resolution-priority order. */
  sources: Source[];
}

interface TransitionState {
  server: string;
  prevTool: string;
  nextTool: string;
  count: number;
  /** Injected-clock time of the last observation (LRU recency). */
  lastUpdated: number;
  /** Per-argument templates for the next call's args, keyed by arg name. */
  templates: Map<string, ArgTemplate>;
}

/** The slice of the previous call the learner retains per server. */
interface PrevCall {
  tool: string;
  args: Record<string, unknown>;
  parsed: unknown;
  timestamp: number;
}

/** A parsed-result path candidate: segments plus the value found there. */
interface ParsedPath {
  segs: string[];
  value: unknown;
}

type Resolution = { ok: true; value: unknown } | { ok: false };

export class TransitionLearner {
  private readonly now: () => number;
  private readonly maxGapMs: number;
  private readonly minObservations: number;
  private readonly maxPredictionsPerTrigger: number;
  private readonly maxTransitions: number;

  /** Most recent observed call per server — the head of that server's chain. */
  private readonly lastCallByServer = new Map<string, PrevCall>();
  /** Bumped on every transition create/update/import (dirty tracking). */
  private mutations = 0;
  /**
   * Tracked transitions keyed by `<server> <prevTool> <nextTool>` (labels
   * and tool names never contain spaces). Map insertion order is LRU
   * order: every update deletes and re-sets the entry.
   */
  private readonly transitions = new Map<string, TransitionState>();

  constructor(opts: TransitionLearnerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxGapMs = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
    this.minObservations = opts.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
    this.maxPredictionsPerTrigger =
      opts.maxPredictionsPerTrigger ?? DEFAULT_MAX_PREDICTIONS_PER_TRIGGER;
    this.maxTransitions = opts.maxTransitions ?? DEFAULT_MAX_TRANSITIONS;
  }

  /** Feed every served real call. Never throws. */
  observe(call: ObservedCall): void {
    try {
      this.observeInner(call);
    } catch {
      // Fail closed: a malformed call degrades to "nothing learned".
    }
  }

  /** Likely next calls after `call`. Never throws; may return []. */
  predict(call: ObservedCall): Prediction[] {
    try {
      return this.predictInner(call);
    } catch {
      return [];
    }
  }

  /** Increments whenever tracked transitions change (dirty tracking). */
  get revision(): number {
    return this.mutations;
  }

  /**
   * Snapshot of learned transitions for persistence (LRU order, oldest
   * first, so importing re-establishes the same eviction order). Chain
   * heads and recency clocks are session-local and excluded.
   */
  exportState(): SerializedLearner {
    const transitions: SerializedTransition[] = [];
    for (const state of this.transitions.values()) {
      transitions.push({
        server: state.server,
        prevTool: state.prevTool,
        nextTool: state.nextTool,
        count: state.count,
        templates: [...state.templates.entries()].map(([name, tpl]) => ({
          name,
          underivable: tpl.underivable,
          sources: tpl.sources.map(serializeSource),
        })),
      });
    }
    return { transitions };
  }

  /**
   * Load a prior snapshot into this (fresh) learner. Defensive by design:
   * every malformed transition/template/source is skipped, never thrown —
   * a corrupt or stale state file can only cost learned knowledge, not
   * correctness or uptime.
   */
  importState(data: unknown): void {
    try {
      const root = data as { transitions?: unknown };
      if (!root || !Array.isArray(root.transitions)) return;
      for (const raw of root.transitions) {
        const t = deserializeTransition(raw);
        if (!t) continue;
        const key = `${t.server} ${t.prevTool} ${t.nextTool}`;
        this.transitions.set(key, {
          ...t,
          lastUpdated: this.now(),
        });
        while (this.transitions.size > this.maxTransitions) {
          const oldest = this.transitions.keys().next();
          if (oldest.done) break;
          this.transitions.delete(oldest.value);
        }
      }
      this.mutations++;
    } catch {
      // Fail closed: partial import is fine, corruption is not contagious.
    }
  }

  // -- observation ----------------------------------------------------------

  private observeInner(call: ObservedCall): void {
    const prev = this.lastCallByServer.get(call.server);
    this.lastCallByServer.set(call.server, {
      tool: call.tool,
      args: call.args,
      parsed: call.parsed,
      timestamp: call.timestamp,
    });
    if (!prev) return;

    // Gap math uses call timestamps, not the injected clock: observations
    // carry their own time. Out-of-order or too-far-apart timestamps just
    // reset the chain (the new call is already stored as the head).
    const gap = call.timestamp - prev.timestamp;
    if (gap < 0 || gap > this.maxGapMs) return;

    const key = `${call.server} ${prev.tool} ${call.tool}`;
    this.mutations++;
    let state = this.transitions.get(key);
    if (state) {
      this.transitions.delete(key); // refresh LRU position on re-set below
      state.count += 1;
      state.lastUpdated = this.now();
      updateTemplates(state, prev, call.args);
    } else {
      state = {
        server: call.server,
        prevTool: prev.tool,
        nextTool: call.tool,
        count: 1,
        lastUpdated: this.now(),
        templates: initialTemplates(prev, call.args),
      };
    }
    this.transitions.set(key, state);

    while (this.transitions.size > this.maxTransitions) {
      const oldest = this.transitions.keys().next();
      if (oldest.done) break;
      this.transitions.delete(oldest.value);
    }
  }

  // -- prediction -----------------------------------------------------------

  private predictInner(call: ObservedCall): Prediction[] {
    const candidates: Array<{
      state: TransitionState;
      ruleId: string;
      args: Record<string, unknown>;
    }> = [];
    for (const state of this.transitions.values()) {
      if (state.server !== call.server || state.prevTool !== call.tool) continue;
      if (state.count < this.minObservations) continue;
      const args = materializeArgs(state, call);
      if (args === null) continue; // fail closed — never partial args
      candidates.push({
        state,
        ruleId: `learned:${state.prevTool}→${state.nextTool}`,
        args,
      });
    }
    candidates.sort(
      (a, b) =>
        b.state.count - a.state.count ||
        (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
    );
    // No `key` stamped: the predictor owns canonical cache keying.
    return candidates.slice(0, this.maxPredictionsPerTrigger).map((c) => ({
      server: call.server,
      tool: c.state.nextTool,
      args: c.args,
      confidence: Math.min(0.55, 0.25 + 0.1 * c.state.count),
      ruleId: c.ruleId,
    }));
  }
}

// -- (de)serialization ----------------------------------------------------------

function serializeSource(s: Source): SerializedSource {
  switch (s.kind) {
    case 'arg':
      return { kind: 'arg', key: s.key };
    case 'parsed':
      return { kind: 'parsed', path: [...s.path] };
    case 'const':
      return { kind: 'const', repr: s.repr };
  }
}

function deserializeSource(raw: unknown): Source | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as SerializedSource;
  if (s.kind === 'arg' && typeof s.key === 'string') {
    return { kind: 'arg', key: s.key };
  }
  if (
    s.kind === 'parsed' &&
    Array.isArray(s.path) &&
    s.path.every((seg) => typeof seg === 'string')
  ) {
    return { kind: 'parsed', path: [...s.path] };
  }
  if (s.kind === 'const' && typeof s.repr === 'string') {
    try {
      // repr is the value's stableStringify form, so it round-trips via JSON.
      return { kind: 'const', value: JSON.parse(s.repr) as unknown, repr: s.repr };
    } catch {
      return null;
    }
  }
  return null;
}

function deserializeTransition(
  raw: unknown,
): Omit<TransitionState, 'lastUpdated'> | null {
  if (raw === null || typeof raw !== 'object') return null;
  const t = raw as SerializedTransition;
  if (
    typeof t.server !== 'string' ||
    t.server.length === 0 ||
    t.server.includes(' ') ||
    typeof t.prevTool !== 'string' ||
    t.prevTool.length === 0 ||
    t.prevTool.includes(' ') ||
    typeof t.nextTool !== 'string' ||
    t.nextTool.length === 0 ||
    t.nextTool.includes(' ') ||
    typeof t.count !== 'number' ||
    !Number.isFinite(t.count) ||
    t.count < 1 ||
    !Array.isArray(t.templates)
  ) {
    return null;
  }
  const templates = new Map<string, ArgTemplate>();
  for (const rawTpl of t.templates) {
    if (rawTpl === null || typeof rawTpl !== 'object') return null;
    const tpl = rawTpl as { name?: unknown; underivable?: unknown; sources?: unknown };
    if (typeof tpl.name !== 'string' || typeof tpl.underivable !== 'boolean') {
      return null;
    }
    if (tpl.underivable) {
      templates.set(tpl.name, { underivable: true, sources: [] });
      continue;
    }
    if (!Array.isArray(tpl.sources)) return null;
    const sources: Source[] = [];
    for (const rawSrc of tpl.sources) {
      const s = deserializeSource(rawSrc);
      if (s) sources.push(s); // malformed sources are dropped, not fatal
    }
    // A derivable template that lost all its sources is poisoned, matching
    // the live invariant (empty sources ⇒ underivable).
    templates.set(tpl.name, { underivable: sources.length === 0, sources });
  }
  return {
    server: t.server,
    prevTool: t.prevTool,
    nextTool: t.nextTool,
    count: Math.min(Math.floor(t.count), MAX_IMPORTED_COUNT),
    templates,
  };
}

// -- argument templates -------------------------------------------------------

/** First instance of a transition: store every candidate source per arg. */
function initialTemplates(
  prev: PrevCall,
  nextArgs: Record<string, unknown>,
): Map<string, ArgTemplate> {
  const templates = new Map<string, ArgTemplate>();
  const parsedPaths = enumerateParsedPaths(prev.parsed);
  for (const [name, value] of Object.entries(nextArgs)) {
    const sources = candidateSources(prev, parsedPaths, value);
    templates.set(name, { underivable: sources.length === 0, sources });
  }
  return templates;
}

/**
 * Later instance: intersect each template's candidates with the sources
 * that would also have produced this instance's value. Arg-set instability
 * (new names, missing names) poisons the affected templates.
 */
function updateTemplates(
  state: TransitionState,
  prev: PrevCall,
  nextArgs: Record<string, unknown>,
): void {
  for (const [name, tpl] of state.templates) {
    if (!Object.prototype.hasOwnProperty.call(nextArgs, name)) {
      tpl.underivable = true; // previously seen arg absent now
      tpl.sources = [];
    }
  }
  for (const [name, value] of Object.entries(nextArgs)) {
    const tpl = state.templates.get(name);
    if (!tpl) {
      // Arg name not seen on earlier instances: inconsistent shape.
      state.templates.set(name, { underivable: true, sources: [] });
      continue;
    }
    if (tpl.underivable) continue; // poisoned stays poisoned
    const repr = safeStringify(value);
    tpl.sources =
      repr === undefined
        ? []
        : tpl.sources.filter((s) => sourceProduces(s, prev, repr));
    if (tpl.sources.length === 0) tpl.underivable = true;
  }
}

/** All sources in the previous call that produce `value`, plus the const. */
function candidateSources(
  prev: PrevCall,
  parsedPaths: ParsedPath[],
  value: unknown,
): Source[] {
  const repr = safeStringify(value);
  if (repr === undefined) return [];
  const sources: Source[] = [];
  // Priority order is baked into storage order: arg-copy, parsed-path, const.
  for (const [k, v] of Object.entries(prev.args)) {
    if (safeStringify(v) === repr) sources.push({ kind: 'arg', key: k });
  }
  for (const p of parsedPaths) {
    if (safeStringify(p.value) === repr) {
      sources.push({ kind: 'parsed', path: p.segs });
    }
  }
  sources.push({ kind: 'const', value, repr });
  return sources;
}

/** Would `source`, applied to this instance's previous call, yield `repr`? */
function sourceProduces(source: Source, prev: PrevCall, repr: string): boolean {
  switch (source.kind) {
    case 'arg': {
      if (!Object.prototype.hasOwnProperty.call(prev.args, source.key)) {
        return false;
      }
      return safeStringify(prev.args[source.key]) === repr;
    }
    case 'parsed': {
      const res = resolvePath(prev.parsed, source.path);
      return res.ok && safeStringify(res.value) === repr;
    }
    case 'const':
      // A const survives only if the literal is identical.
      return source.repr === repr;
  }
}

/**
 * Rebuild a transition's next-call args against the current call. Null when
 * any arg is underivable or fails to resolve now (fail closed).
 */
function materializeArgs(
  state: TransitionState,
  call: ObservedCall,
): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const [name, tpl] of state.templates) {
    if (tpl.underivable) return null;
    const resolved = resolveSources(tpl.sources, call);
    if (!resolved.ok) return null;
    args[name] = resolved.value;
  }
  return args;
}

/**
 * First source that resolves against the current call wins. Sources are
 * stored in priority order (arg-copy > parsed-path > const), so a plain
 * scan implements the priority; const always resolves.
 */
function resolveSources(sources: Source[], call: ObservedCall): Resolution {
  for (const s of sources) {
    switch (s.kind) {
      case 'arg':
        if (Object.prototype.hasOwnProperty.call(call.args, s.key)) {
          return { ok: true, value: call.args[s.key] };
        }
        break;
      case 'parsed': {
        const res = resolvePath(call.parsed, s.path);
        if (res.ok) return res;
        break;
      }
      case 'const':
        return { ok: true, value: s.value };
    }
  }
  return { ok: false };
}

// -- parsed-result path search ------------------------------------------------

/**
 * Candidate paths into a parsed result: top-level object fields, one nested
 * object level, and for arrays indices 0..2 plus those elements' direct
 * fields (`items.0.number`, or `0.id` when the parsed value itself is the
 * array). Anything else (null, primitives, deeper nesting) yields nothing —
 * degradation, not an exception.
 */
function enumerateParsedPaths(parsed: unknown): ParsedPath[] {
  const out: ParsedPath[] = [];
  try {
    if (isPlainObject(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        out.push({ segs: [k], value: v });
        if (isPlainObject(v)) {
          for (const [k2, v2] of Object.entries(v)) {
            out.push({ segs: [k, k2], value: v2 });
          }
        } else if (Array.isArray(v)) {
          pushArrayPaths(out, [k], v);
        }
      }
    } else if (Array.isArray(parsed)) {
      pushArrayPaths(out, [], parsed);
    }
  } catch {
    // Exotic shapes (throwing getters, etc.): keep whatever was collected.
  }
  return out;
}

function pushArrayPaths(out: ParsedPath[], prefix: string[], arr: unknown[]): void {
  const n = Math.min(arr.length, 3);
  for (let i = 0; i < n; i++) {
    const el = arr[i];
    out.push({ segs: [...prefix, String(i)], value: el });
    if (isPlainObject(el)) {
      for (const [k, v] of Object.entries(el)) {
        out.push({ segs: [...prefix, String(i), k], value: v });
      }
    }
  }
}

/** Walk a stored path against a (possibly weird) parsed value. Never throws. */
function resolvePath(root: unknown, path: readonly string[]): Resolution {
  let cur: unknown = root;
  try {
    for (const seg of path) {
      if (Array.isArray(cur)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
          return { ok: false };
        }
        cur = cur[idx];
      } else if (isPlainObject(cur)) {
        if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false };
        cur = cur[seg];
      } else {
        return { ok: false };
      }
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, value: cur };
}

// -- small utilities ----------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * stableStringify guarded for equality use: returns undefined for values it
 * can't represent (undefined, functions, cycles); comparisons involving
 * undefined never match.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    const s: unknown = stableStringify(value);
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}
