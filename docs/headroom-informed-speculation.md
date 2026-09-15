# Headroom-informed speculation

Speculate uses Headroom as a reference for deciding when an optimization earns its cost. Speculate's optimization is still prefetching read-only MCP results: predict a useful call early, let the client consume the exact result, and learn from consumed versus unused work. Claude Code and Codex use the same admission behavior, with separate feedback identities and separately reported evidence.

## What transfers from Headroom

The reference is Headroom commit [`9f32800b`](https://github.com/headroomlabs-ai/headroom/commit/9f32800b86ad277201c2a2ce75192534f8e94b03), inspected on 2026-09-15.

| Headroom mechanism | Speculate adaptation |
| --- | --- |
| TOIN records downstream retrieval feedback by tool signature. | Attribute consumed and wasted speculative work to a stable tool destination and signal source. |
| Output-savings measurement distinguishes conversation holdouts from modeled estimates. | Keep synthetic opportunity, native compatibility, and measured native speedup as separate evidence. |
| Rollout availability and qualification are explicit. | Keep the observer experimental until its existing performance and waste gates pass for each client. |

Sources: [TOIN collector](https://github.com/headroomlabs-ai/headroom/blob/9f32800b86ad277201c2a2ce75192534f8e94b03/headroom/telemetry/toin.py), [conversation holdout estimator](https://github.com/headroomlabs-ai/headroom/blob/9f32800b86ad277201c2a2ce75192534f8e94b03/headroom/proxy/output_savings.py#L394-L440), and [rollout qualification](https://github.com/headroomlabs-ai/headroom/blob/9f32800b86ad277201c2a2ce75192534f8e94b03/docs/content/docs/runtime-rollouts.mdx#L157-L174).

There is a useful implementation caveat: Headroom collects and publishes TOIN recommendations, but its [Rust loader](https://github.com/headroomlabs-ai/headroom/blob/9f32800b86ad277201c2a2ce75192534f8e94b03/crates/headroom-core/src/transforms/recommendations.rs#L1-L22) says the dispatcher does not yet consume them. This change follows the selective-feedback principle using Speculate's existing working feedback path; it does not assume Headroom has validated a complete adaptive loop or copy its constants.

## Selective observer admission

Previously all observer predictions from one client and signal source shared a feedback bucket. An unsuccessful destination could suppress other destinations, while a successful one could hide their waste. Observer hit/waste history affected an abrupt cutoff, but did not continuously reduce the adaptive utility score when the normal calibrator was present.

Observer feedback now uses an internal digest of the client, source, registered host server alias, exposed tool, and upstream tool. It stays stable when routes register again and uses the existing persisted counters. Arguments, prompts, results, random route IDs, and incoming candidate IDs are excluded. Different learned transitions to the same destination intentionally share a bucket.

Admission combines signal confidence, existing smoothed operational effectiveness, and the existing conservative tool-latency estimate. Repeated unused work lowers expected utility before the existing hard waste cutoff. With the production calibrator, a destination with no terminal outcomes keeps its existing confidence; the new weighting starts after consumption or waste. Ordinary next-call calibration and evaluation are unchanged. Legacy source-wide feedback is retained in its original bucket rather than guessed into the new destination buckets.

Both ready hits and in-flight joins count as consumed work. Expiry, invalidation, abandonment, and speculative errors follow the existing waste accounting. Permission checks, exact argument matching, read-only requirements, cache ownership, and host fallback remain authoritative.

This remains a count-based usefulness model. It does not yet learn the actual milliseconds of head start per observer rule, and a suppressed rule has no new exploration mechanism beyond the existing feedback decay. A useful result arriving only a few milliseconds before demand can therefore look better to admission than its realized savings justify.

## What the earlier replay established

The [original 1,000-record replay](observer-results.md) and its failed release gates remain unchanged. Its workload had two important coverage limits:

- Each workflow made only one synthetic model response, for its first tool. Training and held-out arguments had no useful result-to-next-argument relationship, and the recorded transition issue count was zero.
- Ordinary completed-stream predictions had roughly 12–16 ms of head start. Longer reasoning before arguments exist cannot help this source; it can help an already-issued intent or transition prediction.

The task clock also included per-record fixture provider/relay startup and teardown, plus fixed sleeps in hook arms. Those setup and settlement costs limit how its task-wall comparisons transfer to a persistent daily session. The negative result is evidence about that fixture, not a general measurement of multi-turn opportunity.

The supplemental multi-turn diagnostic uses independently generated training and held-out entities, result-derived later arguments, explicit synthetic model-turn latency, and separate post-argument dispatch lag. Fixture lifecycle stays outside task timing. Results are reported separately for both client adapters; Codex flat Responses stream fixtures do not establish native opaque-executor stream coverage.

Parameters declared before measurement:

| Parameter | Value |
| --- | --- |
| Workflows | Warm three-turn cross-server chain; cold two-turn unpredictable case |
| Matrix | 2 workflows × 3 repetitions × 2 clients × 5 arms = 60 records |
| Untimed warm training | 4 episodes with independent entities |
| MCP tool latency | 120 ms during both training and holdout |
| Synthetic model latency | 80 ms per turn |
| Dispatch lag after complete arguments | 8 ms |

Training uses the same tool latency as holdout so it does not teach the persisted latency model that these destinations are cheap. Earlier zero-latency training was rejected before measurement for that reason.

Run from the recorded source checkout:

```bash
npm run build
SPECULATE_BENCH_SOURCE_COMMIT=$(git rev-parse HEAD) npm run bench:observer:multiturn -- --output observer-multiturn-results.json
```

The source tag is supplied by the caller; use a clean checkout of that commit. Timing varies by machine.

## Measured diagnostic

The complete run at `d67218121e85bcd9d540304564472aa6fa91fb07` finished in 164.41 seconds. All 60 records passed correctness checks, with identical provider request and tool-result digests in all 12 paired blocks. There were 150 demanded and 150 physical MCP calls, 66 speculative issues consumed through in-flight joins, and zero unused speculative calls. No ready hits occurred: these predictions overlapped part of the tool wait.

The warm cross-server chain improved over B, the existing predictor with observers off:

| Client fixture | C: hooks | D: request observation | E: completed-stream observation |
| --- | ---: | ---: | ---: |
| Claude | 40.57% | 38.57% | 40.77% |
| Codex | 41.23% | 42.06% | 40.42% |

Values are the median of three paired task-wall improvement ratios per cell, not ratios of unpaired medians. They are descriptive observations without confidence intervals. Each C/D/E cell consumed three intent predictions and six learned-transition predictions across the three repetitions. The early signals supplied the warm-chain benefit; stream observation added no further issued work there.

In the cold unpredictable case, C and D issued no predictions and had small timing differences around B. E consumed six completed-stream predictions per client, with paired median improvements versus B of 3.13% for Claude and 2.66% for Codex. That small overlap comes from the declared 8 ms dispatch lag. The Codex stream result applies to the flat Responses fixture, not the installed native opaque executor.

The first run stopped after 156.03 seconds on an MCP request timeout before writing an artifact. A coordinate-by-coordinate probe then completed all 60 records, and the unchanged official command succeeded. The timeout did not reproduce; its cause remains unestablished. No source, parameters, or thresholds changed between these attempts.

The [complete diagnostic artifact](observer-multiturn-results.json) preserves every aggregate record, execution order, exact arm definitions, and parameters. Its SHA-256 is `1157325c885ecb5ff1d0443a8f075af2bcc1f1ef3c7cfbf1b7a14b084184392b`. The [verification record](observer-adaptive-verification.json) includes the failed attempt, successful rerun, unchanged historical artifact hashes, and the passing build, TypeScript, review, and 1,383-test suite with 8 skipped.

This diagnostic characterizes an opportunity under declared synthetic timing. It compares observer modes on the updated implementation; it does not isolate the speed effect of the new feedback weighting against the previous commit. Native day-to-day speedup still requires matched tasks across enough independent Claude Code and Codex sessions. No release threshold is changed on the basis of the diagnostic.
