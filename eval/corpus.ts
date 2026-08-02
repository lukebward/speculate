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
      switch (rng.weighted([52, 22, 14, 12])) {
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
 * parsed result (`hits.0.docId`). Both the space and the doc ids vary across
 * sessions, so the const fallback dies and the learner has to keep the real
 * derivations to predict at all.
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
      const found = { space, query, hits, took: rng.int(40) };
      const top = hits[0]!;
      const detail = {
        docId: top.docId,
        space,
        title: top.title,
        updatedBy: `user-${rng.int(5)}`,
      };

      const calls: EvalSession['calls'] = [
        { tool: 'space_search', args: { space, query }, parsed: found },
        { tool: 'doc_read', args: { space, docId: top.docId }, parsed: detail },
      ];

      switch (rng.weighted([55, 20, 25])) {
        case 0:
          calls.push({
            tool: 'doc_read_comments',
            args: { space, docId: top.docId },
            parsed: { docId: top.docId, comments: [{ by: 'user-1', body: phrase(rng) }] },
          });
          break;
        case 1:
          calls.push({
            tool: 'doc_list_backlinks',
            args: { docId: top.docId },
            parsed: { docId: top.docId, backlinks: [doc()] },
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
          calls.push({
            tool: 'space_search',
            args: { space, query: next },
            parsed: { space, query: next, hits: more, took: rng.int(40) },
          });
          break;
        }
      }
      out.push({ server: 'docs', calls });
    }
    return out;
  },
};

// -- archetype 4: adversarial (the floor) --------------------------------------

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
      for (let i = 0; i < 4; i++) {
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
  adversarial,
];
