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
 * Fail-closed by construction: an argument no source has ever produced is
 * never fabricated, an argument whose derivation keeps being wrong is
 * gated off by the evidence (see isUnderivable), one such argument drops
 * its whole transition, and predict() never emits partially materialized
 * args. Neither observe() nor predict() ever throws — weird result shapes
 * degrade to fewer/no candidates.
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
/**
 * Observations a competing hypothesis must have explained ON ITS OWN before
 * it may be offered as an ALTERNATIVE candidate (§13.18). The best-scoring
 * source is always used; this gate decides only whether a second, third, …
 * argument set is worth a slot in the batch.
 *
 * It is one gate doing two jobs, and both are needed:
 *   - Recurrence, the same bar `minObservations` sets for transitions: a
 *     literal seen once is not a hypothesis, it is a coincidence. Without
 *     this, every unexplainable value mints a const that then offers itself
 *     back as a candidate forever.
 *   - Non-domination. A source that has only ever matched at the same time as
 *     a better one has no evidence of its own: whenever the two disagree —
 *     which is the only time offering it changes anything — the other one has
 *     been right. Row 0 and row 2 of a list explain disjoint observations and
 *     both earn slots; a const that merely echoes an arg-copy never does.
 * Lifetime count, deliberately undecayed, exactly like `count`: it gates
 * rather than ranks, and the decayed `score` beside it does the ranking.
 */
const MIN_SOURCE_SOLO_WINS = 2;
/**
 * Combinations the beam may examine per transition. A fixed bound, NOT a
 * function of the per-trigger cap: the emitted prefix must be identical
 * whether the caller asks for 3 candidates or 5, which is what makes an
 * offline eval measured at k=5 a faithful reading of production at k=3.
 */
const MAX_BEAM_POPS = 64;
/**
 * Per-argument evidence gate (§5.3). A template used to be disabled forever
 * by ONE observation it could not derive — an agent opening the second row
 * of a list instead of the first was enough to kill the transition for the
 * rest of the process's life. Instead a template stays quiet until it has
 * this many observations, and from then on speaks for as long as its miss
 * rate stays under MAX_TEMPLATE_MISS_RATE. Below the evidence threshold a
 * single miss silences it — quietly and temporarily, not permanently.
 */
const MIN_TEMPLATE_EVIDENCE = 4;
/**
 * Miss rate at or above which a template is treated as underivable — the knob
 * that trades recall on moving values against wasted prefetches. A surviving
 * template at miss rate m costs m/(1-m) wasted predictions per hit, so 0.75
 * admits derivations that are wrong three times for every time they are
 * right. Note that this is a LIFETIME average: `derived`/`missed` do not
 * decay (unlike the transition scores this file ranks by), so a derivation
 * that used to work has to accumulate misses in proportion to its whole
 * history before the gate closes. In production the §5.6 feedback loop is
 * the faster backstop — it suppresses a learner ruleId that keeps missing
 * after a handful of speculations, without waiting on the lifetime rate.
 */
const MAX_TEMPLATE_MISS_RATE = 0.75;
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
  /**
   * Decayed evidence weight for THIS hypothesis. Absent pre-v0.13; defaults
   * to 0 — "no evidence recorded", which is not the same as "never right",
   * and makes the pre-scoring priority order the fallback ranking for a file
   * that never scored anything.
   */
  score?: number;
  /** Clock reading `score` was taken at. Absent pre-v0.13; defaults to now(). */
  lastUpdated?: number;
  /** Observations this source alone explained. Absent pre-v0.13; defaults 0. */
  solo?: number;
  /**
   * 32-bit window of WHICH recent observations this source explained. Omitted
   * when empty, and absent pre-v0.13; defaults to 0, which reads as "no
   * provenance recorded" and never blocks a candidate on its own.
   */
  seen?: number;
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
  templates: Array<{
    name: string;
    /**
     * The verdict as of the write. Pre-v0.13 this WAS the state (sticky, and
     * the only thing stored); it is still written so an older build reading a
     * newer file keeps its fail-closed reading, but a build that understands
     * `derived`/`missed` recomputes the verdict from those instead.
     */
    underivable: boolean;
    /** Observations a source reproduced. Absent pre-v0.13; defaults to 1. */
    derived?: number;
    /** Observations none could. Absent pre-v0.13; defaults to 0. */
    missed?: number;
    sources: SerializedSource[];
  }>;
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
 * call. Seeded in priority order within a template — arg-copy sources
 * first, then parsed-path sources, then the const fallback — which is now
 * only the tie-break: evidence decides (§13.18).
 */
type Source =
  | { kind: 'arg'; key: string }
  | { kind: 'parsed'; path: string[] }
  | { kind: 'const'; value: unknown; repr: string };

/**
 * One competing hypothesis about where an argument's value comes from, with
 * the evidence for it. Several are held per argument at once: the model that
 * kept a single narrowed-down source could never offer row 0 AND row 1, and
 * was hostage to whichever row the first sighting happened to use.
 */
interface ScoredSource {
  s: Source;
  /**
   * Decayed count of observations this source reproduced, as of
   * `lastUpdated`. Ranking and eviction only — read through decayedScore().
   */
  score: number;
  /** Injected-clock time `score` was taken at. */
  lastUpdated: number;
  /** Observations this source alone explained (see MIN_SOURCE_SOLO_WINS). */
  solo: number;
  /**
   * WHICH observations this source explained, as a 32-bit window: bit 0 is
   * this transition's most recent observation, bit i is i observations ago.
   * Shifted for every source of every template on every observation, so bit
   * positions mean the same thing ACROSS arguments — which is the whole
   * point. Scores say how often each argument's hypotheses were right on
   * their own; only this says whether two of them were ever right TOGETHER
   * (see coherence in materializeCombos).
   */
  seen: number;
}

interface ArgTemplate {
  /** Competing candidate sources; seeded in priority order, ranked by score. */
  sources: ScoredSource[];
  /**
   * Observations an ALREADY-STORED source reproduced — i.e. ones the template
   * could have predicted. A source mined from the observation itself never
   * counts here; crediting those would make every template trivially
   * derivable and disable the fail-closed gate entirely. ZERO IS ABSOLUTE: an
   * argument no source has ever produced is never emitted, whatever else is
   * true.
   */
  derived: number;
  /**
   * Observations no source could reproduce, including ones where the
   * argument was absent entirely. Evidence against the template, not a
   * death sentence — see isUnderivable().
   */
  missed: number;
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
          // The longest horizon there is (§6.2): fired before the agent has
          // made a single call, so nothing at all derives it and the wait to
          // the claiming call is the whole session start.
          horizon: 'standing',
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
          underivable: isUnderivable(tpl),
          derived: tpl.derived,
          missed: tpl.missed,
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
      updateTemplates(state, prev, call.args, now);
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
        templates: initialTemplates(prev, call.args, now),
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
      weight: number;
      args: Record<string, unknown>;
      memorized: boolean;
    }> = [];
    for (const state of this.transitions.values()) {
      if (state.server !== call.server || state.prevTool !== call.tool) continue;
      if (state.count < this.minObservations) continue;
      // Server label is part of the id: feedback must never bleed between
      // servers that happen to share tool names (review finding, §13.7).
      const ruleId = `learned:${state.server}:${state.prevTool}→${state.nextTool}`;
      const score = decayedScore(state.score, state.lastUpdated, now);
      for (const c of materializeCombos(state, call, now, this.maxPredictionsPerTrigger)) {
        candidates.push({
          state,
          ruleId,
          score: score * c.weight,
          weight: c.weight,
          args: c.args,
          memorized: c.memorized,
        });
      }
    }
    // One ranking over everything on offer, so a transition's second-choice
    // argument set has to beat another transition's FIRST choice to take its
    // slot — a speculative variant never crowds out a better-evidenced
    // candidate. Among equally frequent transitions the one used recently is
    // the better guess; the gate above is still the raw count.
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
        b.weight - a.weight,
    );
    // No `key` stamped: the predictor owns canonical cache keying.
    const out: Prediction[] = [];
    const emitted = new Set<string>();
    for (const c of candidates) {
      if (out.length >= this.maxPredictionsPerTrigger) break;
      // Two candidates that materialize the same call are one prediction.
      const key = `${c.state.nextTool}\x00${safeStringify(c.args) ?? ''}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({
        server: call.server,
        tool: c.state.nextTool,
        // Fresh, JSON-shaped copy: emitted args must never alias the stored
        // const templates or the current call's args/parsed subtrees.
        args: jsonCopyRecord(c.args),
        // The transition's own confidence — same ramp, same 0.55 ceiling —
        // discounted by how well evidenced this particular argument set is,
        // so a well-evidenced first choice outranks a speculative third
        // downstream too, where §5.6 ranks by confidence x effectiveness. The
        // discount applies AFTER the ceiling: applying it before would let a
        // well-observed transition's third choice clip back up to the cap and
        // arrive indistinguishable from its first. The best combo weighs
        // exactly 1, so a single-candidate transition is unchanged.
        confidence: Math.min(0.55, 0.25 + 0.1 * c.state.count) * c.weight,
        ruleId: c.ruleId,
        // §6.2: a call carrying a remembered literal is a bet on "at some
        // point", not on "next", so the executor fetches it with a shorter
        // TTL. Classified per argument SOURCE, so two candidates for the
        // same tool in the same batch can differ.
        horizon: c.memorized ? 'standing' : 'next',
      });
    }
    return out;
  }
}

// -- (de)serialization ----------------------------------------------------------

function serializeSource(src: ScoredSource): SerializedSource {
  // (score, lastUpdated) travel together and undecayed, exactly as they do
  // for a transition: the next load charges the whole downtime.
  const evidence = {
    score: src.score,
    lastUpdated: src.lastUpdated,
    solo: src.solo,
    ...(src.seen !== 0 ? { seen: src.seen } : {}),
  };
  switch (src.s.kind) {
    case 'arg':
      return { kind: 'arg', key: src.s.key, ...evidence };
    case 'parsed':
      return { kind: 'parsed', path: [...src.s.path], ...evidence };
    case 'const':
      return { kind: 'const', repr: src.s.repr, ...evidence };
  }
}

function deserializeSource(raw: unknown, now: number): ScoredSource | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as SerializedSource;
  const source = ((): Source | null => {
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
  })();
  if (!source) return null;
  return {
    s: source,
    // Missing/junk evidence loads as NONE, not as `count`-style credit: a
    // source may not mint its own standing from a state file, and a file with
    // no scores at all then ranks by the order it stored them in — which is
    // the pre-scoring priority order.
    score: importedScore(s.score, 0, MAX_IMPORTED_COUNT),
    lastUpdated: importedStamp(s.lastUpdated, now),
    solo: importedCount(s.solo) ?? 0,
    seen: importedMask(s.seen),
  };
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
 * A persisted template counter, or undefined when the field is absent or
 * unusable — which is how a pre-v0.13 file is told apart from a current one.
 * Clamped like every other imported count: a state file cannot mint evidence.
 */
function importedCount(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.min(Math.floor(raw), MAX_IMPORTED_COUNT);
}

/**
 * A persisted observation-provenance window, or 0 when absent/junk. Forced
 * into an unsigned 32-bit int so a doctored file cannot smuggle a float or a
 * negative through the bitwise coherence check.
 */
function importedMask(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.trunc(raw) >>> 0;
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
    const tpl = rawTpl as {
      name?: unknown;
      underivable?: unknown;
      derived?: unknown;
      missed?: unknown;
      sources?: unknown;
    };
    if (typeof tpl.name !== 'string' || typeof tpl.underivable !== 'boolean') {
      return null;
    }
    const derived = importedCount(tpl.derived);
    const missed = importedCount(tpl.missed);
    if (derived === undefined && missed === undefined && tpl.underivable) {
      // Pre-v0.13 file: the sticky boolean is all the evidence there is, and
      // it never travelled with usable sources. Keep it fail-closed.
      // Both counters must be absent to read a file as pre-v0.13, so a
      // hand-written hybrid (`underivable: true` with a `derived` but no
      // `missed`) would load as derivable-with-no-misses. No build writes
      // that — this one always writes both — and it can only produce a
      // prediction from sources the same file supplied, so it is left as a
      // documented quirk rather than a third code path.
      templates.set(tpl.name, { sources: [], derived: 0, missed: 1 });
      continue;
    }
    if (!Array.isArray(tpl.sources)) return null;
    const sources: ScoredSource[] = [];
    for (const rawSrc of tpl.sources) {
      const s = deserializeSource(rawSrc, now);
      if (s) sources.push(s); // malformed sources are dropped, not fatal
    }
    // A template that lost all its sources can never derive anything again,
    // matching the live invariant (no sources ⇒ never guess).
    templates.set(tpl.name, {
      sources,
      derived: sources.length === 0 ? 0 : (derived ?? 1),
      missed: missed ?? 0,
    });
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
  now: number,
): Map<string, ArgTemplate> {
  const templates = new Map<string, ArgTemplate>();
  const index = indexPrevCall(prev);
  for (const [name, value] of Object.entries(nextArgs)) {
    templates.set(name, seedTemplate(index, value, 0, now));
  }
  return templates;
}

/**
 * A template from its first sighting. Sources built from a value derive that
 * value by construction, so that sighting counts as a derivation — unless
 * there are no sources at all (an unrepresentable value), which is the one
 * state no later evidence can talk the learner out of.
 */
function seedTemplate(
  index: PrevIndex,
  value: unknown,
  priorMisses: number,
  now: number,
): ArgTemplate {
  const repr = safeStringify(value);
  const sources =
    repr === undefined
      ? []
      : candidateSources(index, value, repr, true).map((s) => newSource(s, now));
  // One sighting explained by exactly one hypothesis is that hypothesis's
  // first solo win; explained by several, it separates none of them.
  if (sources.length === 1) sources[0]!.solo = 1;
  const derived = sources.length > 0 ? 1 : 0;
  return { sources, derived, missed: priorMisses + (derived === 0 ? 1 : 0) };
}

/**
 * Later instance: score each template's competing hypotheses against this
 * instance's value.
 *
 * Every stored source that would have produced the value is credited — not
 * just the first one tried — and any source this instance REVEALS that the
 * template does not hold yet is admitted. Before v0.13 this intersected
 * instead: the candidate list could only ever shrink, so a template was
 * hostage to whichever row index its first sighting happened to use and could
 * never learn that the agent also opens rows 1 and 2. An instance no stored
 * source explains is still a miss (that is the evidence the fail-closed gate
 * runs on) — it just no longer forecloses the hypothesis space. Arg-set
 * instability (a name that appears late, a name that goes missing) is
 * evidence the same way.
 */
function updateTemplates(
  state: TransitionState,
  prev: PrevCall,
  nextArgs: Record<string, unknown>,
  now: number,
): void {
  for (const [name, tpl] of state.templates) {
    // Age every provenance window by one observation FIRST, so that bit i
    // means "i observations ago" for every source of every argument. Doing it
    // per template as each argument is handled would let the windows drift
    // apart, and comparing two arguments' bits is the only thing they are for.
    for (const src of tpl.sources) src.seen = (src.seen << 1) >>> 0;
    if (!Object.prototype.hasOwnProperty.call(nextArgs, name)) {
      tpl.missed += 1; // previously seen arg absent now
    }
  }
  // One index per observation, shared by every argument: the reprs of the
  // previous call's args and result paths do not depend on which argument is
  // being explained.
  let index: PrevIndex | null = null;
  for (const [name, value] of Object.entries(nextArgs)) {
    const tpl = state.templates.get(name);
    index ??= indexPrevCall(prev);
    if (!tpl) {
      // Arg name not seen on earlier instances: seed it from this instance,
      // billed for every earlier instance it was missing from.
      state.templates.set(
        name,
        seedTemplate(index, value, Math.max(0, state.count - 1), now),
      );
      continue;
    }
    const repr = safeStringify(value);
    if (repr === undefined) {
      tpl.missed += 1; // a value nothing can represent explains nothing
      continue;
    }
    const matched: ScoredSource[] = [];
    for (const src of tpl.sources) {
      if (!sourceProduces(src.s, prev, repr)) continue;
      src.score = decayedScore(src.score, src.lastUpdated, now) + 1;
      src.lastUpdated = now;
      src.seen = (src.seen | 1) >>> 0; // this observation, for coherence
      matched.push(src);
    }
    // `derived` counts what the template could have PREDICTED, so only
    // already-stored sources count. Sources mined from the value itself
    // reproduce it by construction; crediting them would make every template
    // derivable and silently disable the fail-closed gate.
    if (matched.length > 0) tpl.derived += 1;
    else tpl.missed += 1;

    const known = new Set(tpl.sources.map((src) => sourceId(src.s)));
    const admitted: ScoredSource[] = [];
    for (const s of candidateSources(index, value, repr, false)) {
      if (known.has(sourceId(s))) continue;
      admitted.push(newSource(s, now));
    }
    if (matched.length === 0 && admitted.length === 0) {
      // Nothing in the trigger explains this value. Memorizing the literal is
      // the last hypothesis available — and it has to earn its keep like any
      // other, which is how a template whose old constant went stale finds
      // the new one instead of going silent forever.
      admitted.push(newSource({ kind: 'const', value, repr }, now));
    }
    // A solo win credits the observation that REVEALED the source, unlike
    // `derived` above, and the asymmetry is deliberate: `derived` asks "could
    // the template have predicted this?", which a source mined from the value
    // cannot have done, while `solo` asks "is this hypothesis telling us
    // something no other one does?", which is exactly what a value nothing
    // else explained shows. The two counters answer different questions and a
    // source still needs MIN_SOURCE_SOLO_WINS of them to be offered.
    const explanations = matched.length + admitted.length;
    if (explanations === 1) (matched[0] ?? admitted[0]!).solo += 1;
    if (admitted.length > 0) {
      tpl.sources.push(...admitted);
      evictSources(tpl, now, admitted.length);
    }
  }
}

/** A newly discovered hypothesis: one observation of evidence, no solo win. */
function newSource(s: Source, now: number): ScoredSource {
  return { s, score: 1, lastUpdated: now, solo: 0, seen: 1 };
}

/** Identity of a hypothesis, for "does the template already hold this?". */
function sourceId(s: Source): string {
  switch (s.kind) {
    case 'arg':
      return `a\x00${s.key}`;
    case 'parsed':
      return `p\x00${s.path.join('\x00')}`;
    case 'const':
      return `c\x00${s.repr}`;
  }
}

/**
 * Trim a template to MAX_SOURCES_PER_ARG by dropping its weakest hypotheses
 * (lowest decayed score, then stalest), never the ones this observation just
 * admitted — the same admission invariant the transition and opener caps
 * carry (§13.16). Refusing new sources at the cap instead, as this did before
 * v0.13, means a saturated argument can never learn anything again: the
 * churn of one-off consts alone is enough to saturate one.
 */
function evictSources(tpl: ArgTemplate, now: number, protectNewest: number): void {
  // The just-admitted sources sit at the tail; everything before them is fair
  // game, and the window shrinks with each eviction.
  let evictable = tpl.sources.length - protectNewest;
  while (tpl.sources.length > MAX_SOURCES_PER_ARG) {
    if (evictable <= 0) {
      // One observation admitted more sources than the cap allows: keep the
      // prefix rather than growing without bound.
      tpl.sources.length = MAX_SOURCES_PER_ARG;
      return;
    }
    let worst = 0;
    for (let i = 1; i < evictable; i++) {
      const a = tpl.sources[i]!;
      const b = tpl.sources[worst]!;
      const delta =
        decayedScore(a.score, a.lastUpdated, now) -
          decayedScore(b.score, b.lastUpdated, now) || a.lastUpdated - b.lastUpdated;
      if (delta < 0) worst = i;
    }
    tpl.sources.splice(worst, 1);
    evictable--;
  }
}

/**
 * Is this argument off limits? Fail closed on the two cases that matter: a
 * source set that has never produced anything (including an empty one, which
 * could not resolve anyway), and a derivation that keeps being wrong once
 * there is enough evidence to say so. In between — thin evidence with at
 * least one miss — the learner stays quiet rather than guessing, and can
 * change its mind later, which the old sticky boolean could not.
 */
function isUnderivable(tpl: ArgTemplate): boolean {
  if (tpl.derived === 0 || tpl.sources.length === 0) return true;
  const observations = tpl.derived + tpl.missed;
  if (observations < MIN_TEMPLATE_EVIDENCE) return tpl.missed > 0;
  return tpl.missed / observations >= MAX_TEMPLATE_MISS_RATE;
}

/**
 * Everything one previous call could have supplied, as canonical reprs,
 * computed ONCE per observation. Every argument of the follow-up call is
 * explained against the same index, so a wide result is walked and stringified
 * once instead of once per argument.
 */
interface PrevIndex {
  args: Array<{ key: string; repr: string | undefined }>;
  paths: Array<{ segs: string[]; repr: string | undefined }>;
}

function indexPrevCall(prev: PrevCall): PrevIndex {
  return {
    args: Object.entries(prev.args).map(([key, v]) => ({ key, repr: safeStringify(v) })),
    paths: enumerateParsedPaths(prev.parsed).map((p) => ({
      segs: p.segs,
      repr: safeStringify(p.value),
    })),
  };
}

/**
 * Sources in the previous call that produce `repr`, in priority order
 * (arg-copy, then parsed-path) — the seed ranking, before evidence exists.
 *
 * `withConst` appends the memorize-this-literal fallback, which a template's
 * FIRST sighting always keeps (it is what makes a stable-valued argument
 * derivable at all). Later sightings mint one only when nothing else explains
 * the value — see updateTemplates — because a const resolves on every future
 * call whatever it is worth, so minting one per observation would fill the
 * cap with stale literals that then compete for slots in the batch.
 */
function candidateSources(
  index: PrevIndex,
  value: unknown,
  repr: string,
  withConst: boolean,
): Source[] {
  const sources: Source[] = [];
  // Priority order is baked into seed order: arg-copy, parsed-path, const.
  const room = withConst ? MAX_SOURCES_PER_ARG - 1 : MAX_SOURCES_PER_ARG;
  for (const a of index.args) {
    if (sources.length >= room) break;
    if (a.repr === repr) sources.push({ kind: 'arg', key: a.key });
  }
  for (const p of index.paths) {
    if (sources.length >= room) break;
    if (p.repr === repr) sources.push({ kind: 'parsed', path: p.segs });
  }
  if (withConst) sources.push({ kind: 'const', value, repr });
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

/** One distinct value an argument could take on the current call. */
interface ArgOption {
  value: unknown;
  /** Canonical repr, for collapsing sources that agree on this call. */
  repr: string;
  /** Decayed evidence for this VALUE: the best admissible source producing it. */
  score: number;
  /**
   * Share of the argument's evidence behind this value, 0..1, and 1 for the
   * best one. Set by argWeights() once the whole option list is known, which
   * is why it is not filled in at construction.
   */
  weight: number;
  /** Union of the provenance windows of the sources producing this value. */
  seen: number;
  /**
   * True when the value came from a `const` source — remembered, not read off
   * the call that just happened. That is the freshness distinction (§6.2):
   * a derived argument says "next", a memorized one says "at some point".
   */
  memorized: boolean;
}

/**
 * The distinct values one argument could take on the current call, best
 * evidence first. Null when the argument is off limits or nothing admissible
 * resolves — both fail-closed, and both drop the whole prediction.
 *
 * Ranking is by decayed per-source score; the seed order (arg-copy >
 * parsed-path > const) survives only as the tie-break, which is what a state
 * file written before per-source scoring — every score 0 — ranks by.
 *
 * ADMISSIBILITY, and why it is not just "whatever resolves": the
 * best-evidenced source is always usable, but any OTHER source needs
 * independent standing (MIN_SOURCE_SOLO_WINS) before it may answer for this
 * argument — whether as a lower-ranked alternative or as a stand-in when the
 * best one fails to resolve. Without that, the const mined from a template's
 * first sighting is a permanent fallback that resolves on every call forever:
 * a list→detail transition whose parsed path finds nothing today would answer
 * with the id it saw once, months ago, and "the derivation did not resolve,
 * so predict nothing" would quietly stop being true.
 */
function argOptions(tpl: ArgTemplate, call: ObservedCall, now: number): ArgOption[] | null {
  if (isUnderivable(tpl)) return null;
  const ranked = tpl.sources
    .map((src, i) => ({ src, i, score: decayedScore(src.score, src.lastUpdated, now) }))
    .sort((a, b) => b.score - a.score || kindRank(a.src.s) - kindRank(b.src.s) || a.i - b.i);

  const byRepr = new Map<string, ArgOption>();
  const out: ArgOption[] = [];
  for (let rank = 0; rank < ranked.length; rank++) {
    const entry = ranked[rank]!;
    if (rank > 0 && entry.src.solo < MIN_SOURCE_SOLO_WINS) continue;
    const res = resolveSource(entry.src.s, call);
    if (!res.ok) continue;
    const repr = safeStringify(res.value);
    if (repr === undefined) continue; // an unrepresentable value is no answer
    // Hypotheses that agree on this call are one candidate, carrying the
    // best-evidenced one's score: offering the same value twice would spend
    // two slots on one answer. Their provenance windows union, because the
    // question a window answers ("was this VALUE right on that observation?")
    // is about the value, not about which source produced it.
    const existing = byRepr.get(repr);
    if (existing) {
      existing.seen = (existing.seen | entry.src.seen) >>> 0;
      continue;
    }
    const option: ArgOption = {
      value: res.value,
      repr,
      score: entry.score,
      weight: 1,
      seen: entry.src.seen,
      memorized: entry.src.s.kind === 'const',
    };
    byRepr.set(repr, option);
    out.push(option);
  }
  return out.length > 0 ? out : null;
}

/**
 * Fill in each option's weight: the SHARE of the argument's evidence standing
 * behind it, with the best one pinned at 1 so the all-best combination weighs
 * 1 and a transition's first candidate ranks exactly where it did before.
 *
 * Normalizing against the leader instead would rank twelve tied one-off
 * literals exactly like a genuine 25/9/5 split of a list position, which is
 * how a transition with an underivable argument spends a whole batch on
 * memorized junk before the miss-rate gate closes on it. Computed over the
 * whole admissible list BEFORE the per-trigger cap truncates it, so the
 * emitted prefix does not depend on how many predictions a trigger is allowed.
 */
function argWeights(options: ArgOption[]): void {
  let total = 0;
  for (const o of options) total += o.score;
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!;
    o.weight = i === 0 || total <= 0 ? 1 : o.score / total;
  }
}

/** Seed priority, the tie-break among equally evidenced sources. */
function kindRank(s: Source): number {
  return s.kind === 'arg' ? 0 : s.kind === 'parsed' ? 1 : 2;
}

/** This source's value on the current call. `const` always resolves. */
function resolveSource(s: Source, call: ObservedCall): Resolution {
  switch (s.kind) {
    case 'arg':
      return Object.prototype.hasOwnProperty.call(call.args, s.key)
        ? { ok: true, value: call.args[s.key] }
        : { ok: false };
    case 'parsed':
      return resolvePath(call.parsed, s.path);
    case 'const':
      return { ok: true, value: s.value };
  }
}

/** One materialized argument set, with its share of the transition's weight. */
interface ArgCombo {
  args: Record<string, unknown>;
  /** Product of the per-argument normalized scores; the best combo is 1. */
  weight: number;
  /**
   * NOTHING in this call was read off the trigger — every argument is a
   * remembered literal — so the only thing tying it to now is the transition
   * itself (§6.2 freshness).
   *
   * The test is `every`, not `some`, and the difference is the whole point.
   * Horizon is about whether the TARGET was derived from the trigger, not
   * whether every argument was: `get_issue {repo, number: <from the trigger's
   * result>, per_page: 100}` is a next-call prediction that happens to carry
   * a constant, and real profiles are full of constant `per_page` /
   * `state: 'open'` / `format` arguments. `some` classified the modal
   * next-call prediction as a standing bet.
   */
  memorized: boolean;
  /** False only when two of the chosen values have never been right together. */
  coherent: boolean;
}

/**
 * Up to `limit` argument sets for one transition, best first (§13.18).
 *
 * The first is the all-best combination — every argument answered by its
 * best-evidenced source, weight exactly 1, i.e. what this transition used to
 * emit as its only candidate. The rest substitute the next-best value for one
 * argument at a time, ordered by the product of the per-argument weights. For
 * the dominant real shape — one argument that moves (which row of the list did
 * the agent open?) and the rest fixed — that yields row 0, row 1, row 2 in the
 * order they have actually been opened.
 *
 * A substitution is skipped when the chosen values are known NEVER to have
 * been right together (see the coherence check below), so two arguments that
 * co-vary do not fill the batch with pairings that never happened.
 *
 * Empty when any argument is underivable or unresolvable: a prediction is
 * still all-or-nothing, and no argument is ever fabricated.
 */
function materializeCombos(
  state: TransitionState,
  call: ObservedCall,
  now: number,
  limit: number,
): ArgCombo[] {
  const names: string[] = [];
  const options: ArgOption[][] = [];
  for (const [name, tpl] of state.templates) {
    const opts = argOptions(tpl, call, now);
    if (opts === null) return []; // fail closed — never partial args
    names.push(name);
    // An argument with no evidence at all (a state file that predates
    // per-source scoring) answers with its priority-order first source and
    // offers no alternatives: there is nothing to rank them by.
    const usable = opts[0]!.score > 0 ? opts : [opts[0]!];
    argWeights(usable);
    options.push(usable.slice(0, Math.max(1, limit)));
  }

  const n = names.length;
  const combo = (idx: number[]): ArgCombo => {
    const args: Record<string, unknown> = {};
    let weight = 1;
    /** Arguments read off the trigger. One is enough to make this next-call. */
    let derived = 0;
    // Provenance windows intersected across arguments. An argument with no
    // window recorded (a pre-v0.13 state file, or a source whose sightings
    // have aged out of the 32-observation window) contributes no evidence
    // either way and is left out of the count.
    let support = 0xffffffff;
    let known = 0;
    for (let a = 0; a < n; a++) {
      const option = options[a]![idx[a]!]!;
      args[names[a]!] = option.value;
      weight *= option.weight;
      if (!option.memorized) derived++;
      if (option.seen !== 0) {
        support = (support & option.seen) >>> 0;
        known++;
      }
    }
    // Two or more windows that never overlap is positive evidence that this
    // pairing has never occurred; anything less is simply unknown, and
    // unknown must not block a candidate.
    // A zero-argument call is next-call: there is nothing to derive, and the
    // transition that triggered it is the derivation.
    return {
      args,
      weight,
      memorized: n > 0 && derived === 0,
      coherent: known < 2 || support !== 0,
    };
  };

  // Best-first over the lattice of per-argument choices. Every step
  // multiplies by a factor <= 1 (options are sorted by score), so popping the
  // heaviest frontier entry yields the combinations in exact weight order.
  const out: ArgCombo[] = [];
  const root = new Array<number>(n).fill(0);
  const visited = new Set<string>([root.join(',')]);
  const frontier = [{ idx: root, c: combo(root) }];
  for (let pops = 0; out.length < limit && frontier.length > 0 && pops < MAX_BEAM_POPS; pops++) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i]!.c.weight > frontier[best]!.c.weight) best = i;
    }
    const cur = frontier.splice(best, 1)[0]!;
    // Weight 0 marks a substitution with no standing of its own, and nothing
    // behind it in the order can weigh more: stop rather than fill the batch.
    if (cur.c.weight <= 0) break;
    // An incoherent combination is skipped but still EXPANDED: the coherent
    // pairing of two co-varying arguments is only reachable through it. The
    // all-best combination is never skipped — it is what this transition
    // predicted before there was a beam at all, and dropping it would turn a
    // ranking heuristic into a fail-closed gate.
    if (out.length === 0 || cur.c.coherent) out.push(cur.c);
    for (let a = 0; a < n; a++) {
      if (cur.idx[a]! + 1 >= options[a]!.length) continue;
      const next = [...cur.idx];
      next[a]! += 1;
      const key = next.join(',');
      if (visited.has(key)) continue;
      visited.add(key);
      frontier.push({ idx: next, c: combo(next) });
    }
  }
  return out;
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
