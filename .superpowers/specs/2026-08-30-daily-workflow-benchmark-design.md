# Daily workflow benchmark design

**Date:** 2026-08-30 · **Status:** draft for implementation

## Goal

Build one repeatable benchmark that tells us whether a Speculate change makes
ordinary tool-using work faster and less wasteful. It must distinguish four
different failure classes:

1. the predictor did not offer the right call;
2. the predictor offered it but admission suppressed it;
3. it was issued but did not finish in time;
4. it finished but was invalidated, expired, or never used.

The benchmark is comparative infrastructure, not a new product feature. It
must exercise actual proxy processes and actual MCP calls while keeping the
default test suite deterministic and offline.

## Success criteria

A single command can compare a candidate checkout against speculation-off and,
optionally, another checkout. Given the same seed, every arm receives the same
logical calls, selected ranks, think times, and mutations. The report contains
enough aggregate data to explain a result without storing tool arguments or
results.

The north-star runtime measures are both reported:

```text
measuredWaitDeltaMsPer100 =
  100 * (pairedOffToolWaitMs - armToolWaitMs) / requestedCalls

estimatedNetSavedMsPer100 =
  100 * (estimatedSavedMs - estimatedAddedWaitMs) / eligibleCalls
```

The measured comparison is primary for deterministic local workflows. The
estimated comparison remains useful for noisy hosted runs and for explaining
where Speculate believes time was saved. They must not be silently combined.

NIST's paired-observation guidance supports comparing differences inside
matched sessions rather than treating arms as unrelated samples. Node's
`performance.now()` provides the process-relative high-resolution clock used
for tool waits. These validate the measurement structure, not any pass/fail
threshold:
[NIST paired observations](https://www.itl.nist.gov/div898/handbook/prc/section3/prc311.htm),
[Node performance timing](https://nodejs.org/api/perf_hooks.html#performancenow).

## Non-goals

- Replacing the existing offline corpus evaluation.
- Running real Git, filesystem, or hosted servers in default CI.
- Proving usefulness from hit rate alone.
- Uploading traces, reports, arguments, results, or repository identities.
- Making benchmark-only hooks part of the public package API.

## Terminology

- **Workflow:** a named family such as Git inspection or code navigation.
- **Session:** one fresh proxy process executing one generated workflow.
- **Arm:** `off`, `stable`, or `candidate`.
- **Pair:** matching arm sessions generated from the same workflow, seed, and
  session index.
- **Requested call:** a tool call made by the benchmark client.
- **Eligible call:** a requested call affirmatively eligible for speculation.
- **Upstream call:** a call actually received by the fixture/remote server;
  this includes real misses and speculative calls.
- **Useful speculation:** a ready hit or in-flight join.

## Command contract

Add this script:

```json
{
  "bench:daily": "tsx bench/daily.ts"
}
```

Supported options:

```text
--seed N             base unsigned 32-bit seed (default 1)
--sessions N         sessions per workflow and arm (default 5)
--workflow NAME      repeatable; omitted means all local workflows
--target-root PATH   candidate checkout (default current checkout)
--stable-root PATH   optional comparison checkout
--json               emit JSON lines only on stdout
```

`--sessions` is capped at 100, unknown workflows/options fail with exit code 2,
and a missing target CLI fails before any workflow starts. Human progress goes
to stderr in JSON mode. A skipped opt-in workflow is a structured skip, not a
fabricated zero result.

## Module boundaries

### `bench/dailyWorkflows.ts`

Owns deterministic workflow generation and fixture setup.

```ts
export type DailyStep =
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
  | { kind: 'think'; ms: number }
  | { kind: 'mutate'; operation: string }
  | { kind: 'turn'; label: string };

export interface DailyWorkflow {
  id: string;
  version: number;
  setup(root: string, seed: number): Promise<DailyFixture>;
  steps(fixture: DailyFixture, seed: number, session: number): DailyStep[];
}
```

The executable report never serializes `DailyStep`. `label`, `args`, fixture
paths, and mutation details are runner inputs only.

Use a tiny repository-owned PRNG rather than `Math.random()`. Its output is
part of the scenario version. Changing generation semantics requires bumping
that workflow's version so old and new reports are not compared as identical.

### `bench/comparison.ts`

Owns pure record validation, aggregation, pairing, percentiles, and invariant
checks. It imports no MCP transport and performs no filesystem writes.

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
  predictorOpportunities: number;
  predictorHitsAt1: number;
  predictorHitsAt3: number;
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

Unknown fields are tolerated when reading a future record. Invalid numbers,
unknown schema versions, duplicate `(workflow, version, arm, seed, session)`
records, and unpaired comparisons are rejected with an explanatory error.

### `bench/daily.ts`

Owns CLI parsing, arm scheduling, process launch, and report output. Shared
process mechanics extracted from the current real Git/filesystem E2Es should
live in a benchmark helper, not production `src/`.

## Arm isolation and order

Each arm receives its own state directory, usage directory, upstream call log,
and workspace copy. Sessions within one arm share state so warm-up is real.
No state crosses arms.

Pair order alternates by session to reduce order bias:

```text
even pair: off → candidate → stable
odd pair:  stable → candidate → off
```

When no stable root is supplied, omit stable without changing off/candidate
order parity. Hosted scenarios already alternate off/on internally and may
continue using their own runner while emitting the common record schema.

## Initial workflow set

### Git inspection

Create a real temporary repository with enough commits, branches, and tags to
vary selection. Sessions list history, select ranks 0/1/2 using the seed, show
the commit, inspect a changed path, and alternate branch/tag/diff follow-ups.
Nothing contacts a remote.

### Code navigation

Reuse the filesystem fixture server. Vary query, selected file, symbol, and
whether references or a second file follows. Preserve list/search → detail
shapes without selecting the first result every time.

### Documentation browsing

Use a local loopback MCP fixture in default CI. It returns deterministic JSON
for search/resolve/fetch calls with rank selection varied by seed. Context7 and
Hugging Face remain opt-in hosted extensions of this family.

### Mutation freshness

Prefetch a read, mutate the backing Git repository or file through an
ineligible tool, then request the old key. Assert the response reflects the
mutation and terminal accounting marks invalidated work. A stale value is a
hard failure independent of performance.

### Negative control

Choose next tools and arguments uniformly from a seeded bounded set, while
retaining read-only annotations. It should have low predictor recall and make
adaptive admission quieter with evidence. This detects a controller that
manufactures hit rate by issuing everything.

## Accounting invariants

Every run checks:

```text
requestedCalls = hits + joins + misses

speculativeCalls =
  hits + joins + terminalWasted + outstandingAtSnapshot

0 <= predictorHitsAt1 <= predictorHitsAt3 <= predictorOpportunities
upstreamCalls >= misses
toolWaitMs >= 0
```

The runner waits for normal terminal settlement up to a short fixed deadline,
then records remaining work as `outstandingAtSnapshot`; it never rewrites that
work as wasted. Counter disagreement fails the run and includes only counter
names and values in the error.

## Output and privacy

JSON mode emits one `DailyRunRecord` per line followed by one tagged comparison
object. Output contains workflow IDs, arm labels, seed/session numbers, tool
and server aggregate counters, durations, runtime version, OS, and an optional
explicit implementation label. It excludes:

- absolute workspace and checkout paths;
- tool arguments and result bodies;
- repository names, URLs, file names, queries, and selected identifiers;
- environment variables and command lines.

A fixture checked into the repository uses the same sanitized schema and adds
the source commit plus explicit benchmark parameters.

## Test matrix

Default tests cover:

- PRNG golden values and deterministic workflow generation;
- meaningful variation across ranks, values, and order;
- arm pairing and alternating order;
- aggregation and percentile edge cases;
- every accounting invariant and deliberately corrupt records;
- report privacy by recursively checking keys and sentinel secret values;
- stable JSONL output ordering;
- one small loopback off/candidate process pair;
- Windows-safe path/process construction.

Opt-in tests retain the existing real Git, filesystem, and hosted gates. They
should emit the common record in addition to their human summary until the new
runner has proven stable; do not delete the old independent entry points in the
first release.

## Implementation slices

1. Pure PRNG, workflow generator, schemas, comparison math, and tests.
2. Shared process/session harness extracted without behavior changes.
3. Local Git, navigation, docs, mutation, and negative workflows.
4. CLI/reporting and checked-in baseline fixture.
5. Adapters for existing real and hosted E2Es.

Slices 1 and 2 can land before any predictor or persistence change.
