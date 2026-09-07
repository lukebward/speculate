# Calibration and admission experiment specification

**Date:** 2026-08-30 · **Status:** calibration validated; discovery remains experimental

## Goal

Determine which candidates are likely to be the exact next call and issue only
the candidates whose individual value justifies speculative work. This is the
main path to better daily usefulness, but its constants should be selected from
paired workflows rather than from one synthetic score.

This document separates settled behavioral requirements from hypotheses that
must earn their way into the implementation.

## Settled requirements

- Correctness learning includes candidates suppressed by admission.
- Prediction correctness stays separate from cache execution outcomes.
- Admission considers candidates independently, producing dynamic batch widths
  from zero through the existing hard cap.
- No server-specific profile or uploaded trace is required.
- Mutations, safety policy, authorization breakers, rate budgets, concurrency,
  and cache freshness remain harder gates than admission.
- Existing `adaptiveAdmission: false` preserves the fixed-cap rollback path.
- Any unknown-latency exploration is explicit in metrics and tightly bounded.

## Shadow evaluation contract

After validation, canonical-key dedupe, scoring, and the shipped rank cap—but
before latency admission—retain this per-server batch:

```ts
export interface PendingCandidate {
  key: string;
  candidateId: string;
  rank: number;
  baseConfidence: number;
  admitted: boolean;
  probability: number;
}
```

On the next successful eligible user call for that server:

- compare its canonical key with every retained candidate;
- record one evaluation per candidate, with at most one correct after dedupe;
- record the actual rank once for recall telemetry;
- delete the pending batch before creating the next one.

Cross-server calls do not consume the batch. An ineligible/mutating call on the
same server clears it without recording negatives because the previous
prediction was no longer claiming to follow the same read-only sequence.
Session end, unkeyable arguments, and failed real results also produce no
negative. Session-opening candidates are evaluated by the first eligible call.

The pending batch remains memory-only because it contains canonical argument
keys. Only aggregate candidate feedback persists.

## Candidate identity

Candidate identity must be stable enough to accumulate evidence but must not
contain arguments:

```text
candidateId = stable rule ID for the emitted alternative
```

Learner alternatives already use suffixes such as `#2`. Config-authored rules
that emit multiple alternatives receive deterministic emission suffixes before
dedupe. Preserve the unsuffixed historical ID for the first alternative so
existing operational feedback survives.

Do not use canonical keys, argument hashes, selected entity IDs, repository
paths, or raw target values as durable identity. If one rule's alternative
ordering is unstable, fix the rule ordering; do not leak its arguments into
calibration state.

## Initial calibration hypothesis

Persist per-candidate decayed counts:

```ts
export interface CandidateFeedback {
  correct: number;
  evaluated: number;
  lastUpdated: number;
}
```

Start with a confidence-informed Beta prior:

```text
alpha = correct + priorStrength * baseConfidence
beta = evaluated - correct + priorStrength * (1 - baseConfidence)
pNext = alpha / (alpha + beta)
```

Strength 4 is the implemented default after improving Brier against static
confidence on real Git, filesystem, Hugging Face, and warm Context7 workflows.
Strengths 2 and 8 remain useful future comparison arms, not user-facing knobs.
Counts decay with the existing 14-day feedback horizon. Clamp imported base
confidence and counts defensively.

Why start here: it works online with sparse data, retains static confidence as
a cold prior, is cheap to persist, and produces a probability that admission
can interpret. It is not assumed globally calibrated until Brier/reliability
results say so.

The Beta distribution is a standard prior for a Bernoulli event and the Brier
score is a proper score for binary probability forecasts. Those results support
the form of the experiment, but they do not validate using strength 4 for this
workload. That constant remains observation-only until paired results support
it: [Beta-binomial calibration framework](https://journals.ametsoc.org/view/journals/mwre/137/3/2008mwr2579.1.xml),
[Brier-score forecasting guidance](https://www.ecmwf.int/sites/default/files/elibrary/1999/7848-probabilistic-forecasting-meteo-france.pdf).

## Calibration experiments

Run all variants against identical daily benchmark records:

| Variant | Question |
|---|---|
| Static confidence | How much does feedback add at all? |
| Beta strength 2 | Does fast adaptation become noisy? |
| Beta strength 4 | Provisional balance |
| Beta strength 8 | Does a stronger prior slow useful correction? |
| Operational hit-rate multiplier | Confirm selection bias in current behavior |

Report candidate-level Brier score, top-1 accuracy, recall@1/@3, five equal
width reliability buckets, correct-but-suppressed, and admitted-but-wrong.
Also break results out by session number (1, 2, 3, 5, 10), rank, prediction
source, and workflow family.

Selection rule: prefer the simplest variant whose Brier score is no worse than
static confidence, improves admitted precision or net savings on varied
workflows, and does not materially reduce cold recall. Do not choose from
pooled hit rate alone.

## Admission contract

The first controller interface is deliberately small:

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
  reason:
    | 'admitted'
    | 'low-benefit'
    | 'poor-history'
    | 'unknown-latency'
    | 'discovery-limit';
}
```

The baseline policy computes each candidate independently:

```text
expectedBenefitMs = pNext * conservativeLatencyMs
admit when expectedBenefitMs >= minExpectedSavedMs
```

Sort admitted candidates by expected benefit and take candidates until the
existing per-trigger, rate, and concurrency caps stop them. A strong rank 1
must not pull weak ranks 2/3 through the gate.

Operational feedback may suppress a sufficiently sampled rule whose terminal
useful/speculated rate remains below the existing floor. It does not modify
`pNext`; correctness and execution cost answer different questions.

## Admission ideas to test

### A. Conservative latency factor

Test mean latency, `mean - 0.5 deviation`, and `mean - 1.0 deviation`. The
middle value is provisional. Choose using net savings and fast-local quietness,
not the greatest speculative hit count.

### B. Rank penalty

No explicit penalty is initially needed because calibration is candidate/rank
specific. Test a rank penalty only if reliability plots show persistent
overconfidence by rank after enough feedback.

### C. HTTP cost reporting

HTTP waste usually consumes quota/server work rather than local wall time.
Report `extraUpstreamCallsPerSavedSecond`; do not invent a universal conversion
from one extra API call to milliseconds. A future config could express a user
budget, but the first controller should remain explainable.

### D. Stdio contention cost

Stdio speculation can delay a real call. Initially rely on the current strict
budget plus `estimatedAddedWaitMs`. If paired tests show regressions, evaluate:

```text
netCandidateValue =
  pNext * conservativeLatencyMs
  - (1 - pNext) * observedContentionRisk * conservativeLatencyMs
```

Do not add this formula until contention risk is directly measurable; a made-up
constant would create false precision.

### E. Recent failure breaker

The existing authorization/speculation breakers stay authoritative. Consider a
short per-tool operational cooldown only if repeated timeouts/errors appear in
daily evidence and existing server-level behavior is too coarse.

## Bounded cold discovery hypothesis

Shadow evaluation teaches correctness without issuing. When the actual next
call arrives, it also supplies the target latency even if the candidate was
suppressed. Therefore most unknown tools need no active exploration.

The one proposed exception is:

- HTTP transport only;
- rank 1 only;
- base/calibrated probability at least 0.45;
- one unknown-latency issue per server per process session;
- existing eligibility, breaker, rate, and concurrency gates still pass;
- marked `exploratory` in decision aggregates.

Experiments compare no discovery, the rule above, and a stricter 0.60
probability threshold. Unknown stdio never explores by default. The exception
lands only if it improves a cold varied workflow while the negative control
stays within one extra issue per server/session.

## Required tests before rollout

- correct fast candidate is shadow-credited while issuance remains zero;
- consistently wrong rank 2 falls below consistently correct rank 3;
- mutation/session end/failure never manufacture negative feedback;
- candidate and operational counts reconcile independently;
- 0/1/2/3 candidates are admitted under constructed latency/probability cases;
- valuable rank 1 does not admit low-value alternatives;
- persisted fast-tool latency remains quiet after restart;
- one slow HTTP unknown receives at most one discovery opportunity;
- unknown stdio does not explore;
- negative-control issuance falls with evidence;
- all old state/config files load and rollback mode preserves behavior.

## Experiment decision table

Record each decision in the eventual implementation PR:

| Decision | Evidence required | Default if inconclusive |
|---|---|---|
| Beta prior strength | Brier + cold recall + sessions-to-correct | 4 |
| Deviation factor | net savings + fast-local p95 | 0.5 |
| Discovery probability | cold improvement + negative-control waste | no discovery |
| Dynamic beam | net savings + upstream calls | independent threshold |
| Stdio cost term | measured contention regression | omit |

## Rollout boundary

Calibration may ship behind adaptive admission before it changes issuance, so
we can gather reliability data safely. Admission changes ship separately after
the persisted latency model. Discovery ships last behind its own internal
kill-switch until real hosted runs and seven days of dogfood pass.

The controller is successful when it can say not merely “the hit rate rose,”
but “the right candidates were offered, expensive ones were issued in time,
cheap ones stayed quiet, and net user wait improved without unsafe results.”
