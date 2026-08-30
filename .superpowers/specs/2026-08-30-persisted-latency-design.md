# Persisted latency model design

**Date:** 2026-08-30 · **Status:** draft for implementation

## Goal

Give every prediction one trustworthy estimate of how expensive its target
tool is, including immediately after a proxy restart. A cheap local tool should
remain suppressed once learned; a slow remote tool should remain eligible for
useful prefetching without a server-specific profile.

The model is an optimization input. Missing, stale, corrupt, or unmergeable
data must fall back conservatively and never fail a real tool call.

## Why a separate component

Latency currently exists in three places:

- learned transitions carry `expectedLatencyMs`;
- learned session openers carry `expectedLatencyMs`;
- `Predictor` maintains process-local tool and server EWMAs.

That means estimates depend on the prediction source and disappear at restart.
It also makes admission hard to test independently. `LatencyModel` becomes the
single owner; transition/opener values remain temporary migration hints only.

## Chosen representation

Use a time-decayed weighted mean and centered `M2` rather than a process-local
EWMA. The pair has two advantages important in this repository: it produces a
mean and uncertainty estimate, and it can be split/combined through
`StateStore`'s baseline-delta strategy without guessing event order. Centered
`M2` avoids the cancellation error in `sum(x²) / n - mean²` when durations are
large but nearly identical.

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
  constructor(options?: { now?: () => number });
  observe(server: string, tool: string, latencyMs: number): void;
  estimate(server: string, tool: string, predictionHintMs?: number): EstimatedLatency;
  exportState(): LatencySnapshot;
  importState(raw: unknown): void;
}
```

The public surface is internal to the package. Tests inject the clock; callers
cannot change decay or bounds in the first release.

## Observation algorithm

Constants:

```text
LATENCY_HALF_LIFE_MS = 30 days
MAX_LATENCY_MS = 600,000
MAX_EFFECTIVE_WEIGHT = 1,000,000,000
MAX_OBSERVATIONS = 1,000,000,000
TOOL_MIN_WEIGHT = 0.5
SERVER_MIN_WEIGHT = 2.0
UNKNOWN_LATENCY_MS = 100
CONSERVATIVE_DEVIATION_FACTOR = 0.5
```

For an existing estimate last updated at `t0`, first age its effective weight
and `M2` to `t1`; the mean is unchanged:

```text
factor = 2 ^ (-(t1 - t0) / LATENCY_HALF_LIFE_MS)
weight *= factor
m2Ms2 *= factor
```

Then add one sanitized observation `x`:

```text
newWeight = weight + 1
delta = x - meanMs
meanMs += delta / newWeight
m2Ms2 += delta * delta * weight / newWeight
weight = newWeight
observations += 1
lastUpdated = t1
```

If the defensive weight cap is ever reached, scale weight and `M2` by the same
factor. This preserves mean and variance. The deliberately high cap keeps
ordinary baseline-delta merges additive; cap-edge merges are conservative.
`observations` is an explanatory monotonic count and is independently capped.

Every successful served eligible call is observed once. For a cache hit or
join, use the cache entry's full upstream latency, which the proxy already
places in `CompletedCall.latencyMs`; do not use the near-zero client wait. A
real miss uses its measured upstream duration. Failed results, speculative
calls never requested by the client, and non-finite/negative durations are not
observations.

Each accepted observation updates both `(server, tool)` and the server
fallback. The server aggregate is intentionally a fallback, not a substitute
for a sufficiently weighted tool estimate.

## Estimation algorithm

Age a copy to `now`; reads do not mutate the stored entry or dirty persistence.
For valid moments:

```text
mean = meanMs
variance = max(0, m2Ms2 / weight)
deviation = sqrt(variance)
conservative = max(0, mean - 0.5 * deviation)
```

Fallback order:

1. tool moments with effective weight at least `0.5`;
2. server moments with effective weight at least `2.0`;
3. a finite prediction hint in `[0, 600_000]`;
4. the 100 ms unknown prior.

A single tool observation therefore remains usable for one half-life. Server
fallback requires more evidence because heterogeneous tools can otherwise let
one slow call classify an entire server as expensive.

For hint/unknown estimates, deviation is zero and effective samples is zero.
`expectedMs` is the mean/hint/prior. Admission uses `conservativeMs`; ranking
and diagnostics may display `expectedMs`.

## Persistence

Add `latency?: LatencySnapshot` to `PersistedState` and to the atomic `save`
payload. Keep state version 1: the field is optional and a legacy file is a
valid cold latency model.

Disk arrays are sorted by server then tool for deterministic output. Bounds:

- at most 128 server estimates;
- at most 256 tool estimates per server;
- server/tool labels must be non-empty strings no longer than 512 code units;
- weakest effective weight, then oldest timestamp, then lexical key determines
  deterministic eviction.

Import validates every number independently, clamps timestamps to `now`, drops
entries whose moments are inconsistent, deduplicates keys by preferring the
stronger/newer entry, and never throws. Import does not mark the model dirty.

No arguments, results, URLs, workspace paths, credentials, or cache keys are
added to state. Existing scope hashing continues to prevent workspace/account
cross-contamination.

## Concurrent merge

All snapshots are first aged to the incoming save timestamp. For each matching
entry, remove the aged baseline group from the incoming total using the inverse
pairwise formula. Then combine that delta group with the latest on-disk group:

```text
weight = weightA + weightB
delta = meanB - meanA
mean = meanA + delta * weightB / weight
m2 = m2A + m2B + delta² * weightA * weightB / weight
```

Use a small floating-point epsilon before clamping a moment delta to zero.
Disjoint entries are unioned. Apply caps and deterministic eviction after the
merge. If there is no baseline, prefer the entry with greater effective weight
and then the newer timestamp rather than summing potentially duplicate state.

Invalid or materially negative inverse `M2` degrades to the stronger incoming
estimate instead of propagating corrupt arithmetic. Tests must cover two
processes observing the same tool as well as disjoint tools.

## Research validation

Chan, Golub, and LeVeque analyze updating and pairwise variance algorithms and
their round-off behavior. Their centered, pairwise approach is why this design
replaced the first draft's raw weighted-square sums:
[Algorithms for Computing the Sample Variance](https://doi.org/10.1080/00031305.1983.10483115).

This source validates numerical structure, not the product constants. The
30-day half-life, minimum effective weights, and `0.5 × deviation` conservative
factor remain Speculate hypotheses gated by real workflows.

## Integration

`SpeculateProxy` constructs one model and injects it into `Predictor`. Startup
order is:

```text
load scoped state
  → import learner
  → import rule feedback
  → import latency
  → evaluate session openers
```

On successful served calls, `Predictor.observe` records latency before ranking
the next batch. `Predictor.utility` no longer owns maps and instead calls the
model. The model is exported in the same scheduled atomic save as learner and
feedback state.

`mode: off` does not construct meaningful learning state, observe latency,
schedule a save, or alter an existing file.

Keep transition and opener `expectedLatencyMs` in serialized learner state for
one compatibility release. They may be passed as the prediction hint only when
the model lacks weighted evidence. Stop separately updating those estimates
after the migration release, then remove them in a later state-compatible
cleanup.

## Diagnostics

Extend per-tool durable usage with:

```ts
realCallCount: number;
realLatencyMs: number;
```

These counters explain observed day-to-day latency but are not the latency
model state and do not participate in admission. Live decision aggregates add
latency source and broad estimate buckets (`<10`, `10-50`, `50-200`, `200+`),
not raw per-decision logs unless the existing decision log is enabled.

## Test matrix

Unit tests cover:

- first observation and repeated identical observations;
- weighted mean/deviation with an injected clock;
- exact 30-day half-life decay;
- outlier handling and conservative estimate;
- tool → server → hint → unknown fallback;
- invalid hints and observations;
- import of null, legacy, hostile, oversized, duplicate, and future data;
- deterministic caps and export order;
- no dirty revision from estimate reads/import;
- baseline-delta merges for disjoint and matching tools;
- cap behavior during concurrent merge.

Integration tests cover:

- proxy restart preserving a cheap-tool decision;
- a cache hit contributing full upstream latency, not client wait;
- scope mismatch producing a cold model;
- `mode: off` producing no write;
- save failure degrading without affecting a real call;
- old learner-only state loading and supplying a migration hint.

Real E2Es cover fast Git across restarts and the 120 ms filesystem workflow.
The daily benchmark must show unchanged raw prediction recall: this component
changes admission input, not candidate generation.

## Implementation slices

1. Pure `LatencyModel`, serialization, and unit tests.
2. Optional persisted field and baseline-delta merge.
3. Proxy injection and removal of predictor-local maps.
4. Diagnostics and real-workflow gates.

No admission formula change belongs in slices 1-3. That isolation makes any
behavior delta attributable to persistence rather than controller redesign.
