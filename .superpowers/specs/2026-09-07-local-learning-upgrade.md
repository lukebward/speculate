# Local learning upgrade

Approved direction: the user authorized autonomous implementation, testing, and release only if the upgrade demonstrates a clear benefit. Report before/after times, hits, waste, and limitations. This document makes the agreed direction concrete without another approval checkpoint.

## Product contract

- Prediction remains local, automatic, and generic. No service names, workflow-specific logic, or domain examples in production learner code or comments. GitHub/Linear/CI/PR scenarios belong in tests and benchmark fixtures only.
- Learn recurring sequences with changing identifiers, result ordering, and optional intervening calls. Preserve exact argument matching, read-only eligibility, budgets, invalidation, and existing admission behavior.
- Persist compact learned descriptors, evidence, and aggregate statistics by default. Raw call/result history remains session-local and bounded. There is no raw transcript archive or external training service.
- Secret filtering covers learned literals, imported legacy state, merged state, atomic temporary files, and diagnostics. Filtering is a reduction in exposure, not a guarantee that arbitrary secrets can always be recognized.
- Memory is outside repositories by default, bounded by retention and byte limits, inspectable, and clearable without changing authentication or host wrapping configuration.
- Existing stats explain activity, learning coverage, useful predictions, misses, waste, and estimated benefit without pretending estimated tool wait is measured total task time.
- Node >=18 production compatibility and Linux/macOS/Windows support; no external model dependency.

## Learner design

Extend argument source descriptors with optional `sourceTool`: resolve an argument or parsed-result path from the most recent earlier call to that tool on the same server. Keep at most eight calls per server in memory and reset on existing stale/out-of-order history boundaries. Observe targets only after training from preceding history, preventing future-answer leakage. Persist descriptors and evidence, never the retained calls. Old states remain readable and new descriptors fail closed when their source is absent. Preserve existing source scoring and candidate caps. Evaluate bounded boolean/nullness context features separately if needed; do not add authored string predicates or workflow rules.

## Persistence and diagnostics design

Apply a centralized generic sanitizer before serialization and after legacy import/merge; discard unusable sources instead of replacing arguments with redaction placeholders. Reject sensitive argument names and recognizable credential values, including transformed literal fragments. Preserve valid structural sources and ordinary identifiers. Every removal contributes aggregate diagnostics only. Exclude raw exception text that can repeat paths or private values in persistence failures.

Add configurable `persistence.retentionDays` (default 30) and `persistence.maxBytes` (default 8388608 per scoped state). Prune expired entries and deterministically trim weak/old entries to fit. Refuse oversized reads before allocation. Maintain atomic writes and concurrent merge behavior. Expired/oversized/corrupt state degrades to cold learning, never a broken real call.

Add `speculate memory` (human/JSON inventory) and `speculate memory clear` for managed learning/usage records. Respect explicit configured state paths through config resolution; do not remove unknown files, auth stores, wrapping state, or follow symlinks. Document active-session behavior and prevent active sessions resurrecting cleared history if feasible through a generation marker.

## Validation and release gates

Baseline is commit 1371efe (v0.18.0), isolated at ../speculate-baseline. Candidate is this worktree. The same benchmark driver and fixtures run both; separate per-arm persisted state, identical seeds and chronological sessions, and no target information leaked before predictions.

1. All regression tests and build pass, including Linux/macOS/Windows CI. Secret canaries do not appear in produced state/temp/diagnostic artifacts. Legacy migration, bounds, clearing, and malformed states are covered.
2. Warm held-out repeated-workflow fixtures show at least 15% lower mean measured tool wait and 10 percentage points higher useful hit/join rate versus baseline across at least two varied workflows. Check per-workflow outcomes rather than only pooled averages.
3. Wasted calls per useful hit do not worsen, or stay <=1.0. Unpredictable negative controls add no material speculation (at most one additional speculative call per 100 requests versus baseline). Correct outputs match speculation-off exactly.
4. Existing offline workflow recall@3 falls by no more than 0.01. Retain cold-session results and control results in the report, including regressions.
5. Run existing real filesystem/Git and hosted read-only benchmarks where available. Clearly label injected-latency fixtures versus real hosted measurements. Time claims apply to tool waits; no unmeasured total-task speed claim.
6. Review actual diff and resolve important findings. Release via existing trusted-publishing tag workflow only after evidence meets the gates; verify registry version and installation afterward.

If a gate fails, investigate and revise within the agreed scope. Do not publish a weaker result or relax gates to force a release.
