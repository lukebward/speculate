# Day-to-Day Utility Implementation Plan

**Goal:** Make Speculate automatically spend speculative work where a user will
notice it, remain quiet on cheap local tools, and improve on varied daily
coding workflows without optimizing for hit rate in isolation.

**Primary outcome:** Increase net wall-clock milliseconds saved per 100 real
eligible calls while preserving zero stale responses and keeping terminal
waste bounded.

**Architecture:** Build a common comparative instrument first. Then replace
the predictor's split/process-local latency knowledge with one persisted model,
learn candidate correctness from shadow evaluation whether or not a candidate
was issued, and feed both into a small admission controller that chooses a
dynamic batch width. Unknown-latency discovery is a final bounded policy, not
the foundation of the controller.

**Tech stack:** TypeScript, Node built-ins, Vitest, existing MCP SDK and Zod.
No new runtime dependency.

**Checkpoint (2026-08-30):** The deterministic benchmark core, persisted
latency model, and shadow candidate calibration are implemented and validated.
The executable daily runner, durable per-tool explanation fields, marginal
admission controller, and bounded cold discovery remain follow-up work.

**Companion specifications:**

- [Daily workflow benchmark](../specs/2026-08-30-daily-workflow-benchmark-design.md)
- [Persisted latency model](../specs/2026-08-30-persisted-latency-design.md)
- [Calibration and admission experiments](../specs/2026-08-30-calibration-admission-experiments.md)
- [Validation findings](../specs/2026-08-30-validation-findings.md)

## Why this sequence

The current implementation has three useful pieces, but they do not yet form
one reliable controller:

1. `TransitionLearner` persists target latency on learned transitions and
   openers.
2. `Predictor` also keeps per-tool and per-server latency EWMAs, but only for
   the lifetime of one process.
3. Rule effectiveness is learned only from issued predictions. A candidate
   suppressed by admission can be checked against the next real call, but that
   correctness evidence is currently retained only in aggregate recall.

Changing the admission formula before fixing those inputs would tune policy on
session-local latency and selection-biased feedback. The dependency order is:

```text
daily benchmark
      ↓
persisted latency model
      ↓
shadow candidate calibration
      ↓
marginal admission + bounded discovery
      ↓
dogfood gate and default rollout
```

## Measured starting point

Record these as the pre-plan comparison baseline. Do not replace them with a
single pooled score:

| Workflow | Current result | Control |
|---|---:|---:|
| Real Git, unconstrained | 80.0% hit/join | `HEAD` 62.2% |
| Real Git, default | 0 speculative calls on ~6 ms reads | desired |
| Real filesystem, 120 ms | 69.1% hit/join, 38.8 ms mean wait | `HEAD` 61.8%, 48.1 ms |
| Microsoft Learn, full | 17% → 33% → 83% by session | `HEAD` same hit curve |
| Microsoft Learn, one cold pair | 50% first-session hit rate | `HEAD` 0% |
| Offline workflow corpus | recall@3 0.8463, waste/hit 2.00 | must not regress |

The primary runtime numbers for later tasks are:

```text
measuredWaitDeltaMsPer100 =
  100 * (pairedOffToolWaitMs - armToolWaitMs) / requestedCalls

estimatedNetSavedMsPer100 =
  100 * (estimatedSavedMs - estimatedAddedWaitMs) / eligibleRealCalls
```

Because concurrent HTTP waste consumes quota rather than directly adding wall
time, also report `extraUpstreamCallsPerSavedSecond`. Neither number replaces
the safety invariants.

## Global constraints

- Never speculate a tool that is not already eligible under the existing
  policy. Admission cannot widen safety.
- Persist no tool arguments, results, response text, URLs, repository IDs, or
  credential material in the new models. Server/tool labels and aggregate
  numbers are permitted; state scope isolation remains mandatory.
- No server-specific scoring logic or hosted-service profile.
- Preserve `adaptiveAdmission: false` as an immediate rollback path.
- Missing new state fields are a cold/default model, never a state-version
  failure. Old state files must keep loading.
- Every persisted collection is bounded and defensively deserialized.
- `mode: off` remains fully off: no learning, model mutation, or durable writes.
- Optimize net usefulness, not hit rate. A fast-tool suppression is not a
  regression when raw predictor recall remains measurable.
- Hosted measurements are opt-in, read-only, interleaved off/on, and reported
  as a spread. Do not gate on one remote latency sample.
- Windows remains first-class; no POSIX-only production or default-test code.

---

## Release 1: Daily-workflow measurement contract

**Purpose:** Make every later algorithm change answer the same question with
the same workflows and output schema.

### Files

- Create `bench/daily.ts`
- Create `bench/dailyWorkflows.ts`
- Create `bench/comparison.ts`
- Create `test/daily-benchmark.test.ts`
- Refactor shared mechanics from:
  - `test/git-real-e2e.test.ts`
  - `test/filesystem-real-e2e.test.ts`
  - `bench/remote.ts`
- Modify `package.json`, `CONTRIBUTING.md`

### Public/internal interfaces

```ts
export interface DailyRunRecord {
  schemaVersion: 1;
  workflow: string;
  workflowVersion: number;
  arm: 'off' | 'stable' | 'candidate';
  seed: number;
  session: number;
  requestedCalls: number;
  eligibleCalls: number;
  hits: number;
  joins: number;
  misses: number;
  speculativeCalls: number;
  terminalWasted: number;
  outstandingAtSnapshot: number;
  predictorHitsAt1: number;
  predictorHitsAt3: number;
  predictorOpportunities: number;
  toolWaitMs: number;
  toolWaitSamplesMs: number[];
  estimatedSavedMs: number;
  estimatedAddedWaitMs: number;
  upstreamCalls: number;
}

export interface DailyComparison {
  schemaVersion: 1;
  records: DailyRunRecord[];
  measuredWaitDeltaMsPer100: number | null;
  estimatedNetSavedMsPer100: number | null;
  extraUpstreamCallsPerSavedSecond: number | null;
  p50ToolWaitMs: number;
  p95ToolWaitMs: number;
}
```

### Workflows

Use deterministic seeds and vary values/order between sessions:

- Git: list commits → select ranks 0/1/2 → show → branch/tag/diff paths.
- Code navigation: search → read → symbols → references, with the selected
  file and branch changing.
- Documentation: search → select a non-constant result rank → fetch → query a
  different topic.
- Mutation: prefetch a Git/file read, mutate, then prove the returned value is
  fresh and the old entry was invalidated.
- Negative control: uniformly random next tools/arguments; speculation should
  become quiet rather than chase the workload.

Every seed must generate the same workflow for off/stable/candidate. Stable
and candidate target roots run in alternating order. State is isolated by arm
and shared only across that arm's sessions.

### Tasks

- [ ] Extract process launching, stats reading, terminal usage reading, and
      JSON-line output into a common harness without weakening the opt-in gates.
- [ ] Add `npm run bench:daily` with `--seed`, `--sessions`, `--target-root`,
      `--stable-root`, and `--json`.
- [ ] Generate sessions 1, 2, 3, 5, and 10 summaries rather than only cold/warm.
- [ ] Reconcile terminal counters:
      `terminalWasted = expired + invalidated + abandoned + specErrors`, then
      `speculativeCalls = hits + joins + terminalWasted + outstandingAtSnapshot`.
- [x] Add deterministic tests for comparison math and seeded variation.
- [ ] Keep real-process and hosted runs gated; default CI tests only generators,
      aggregation, invariants, and one small loopback workflow.
- [ ] Capture the starting table above as a checked-in JSON fixture tagged with
      the current commit, Node version, OS, and scenario parameters.

### Release gate

- Repeating one seed produces byte-identical workflow inputs and aggregate
  counts.
- The harness detects a deliberately injected counter mismatch.
- Off/stable/candidate use identical calls and selection ranks.
- No result or argument value appears in the machine-readable report.
- Existing real Git/filesystem and remote scenarios still run independently.

---

## Release 2: One persisted latency model

**Purpose:** A new session should already know that local Git costs ~6 ms and a
hosted documentation fetch costs hundreds of milliseconds. Target latency must
not depend on which learner path produced a prediction.

### Files

- Create `src/latency.ts`
- Create `test/latency.test.ts`
- Modify `src/predictor.ts`, `src/proxy.ts`, `src/persistence.ts`, `src/types.ts`
- Modify `test/predictor.test.ts`, `test/persistence.test.ts`
- Extend real Git/filesystem E2Es

### Interfaces

```ts
export interface LatencyEstimate {
  weight: number;
  meanMs: number;
  m2Ms2: number;
  observations: number;
  lastUpdated: number;
}

export interface LatencySnapshot {
  version: 1;
  tools: Array<{ server: string; tool: string } & LatencyEstimate>;
  servers: Array<{ server: string } & LatencyEstimate>;
}

export interface EstimatedLatency {
  expectedMs: number;
  deviationMs: number;
  conservativeMs: number;
  effectiveSamples: number;
  source: 'tool' | 'server' | 'prediction-hint' | 'unknown';
}

export class LatencyModel {
  observe(server: string, tool: string, latencyMs: number): void;
  estimate(server: string, tool: string, predictionHintMs?: number): EstimatedLatency;
  exportState(): LatencySnapshot;
  importState(raw: unknown): void;
}
```

### Model rules

- Use a time-decayed weighted mean and centered `M2`. They are deterministic
  across restarts, numerically stable for similar durations, and mergeable
  with the state store's existing baseline-delta strategy.
- Derive mean and standard deviation from the moments. Admission consumes a
  conservative estimate: `max(0, meanMs - 0.5 * deviationMs)`.
- Tool estimate wins, then server estimate, then the prediction's legacy
  `expectedLatencyMs`, then the existing 100 ms unknown prior.
- Decay moment weight with a 30-day half-life. Tool estimates back off below
  0.5 effective samples and server estimates below 2; do not silently rewrite
  the underlying observation count.
- Clamp imported durations to `[0, 600_000]`, counts to a fixed maximum, and
  timestamps to `now`.
- Cap tool entries per server (default 256), evicting the stalest/weakest.

### Persistence and migration

Add optional `latency?: LatencySnapshot` to `PersistedState`; do not bump the
state version for an optional field. `StateStore.save` and concurrent merge
must include it.

Concurrent latency merge ages weighted statistics to the incoming save time,
derives only the incoming process's delta from its load baseline, and combines
that delta with the latest state using the pairwise mean/`M2` formula.
Disjoint tools are unioned. A legacy file without latency loads normally.

Keep transition/opener `expectedLatencyMs` as a migration hint for one release,
but stop using separate process-local predictor maps. All successful eligible
user calls feed `LatencyModel.observe`, including hits, misses, and joins when
the full upstream latency is known.

### Tasks

- [x] Write weighted-moment, deviation, decay, fallback, cap, and hostile
      import tests with an injected clock.
- [x] Add optional latency state and concurrent merge tests.
- [x] Construct one model in `SpeculateProxy`, import before session-start
      predictions, and export during the same atomic save as learner feedback.
- [x] Replace `Predictor.latencyByTool` / `latencyByServer` with the injected
      estimator.
- [x] Preserve prediction hints only as migration fallback.
- [ ] Add aggregate `realLatencyMs` and `realCallCount` to per-tool durable
      usage so `speculate stats --by-tool` can explain admission decisions.
- [x] Rerun real Git across restarts and the 120 ms filesystem workflow.

### Release gate

- After two observed ~6 ms Git sessions, a fresh proxy issues zero default
  Git predictions while raw recall remains visible.
- A fresh proxy loaded with a persisted 120+ ms tool estimate still admits a
  moderate-confidence useful prediction.
- Workspace/account state scoping prevents latency crossing identities.
- Concurrent saves preserve disjoint tool estimates.
- Daily benchmark net savings do not regress; offline recall is byte-identical.

---

## Release 3: Shadow candidate calibration

**Purpose:** Learn whether each candidate is the exact next eligible call even
when policy correctly declines to issue it. This removes selection bias and
separates model correctness from execution mechanics.

### Files

- Modify `src/predictor.ts`, `src/metrics.ts`, `src/persistence.ts`, `src/types.ts`
- Modify `src/usage.ts`, `src/stats.ts`
- Modify focused predictor/metrics/persistence/stats tests

### Interfaces

```ts
export interface CandidateFeedback {
  correct: number;
  evaluated: number;
  lastUpdated: number;
}

export interface CalibratedProbability {
  probability: number;
  observations: number;
  source: 'empirical' | 'prior';
}

export interface PendingCandidate {
  key: string;
  candidateId: string;
  rank: number;
  baseConfidence: number;
  admitted: boolean;
  probability: number;
}
```

`Predictor` retains the ranked pre-admission candidate objects, not only their
keys. On the next eligible real call it records one correctness observation for
each candidate at the shipped rank cap. Exactly one may be correct because
canonical keys are deduplicated. An ineligible mutation/reset clears the batch
without marking candidates wrong.

Use a confidence-informed Beta prior with strength 4:

```text
alpha = correct + 4 * baseConfidence
beta  = (evaluated - correct) + 4 * (1 - baseConfidence)
pNext = alpha / (alpha + beta)
```

Decay empirical counts with the existing 14-day feedback horizon. The static
confidence remains a prior, not a second multiplier applied after calibration.

### Rule identity

- Preserve rank-1 historic rule IDs so existing feedback survives.
- Give every alternative a stable suffix (`#2`, `#3`, ...). The learner does
  this already; config-authored rules must follow the same rule.
- Never key calibration by arguments or canonical cache key on disk.

### Metrics

Retain cache outcomes (`hits`, `joins`, `wasted`) separately. Add aggregate:

- candidate evaluations/correct by rule;
- pre-admission recall@1/@3;
- admitted recall@1/@3;
- Brier score and five probability buckets;
- correct-but-suppressed count;
- admitted-but-wrong count.

Only counts, probabilities, rule IDs, server names, and tool names persist.

### Tasks

- [x] Add a suppressed-fast-but-correct test: calibration receives credit,
      cache hit rate stays zero, and admission remains quiet.
- [x] Add wrong-candidate and mixed-variant tests proving probabilities diverge.
- [ ] Prove session end and intervening mutation do not manufacture negatives.
- [x] Extend feedback snapshots and concurrent delta merge with optional
      `correct`/`evaluated` fields.
- [x] Add defensive import, decay, cap, and legacy-state tests.
- [x] Replace `confidence * effectiveness` ranking with calibrated `pNext`;
      retain operational feedback as a separate cost/suppression signal.
- [ ] Expose calibration aggregates in live and durable stats.
- [ ] Add calibration reliability output to `bench:daily`.

### Release gate

- Fast Git can show high pre-admission recall with zero issued calls.
- A consistently wrong rank-2 variant falls below a consistently correct
  rank-3 variant after sufficient observations.
- Calibration receives observations for suppressed candidates.
- Brier score improves or remains neutral on the varied daily workflows.
- Cache hit rate, waste, and calibration counts reconcile independently.

---

## Release 4: Marginal admission and bounded cold discovery

**Purpose:** Choose zero to three predictions according to each candidate's
own expected value. Do not issue three merely because the first candidate is
valuable.

### Files

- Create `src/admission.ts`
- Create `test/admission.test.ts`
- Modify `src/predictor.ts`, `src/proxy.ts`, `src/config.ts`, `src/types.ts`
- Extend metrics/stats and daily/real E2Es

### Interface

```ts
export interface AdmissionInput {
  probability: number;
  latency: EstimatedLatency;
  rank: number;
  transport: 'stdio' | 'http';
  operational: RuleFeedback;
  isSessionOpener: boolean;
}

export interface AdmissionDecision {
  admit: boolean;
  expectedBenefitMs: number;
  exploratory: boolean;
  reason: 'admitted' | 'low-benefit' | 'poor-history' | 'unknown-latency' | 'discovery-limit';
}

export class AdmissionController {
  decide(server: string, input: AdmissionInput): AdmissionDecision;
}
```

### Decision rules

1. Compute each candidate independently:
   `expectedBenefitMs = pNext * conservativeTargetLatencyMs`.
2. Require `expectedBenefitMs >= minExpectedSavedMs`.
3. Operational feedback can suppress a candidate whose decayed terminal
   useful/speculated rate remains below the existing floor after the existing
   minimum sample count. It must not change `pNext`.
4. Admit candidates in descending expected benefit until the existing hard
   cap, rate budget, or concurrency budget stops them. This makes beam width
   dynamic without another user-facing knob.
5. Record the decision inputs and reason as aggregate telemetry, never args.

Do not introduce a quota-to-milliseconds conversion in this release. Report
extra upstream calls separately and let measured release gates constrain it;
an invented conversion factor would hide the tradeoff rather than solve it.

### Bounded discovery

Correct unknown-latency candidates teach their latency when the real call
arrives even if suppressed, so broad active exploration is unnecessary.
Allow only this cold exception:

- HTTP transport only;
- rank 1 only;
- base/calibrated probability at least 0.45;
- at most one unknown-latency candidate per server per session;
- normal policy and budgets still apply;
- no recent authorization/speculation breaker condition;
- every exception is marked `exploratory` in metrics.

For unknown stdio tools, wait for the first real call. Users can explicitly
bypass with `adaptiveAdmission: false`.

### Tasks

- [ ] Unit-test 0/1/2/3 dynamic batch widths at varied probability/latency.
- [ ] Prove a valuable rank 1 does not pull low-value ranks 2/3 through.
- [ ] Prove fast Git candidates remain suppressed after process restart.
- [ ] Prove slow HTTP rank 1 gets one cold discovery opportunity.
- [ ] Prove unknown stdio does not explore by default.
- [ ] Pass transport/admission context from `SpeculateProxy`.
- [ ] Add `expectedBenefitMs`, admitted/suppressed counts, and exploratory
      outcomes to per-tool stats.
- [ ] Retain the existing fixed-cap path unchanged behind
      `adaptiveAdmission: false`.
- [ ] Run the complete daily, real Git/filesystem, and hosted scenario matrix.

### Release gate

- Real Git default: zero speculative calls and zero waste at ~6 ms, while
  pre-admission recall remains at least 75% after warm-up.
- Real filesystem at 120 ms: at least 65% useful hit/join rate and positive
  conservative net savings.
- Microsoft cold pair: first-session fetch remains predicted, with terminal
  waste no greater than two alternatives per useful hit.
- Negative control: no more than one discovery issue per server/session and
  the controller becomes quiet after evidence.
- Across the combined daily workload, candidate net saved ms per 100 calls is
  greater than stable and extra upstream calls per saved second do not worsen
  by more than 10%.
- No safety, mutation, state-isolation, or offline recall regression.

---

## Release 5: Dogfood gate and default rollout

This release changes defaults only if the prior releases have enough ordinary
usage evidence.

### Tasks

- [ ] Run normal development traffic for at least seven days.
- [ ] Capture `speculate stats --since 7d --by-server --by-tool --json` before
      and after each controller release.
- [ ] Review tools with:
      - high correct-but-suppressed counts;
      - high hit rate but negligible saved time;
      - high terminal waste;
      - repeated near misses;
      - poor calibration/Brier score.
- [ ] Compare against the checked-in daily-workflow fixture and rerun hosted
      scenarios in alternating order.
- [ ] Change no default from a single tool/server result. Require the combined
      gates below.
- [ ] Document measured behavior and keep rollback configuration visible.

### Default rollout gates

- Positive `measuredWaitDeltaMsPer100` and `estimatedNetSavedMsPer100` overall
  and for every deterministic slow-workflow family.
- No material p95 regression on off/fast-local workflows.
- Zero stale-result or mutation-safety failure.
- Terminal accounting reconciles in every run.
- Fast local speculative-call rate remains effectively zero by default.
- At least one cold/varied workflow improves over stable.
- Offline workflow recall@3 stays at or above 0.8463 and the adversarial floor
  does not become more aggressive.

Roll out one release at a time. If a gate fails, keep the measurement and
revert only that release; do not compensate by loosening an unrelated safety
or accounting invariant.

## Explicitly deferred

- Server-specific profiles or field-name tables.
- Uploading usage traces or arguments for centralized training.
- A user-facing collection of tuning knobs beyond the current threshold and
  rollback switch.
- Automatic TTL tuning before freshness/mutation evidence identifies a real
  TTL problem.
- A general exploration scheduler. Shadow evaluation plus the real next call
  already supplies correctness and latency for candidates that matter.
- Optimizing the synthetic offline headline without moving daily-workflow net
  savings.

## Definition of done

The work is complete when a fresh installation automatically behaves in these
three ways without per-server configuration:

1. It stays quiet on cheap local Git/filesystem reads.
2. It becomes increasingly accurate and useful on repeated but varied coding
   and documentation workflows.
3. It can explain, with privacy-preserving aggregate evidence, whether a miss
   came from prediction, calibration, admission, timing, or invalidation.
