# Experimental observer results

Checked 2026-09-14. The context-aware observer is unreleased and remains experimental. Its native transfer path is verified for both supported clients; its incremental performance benefit is not yet measured.

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
| B | Current Speculate prediction through `run --observe off` |
| C | B plus hook observations |
| D | C plus model-request observation through the proxy |
| E | D plus complete structured stream-call observations where the native tool shape permits them |

Proxy and stream value must be measured incrementally against hook mode. For installed Codex 0.154.0, native MCP tools are deferred behind opaque `functions.exec`; E cannot claim direct native stream-call coverage. Flat Responses function calls remain a supported API fixture only.

## Gates

| Gate | Current status |
| --- | --- |
| Native wrapper ownership, result correctness, one upstream call | Passed for both clients in B/C/D |
| Zero correctness, consent, and isolation failures across the final suite | Pending final Task 9/10 verification |
| No extra predictor model calls | Pending benchmark report |
| Relay overhead at most 5 ms p95 | Pending |
| At least 10% median improvement over B per client, 95% interval excluding zero | Pending |
| Mixed-task p95 regression at most 5% | Pending |
| Settled waste at most 20% | Pending |
| Native hook delivery | Unverified; Codex trust restriction remains visible |
| Live API-key routing | Unverified for both clients |

No enablement decision can be made until the pending per-client measurements complete. A correct smoke is not evidence of saved time.

## Historical core regression

The existing MCP predictor benchmark ran 240 records with 400 ms of injected tool latency. Against no prediction, current Speculate reduced aggregate tool wait by 6.01% and left 35.96% of issued speculative calls unused. Those numbers validate continuity of the existing core at its recorded snapshot. They do not measure native clients, hooks, the model proxy, stream observation, or improvement over Arm B, and they must not be used as the new observer result. See the [core regression artifact](observer-core-regression-results.json).

## Compatibility and recovery limits

Claude exposes flat MCP names and schemas to the model transport. Codex's installed native default exposes only an opaque custom executor, which remains unchanged and observation-only. Prompt and learned-transition prediction can still use live registered MCP routes on both clients.

Speculation requires the host's exact permission and a read-only tool annotation. Unsupported policy, hook trust, configuration precedence, provider routing, or Codex alias encoding causes the affected capability to abstain or fall back; it never grants permission. Reports remain aggregate and omit raw session material.

Failure handling is conservative: provider/client retry remains native, partially forwarded model requests are not automatically replayed, and a fresh launch creates fresh temporary routing state. Task 9 recovery fixes and verification are still in progress, so recovery is not marked passed here.

Supporting evidence: [native routing](observer-native-routing.md), [native tool shapes](observer-native-tool-shapes.md), [native transfer results](observer-native-transfer-results.json), and [compatibility](observer-compatibility.md).
