# Benchmark methodology and results

This page is the authoritative guide to Speculate's performance instruments.
Every result must identify its source revision, workload, latency conditions,
training/held-out split, and accounting. Historical release results below are
snapshots of those versions, not measurements of the current release.

## Maintained instruments

| Command | What it measures | Limits |
| --- | --- | --- |
| `npm run bench` (alias: `bench:repeated`) | Full MCP proxy tool wait on changing repeated workflows, with separate persisted learning per arm | Authored fixtures with injected upstream latency; no claim about ordinary traffic or hosted-service latency |
| `npm run eval` | Generic offline replay prediction recall and adversarial floor | No real proxy timing or whole-task speedup |
| `npm run bench:remote` | Alternating off/on sessions against actual hosted MCP servers | Network and service noise; repeats an identical script; requires explicit live opt-in |
| Real filesystem and Git E2Es | Full proxy sessions with actual local operations | Disposable fixtures; inexpensive local reads may cost more to prefetch than they save |
| `npm run bench:mock` | Historical GitHub-rule mechanics example with injected delay | Explicit domain rules and disabled persistence; does not qualify the general learner |

The unused daily-workflow generator had no runner and was removed in v0.20,
along with its unused comparison API. The repeated-workflow harness and its
paired accounting remain maintained.

## Repeated workflows

Build before running; the driver invokes `dist/src/cli.js` from each target.
The default command compares this checkout with speculation off and on. It uses
three seeds, four training sessions, four held-out sessions, and 120 ms injected
latency. Each arm has independent state, shared only across that arm's sessions
for the same workflow and seed. Execution order rotates across sessions.

```bash
npm run build
npm run bench -- --json repeated.json
```

For a release comparison, build both checkouts and supply a baseline. This adds
an enabled baseline arm (`stable`) alongside off and candidate. `off` runs the
baseline revision; `candidate` defaults to this checkout. `--arms` can select
explicit arms for diagnostic runs.

```bash
npm run bench -- --baseline ../speculate-baseline --candidate . \
  --seeds 1,2,3,4,5 --train 8 --holdout 8 --latency 120 --json repeated-release.json
```

Use a fresh output path for a new comparison. The driver writes a JSON artifact
and adjacent `.progress.log`; an existing compatible artifact is merged by
session identity, while incompatible settings are rejected. Progress reports
are not a substitute for the completed artifact.

Train chronologically on earlier sessions. Held-out identifiers, optional calls,
and ordering change; each request is scored before its result can teach that
arm. Earlier held-out sessions can teach later ones, so this is online
chronological evaluation, not a frozen-model test. Fixture domains belong only
in `bench/` and `test/`. Do not tune production mechanisms on held-out answers.

Report cold and held-out results separately, preserve the unpredictable control,
and compare full output digests for every paired session. A useful prediction
is a ready hit or an in-flight join. A join still waits for unfinished work.
Report those counts separately, together with misses, speculative calls,
upstream calls, predictor recall, wait samples and p50/p95, and state size.

At the final snapshot, every speculative call must have exactly one outcome:

```text
speculative calls = ready hits + in-flight joins + terminal wasted + outstanding
shutdown waste = terminal wasted + outstanding at snapshot
```

Outstanding ready/in-flight work is counted as abandoned on close. Report waste
per useful call as well as absolute waste; ready hit rate alone hides joins and
unused upstream work. Estimated saved time in stats is distinct from measured
tool wait. Driver CPU/RSS does not measure all proxy/server process resources.
Neither tool-wait reductions nor offline recall establish end-to-end task gains.

## Real-server checks

Hosted scenarios require live opt-in. The harness checks each tool's
`readOnlyHint` before calling it and aborts if a requested tool is not explicitly
read-only. The following scenarios need no credential:

```bash
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario context7
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario mslearn
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario mslearn-cold
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario huggingface

# GitHub: config holds a ${VAR} placeholder resolved in the child's environment.
SPECULATE_E2E_LIVE=1 GITHUB_TOKEN=$(gh auth token) npm run bench:remote
```

Report every alternating run, including cold starts and regressions. A warm
median here is runs 2 and 3 of an identical script; it describes a favorable
repeated workflow. Schema-backed candidates can sometimes help a first pass,
while learned transitions require evidence. Host/network changes between
separate runs prevent attributing all timing differences to a source change.

The two opt-in local E2Es use SDK-backed stdio servers, actual filesystem
operations, and a disposable Git repository:

```bash
SPECULATE_REAL_E2E=1 npx vitest run test/filesystem-real-e2e.test.ts
SPECULATE_REAL_E2E=1 npx vitest run test/git-real-e2e.test.ts
```

These real harnesses accept `SPECULATE_E2E_TARGET_ROOT=/path/to/built/checkout`,
so one driver can compare revisions. Machine-readable summaries use the labels
`REMOTE_E2E`, `FILESYSTEM_REAL_E2E`, and `GIT_REAL_E2E`.

## v0.20 qualification against v0.19

This is a simplification and prediction-lifecycle release. Validation on
2026-09-07 used Node 22.23.2 on Linux and the released v0.19.0 commit
`3c503a015bc7f841a77e03d54c4cf7ed1b4cf64a` as the baseline. It does not
establish a general task-speed improvement.

### Paired repeated workflows

The complete comparison ran all five workflows over seeds 1, 2, and 3, with
four training and four held-out sessions per seed and 120 ms injected latency.
All 360 proxy sessions completed, and paired output digests matched. Each
held-out arm contained 336 real tool calls across 60 sessions.

| Held-out metric | Off | v0.19.0 | v0.20.0 |
| --- | ---: | ---: | ---: |
| Ready hits | 0 | 13 | 13 |
| In-flight joins | 0 | 191 | 191 |
| Useful calls / real calls | 0/336 | 204/336 | 204/336 |
| Speculative upstream calls | 0 | 287 | 287 |
| Terminal wasted calls | 0 | 83 | 83 |
| Predictor recall@3 | n/a | 67.8571% | 67.8571% |
| Mean tool wait | 123.42 ms | 96.25 ms | 96.25 ms |
| p95 tool wait | 129.66 ms | 129.42 ms | 129.35 ms |
| Peak state file | 0 bytes | 30,545 bytes | 29,714 bytes |

Cold useful calls also matched at 11/84, with 13 wasted calls in each enabled
arm. The unpredictable control issued no speculation. The candidate preserved
useful work and waste totals; measured wait was effectively unchanged. Removing
duplicate latency storage reduced the peak state file in this fixture, but the
queue-lifetime correction did not demonstrate a throughput gain here.
Supplemental validation overlapped part of this run; sub-millisecond timing
differences should not be attributed to the release.

```bash
npm run bench -- --baseline ../speculate-release-baseline --candidate . \
  --seeds 1,2,3 --train 4 --holdout 4 --latency 120 --json repeated-release.json
```

### Feedback ablation

The operational feedback cutoff remains alongside correctness calibration.
They address different outcomes: a correct prediction can expire before the
real call arrives. Their shared scoring implementation was consolidated.

Two otherwise identical builds differed only in the operational cutoff
(`FEEDBACK_EFFECTIVENESS_FLOOR`: 0.15 versus 0). With seed 1, four training
and four held-out sessions, all five repeated workflows, and 120 ms injected
latency, both builds served 68 useful predictions in 112 held-out calls,
issued 96 speculative calls, and wasted 28. This fixture alone did not show a
reason to delete the cutoff.

A deterministic ablation exercised the production predictor, calibration,
latency model, metrics, and cache with an injected clock. It offered 100 correct
list-to-detail predictions with a 200 ms latency estimate and the normal
30-second TTL. When requests arrived after 30.001 seconds, the cutoff stopped
after eight wasted calls; removing it wasted all 100. With requests at five
seconds, both variants served all 100. The recovery fixture also exposed the
tradeoff: when the first 20 requests arrived too late and later requests were
timely, the cutoff stayed muted, while calibration alone recovered to 80 hits with 20 wasted
calls. That recovery limitation remains; this release does not introduce a
new exploration mechanism. These are controlled fixtures, not live-server
performance measurements.

### Other validation

The default test suite passed 853 tests with seven platform/opt-in skips.
Strict documentation build and the production TypeScript build passed. A clean
package install completed MCP initialization, tool discovery, and a real tool
call against the bundled fixture on Node 18.20.8. Clean builds remove `dist`
before compiling so retired modules cannot remain in a published tarball.

Generic replay recall@3 stayed at 85.9184%, with the adversarial floor at
8.6667% and prediction waste per hit at 1.8480. This corpus models triggered
calls; startup timing is explicitly unmeasured, and constant-argument
transitions now receive the ordinary next-call lifetime.

Both versions passed the real filesystem and Git E2Es using the same current
drivers. Filesystem useful predictions stayed at 30/44 with five terminal
wasted calls. Unconstrained Git stayed at 36/45 with eight wasted calls. In the
cheap-read Git default-admission check, the baseline issued no speculation;
the candidate issued three calls, of which two were useful and one wasted,
before later sessions suppressed speculation. These validation runs overlapped
other local checks and do not isolate a release speedup.

The credential-free live Microsoft Learn check completed three off/on pairs
without tool errors. Candidate useful calls were 2/6, 2/6, and 5/6. Measured off
waits were 1589, 1344, and 1648 ms; on waits were 1387, 1103, and 622 ms.
Outstanding predictions at the final snapshots were 2, 2, and 4, so zero
completed waste at those snapshots does not mean zero terminal waste. This
was a candidate off/on check, not a live comparison with v0.19.

## Historical hosted-server snapshots

These earlier snapshots used three alternating off/on runs each with no
per-server prediction configuration. Warm tool wait is the median of runs 2
and 3, after repeating the identical session.

| Server | Auth | Warm tool wait | Reduction |
| --- | --- | --- | ---: |
| Context7 | none | 9.4 s to 3.1 s | 67% |
| GitHub hosted MCP | token | 5.0 s to 1.6 s | 67% |
| Microsoft Learn | none | 2.3 s to 1.1 s | 54% |
| Hugging Face Hub | none | 259 ms to 139 ms | 46% |

They reported zero completed waste but predated final outstanding-batch
accounting, so they do not establish zero wasted calls. Current harnesses
expose outstanding work and count it as abandoned at shutdown. These are
historical observations, not current-release qualification. Full run history
and caveats remain in the [implementation notes](implementation-notes.md) and
[release notes](releases.md).

## Historical qualification: v0.19 versus v0.18

The upgrade passed the release gates set before measurement. The clearest
benefit is more useful prefetches on repeated workflows whose arguments depend
on earlier calls. These are controlled MCP fixtures with 120 ms injected
upstream latency, not measurements of GitHub or Linear service performance.

### Before and after

Five seeds each ran eight training and eight held-out sessions through the
full MCP proxy. Speculation off, v0.18.0, and the candidate used the same
fixtures with independent persisted state and rotating arm order. The run
contained 1,200 sessions and 6,720 requested calls. Each repeated workflow
below has 200 held-out requests per arm.

| Repeated workflow | v0.18 mean wait | v0.19 mean wait | Reduction | Useful before | Useful after |
| --- | ---: | ---: | ---: | ---: | ---: |
| CI investigation | 83.80 ms | 73.72 ms | 12.03% | 54.5% | 70.0% |
| PR review | 86.79 ms | 80.37 ms | 7.39% | 80.0% | 85.5% |
| Issue triage | 97.99 ms | 82.16 ms | 16.15% | 70.0% | 89.5% |
| Renamed tools | 98.53 ms | 83.60 ms | 15.15% | 69.5% | 90.0% |

"Useful" combines ready cache hits and joins of already-issued speculative
calls. A join still waits for the remaining work; it is not an instant hit.

Across those four workflows (800 requests per enabled arm):

| Metric | v0.18 | v0.19 |
| --- | ---: | ---: |
| Mean measured tool wait | 91.78 ms | 79.96 ms |
| p50 / p95 wait | 108.18 / 140.43 ms | 79.45 / 141.05 ms |
| Ready cache hits | 119 | 104 |
| In-flight joins | 429 | 566 |
| Useful rate | 68.50% | 83.75% |
| Misses | 252 | 130 |
| Speculative calls issued | 768 | 886 |
| Wasted calls, including outstanding at shutdown | 220 | 216 |
| Waste per useful call | 0.401 | 0.322 |
| Total upstream calls | 1,020 | 1,016 |
| Predictor recall@3 | 73.75% | 95.00% |
| Largest observed state file | 20,270 B | 20,554 B |

The pooled mean wait reduction is 12.87%, or 11.81 ms per requested call.
Ready hits decreased; the additional useful work was predominantly joined
in flight. PR-review waste increased from 40 to 56 calls, although its
waste/useful ratio remained below one. Tail latency did not improve.

### Controls and uncertainty

The unpredictable control made 320 held-out requests per arm and issued zero
speculative calls in either version. Its mean wait was 139.94 ms for v0.18 and
128.58 ms for v0.19. The apparent improvement is timing noise, not learning:
the stable arm included a 2,472 ms outlier. Timing spikes affected multiple
arms, including off. Every full output digest matched across all 400 paired
sessions. No outliers were removed from the release-gate calculation.

Cold sessions produced 19 useful calls out of 140 requests in both versions,
with 21 wasted calls each. Mean cold wait changed from 113.29 to 117.29 ms.
The added learner history did not improve cold-start useful rate.

Held-out evaluation is online and chronological: each request is evaluated
before its result can teach that arm. Earlier held-out sessions can inform
later ones. IDs, optional calls, and ordering change; production learner
code contains no workflow names or domain examples. The fixtures remain
authored tests, not a sample of ordinary user traffic. The two passing
fixtures have related branch structures: they show transfer across changed
tools and arguments, with limited evidence of broader workflow diversity.

All five seeds improved the mean over the four repeated workflows. A
10,000-resample seed bootstrap gives an exploratory 95% interval of
11.17–12.32 ms saved per call. With five seeds, this is not a claim of
statistical significance or a prediction of whole-task speedup. Each passing
workflow exceeded 15% in three of five seeds; the renamed aggregate passed
by only 0.15 percentage points. The pooled interval does not establish a
confidence bound above either workflow's threshold. CPU/RSS measurements
cover only the driver.

### Release gates and other checks

The fixed performance gate required at least two varied workflows to reduce
mean wait by at least 15% and improve useful rate by at least 10 percentage
points. Issue triage and renamed tools passed. Waste, negative-control
speculation, exact outputs, and offline recall-regression gates also passed.

The existing offline corpus improved recall@3 from 84.6259% to 85.9184%; its
adversarial floor stayed at 8.6667%. Waste/hit fell from 1.9984 to 1.8480.
Linux and macOS CI passed 868 tests with 7 skips; Windows passed 865 with
10 skips. Node 18 CLI compatibility was checked. The three-platform
[CI run](https://github.com/lukebward/speculate/actions/runs/34157066999)
tested the frozen runtime.

Supplemental results limit the claim. The existing 120 ms filesystem fixture
kept its 30/44 useful rate and changed mean wait from 50.58 to 51.06 ms.
Real local Git changed from 17.98 to 19.08 ms and 24/45 to 18/45 useful calls,
while the off arm itself became faster and admission issued fewer cheap
reads. Live Microsoft Learn produced 10/18 useful calls before and 9/18 after,
with eight terminal wasted calls each. Separate host/network conditions make
those runs unsuitable for isolating an upgrade speedup.

### Reproduce and inspect

The baseline is commit `1371efef3758d6bdf679556867c0c4828a9d6657`.
The frozen candidate is `9d61a06d96ea5749c5382120948ca11854737409`;
later release changes are documentation only. Build both checkouts, then run
the candidate's driver:

```bash
npm run bench:repeated -- --baseline ../speculate-baseline --candidate . \
  --seeds 1,2,3,4,5 --train 8 --holdout 8 --latency 120 --json repeated.json
```

The [release artifacts](https://github.com/lukebward/speculate/releases/tag/v0.19.0)
include raw repeated results, summaries, and source/build hashes. Local path
fields in public copies are normalized; timing samples and output digests
are unchanged.
