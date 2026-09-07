# v0.19 local learning qualification

The upgrade passed the release gates set before measurement. The clearest
benefit is more useful prefetches on repeated workflows whose arguments depend
on earlier calls. These are controlled MCP fixtures with 120 ms injected
upstream latency, not measurements of GitHub or Linear service performance.

## Before and after

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

## Controls and uncertainty

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

## Release gates and other checks

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

## Reproduce and inspect

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
