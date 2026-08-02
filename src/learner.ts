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
  /** Injectable clock (decay and recency only — gap math uses call timestamps). */
  now?: () => number;
  /** Max prev→next spacing (ms, by call timestamps) to count as a transition. */
  maxGapMs?: number;
  /** Observations of a transition required before it may predict. */
  minObservations?: number;
  /** Cap on predictions returned per trigger call. */
  maxPredictionsPerTrigger?: number;
  /** Cap on tracked transitions; the weakest is evicted past it. */
  maxTransitions?: number;
}

const DEFAULT_MAX_GAP_MS = 120_000;
const DEFAULT_MIN_OBSERVATIONS = 2;
const DEFAULT_MAX_PREDICTIONS_PER_TRIGGER = 3;
const DEFAULT_MAX_TRANSITIONS = 500;
/**
 * Evidence decay time constant (§5.3) — the 1/e time, NOT the half-life:
 * after one TAU of silence a score RETAINS ~37% of its weight, and the
 * half-life is TAU*ln2 ≈ 9.7 days. Tune from those two numbers, not from
 * "14 days is the half-life", which is off by ~1.44x.
 *
 * 14 days is long enough that a workflow paused over a holiday still ranks,
 * short enough that a project finished last quarter stops outranking this
 * week's. Ranking and eviction only — `count` never decays, so the
 * minObservations gate keeps its meaning.
 */
const TAU_MS = 14 * 24 * 3600_000;
/** Persisted observation counts are clamped here on import (sanity bound). */
const MAX_IMPORTED_COUNT = 10_000;
/** Wide-result guards: a huge JSON map must not explode template state. */
const MAX_PARSED_KEYS_PER_LEVEL = 32;
const MAX_PARSED_PATHS = 256;
/** Per-arg candidate-source cap (arg-copies + parsed-paths; const always kept). */
const MAX_SOURCES_PER_ARG = 12;
/** Session-opener tracking (§13.15): per-server cap and sanity bounds. */
const MAX_OPENERS_PER_SERVER = 8;
const MAX_OPENER_REPR_LENGTH = 4_096;
const MAX_IMPORTED_OPENER_COUNT = 1_000;

/**
 * Exponential time decay of an evidence score: `score * e^(-elapsed/tau)`.
 *
 * Exported for tests. Total by construction, and every degenerate input
 * fails toward LESS evidence, never more:
 *   - unusable score or a non-positive one -> 0
 *   - non-finite tau or tau <= 0 -> decay disabled, score unchanged
 *   - a stamp that is not a finite number -> 0, i.e. maximally stale. An
 *     unreadable stamp must never read as perfectly fresh; that is how an
 *     infinitely old entry would outrank a real one.
 *   - `to` before `from` (clock skew, a state file from a machine set to
 *     the future) -> score unchanged, never amplified.
 * An elapsed time that overflows to +Infinity needs no special case:
 * e^(-Infinity) is 0, which is the correct limit.
 */
export function decayedScore(
  score: number,
  from: number,
  to: number,
  tauMs: number = TAU_MS,
): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (!Number.isFinite(tauMs) || tauMs <= 0) return score;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const elapsed = to - from;
  if (elapsed <= 0) return score;
  return score * Math.exp(-elapsed / tauMs);
}

// -- persistence shapes (DESIGN.md §13.6) --------------------------------------
//
// What persists: transition structure — tool names and argument TEMPLATES
// (including constant argument values via their canonical repr), plus the
// decayed evidence score and the clock reading it was taken at. What never
// persists: tool results and the per-server chain heads (session-local).
//
// Recency MUST travel with the snapshot: restamping lastUpdated on load
// would reset decay on every restart and make the whole mechanism cosmetic.
// Both new fields are optional so a pre-existing state file still loads —
// missing score defaults to count, missing lastUpdated to now().

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
  /** Decayed evidence weight. Absent pre-v0.13; defaults to `count`. */
  score?: number;
  /** Clock reading `score` was taken at. Absent pre-v0.13; defaults to now(). */
  lastUpdated?: number;
  templates: Array<{ name: string; underivable: boolean; sources: SerializedSource[] }>;
}

export interface SerializedOpener {
  server: string;
  tool: string;
  /** stableStringify of the opening call's args (constants only, by nature). */
  argsRepr: string;
  count: number;
  /** Decayed evidence weight. Absent pre-v0.13; defaults to `count`. */
  score?: number;
  /** Clock reading `score` was taken at. Absent pre-v0.13; defaults to now(). */
  lastUpdated?: number;
}

export interface SerializedLearner {
  transitions: SerializedTransition[];
  /** Session-opening reads (§13.15). Absent in pre-v0.10 state files. */
  openers?: SerializedOpener[];
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
  /**
   * Lifetime observation count. Never decays: it is the evidence gate
   * (minObservations) and the confidence input. A transition that was real
   * a year ago is still real, it is just no longer topical.
   */
  count: number;
  /**
   * Decayed evidence weight as of `lastUpdated`, for ranking and eviction
   * only. Read through decayedScore(), never raw.
   */
  score: number;
  /** Injected-clock time `score` was taken at (also recency for eviction). */
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

interface OpenerState {
  server: string;
  tool: string;
  argsRepr: string;
  /** Lifetime sighting count — the minObservations gate. Never decays. */
  count: number;
  /** Decayed evidence weight as of `lastUpdated` (eviction only). */
  score: number;
  /** Injected-clock time of the last sighting (eviction tie-break). */
  lastUpdated: number;
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
  /**
   * Primed transitions (§13.9): (server, prev, next) pairs shipped as
   * product knowledge or derived from tool-name morphology. A primed
   * transition reaches the prediction threshold on its FIRST sighting
   * instead of the usual minObservations — pre-loaded priors that then
   * grow, get suppressed, and persist exactly like organically learned
   * ones. Never persisted itself (recomputed per session from tool lists).
   */
  private readonly primed = new Set<string>();
  /** Bumped on every transition create/update/import (dirty tracking). */
  private mutations = 0;
  /**
   * Tracked transitions keyed by `<server> <prevTool> <nextTool>` (labels
   * and tool names never contain spaces). Map insertion order is
   * observation order — every update deletes and re-sets the entry — which
   * is the last eviction tie-break and the export order, not the policy.
   */
  private readonly transitions = new Map<string, TransitionState>();
  /**
   * Session-opening reads (§13.15): the first few read-eligible calls of
   * each session, keyed by (server, tool, exact args repr). Only calls
   * whose arguments repeat verbatim across sessions ever reach the
   * prediction threshold — an opener with varying args never fires.
   */
  private readonly openers = new Map<string, OpenerState>();

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
   * Pre-load a transition prior: the first observed instance of
   * (prevTool → nextTool) on `server` becomes immediately predictable,
   * with argument templates taken from that instance. No-op if the
   * transition is already tracked (real evidence wins over priors).
   */
  prime(server: string, prevTool: string, nextTool: string): void {
    if (server.includes(' ') || prevTool.includes(' ') || nextTool.includes(' ')) return;
    this.primed.add(`${server} ${prevTool} ${nextTool}`);
  }

  /** Number of primed (not yet observed) transition priors. */
  get primedCount(): number {
    return this.primed.size;
  }

  /**
   * Record one of a session's opening reads (§13.15). Called by the proxy
   * for the first few read-eligible asks per server per session. Never
   * throws; oversized or unrepresentable args are skipped (fail closed).
   */
  recordOpener(server: string, tool: string, args: Record<string, unknown>): void {
    try {
      if (server.includes(' ') || tool.includes(' ') || tool.length === 0) return;
      const repr = safeStringify(args);
      if (repr === undefined || repr.length > MAX_OPENER_REPR_LENGTH) return;
      const key = `${server}\x00${tool}\x00${repr}`;
      const now = this.now();
      const existing = this.openers.get(key);
      if (existing) {
        existing.count = Math.min(existing.count + 1, MAX_IMPORTED_OPENER_COUNT);
        existing.score = decayedScore(existing.score, existing.lastUpdated, now) + 1;
        existing.lastUpdated = now;
      } else {
        this.openers.set(key, {
          server,
          tool,
          argsRepr: repr,
          count: 1,
          score: 1,
          lastUpdated: now,
        });
        // Evict the weakest opener (lowest decayed score, then stalest),
        // never the one just recorded.
        this.evictOpeners(server, now, key);
      }
      this.mutations++;
    } catch {
      // Fail closed: an unrecordable opener costs a future prefetch, nothing else.
    }
  }

  /**
   * Openers worth prefetching at session start: seen in at least
   * minObservations sightings with identical args. Confidence stays below
   * hand-written rules; ruleId feeds the normal §5.6 feedback loop.
   */
  openerPredictions(server: string): Prediction[] {
    try {
      const now = this.now();
      // The gate is the undecayed count: an opener that qualified once still
      // qualifies. Decay only decides which of the qualifiers goes first.
      const mine = [...this.openers.values()].filter(
        (o) => o.server === server && o.count >= this.minObservations,
      );
      mine.sort(
        (a, b) =>
          decayedScore(b.score, b.lastUpdated, now) -
            decayedScore(a.score, a.lastUpdated, now) ||
          (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0),
      );
      const out: Prediction[] = [];
      for (const o of mine.slice(0, this.maxPredictionsPerTrigger)) {
        let args: unknown;
        try {
          args = JSON.parse(o.argsRepr) as unknown;
        } catch {
          continue;
        }
        if (!isPlainObject(args)) continue;
        out.push({
          server,
          tool: o.tool,
          args: jsonCopyRecord(args),
          confidence: Math.min(0.5, 0.2 + 0.1 * o.count),
          ruleId: `opener:${server}:${o.tool}`,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Snapshot of learned transitions for persistence, in observation order
   * (oldest first). Each entry carries its evidence score and the clock
   * reading that score was taken at, so decay continues across a restart
   * instead of resetting. Chain heads are session-local and excluded.
   */
  exportState(): SerializedLearner {
    const transitions: SerializedTransition[] = [];
    for (const state of this.transitions.values()) {
      transitions.push({
        server: state.server,
        prevTool: state.prevTool,
        nextTool: state.nextTool,
        count: state.count,
        // The (score, lastUpdated) pair travels together and undecayed: the
        // next load applies the decay for the whole gap, however long the
        // process was down.
        score: state.score,
        lastUpdated: state.lastUpdated,
        templates: [...state.templates.entries()].map(([name, tpl]) => ({
          name,
          underivable: tpl.underivable,
          sources: tpl.sources.map(serializeSource),
        })),
      });
    }
    const openers: SerializedOpener[] = [...this.openers.values()].map((o) => ({
      server: o.server,
      tool: o.tool,
      argsRepr: o.argsRepr,
      count: o.count,
      score: o.score,
      lastUpdated: o.lastUpdated,
    }));
    return openers.length > 0 ? { transitions, openers } : { transitions };
  }

  /**
   * Load a prior snapshot into this (fresh) learner. Defensive by design:
   * every malformed transition/template/source is skipped, never thrown —
   * a corrupt or stale state file can only cost learned knowledge, not
   * correctness or uptime.
   */
  importState(data: unknown): void {
    try {
      const root = data as { transitions?: unknown; openers?: unknown };
      if (!root || !Array.isArray(root.transitions)) return;
      const now = this.now();
      for (const raw of root.transitions) {
        const t = deserializeTransition(raw, now);
        if (!t) continue;
        this.transitions.set(`${t.server} ${t.prevTool} ${t.nextTool}`, t);
      }
      // Trim once, after the whole file is in: an oversized snapshot then
      // keeps its most valuable entries rather than its last-listed ones.
      this.evictTransitions(now);
      if (Array.isArray(root.openers)) {
        const servers = new Set<string>();
        for (const raw of root.openers) {
          const o = deserializeOpener(raw, now);
          if (!o) continue; // malformed openers are skipped, never fatal
          this.openers.set(`${o.server}\x00${o.tool}\x00${o.argsRepr}`, o);
          servers.add(o.server);
        }
        // A snapshot carrying more openers for a server than the live cap
        // allows must not load them all: trim to the same bound recording
        // enforces, keeping the strongest.
        for (const server of servers) this.evictOpeners(server, now);
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
    const now = this.now();
    this.mutations++;
    let state = this.transitions.get(key);
    if (state) {
      this.transitions.delete(key); // keep insertion order = observation order
      state.count += 1;
      // Age the standing evidence to now, THEN add this observation's full
      // weight: recent evidence is worth more than the same volume of old.
      state.score = decayedScore(state.score, state.lastUpdated, now) + 1;
      state.lastUpdated = now;
      updateTemplates(state, prev, call.args);
    } else {
      // A primed pair arms on first sight (§13.9); templates still come
      // from real traffic, so a prior can never invent arguments.
      const initial = this.primed.has(key) ? this.minObservations : 1;
      state = {
        server: call.server,
        prevTool: prev.tool,
        nextTool: call.tool,
        count: initial,
        score: initial,
        lastUpdated: now,
        templates: initialTemplates(prev, call.args),
      };
    }
    this.transitions.set(key, state);
    this.evictTransitions(now, key);
  }

  /**
   * Trim to maxTransitions by VALUE, not arrival order: drop the lowest
   * decayed scores, ties broken by the stalest observation and then (via a
   * stable sort) by insertion order, so eviction is deterministic. Evicting
   * FIFO threw away the transition seen a hundred times at session start to
   * make room for a one-off seen a second ago.
   *
   * `protectKey` is the entry this observation just wrote, and it is NEVER
   * a candidate. Without that exemption a full table can never learn
   * anything new: a first sighting scores 1, every incumbent with two
   * recent sightings scores just under 2, so the newcomer is the weakest
   * entry and is deleted by the same observe() that created it — then
   * recreated and re-deleted on every later sighting, so it can never reach
   * minObservations. That is the FIFO bug pointed the other way (FIFO
   * discarded the best entry; unprotected value-eviction admits nothing),
   * and it fails silently: prediction quality simply freezes.
   */
  private evictTransitions(now: number, protectKey?: string): void {
    const overflow = this.transitions.size - this.maxTransitions;
    if (overflow <= 0) return;
    const weakerFirst = (a: TransitionState, b: TransitionState): number =>
      decayedScore(a.score, a.lastUpdated, now) -
        decayedScore(b.score, b.lastUpdated, now) || a.lastUpdated - b.lastUpdated;

    if (overflow === 1) {
      // Steady state: one over the cap on nearly every new transition, so a
      // single scan beats sorting the whole table.
      let worstKey: string | undefined;
      let worst: TransitionState | undefined;
      for (const [key, s] of this.transitions) {
        if (key === protectKey) continue;
        if (worst === undefined || weakerFirst(s, worst) < 0) {
          worstKey = key;
          worst = s;
        }
      }
      if (worstKey !== undefined) this.transitions.delete(worstKey);
      return;
    }
    // Bulk (an oversized import): rank once instead of rescanning per victim.
    const ranked = [...this.transitions.entries()]
      .filter(([key]) => key !== protectKey)
      .sort((a, b) => weakerFirst(a[1], b[1]));
    for (let i = 0; i < overflow && i < ranked.length; i++) {
      this.transitions.delete(ranked[i]![0]);
    }
  }

  /**
   * Same trim for one server's openers, and the same exemption: the opener
   * just recorded is never its own victim. (This shape predates the decay
   * work — under count-ranked eviction a newcomer tied with other count-1
   * entries and won on recency — but scoring made it reachable, so it is
   * fixed here rather than left as a latent duplicate of the bug above.)
   */
  private evictOpeners(server: string, now: number, protectKey?: string): void {
    const mine = [...this.openers.entries()].filter(([, o]) => o.server === server);
    const overflow = mine.length - MAX_OPENERS_PER_SERVER;
    if (overflow <= 0) return;
    const ranked = mine
      .filter(([key]) => key !== protectKey)
      .sort(
        (a, b) =>
          decayedScore(a[1].score, a[1].lastUpdated, now) -
            decayedScore(b[1].score, b[1].lastUpdated, now) ||
          a[1].lastUpdated - b[1].lastUpdated,
      );
    for (let i = 0; i < overflow && i < ranked.length; i++) {
      this.openers.delete(ranked[i]![0]);
    }
  }

  // -- prediction -----------------------------------------------------------

  private predictInner(call: ObservedCall): Prediction[] {
    const now = this.now();
    const candidates: Array<{
      state: TransitionState;
      ruleId: string;
      score: number;
      args: Record<string, unknown>;
    }> = [];
    for (const state of this.transitions.values()) {
      if (state.server !== call.server || state.prevTool !== call.tool) continue;
      if (state.count < this.minObservations) continue;
      const args = materializeArgs(state, call);
      if (args === null) continue; // fail closed — never partial args
      candidates.push({
        state,
        // Server label is part of the id: feedback must never bleed between
        // servers that happen to share tool names (review finding, §13.7).
        ruleId: `learned:${state.server}:${state.prevTool}→${state.nextTool}`,
        score: decayedScore(state.score, state.lastUpdated, now),
        args,
      });
    }
    // Rank by decayed score: among equally frequent transitions the one used
    // recently is the better guess. The gate above is still the raw count.
    candidates.sort(
      (a, b) =>
        b.score - a.score || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
    );
    // No `key` stamped: the predictor owns canonical cache keying.
    return candidates.slice(0, this.maxPredictionsPerTrigger).map((c) => ({
      server: call.server,
      tool: c.state.nextTool,
      // Fresh, JSON-shaped copy: emitted args must never alias the stored
      // const templates or the current call's args/parsed subtrees.
      args: jsonCopyRecord(c.args),
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

/**
 * Validate one persisted opener (untrusted input): sane strings, args that
 * round-trip to a plain object, count clamped. Null skips the entry.
 */
function deserializeOpener(raw: unknown, now: number): OpenerState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as SerializedOpener;
  if (
    typeof o.server !== 'string' ||
    o.server.length === 0 ||
    o.server.includes(' ') ||
    typeof o.tool !== 'string' ||
    o.tool.length === 0 ||
    o.tool.includes(' ') ||
    typeof o.argsRepr !== 'string' ||
    o.argsRepr.length > MAX_OPENER_REPR_LENGTH ||
    typeof o.count !== 'number' ||
    !Number.isFinite(o.count) ||
    o.count < 1
  ) {
    return null;
  }
  try {
    if (!isPlainObject(JSON.parse(o.argsRepr))) return null;
  } catch {
    return null;
  }
  const count = Math.min(Math.floor(o.count), MAX_IMPORTED_OPENER_COUNT);
  return {
    server: o.server,
    tool: o.tool,
    argsRepr: o.argsRepr,
    count,
    score: importedScore(o.score, count, MAX_IMPORTED_OPENER_COUNT),
    lastUpdated: importedStamp(o.lastUpdated, now),
  };
}

/**
 * A persisted score, or `count` when the file predates the field (or carries
 * junk there). Clamped to the same bound as count so a doctored file cannot
 * pin an entry at the top of the ranking forever.
 */
function importedScore(raw: unknown, count: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return count;
  return Math.min(raw, max);
}

/**
 * A persisted recency stamp, or now() when absent/junk. Never in the future:
 * a state file written by a clock ahead of ours must not buy an entry
 * permanent freshness.
 */
function importedStamp(raw: unknown, now: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return now;
  return Math.min(raw, now);
}

function deserializeTransition(raw: unknown, now: number): TransitionState | null {
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
  const count = Math.min(Math.floor(t.count), MAX_IMPORTED_COUNT);
  return {
    server: t.server,
    prevTool: t.prevTool,
    nextTool: t.nextTool,
    count,
    score: importedScore(t.score, count, MAX_IMPORTED_COUNT),
    lastUpdated: importedStamp(t.lastUpdated, now),
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
    if (sources.length >= MAX_SOURCES_PER_ARG) break;
    if (safeStringify(v) === repr) sources.push({ kind: 'arg', key: k });
  }
  for (const p of parsedPaths) {
    if (sources.length >= MAX_SOURCES_PER_ARG) break;
    if (safeStringify(p.value) === repr) {
      sources.push({ kind: 'parsed', path: p.segs });
    }
  }
  // The const fallback always survives the cap: it is the source of last
  // resort that keeps a stable-valued arg derivable.
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
      let topSeen = 0;
      for (const [k, v] of Object.entries(parsed)) {
        if (++topSeen > MAX_PARSED_KEYS_PER_LEVEL || out.length >= MAX_PARSED_PATHS) break;
        out.push({ segs: [k], value: v });
        if (isPlainObject(v)) {
          let nestedSeen = 0;
          for (const [k2, v2] of Object.entries(v)) {
            if (++nestedSeen > MAX_PARSED_KEYS_PER_LEVEL || out.length >= MAX_PARSED_PATHS) break;
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
    if (out.length >= MAX_PARSED_PATHS) return;
    const el = arr[i];
    out.push({ segs: [...prefix, String(i)], value: el });
    if (isPlainObject(el)) {
      let seen = 0;
      for (const [k, v] of Object.entries(el)) {
        if (++seen > MAX_PARSED_KEYS_PER_LEVEL || out.length >= MAX_PARSED_PATHS) break;
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
 * Fresh JSON-shaped deep copy of an args record. Uses defineProperty so an
 * own '__proto__' key copies as an own property instead of reparenting the
 * object (JSON.parse can produce such keys).
 */
export function jsonCopyRecord(args: Record<string, unknown>): Record<string, unknown> {
  return jsonCopy(args) as Record<string, unknown>;
}

function jsonCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(jsonCopy);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    Object.defineProperty(out, key, {
      value: jsonCopy((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
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
