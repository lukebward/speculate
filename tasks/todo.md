# Durable Usage Stats

- [x] Approve design
- [x] Write implementation plan
- [x] Persist and aggregate usage snapshots
  - [x] Add failing default-directory and recorder tests
  - [x] Expose the state directory and implement durable snapshots
  - [x] Add failing validation and aggregation tests
  - [x] Implement strict report validation and aggregation
  - [x] Project recorder updates onto the approved counter schema
  - [x] Run focused tests, build, full suite, and self-review
- [x] Format human and JSON stats
  - [x] Add failing parser, formatter, empty-state, and JSON tests
  - [x] Implement argument parsing and deterministic human formatting
  - [x] Implement injectable command execution
  - [x] Run focused tests, build, full suite, and self-review
- [x] Record MCP usage
  - [x] Add a failing Metrics durable-counter notification test
  - [x] Publish only durable counter changes from Metrics
  - [x] Add a failing real-proxy persistence test
  - [x] Inject, close, and construct the MCP usage recorder
  - [x] Run focused tests, build, full suite, and self-review
- [x] Record CLI usage
  - [x] Add a failing asynchronous cache-waste notification test
  - [x] Centralize waste increments behind a failure-safe observer
  - [x] Add a failing durable daemon usage test
  - [x] Normalize daemon counters and close the recorder once
  - [x] Disable real state writes in unrelated daemon/client tests
  - [x] Run focused tests, build, full suite, and self-review
- [x] Register the command and preserve zero-write trials
  - [x] Add failing real-CLI human, JSON, and argument-error tests
  - [x] Register only top-level `stats` and `--json`
  - [x] Add a failing trial usage-disable environment test
  - [x] Pass the usage-disable flag to the trial client
  - [x] Document durable versus live stats and snapshot privacy
  - [x] Run focused tests, build, full suite, diff check, and self-review
- [x] Run focused tests, full tests, and build
- [x] Review the final diff
- [x] Apply final review fixes
  - [x] Preserve ignored-record visibility with zero valid sessions
  - [x] Account for expired cache entries replaced before sweep
  - [x] Escape control characters only in human workspace output
  - [x] Remove the unrelated local-worktree ignore
  - [x] Run focused tests, build, isolated full suite, diff check, and self-review

## Review

- Task 1 persists owner-only aggregate session snapshots and reports validated totals by source and workspace.
- Focused tests pass 20/20 and the TypeScript build passes.
- The full suite passed 453/453.
- Task 2 formats cumulative human and exact JSON reports behind an injectable command runner.
- Task 2 focused tests pass 21/21, the TypeScript build passes, and the full suite passes 465/465.
- Task 3 records only cumulative MCP counters through Metrics and closes the durable recorder with proxy shutdown.
- Task 3 focused tests pass 33/33, the TypeScript build passes, and the full suite passes 467/467.
- Task 4 records normalized CLI daemon counters without changing daemon-local stats output.
- Task 4 focused tests pass 22/22, the TypeScript build passes, and the full suite passes 470/470.
- Task 5 registers only `speculate stats [--json]`, preserves trial zero-write behavior, and documents durable versus live stats.
- Task 5 focused tests pass 102/102, the TypeScript build passes, the full suite passes 472/472, and `git diff --check` passes.
- Final review fixes retain ignored-record visibility, count pre-sweep cache replacement waste, escape human-only workspace controls, and remove the unrelated worktree ignore.
- Final focused stats tests pass 14/14, cache tests pass 9/9, the TypeScript build passes, the isolated full suite passes 475/475, and text/control-byte/diff checks pass.

# v0.10 — session-start priming + filesystem/slack profiles

Rebased onto the durable-usage-stats work after it landed on main (the
receipts feature was implemented in parallel; main's version kept — it also
covers the CLI daemon).

- [x] Learner opener tracking: first 3 read-eligible asks per server per
      session, constant-args-only, persisted with defensive deserialization
- [x] `Predictor.sessionStart` through the shared feedback/dedupe/cap tail
- [x] Proxy records openers and fires them at start (mode-gated, fail-open)
- [x] filesystem + slack vetted profiles, validated against bundled mocks
      mirroring the reference servers; registered for fingerprinting
- [x] Unit tests: openers (10), filesystem profile (8), slack profile (6)
- [x] Scenario tests: S9 priming curve 215ms → 219ms → 5ms; S10/S11 both
      ~60% hit / ~58% cut vs off; S12 rewritten against the landed stats CLI
      (accumulation via `speculate stats --json`; snapshots aggregate-only)
- [x] DESIGN §13.15, README, version 0.10.0; full suite green
