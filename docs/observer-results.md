# Experimental observer results

Measured 2026-09-14 at source `e6bf9866e636b6d7914e9fab2e73eb27ac0e7b60`. The observer remains experimental: its 1,000-case deterministic replay passed correctness checks but failed the speedup and speculative-waste targets for both clients. Native MCP transfer is verified; native speedup remains unverified.

## What has passed

Native-account smoke tests used Claude Code 2.1.268 and Codex CLI 0.154.0 with their existing account, model, effort, permission, and transport selections. Each client completed the expected model response in all three public modes and made exactly one correct call to a wrapper-owned synthetic read tool.

| Client | `--observe off` | `--observe hooks` | `--observe proxy` | Duplicate MCP calls |
| --- | --- | --- | --- | ---: |
| Claude Code 2.1.268 | Passed | Passed | Passed | 0 |
| Codex CLI 0.154.0 | Passed | Passed | Passed | 0 |

The fixture returned a fixed value and the model produced the required final output only after receiving it. The checks asserted a terminal completed response independently of exit status. Off mode retained current Speculate prediction while disabling new hook/model observation. Proxy mode also recorded successful relay traffic. The [sanitized transfer artifact](observer-native-transfer-results.json) contains tool counts, provider-reported token counts, wall time, active modes, and disabled-capability reasons.

These are single transfer samples. Their elapsed time and token totals are descriptive diagnostics, not performance evidence. `registeredRoutes` was sampled after native child shutdown and is not route-ownership history; wrapper initialization established ownership.

Native model routing through the production relay also completed an expected no-tool response for both clients. The relay preserved native authentication, model selection, request/response bytes, headers, and Claude HTTP or Codex WebSocket transport. Live API-key credentials were unavailable and were not acquired, so live API-key routing remains unverified.

## Benchmark arms

The release benchmark uses these distinct arms:

| Arm | Behavior |
| --- | --- |
| A | Direct fixture MCP provider, no Speculate |
| B | Current Speculate prediction through the session wrapper, with observers off |
| C | B plus hook observations |
| D | C plus model-request observation through the proxy |
| E | D plus complete structured stream-call observations where the native tool shape permits them |

Proxy and stream value must be measured incrementally against hook mode. For installed Codex 0.154.0, native MCP tools are deferred behind opaque `functions.exec`; E cannot claim direct native stream-call coverage. Flat Responses function calls remain a supported API fixture only.

## Measured replay results

The complete matrix contains 20 held-out workflows × 5 repetitions × 2 client fixtures × 5 arms: 1,000 records and 290 requested MCP calls per client/arm. Training was untimed with zero injected latency; holdout tools used 400 ms injected latency. Training and holdout seeds were independent, paired arm order was randomized, and no implementation or threshold was tuned on these results. The task clock ends at the final requested result; subsequent settlement is used for waste accounting only.

These are deterministic fixtures for Claude 2.1.268 and Codex 0.154.0, using `deterministic-fixture-model`, no effort value, and Messages SSE or Responses SSE. They are not native-client performance measurements. Launcher checks separately passed for both fake native clients.

Positive improvement means faster than B. Intervals use 10,000 workflow-cluster bootstrap samples over 12 tool-heavy workflows (60 paired records per comparison). Mixed-task p95 comparisons cover the other 8 workflows.

| Client | Arm | Median task-wall improvement vs B (95% interval) | Settled waste / issued |
| --- | --- | --- | --- |
| Claude | C: hooks | −2.38% (−2.69%, −2.07%) | 46 / 51 (90.20%) |
| Claude | D: request observation | −2.46% (−2.63%, −2.02%) | 45 / 50 (90.00%) |
| Claude | E: completed stream calls | −1.43% (−1.67%, −1.18%) | 46 / 131 (35.11%) |
| Codex | C: hooks | −2.34% (−2.75%, −2.02%) | 50 / 55 (90.91%) |
| Codex | D: request observation | −2.19% (−2.74%, −1.95%) | 50 / 55 (90.91%) |
| Codex | E: completed stream calls | −1.16% (−1.32%, −0.85%) | 50 / 135 (37.04%) |

Arm B had no cache hits or joins in this replay; all 46 Claude and 50 Codex speculative calls were unused. That is specific to this workload and differs from the historical core benchmark below. Arm E delivered 5 ready hits and 80 in-flight joins per client, but its overall task-wall result still failed to beat B.

Completed-stream observation improved E relative to D by 1.09% for Claude (95% interval 0.76–1.25%) and 0.97% for Codex (0.75–1.37%). Request observation D versus C had no statistically demonstrated benefit. The Codex E result applies to flat Responses fixtures only; installed native Codex's opaque executor does not expose this direct stream-call path.

## Gates and decision

| Gate | Claude | Codex |
| --- | --- | --- |
| Correctness, consent, isolation, unexpected writes | Passed: zero violations | Passed: zero violations |
| Extra predictor model calls | Passed: zero | Passed: zero |
| Local relay added TTFB ≤5 ms p95 | Passed: 0.123 ms | Passed: 0.132 ms |
| Median tool-heavy improvement vs B ≥10%, interval excluding zero | Failed in C/D/E | Failed in C/D/E |
| Mixed-task p95 regression ≤5%, vs B and incrementally | Passed in C/D/E | Passed in C/D/E |
| Settled waste ≤20% | Failed in C/D/E | Failed in C/D/E |
| Positive incremental benefit | C−B and D−C failed; E−D passed | C−B and D−C failed; E−D passed |
| Native matched-task speedup | Unverified | Unverified |
| Native hook delivery / live API-key routing | Unverified | Unverified |

Relay measurements used 20 warmups and 200 pairs per client, with byte-identical payloads. Their p95 added-TTFB 95% intervals were 0.116–0.144 ms for Claude and 0.120–0.149 ms for Codex. The largest positive mixed-task p95 regression among the tested comparisons was 0.127%, below the 5% threshold.

The unchanged automatic release evaluator returned **`remove` for all three stages on both clients**, because speedup and waste gates failed. The implementation plan permits retaining failing increments as experimental or removing them. This source-only delivery chooses **retain experimental**, with no npm release or broader enablement. It does not override the measured failed gates or claim that the new observer improves native task performance.

The final production snapshot passed build, strict TypeScript, independent review, and 1,362 tests with 8 skipped. The full benchmark completed in about 65 minutes. See the [verification artifact](observer-verification-results.json).

## Reproducibility and reports

The [benchmark summary](observer-benchmark-results.json) preserves raw comparisons and gate decisions, plus per-workflow counts, latency percentiles, waste, and correctness counters. The [compressed complete record artifact](observer-benchmark-records.json.gz) contains the 1,000 aggregate records, execution order, seeds, and measurements. Its uncompressed SHA-256 is `0478862f8a42f6c7a42458c49ca3e30cb7bc000ef867a75c72a962c46b1eacfa`. No raw native session material is included.

Run from a built checkout of the recorded source commit:

```bash
npm run build
SPECULATE_BENCH_SOURCE_COMMIT=e6bf9866e636b6d7914e9fab2e73eb27ac0e7b60 npm run bench:observer -- --output observer-results.json
```

Timing varies by machine. The command retains the fixed workload, seeds, thresholds, and bootstrap method. Preserve the exact source tag; a run with no tag is labeled `staging-uncommitted` and is not immutable-source evidence.

## Historical core regression

The existing MCP predictor benchmark ran 240 records with 400 ms of injected tool latency. Against no prediction, current Speculate reduced aggregate tool wait by 6.01% and left 35.96% of issued speculative calls unused. Those numbers validate continuity of the existing core at its recorded snapshot. They do not measure native clients, hooks, the model proxy, stream observation, or improvement over Arm B, and they must not be used as the new observer result. See the [core regression artifact](observer-core-regression-results.json).

## Compatibility and recovery limits

Claude exposes flat MCP names and schemas to the model transport. Codex's installed native default exposes only an opaque custom executor, which remains unchanged and observation-only. Prompt and learned-transition prediction can still use live registered MCP routes on both clients.

Speculation requires the host's exact permission and a read-only tool annotation. Unsupported policy, hook trust, configuration precedence, provider routing, or Codex alias encoding causes the affected capability to abstain or fall back; it never grants permission. Reports remain aggregate and omit raw session material.

Failure handling is conservative: provider/client retry remains native, partially forwarded model requests are not automatically replayed, and a fresh launch creates fresh temporary routing state. Detected tracking loss also revokes owner routes, queued work, in-flight publication, and ready cache results until a fresh launch. The final production changes passed independent review and the 1,362-test suite; see the [verification artifact](observer-verification-results.json).

Supporting evidence: [native routing](observer-native-routing.md), [native tool shapes](observer-native-tool-shapes.md), [native transfer results](observer-native-transfer-results.json), and [compatibility](observer-compatibility.md).
