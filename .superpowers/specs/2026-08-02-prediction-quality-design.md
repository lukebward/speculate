# Prediction quality: learn which candidate is right, and forget stale ones

**Date:** 2026-08-02 · **Status:** approved (Luke, in-session) · **Branch:** `prediction-quality`

## Goal

Make the learner predict well on **any** MCP server, with no profile and no
server-specific knowledge. Profiles stay as optional accelerants; nothing in
this work may depend on a field only GitHub (or Slack, or anyone) emits.

## What the learner already does right

`enumerateParsedPaths` (`src/learner.ts:719-760`) enumerates paths into the
previous call's parsed result, **including array indices** (`["0","number"]`,
`["items","1","id"]`). So `list → detail` argument derivation is already
learned generically: open PR #7 after a list, and the learner finds 7 at
`['0','number']` and stores it. This is the hardcoded GitHub rule, learned
from traffic, and it works identically for Slack threads, Sentry issues, or
any list-then-detail shape.

The machinery is right. It just never learns which hypothesis is correct, and
it never forgets.

## The five defects

1. **Twelve hypotheses, zero scoring.** `resolveSources` (`:687-700`) returns
   the first source that resolves, in fixed priority order (arg-copy >
   parsed-path > const). Nothing records which source actually produced the
   value used next, so evidence never accumulates and priority order can be
   permanently wrong for a given user.

2. **One transition yields exactly one prediction.** `materializeArgs`
   (`:670-684`) builds a single arg set. A transition can never offer index 0
   *and* index 1 as separate candidates, so recall@K is capped at recall@1
   regardless of budget. This is the largest single loss.

3. **No time decay.** `confidence = min(0.55, 0.25 + 0.1 * count)` (`:443`) is
   frequency only. Five uses last month rank identically to five uses today.
   `lastUpdated` is already stored on every transition and used only for
   opener eviction.

4. **Transition eviction is FIFO.** `:341-344` evicts via
   `transitions.keys().next()`, i.e. oldest-inserted, so a daily-use
   transition can be dropped in favour of a once-seen recent one. Openers
   already evict correctly (`:249`, lowest count then stalest).

5. **Source slots are first-come.** `:633` breaks at `MAX_SOURCES_PER_ARG`,
   so early noise permanently occupies slots. Widening the index window
   (defect 6) would make this worse, not better.

6. **Positions past index 2 are unlearnable.** `pushArrayPaths` uses
   `Math.min(arr.length, 3)`. If a user habitually opens the fourth item,
   nothing can represent it.

## Design

### Scoring: raw count gates, decayed score ranks

Decay must **not** replace `count`, because `count` gates `minObservations`
and decaying it in place would silently stop stale-but-valid transitions from
firing at all. Instead:

- `count` (raw, existing) keeps gating `minObservations`. Unchanged semantics.
- `score` (new, decayed) ranks and evicts.

On each observation: `score = score * exp(-(now - lastUpdated) / TAU) + 1`,
with `TAU` a half-life-shaped constant (default 14 days, configurable). Read
sites apply the same decay lazily to `now` so a score read long after its last
update is not stale-high.

### Per-source success counts (defects 1, 2, 5)

Each stored `Source` gains `{ score, lastUpdated }` with the same decay.

**On observe:** for each argument, mark **every** stored source that would
have produced the value actually used (not just the first). Multiple sources
can legitimately match, and all of them earned it.

**On predict:** rank each argument's sources by decayed score. Emit multiple
predictions via a **beam of width K**: start from the all-best-source
combination, then generate variants by substituting the next-best source for
one argument at a time, ordered by the product of source scores. Cap at
`maxPredictionsPerTrigger`. This produces "index 0, then index 1, then index
2" naturally, ranked by that user's observed behavior rather than the
hardcoded `[0.5, 0.35]` in the GitHub profile.

Per-prediction confidence derives from the transition's decayed score and the
normalized source-score product, so a well-evidenced first choice outranks a
speculative third.

**At the source cap:** evict the lowest-scoring source instead of refusing to
add (fixes defect 5, and is a prerequisite for defect 6 to help).

### Window widening (defect 6)

`pushArrayPaths` index limit becomes a constant, default 8. Safe only because
per-source scoring now prunes losers; `MAX_PARSED_PATHS = 256` still bounds
total enumeration.

### Entity frecency (return visits)

Positional learning predicts *new* items. It cannot predict "the PR I have
been living in all week," which sits at an arbitrary position.

Add `(server, tool, canonicalArgsRepr) -> {score, lastUpdated}`, same decay.
Used as a **generator**, but gated to stay targeted: emit only when (a) the
tool-pair transition already exists, (b) the entity's decayed score clears a
threshold, and (c) at most 1-2 per trigger. Gate (a) keeps it
transition-conditioned rather than firing arbitrary history at every call.

### Measurement (prerequisite, not an afterthought)

None of the above is provable against the current benchmark, which replays
exactly the transitions the GitHub profile hardcodes. Build an offline
evaluation harness first:

- A corpus generator producing sessions from several archetypes with
  **randomized entity selection** (not always index 0), plus a deliberately
  low-predictability archetype. This is the adversarial floor `DESIGN.md` §10
  item 8 promised at v0.1 and never delivered.
- A replay that, for each observed `prev -> next` pair, asks the predictor for
  its ranked candidates and records the rank of the actual next call.
- Reports **recall@1 / @3 / @5** and waste per hit, per archetype.

Every later task reports its recall delta against the baseline this
establishes. A change that does not move recall does not land.

## Constraints

- **Generic only.** No `updated_at`, authorship, or any server-specific field
  in the core scorer. Profiles may boost; the generic path must work on a
  server nobody has profiled.
- **Old state files must keep loading.** Deserialization already skips
  malformed entries; new fields default rather than invalidate.
- **Privacy unchanged.** The learner already persists argument templates and
  never results; entity keys are argument-derived, so this stays inside that
  boundary.
- **No regressions.** 497 passing / 7 platform-skipped is the floor, and the
  existing safety gates (read-only eligibility, budget, dedup) are untouched.
- Windows is a first-class target.

## Non-goals

- Changing the safety policy, budget, or cache.
- Semantic understanding of any server's payloads.
- Replacing profiles. They remain a cold-start accelerant.
- Cross-server or cross-project learning.
