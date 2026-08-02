/**
 * Prediction-quality evaluation corpus (DESIGN.md §5.3, §10 item 8).
 *
 * Synthetic agent sessions used to measure the GENERIC TransitionLearner —
 * not the vetted profiles. Nothing here is shaped to the five hand-written
 * rules in src/profiles/github.ts: different domains, different tool names,
 * different result shapes. A corpus built to match the rules would only
 * prove the rules match the corpus (the mistake bench/bench.ts makes by
 * replaying exactly the transitions the GitHub profile hardcodes).
 *
 * What the corpus DOES target is the learner's actual machinery:
 *   - transitions keyed (server, prevTool, nextTool), armed at 2 observations;
 *   - per-argument sources: arg-copy, a path into the previous call's PARSED
 *     result (arrays only expose indices 0..2), and the const fallback;
 *   - the sticky "underivable" poisoning that drops a transition entirely.
 *
 * Every archetype therefore contains BOTH a leg the current learner can
 * derive and a leg it cannot, so the score sits in a sensitive middle band
 * instead of saturating at 0 or 100.
 *
 * KNOWN BLIND SPOT — array-index parsed paths. No archetype has a SURVIVING
 * `hits.0.docId`-style derivation: both list→detail legs are poisoned by
 * design (they are the improvement targets), and multi-arg resolves through
 * the nested-object path `suggested.docId` so that it does not smuggle in the
 * "the agent opens the top of the list" assumption. Consequence: if
 * `pushArrayPaths` in src/learner.ts broke outright, this eval would not
 * notice — the headline would not move. Do not treat a green eval as
 * validation of array-path work; test/learner.test.ts is where that lives.
 *
 * Determinism: every draw comes from the seeded PRNG below. No ambient
 * randomness and no ambient clock is reachable from this package —
 * test/eval.test.ts greps the sources to keep it that way.
 */

/** One replayed agent session: an ordered run of calls against one server. */
export interface EvalSession {
  server: string;
  calls: Array<{ tool: string; args: Record<string, unknown>; parsed: unknown }>;
}

/** A named family of sessions, reproducible from a seed. */
export interface Archetype {
  name: string;
  sessions(seed: number): EvalSession[];
}

/**
 * Sessions generated per archetype (warm-up included). Sized so the rarest
 * branch in an archetype is seen often enough to arm AND recur — otherwise
 * the deep ranks are unreachable and recall@5 degenerates into recall@3.
 */
export const SESSIONS_PER_ARCHETYPE = 60;
/**
 * Leading sessions that are observed but NOT scored. The learner needs two
 * sightings before a transition can fire at all, so scoring the cold start
 * would just measure the minObservations gate. Warm-up sessions still teach
 * the model; only their pairs are excluded from the report.
 */
export const WARMUP_SESSIONS = 10;

// -- deterministic PRNG -------------------------------------------------------

export interface Rng {
  /** Float in [0, 1). */
  float(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  /** Index into `weights`, drawn proportionally to them. */
  weighted(weights: readonly number[]): number;
}

/** mulberry32 — 32-bit, seedable, no dependencies, identical everywhere. */
function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const float = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n: number): number => Math.floor(float() * n);
  return {
    float,
    int,
    pick: <T,>(xs: readonly T[]): T => xs[int(xs.length)]!,
    weighted: (weights: readonly number[]): number => {
      let total = 0;
      for (const w of weights) total += w;
      let r = float() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!;
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
  };
}

/** Mixes the run seed with an archetype label so streams stay independent. */
function streamSeed(seed: number, label: string): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic unique-id minter: ids never repeat within a run. */
function minter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(++n).toString(36).padStart(4, '0')}`;
}

const WORDS = [
  'retry',
  'timeout',
  'quota',
  'schema',
  'replica',
  'ingest',
  'rollup',
  'sidecar',
  'webhook',
  'backfill',
] as const;

function phrase(rng: Rng): string {
  return `${rng.pick(WORDS)} ${rng.pick(WORDS)}`;
}

// -- archetype 1: list-detail-varied ------------------------------------------

/**
 * Board → card → follow-up, where the opened card sits at a RANDOMIZED index
 * drawn from a skewed distribution (index 0 most likely, but a long tail past
 * the learner's 0..2 array window).
 *
 * Hard leg — `board_list_cards → card_get`: the card id lives only in the
 * parsed list, at a position that moves. The first time the opened index
 * differs from the learned one, the argument template is poisoned for good.
 * Easy leg — `card_get → …`: FOUR competing follow-ups whose arguments are
 * copies of the previous call's args (plus one genuine constant), so ranking
 * rather than derivation decides recall@1 vs @3 vs @5 — the rarest branch
 * sits past the shipped per-trigger cap and is only reachable at rank 4+.
 */
const listDetailVaried: Archetype = {
  name: 'list-detail-varied',
  sessions(seed) {
    const rng = makeRng(streamSeed(seed, 'list-detail-varied'));
    const card = minter('card');
    const boards = ['bugs', 'platform', 'mobile'] as const;
    // Index 0 dominates but never wins outright; the tail reaches past the
    // indices any parsed path can address today.
    const indexWeights = [40, 18, 12, 8, 6, 4, 4, 3, 3, 2];
    const out: EvalSession[] = [];

    for (let s = 0; s < SESSIONS_PER_ARCHETYPE; s++) {
      const board = rng.pick(boards);
      const cards = Array.from({ length: 10 }, () => ({
        cardId: card(),
        title: phrase(rng),
        laneId: `lane-${rng.int(4)}`,
      }));
      const listed = { board, cards, total: cards.length };
      const opened = cards[rng.weighted(indexWeights)]!;
      const detail = {
        cardId: opened.cardId,
        title: opened.title,
        laneId: opened.laneId,
        assignee: `user-${rng.int(6)}`,
      };

      const calls: EvalSession['calls'] = [
        { tool: 'board_list_cards', args: { board }, parsed: listed },
        {
          tool: 'card_get',
          args: { board, cardId: opened.cardId },
          parsed: detail,
        },
      ];

      // Branching follow-up: the learner must rank four armed transitions.
      // The weights are spread so the fourth-ranked one still draws enough
      // pairs to be measurable past the shipped cap of 3.
      switch (rng.weighted([40, 28, 18, 14])) {
        case 0:
          calls.push({
            tool: 'card_get_activity',
            args: { board, cardId: opened.cardId },
            parsed: {
              cardId: opened.cardId,
              events: [
                { at: 1 + rng.int(9), kind: 'moved' },
                { at: 10 + rng.int(9), kind: 'commented' },
              ],
            },
          });
          break;
        case 1:
          calls.push({
            tool: 'card_get_attachments',
            args: { cardId: opened.cardId },
            parsed: { cardId: opened.cardId, files: [phrase(rng)] },
          });
          break;
        case 2:
          // "back to the board" — same list, re-read.
          calls.push({ tool: 'board_list_cards', args: { board }, parsed: listed });
          break;
        default:
          // The rare branch. `depth` is a true constant: the const source is
          // the only thing that can supply it, so this also checks the
          // learner's fallback still works alongside arg-copies.
          calls.push({
            tool: 'card_list_links',
            args: { cardId: opened.cardId, depth: 2 },
            parsed: { cardId: opened.cardId, links: [{ cardId: card(), kind: 'blocks' }] },
          });
          break;
      }
      out.push({ server: 'tracker', calls });
    }
    return out;
  },
};

// -- archetype 2: return-visits ------------------------------------------------

/**
 * The same two alerts reopened across many sessions, at list positions that
 * move every time.
 *
 * Hard leg — `svc_list_alerts → alert_get`: the id alternates between two
 * stable values (so the const source dies) at shifting positions (so every
 * parsed path dies too). Today that transition is poisoned and predicts
 * nothing; a model that remembered recently-visited entities would score
 * here, which is exactly what this archetype is for.
 * Easy leg — `alert_get → …`: arg-copy follow-ups, two-way branch.
 */
const returnVisits: Archetype = {
  name: 'return-visits',
  sessions(seed) {
    const rng = makeRng(streamSeed(seed, 'return-visits'));
    const filler = minter('alert');
    const services = ['checkout', 'search', 'billing'] as const;
    // The two entities this operator keeps coming back to.
    const favourites = ['alert-hot-1042', 'alert-hot-2071'] as const;
    const out: EvalSession[] = [];

    for (let s = 0; s < SESSIONS_PER_ARCHETYPE; s++) {
      const service = rng.pick(services);
      const alerts = Array.from({ length: 10 }, () => ({
        alertId: filler(),
        severity: rng.pick(['warn', 'crit', 'info'] as const),
        summary: phrase(rng),
      }));
      // Drop the two return visits at moving, distinct positions.
      const first = rng.int(10);
      let second = rng.int(9);
      if (second >= first) second += 1;
      alerts[first] = {
        alertId: favourites[0],
        severity: 'crit',
        summary: phrase(rng),
      };
      alerts[second] = {
        alertId: favourites[1],
        severity: 'crit',
        summary: phrase(rng),
      };
      const listed = { service, alerts, window: '24h' };

      const openedId = favourites[rng.int(2)]!;
      const opened = alerts.find((a) => a.alertId === openedId)!;
      const detail = {
        alertId: openedId,
        service,
        severity: opened.severity,
        owner: `team-${rng.int(4)}`,
      };

      const calls: EvalSession['calls'] = [
        { tool: 'svc_list_alerts', args: { service }, parsed: listed },
        { tool: 'alert_get', args: { service, alertId: openedId }, parsed: detail },
      ];

      if (rng.weighted([70, 30]) === 0) {
        calls.push({
          tool: 'alert_get_timeline',
          args: { alertId: openedId },
          parsed: {
            alertId: openedId,
            entries: [{ at: rng.int(60), state: 'firing' }],
          },
        });
      } else {
        calls.push({ tool: 'svc_list_alerts', args: { service }, parsed: listed });
      }
      out.push({ server: 'oncall', calls });
    }
    return out;
  },
};

// -- archetype 3: multi-arg ----------------------------------------------------

/**
 * A follow-up whose two arguments come from two DIFFERENT sources: `space` is
 * an arg-copy of the search call's argument, `docId` only exists inside the
 * parsed result. Both the space and the doc ids vary across sessions, so the
 * const fallback dies and the learner has to keep the real derivations to
 * predict at all.
 *
 * The doc that gets opened is the server's own `suggested` best match, whose
 * position inside `hits` is drawn from a skew — so the derivation runs through
 * a NESTED OBJECT path (`suggested.docId`), not an array index, and no
 * "the agent always opens the top of the list" assumption is embedded here.
 * A rule that predicted `hits[0]` would miss most of these sessions.
 *
 * The third call is a two-way branch plus a genuinely unpredictable move (a
 * brand-new search query, derivable from nothing), so this archetype cannot
 * saturate at 100 either.
 */
const multiArg: Archetype = {
  name: 'multi-arg',
  sessions(seed) {
    const rng = makeRng(streamSeed(seed, 'multi-arg'));
    const doc = minter('doc');
    const spaces = ['runbooks', 'adr', 'onboarding', 'postmortems'] as const;
    const out: EvalSession[] = [];

    for (let s = 0; s < SESSIONS_PER_ARCHETYPE; s++) {
      const space = rng.pick(spaces);
      const query = phrase(rng);
      const hits = Array.from({ length: 5 }, (_unused, i) => ({
        docId: doc(),
        title: phrase(rng),
        score: 90 - i * 7 - rng.int(3),
      }));
      // The server's best match is usually, but not always, the first row.
      // `suggested` is declared before `hits` so the stable nested path is
      // also the one enumerateParsedPaths reaches first.
      const opened = hits[rng.weighted([40, 25, 15, 12, 8])]!;
      const found = {
        space,
        query,
        suggested: { docId: opened.docId, title: opened.title },
        hits,
        took: rng.int(40),
      };
      const detail = {
        docId: opened.docId,
        space,
        title: opened.title,
        updatedBy: `user-${rng.int(5)}`,
      };

      const calls: EvalSession['calls'] = [
        { tool: 'space_search', args: { space, query }, parsed: found },
        { tool: 'doc_read', args: { space, docId: opened.docId }, parsed: detail },
      ];

      switch (rng.weighted([55, 20, 25])) {
        case 0:
          calls.push({
            tool: 'doc_read_comments',
            args: { space, docId: opened.docId },
            parsed: {
              docId: opened.docId,
              comments: [{ by: 'user-1', body: phrase(rng) }],
            },
          });
          break;
        case 1:
          calls.push({
            tool: 'doc_list_backlinks',
            args: { docId: opened.docId },
            parsed: { docId: opened.docId, backlinks: [doc()] },
          });
          break;
        default: {
          // A fresh query: derivable from nothing, and it poisons the
          // doc_read → space_search transition. That is the honest outcome.
          const next = phrase(rng);
          const more = Array.from({ length: 5 }, (_unused, i) => ({
            docId: doc(),
            title: phrase(rng),
            score: 88 - i * 6,
          }));
          const pick = more[rng.weighted([40, 25, 15, 12, 8])]!;
          calls.push({
            tool: 'space_search',
            args: { space, query: next },
            parsed: {
              space,
              query: next,
              suggested: { docId: pick.docId, title: pick.title },
              hits: more,
              took: rng.int(40),
            },
          });
          break;
        }
      }
      out.push({ server: 'docs', calls });
    }
    return out;
  },
};

// -- archetype 4: regime-shift -------------------------------------------------

/** Phase-1 sessions. Also this archetype's warm-up: none of them are scored. */
const REGIME_PHASE1_SESSIONS = 40;
/** Phase-2 sessions — the only ones scored. */
const REGIME_PHASE2_SESSIONS = 40;
/**
 * Idle time between the two phases. Must be several multiples of the
 * learner's evidence half-life (TAU, 14 days at time of writing) for phase-1
 * evidence to be genuinely stale rather than merely old.
 */
export const REGIME_IDLE_GAP_MS = 45 * 24 * 3600_000;

/**
 * The user changed how they work.
 *
 * Phase 1 establishes a workflow: `pipeline_status` is followed by three
 * different reads, twice each per session, for 40 sessions — so each of those
 * transitions ends up with a raw count of 80. Then 45 days pass. Phase 2 uses
 * the SAME trigger but a follow-up that did not exist before, and it never
 * reaches a count above 40 — half the abandoned workflow's.
 *
 * Only phase 2 is scored, and every scored pair is the same question: after
 * the trigger, does the model offer what the user does NOW, or what they used
 * to do?
 *
 * A frequency-only learner answers "what they used to do" forever: the three
 * stale transitions outrank the fresh one on raw count, and with a
 * per-trigger cap of 3 they crowd it out of the batch entirely — recall@3
 * near 0 while recall@5 stays high, because the right candidate is there and
 * merely ranked fourth. Time-decayed evidence answers "what they do now".
 *
 * This archetype exists because the rest of the corpus cannot ask that
 * question: its sessions are 600 s apart against a 14-day half-life, so
 * nothing in it is ever stale and decay can only perturb tie-breaks. Judging
 * a staleness change against an instrument blind to staleness is the circular
 * benchmark mistake wearing a different hat.
 *
 * Note what it does NOT measure: it is a discriminator, not a difficulty
 * test. It sits near 1.0 with decay and near 0.0 without, so it guards the
 * behaviour rather than leaving headroom.
 */
const regimeShift: Archetype = {
  name: 'regime-shift',
  sessions(seed) {
    const rng = makeRng(streamSeed(seed, 'regime-shift'));
    const run = minter('run');
    const projects = ['orders-api', 'web-edge', 'ledger-sync', 'search-idx'] as const;
    // The workflow that gets abandoned. Each appears twice per phase-1
    // session, so all three accumulate identical raw counts and the fresh
    // transition has to beat all of them, not just the weakest.
    const established = [
      'pipeline_get_logs',
      'pipeline_list_artifacts',
      'pipeline_get_tests',
    ] as const;
    const out: EvalSession[] = [];

    const status = (project: string, runId: string): EvalSession['calls'][number] => ({
      tool: 'pipeline_status',
      args: { project },
      parsed: {
        project,
        runId,
        branch: rng.pick(['main', 'release', 'next'] as const),
        jobs: Array.from({ length: 4 }, () => ({
          name: phrase(rng),
          state: rng.pick(['passed', 'failed', 'running'] as const),
        })),
      },
    });

    // -- phase 1: the workflow that will be abandoned --
    for (let s = 0; s < REGIME_PHASE1_SESSIONS; s++) {
      const project = rng.pick(projects);
      const runId = run();
      const calls: EvalSession['calls'] = [];
      for (let round = 0; round < 2; round++) {
        // Shuffled order, identical multiset: the counts stay tied while the
        // sequence is not a fixed drumbeat.
        const order = [...established];
        for (let i = order.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        for (const tool of order) {
          calls.push(status(project, runId));
          calls.push({
            tool,
            args: { project, runId },
            parsed: { runId, project, entries: [{ at: rng.int(90), note: phrase(rng) }] },
          });
        }
      }
      out.push({ server: 'pipeline', calls });
    }

    // -- 45 days pass (applied by the replay via ARCHETYPE_TIMING) --

    // -- phase 2: same trigger, new follow-up --
    for (let s = 0; s < REGIME_PHASE2_SESSIONS; s++) {
      const project = rng.pick(projects);
      const runId = run();
      out.push({
        server: 'pipeline',
        calls: [
          status(project, runId),
          {
            tool: 'pipeline_get_deploy',
            args: { project, runId },
            parsed: {
              runId,
              project,
              rollout: rng.pick(['queued', 'live', 'rolled-back'] as const),
            },
          },
        ],
      });
    }
    return out;
  },
};

// -- archetype 5: adversarial (the floor) --------------------------------------

/**
 * The low-predictability floor DESIGN.md §10 item 8 asks for: the next tool is
 * drawn uniformly at random, and every entity id is minted fresh and never
 * repeats, so no argument is derivable from the previous call by any source
 * the learner has — arg-copy, parsed path, or const.
 *
 * One argument-free tool (`ledger_health`) is in the mix on purpose. Its
 * transitions ARE materializable (an empty template always resolves), so the
 * floor is not trivially "nothing is ever predicted": the learner fires,
 * mostly wrongly, and the waste/hit column measures the cost. A change that
 * buys recall by predicting more aggressively shows up here first.
 */
const adversarial: Archetype = {
  name: 'adversarial',
  sessions(seed) {
    const rng = makeRng(streamSeed(seed, 'adversarial'));
    const entity = minter('e');
    const tools: Array<{ tool: string; arg: string | null }> = [
      { tool: 'ledger_entry_get', arg: 'entryId' },
      { tool: 'ledger_account_get', arg: 'accountId' },
      { tool: 'ledger_batch_get', arg: 'batchId' },
      { tool: 'ledger_ref_lookup', arg: 'ref' },
      { tool: 'ledger_export_get', arg: 'exportId' },
      { tool: 'ledger_health', arg: null },
    ];
    const out: EvalSession[] = [];

    for (let s = 0; s < SESSIONS_PER_ARCHETYPE; s++) {
      const calls: EvalSession['calls'] = [];
      // Same length as every other archetype: the floor must not outweigh the
      // rest of the corpus just because its sessions are longer.
      for (let i = 0; i < 3; i++) {
        const spec = tools[rng.int(tools.length)]!;
        const args: Record<string, unknown> = spec.arg ? { [spec.arg]: entity() } : {};
        // The parsed result shares nothing with any later call's arguments:
        // every id is minted once and never seen again.
        calls.push({
          tool: spec.tool,
          args,
          parsed: { id: entity(), rows: rng.int(500), stamp: entity() },
        });
      }
      out.push({ server: 'chaos', calls });
    }
    return out;
  },
};

/** The evaluated corpus, in report order. */
export const ARCHETYPES: readonly Archetype[] = [
  listDetailVaried,
  returnVisits,
  multiArg,
  regimeShift,
  adversarial,
];

/**
 * Per-archetype replay timing. Kept beside the corpus rather than inside
 * `Archetype`, whose shape is fixed by the task brief.
 */
export interface ArchetypeTiming {
  /** Overrides WARMUP_SESSIONS: sessions observed but not scored. */
  warmupSessions?: number;
  /** Idle time inserted before `beforeSession`, on top of the usual spacing. */
  idleGap?: { beforeSession: number; ms: number };
}

export const ARCHETYPE_TIMING: ReadonlyMap<string, ArchetypeTiming> = new Map([
  [
    'regime-shift',
    {
      // Phase 1 is entirely warm-up: it exists to build the stale evidence,
      // and scoring it would measure the old workflow instead of the shift.
      warmupSessions: REGIME_PHASE1_SESSIONS,
      idleGap: { beforeSession: REGIME_PHASE1_SESSIONS, ms: REGIME_IDLE_GAP_MS },
    },
  ],
]);

/** The warm-up this archetype actually replays with. */
export function warmupFor(archetype: string): number {
  return ARCHETYPE_TIMING.get(archetype)?.warmupSessions ?? WARMUP_SESSIONS;
}

/**
 * Archetypes that are floors, not targets. They are reported next to the
 * headline but never pooled INTO it: a change that fires more aggressively on
 * noise would otherwise move the headline while predicting nothing better.
 * Their job is the opposite — to catch exactly that change, via recall staying
 * near zero while waste/hit climbs.
 */
export const FLOOR_ARCHETYPES: ReadonlySet<string> = new Set(['adversarial']);

/** Archetypes pooled into the headline number. */
export const WORKFLOW_ARCHETYPES: readonly Archetype[] = ARCHETYPES.filter(
  (a) => !FLOOR_ARCHETYPES.has(a.name),
);
