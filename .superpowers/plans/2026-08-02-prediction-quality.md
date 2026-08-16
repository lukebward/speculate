# Prediction Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the learner predict well on any MCP server with no profile, by scoring its competing argument-source hypotheses, emitting several ranked candidates per trigger, and decaying stale evidence.

**Architecture:** Build the measurement first, then change scoring under it. Each task reports its recall@K delta against the baseline; a change that does not move recall does not land.

**Tech Stack:** TypeScript (strict), Node >= 18, vitest, no new dependencies.

**Spec:** `.superpowers/specs/2026-08-02-prediction-quality-design.md` (read it).

## Global Constraints

- **Generic only.** No server-specific field (`updated_at`, authorship, anything GitHub/Slack-shaped) may enter the core scorer. The generic path must work on a server nobody has profiled. Profiles stay as optional accelerants.
- **Old state files must keep loading.** New fields default rather than invalidate; `loadManagedState`-style tolerance already exists in `deserialize*` and must be preserved.
- **`count` keeps gating `minObservations`.** Decay adds a separate `score` used for ranking and eviction only. Decaying `count` in place would silently stop stale-but-valid transitions from firing.
- **Privacy unchanged:** argument templates persist, results never do.
- Baseline to beat: **497 passing / 7 platform-skipped**, `npx tsc --noEmit` clean.
- Windows is a first-class target: `fileURLToPath`, no POSIX assumptions, no shell.
- Commit after every task with the trailer:
  `Claude-Session: https://claude.ai/code/session_0132gkXEyxVDApKViwTv4X4a`

---

### Task 1: Evaluation harness and baseline

**Files:**
- Create: `eval/corpus.ts`, `eval/replay.ts`, `eval/eval.ts`
- Modify: `package.json` (add `"eval": "tsx eval/eval.ts"`)
- Test: `test/eval.test.ts`

**Interfaces:**
- Produces:
```ts
export interface EvalSession { server: string; calls: Array<{ tool: string; args: Record<string, unknown>; parsed: unknown }> }
export interface Archetype { name: string; sessions(seed: number): EvalSession[] }
export interface RecallReport {
  archetype: string; pairs: number;
  recallAt1: number; recallAt3: number; recallAt5: number;
  wastePerHit: number;
}
export function runEval(seed: number): RecallReport[]
```

- [ ] **Step 1: Write the corpus.** `eval/corpus.ts` exports at least four archetypes. They must NOT be shaped to the GitHub profile's five rules, or this repeats the circular-benchmark mistake the project already made once:
  - `list-detail-varied`: list of 10 entities, then open one at a **randomized** index drawn from a skewed distribution (index 0 most likely but not always), repeated across sessions.
  - `return-visits`: the same 2 entities reopened repeatedly across sessions, at varying list positions.
  - `multi-arg`: a follow-up call whose args come from two different sources (one arg-copy, one parsed-path).
  - `adversarial`: low-predictability, entities chosen uniformly at random with no repetition. This is the floor `DESIGN.md` §10 item 8 promised and never delivered.

  Seed all randomness explicitly (a small deterministic PRNG in the file); `Math.random()` must not appear, so runs are reproducible.

- [ ] **Step 2: Write the replay.** `eval/replay.ts` drives a real `TransitionLearner` (and optionally the full `Predictor`) directly, in-process, with no MCP server or subprocess. For each session: feed calls in order via the learner's observe path; before feeding call N, ask for predictions given call N-1 and record the **rank** of the actual call N among them (or a miss). Warm-up sessions count toward learning but not toward the score, so cold start is not scored as failure. Report recall@1/3/5 and waste per hit.

- [ ] **Step 3: Write `eval/eval.ts`** to run every archetype and print a table: archetype, pairs, recall@1/3/5, waste/hit. Print a single `BASELINE` line with the overall recall@3 so later tasks can diff against it.

- [ ] **Step 4: Add a test** (`test/eval.test.ts`) asserting the harness is deterministic (same seed gives identical report) and that the adversarial archetype scores strictly below the varied one. Do not assert absolute recall numbers; they change in later tasks by design.

- [ ] **Step 5: Run `npm run eval`, record the baseline table in the task report verbatim.** This is the number every later task is measured against.

- [ ] **Step 6: Commit** `eval: offline recall@K harness with an adversarial floor archetype`.

### Task 2: Decay infrastructure, persisted recency, value-based eviction

**Files:**
- Modify: `src/learner.ts`
- Test: `test/learner.test.ts`, `test/persistence.test.ts`

**Interfaces:**
- Consumes: `TransitionState`, `OpenerState`, `SerializedTransition`, `SerializedOpener`.
- Produces:
```ts
/** Exported for tests: score decayed from `from` to `to`. */
export function decayedScore(score: number, from: number, to: number, tauMs?: number): number
```
  plus `score: number` on `TransitionState`/`OpenerState` and `score`/`lastUpdated` on both serialized shapes.

- [ ] **Step 1: Write failing tests.**

```ts
it('decays a score toward zero as time passes', () => {
  const fresh = decayedScore(4, 0, 0);
  const aged = decayedScore(4, 0, 14 * 24 * 3600_000);
  expect(fresh).toBe(4);
  expect(aged).toBeLessThan(4);
  expect(aged).toBeGreaterThan(0);
});

it('ranks a recently used transition above an equally frequent stale one', () => {
  // two transitions, same count, different lastUpdated; assert predict() order
});

it('evicts the lowest-scoring transition, not the oldest inserted', () => {
  // fill past maxTransitions; insert a hot transition FIRST, then many cold ones
  // assert the hot transition survives (today's FIFO drops it)
});

it('persists lastUpdated so decay survives a reload', () => {
  // export -> import with a clock advanced; assert the score reflects the gap
  // rather than being restamped to now
});

it('loads a pre-existing state file with no score/lastUpdated fields', () => {
  // assert count-derived defaults and no throw
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Add `TAU_MS` (default 14 days) and `decayedScore(score, from, to, tau)`.
  - Add `score` to `TransitionState` and `OpenerState`. On observation: `state.score = decayedScore(state.score, state.lastUpdated, now) + 1`, then `state.lastUpdated = now`. `count` continues to increment exactly as today and continues to gate `minObservations`.
  - **Serialize `lastUpdated` and `score`** on both `SerializedTransition` and `SerializedOpener`. Today `SerializedTransition` carries neither, so `deserialize` restamps `lastUpdated` to `now()` (`src/learner.ts:338`) and decay would reset on every reload. On load: missing `score` defaults to `count`; missing `lastUpdated` defaults to `now()`.
  - Replace the FIFO eviction at `src/learner.ts:341-344` with lowest-decayed-score, tie-broken by stalest `lastUpdated`, mirroring the opener eviction at `:249`.
  - Rank predictions by decayed score (highest first) where they are currently ordered by raw `count` (`:431-436`).
- [ ] **Step 4:** Focused tests pass, `npx tsc --noEmit` clean, full `npx vitest run` green.
- [ ] **Step 5: Run `npm run eval`** and record the delta against Task 1's baseline in the report.
- [ ] **Step 6: Commit** `feat: decay stale learner evidence and evict by value`.

### Task 2b: Stop one underivable value from poisoning a template forever

Found by the Task 1 harness, not predicted by the spec: two whole list-detail
legs score exactly 0.000 because `ArgTemplate.underivable` is sticky. One value
the learner cannot derive permanently disables the transition, and
`materializeArgs` (`src/learner.ts:670-684`) then bails on every future
prediction.

**There are two latches, and loosening only the boolean is a no-op.**
`updateTemplates` (`src/learner.ts:616-617`) intersects candidate sources with
`tpl.sources = tpl.sources.filter(...)`, so a value with no matching source
empties the list. After that `resolveSources` returns `{ok:false}` and
`materializeArgs` returns null regardless of what the `underivable` flag says.
Both must change together.

**Measured ladder** (workflow recall@3, seeds 1/2/3, 900 pairs; supersedes the
retired 0.44 pooled figure and the "~0.77 from this task alone" estimate,
which credited Task 3's work to this one):

| state | workflow recall@3 |
|---|---|
| today | 0.603 |
| this task, boolean only | 0.603 (no-op) |
| this task, boolean + source retention | ~0.681 |
| + Task 3 beam emission | ~0.766 |
| + Task 5 entity memory | ~0.88 |

Recovering the full ~0.766 needs index-0, index-1 **and** index-2 hypotheses
emitted per trigger, which is Task 3's beam, not this task. Do not reach for it
here.

**Files:**
- Modify: `src/learner.ts`
- Test: `test/learner.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
it('recovers after a single underivable observation', () => {
  // observe a transition twice with a derivable arg, once with a value that
  // has no source, then twice more derivable
  // assert predict() still offers the transition afterwards
});

it('still refuses to guess an argument it has never derived', () => {
  // the fail-closed half must survive: an arg with NO successful derivation
  // must not be fabricated
});
```

- [ ] **Step 2:** Run → FAIL (today the first observation poisons it permanently).
- [ ] **Step 3: Implement, both latches.**
  - Replace the sticky boolean with evidence: track derivable and underivable observation counts per argument, and treat the argument as underivable only when it has never been derived, or when its failure rate stays above a threshold across a minimum number of observations.
  - **Stop `updateTemplates` emptying `sources`** (`src/learner.ts:616-617`). Retain candidate sources across an observation that none of them match, rather than intersecting to nothing. Without this the boolean change measures zero, which is the trap this task previously set.
  - **Preserve the fail-closed property.** An argument with no successful derivation is still never fabricated, and a prediction whose arguments cannot all be resolved is still dropped. This loosens a permanent latch; it does not remove a safety gate. Say in the report which test pins that.
- [ ] **Step 4:** Focused tests pass, `npx tsc --noEmit` clean, full suite green.
- [ ] **Step 5: Run `npm run eval --` with `--compare`** against the Task 1 baseline JSON. The gate is **attribution, not an absolute number**: `list-detail-varied` must move up. Do not gate on the pooled figure, and do not expect ~0.77 here; that number belongs to this task plus Task 3. If `list-detail-varied` does not move, stop and report.
- [ ] **Step 6: Commit** `fix: one underivable value no longer disables a transition forever`.

### Task 3: Per-source scoring and multi-candidate emission

This is the task that lifts recall@K above recall@1. Expect the largest delta here after Task 2b.

**Files:**
- Modify: `src/learner.ts`
- Test: `test/learner.test.ts`

**Interfaces:**
- Produces: sources stored as `{ s: Source; score: number; lastUpdated: number }`; `SerializedSource` gains optional `score`/`lastUpdated`; `predict()` may return several predictions derived from one transition.

- [ ] **Step 1: Write failing tests.**

```ts
it('credits every source that could have produced the observed value', () => {
  // an observation where BOTH an arg-copy and a parsed index yield the value
  // assert both sources' scores rose, not just the first
});

it('prefers the source that has actually been right, over priority order', () => {
  // arg-copy resolves but has always been wrong; parsed index 2 has always
  // been right. After enough evidence, predict() must emit index 2 FIRST.
  // Today priority order makes this impossible.
});

it('emits several ranked candidates from one transition', () => {
  // a list->detail transition where the chosen index varies
  // assert predict() returns index0 AND index1 as separate predictions,
  // ordered by observed frequency
});

it('evicts the weakest source at the cap instead of refusing new ones', () => {
  // saturate MAX_SOURCES_PER_ARG with losers, then feed a consistent winner
  // assert the winner is stored
});

it('keeps loading sources with no score field', () => { /* back-compat */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Wrap stored sources in `{ s, score, lastUpdated }`, decayed like transitions.
  - **On observe:** for each argument, test every stored source against the observed value and increment **all** that match (not just the first). Add newly discovered sources as today.
  - **At `MAX_SOURCES_PER_ARG`:** evict the lowest-scoring source rather than `break`ing (`src/learner.ts:633`).
  - **On predict:** for each argument, rank its resolvable sources by decayed score. Build candidates with a **beam of width `maxPredictionsPerTrigger`**: start from the all-best combination, then generate variants substituting the next-best source for one argument at a time, ordering by the product of normalized source scores. Dedupe by materialized-args repr. This yields index 0, index 1, index 2 for the single-varying-argument case, which is the dominant real shape.
  - Confidence per emitted prediction: today's transition-derived confidence multiplied by the normalized combo score, so a well-evidenced first choice outranks a speculative third. Keep the existing `0.55` ceiling.
  - `resolveSources`' fixed priority order is now a **fallback only**, used when no source has evidence yet.
- [ ] **Step 4:** Focused tests pass, `npx tsc --noEmit` clean, full suite green. Existing tests that pin first-source-wins or the old confidence formula may be updated **only** where this spec deliberately changes that behavior; list each one you touched and why in the report.
- [ ] **Step 5: Run `npm run eval`**, record the delta. Recall@3 on `list-detail-varied` should rise materially; if it does not, stop and report rather than proceeding.
- [ ] **Step 6: Commit** `feat: learn which argument source is right, and offer several`.

### Task 4 (optional, lowest value): Widen the learnable index window


**Demoted after measurement, reversing an earlier promotion.** Widening
`pushArrayPaths` from 0..2 to 0..7 is worth **+3 pairs out of 900 (+0.003)**,
not the ~0.06 first estimated. Under the shipped per-trigger cap of 3,
top-3-by-frequency is always `{0,1,2}` whenever the index distribution
decreases monotonically, which both corpus archetypes do. It must also run
**after** Task 3: `MAX_SOURCES_PER_ARG = 12` truncates candidates in
enumeration order (`src/learner.ts:633`), so widening to 8 indices before
per-source scoring exists can evict good sources.

**Known blind spot, which is why this is not deleted.** Neither corpus
archetype has a mode above index 2, so a real workload where someone
habitually opens the fifth item is invisible to both the current window and
this corpus. The eval also has **zero surviving array-index derivations**, so
it cannot validate work here at all; rely on `test/learner.test.ts`, and do
not expect `npm run eval` to move.

**Files:**
- Modify: `src/learner.ts`
- Test: `test/learner.test.ts`

- [ ] **Step 1: Write a failing test** asserting a transition whose follow-up consistently uses index 5 of the previous result becomes predictable. Today `pushArrayPaths` caps at `Math.min(arr.length, 3)`, so it cannot be.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Replace the literal `3` with `MAX_ARRAY_INDEX_PATHS` (default 8). Task 3 per-source scoring will prune losers once it lands; until then rely on MAX_PARSED_PATHS and the existing source cap. Note `MAX_PARSED_PATHS = 256` still bounds total enumeration. Confirm in the report that enumeration cost did not blow up (assert the path count stays bounded for a large array).
- [ ] **Step 4:** Focused tests pass, full suite green.
- [ ] **Step 5: Run `npm run eval`**, record the delta.
- [ ] **Step 6: Commit** `feat: learn follow-up positions past the third entry`.

### Task 5: DROPPED — entity frecency already shipped in Task 3

**Killed by measurement, not by judgement.** This task was to add
`(server, tool, canonicalArgs) -> decayed score` memory so the learner could
predict an entity the user keeps returning to. It is redundant: Task 3's
per-source scoring already does it.

Evidence. The `direct-recall` archetype was built specifically to isolate the
one case entity memory should uniquely solve, where the entity is **not
derivable from the previous call at all** (verified: across 180 sessions the
target id appears zero times in the trigger's args or, recursively, its parsed
result, while six wrong ids sit at enumerable array positions). It was expected
to fail at HEAD. It scored **0.835** on its common-trigger leg. Reading
`exportState()` shows why: the transition holds **four `const` sources, one per
pinned entity, ranked by decayed score**, giving recall@1 0.369 (the 40% entity)
and recall@3 0.835 (the top three, 40+30+20). That is entity frecency, arrived
at generically. The negative control confirms it: the same shape with entities
never reused scores 0.000 with zero waste, so the score is the returns and
nothing else.

**What actually remains is scope, not memory.** Constants are keyed per
`(server, prevTool, nextTool, arg)`, so the same entities reached from a rarer
trigger get nothing. Measured as the second trigger thins from every-2 to
every-16 sessions: 0.733 / 0.667 / 0.389 / 0.000, while the common leg stays
flat near 0.87. The `direct-recall` archetype ships both legs, the common one
as a guard and 47 rare-trigger pairs as live headroom.

**Optional successor, if time allows:** share value-evidence across transitions
with the same `(server, nextTool, arg)`, so a value learned under a common
trigger is available under a rare one. Judge it against **+0.03 headline**, not
the +0.25 the original framing implied, and drop it too if it does not clear
that. Note it touches the persistence key shape, so it carries migration risk
disproportionate to its size.

### Task 5c: REVERTED — a measured no-op on every shipped configuration

Implemented from PASTE (arXiv 2603.18897), which ranks candidates by
`U = (p·T)/(c·d)` and launches greedily while slack remains, rather than fixing
K. Speculate ranked by `confidence × effectiveness` alone, so a 50 ms call at
0.8 outranked a 2 s call at 0.3 despite being worth roughly a tenth as much.
The reasoning still looks right; it just does not pay here yet.

**Why it was reverted.** It could not be demonstrated on anything we ship:

- The bundled bench gives every mock tool the same latency, so `score × ms` is
  `score` times a constant. Nothing to prioritize.
- On the bundled profile the per-trigger cap **never binds** (measured: zero
  per-trigger-cap suppression events), so there is no cut for a better ranking
  to change.
- The only win was on a constructed `--hetero --cap 1` workload: 4.50 s → 4.05 s.

Cost was 805 insertions across 10 files including a new `src/latency.ts`. The
plan's own rule is that a change which does not move the measurement does not
land, and this moved nothing on any default.

**When to revisit.** PASTE's utility ranking matters when a trigger offers more
candidates than the budget pays for. Task 3's beam now emits several candidates
per trigger, so if the cap starts binding in practice, or if beams widen, the
premise becomes true and this is worth rebuilding. The reverted commit is
`41128ee` and the honest per-workload numbers are in
`.superpowers/sdd/task-5c-report.md`.

### Task 5b: Staleness, because better prediction makes it worse

Prediction quality and freshness pull in **opposite directions**, and this
plan only improves one of them. Every task above makes the proxy prefetch
more, earlier, and further ahead, which raises the age of an entry at the
moment it is consumed. Nothing currently measures that, so this plan could
improve recall while quietly serving staler answers and no metric would show
it.

What already bounds staleness: a TTL resolved through operator per-tool,
profile per-tool, operator default, profile default, then a hardcoded
**30 s** fallback (`src/executor.ts:225-239`); single-use entries; and a full
per-server cache flush on any non-read-only call (`src/proxy.ts:618`, `:702`).
The worst-case age is therefore already capped. What changes is the
distribution: more entries consumed near the TTL edge rather than immediately.

Two honest gaps, neither of which this task can fully close, but both of
which it must surface: the 30 s default is an **unmeasured guess**, and
mutations made outside the proxy (a teammate merges the PR, a file changes on
disk) are invisible to invalidation, which `DESIGN.md:181` already calls the
sharpest staleness caveat in the design.

**Files:**
- Modify: `eval/replay.ts`, `eval/eval.ts`, `src/metrics.ts`, `src/learner.ts` (entity TTL hint only)
- Test: `test/eval.test.ts`, `test/metrics.test.ts`

- [ ] **Step 1: Measure age at consumption.** Extend the eval report with the distribution of entry age when a prediction is consumed: median and p95, plus the share consumed in the last quarter of their TTL. Re-run the earlier tasks' scenarios so the plan can state whether improving recall moved entries closer to expiry. Report the before/after.

- [ ] **Step 2: Surface it at runtime too.** Add an age-at-hit histogram to `src/metrics.ts` alongside the existing counters, reported through the existing stats surface. A user should be able to see whether their hits are fresh or scraping the TTL edge. Keep it aggregate-only, consistent with the existing privacy stance (counters and templates, never results).

- [ ] **Step 3: Give entity-frecency predictions a shorter TTL.** Task 5's entity candidates are speculative about a **longer horizon** than transition candidates: they predict "you will reopen this at some point," not "this is the next call." Fetching them with the same TTL is what would actually make staleness worse. Add a TTL multiplier (default 0.5) applied to entity-derived predictions only, so the longest-horizon guesses expire soonest. Test that a transition-derived and an entity-derived prediction for the same tool get different TTLs.

- [ ] **Step 4: Do NOT implement shadow validation in this task.** Comparing a served prefetch against a live re-fetch would measure the real staleness rate, but it doubles upstream calls and only detects a stale answer *after* it was served, so it is a tuning instrument rather than a correctness guarantee. Record it in DESIGN.md as the way to replace the 30 s guess with a measured number, and leave it unbuilt.

- [ ] **Step 5:** `npx tsc --noEmit` clean, full suite green, `npm run eval` recorded.
- [ ] **Step 6: Commit** `feat: measure prefetch age, and expire long-horizon guesses sooner`.

### Task 6: Honest numbers and docs

**Files:**
- Modify: `DESIGN.md`, `package.json` + `package-lock.json` (0.13.0), `plugin/.claude-plugin/plugin.json` (0.13.0, a test asserts these match)

- [ ] **Step 1:** `npm version 0.13.0 --no-git-tag-version`, and bump the plugin manifest in the same commit.
- [ ] **Step 2: DESIGN.md** gets a `## v0.13 (2026-08-02): prediction quality` section recording: the five defects fixed, the decay model with its TAU, the beam emission, and **the measured recall table before and after, including the adversarial floor**. State plainly that the floor exists and what it is. Do not use em dashes.
- [ ] **Step 3:** Note in the same section that `npm run eval` is now the instrument for prediction quality, and that `npm run bench` measures prefetch mechanics only, which is what made the older headline number circular.
- [ ] **Step 3b: Calibrate against PASTE honestly.** PASTE (arXiv 2603.18897) reports **27.8% top-1 and 43.9% top-3** on Deep Research Bench, SWE Bench and ScholarQA, which are real traces. Our numbers come from a corpus we authored. If ours read higher, the likely explanation is that our corpus is easier, not that the learner is better, and the section must say so rather than inviting the flattering reading. Record two genuine differences in our favour as facts, not boasts: PASTE describes no staleness or invalidation mechanism, and no decay (patterns are mined once and applied uniformly). Also record what it has that we lack: a string formatting/normalization transform as a third argument-source kind, and utility-based greedy launch, which Task 5c adopts.
- [ ] **Step 4: Verify** `npx tsc --noEmit`, full `npx vitest run`, `npm run eval`, `npm run bench`, `npm run demo`.
- [ ] **Step 5: Commit** `docs: v0.13 prediction quality, with measured recall`.
