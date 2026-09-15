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

# Plugin wrap — the §13.23 fifth row (2026-08-05)

- [x] Verify the mechanism against the real CLI (Claude Code 2.1.222,
      isolated CLAUDE_CONFIG_DIR): installed_plugins.json v2 layout,
      enabledPlugins, cache root vs directory-source root, the
      disabledMcpServers per-project switch gating every connect path
- [x] Design spec: .superpowers/archive/specs/2026-08-05-plugin-wrap-design.md
- [x] Discovery: pluginServers + disabledMcpServers on ClaudeConfigView,
      fail-closed interpolation (13 tests)
- [x] Wrap/unwrap: copy-then-disable with rollback, teardown, drift
      refresh, adoption, /mcp switches honored both directions, off with
      and without state, sync + hash coverage, status, auth (14 tests)
- [x] DESIGN.md §13.26 (the invariant amendment, named), README
- [x] Full suite green (30 files, 716 passed), build green
- [x] Live end-to-end round trip against the real host: on wraps and
      disables, off restores exactly
- [x] Adversarial review findings applied (6 reviewers, 32 findings, 20
      confirmed — marker-based adoption, measured enabledPlugins semantics,
      loud repair, mode-preserving refresh, redaction and robustness fixes)

# Auto-wrap on GUI-launched hosts (2026-08-05)

- [x] Measure: command hooks run through a shell (|| chain fired on the
      real host); SessionStart matcher matches source, alternation works
- [x] POSIX hook command = baked-interpreter || PATH-node chain; Windows
      keeps single bare-node (PS 5.1 has no ||)
- [x] Bake --claude-bin behind `--`; sync uses it only while it exists;
      resolveClaudeBin POSIX fallbacks (~/.claude/local, brew, /usr/local,
      ~/.local/bin)
- [x] Matcher widened to startup|resume|clear (v0.12 choice reversed with
      measurements); staleness check versions matcher + command
- [x] Heartbeat in the wrapper + status warns when an install >1 day old
      has no heartbeat since installedAt
- [x] Live: refreshed hook fired in a real session, heartbeat stamped;
      prior session's hook had auto-wrapped the plugin server unattended
      and the adoption pass recovered its lost record in production
- [x] DESIGN.md §13.27, README; full suite green

# Upstream seam proposal (2026-08-05)

- [x] Verified the shipped host (2.1.222) has no wrapper/middleware seam
      under any plausible name; plugin capability surface is
      commands/agents/hooks/mcpServers/skills only
- [x] docs/upstream/mcp-wrapper-seam.md — fileable issue body for
      anthropics/claude-code: field report of the six mechanisms the
      missing seam forced, two API shapes (settings key / plugin
      capability), safety story (sniffing pass-through, direct fallback,
      consent unchanged), references into DESIGN.md measurements
- [ ] File it (needs a human go — public issue under the repo owner's name)

# status goes machine-wide (2026-08-05)

- [x] `speculate status` = global view: auto-wrap health + heartbeat,
      logins, user-scope servers once, one line per project (wrapped /
      plugin copies / NOT wrapped / opted out / directory missing),
      unlisted count, no network probes
- [x] `speculate status <path>` = the per-project deep view, unchanged
- [x] Cheap pre-filter so hundreds of serverless projects cost existsSync,
      not config parses; dead-path projects classified from raw entries
- [x] Verified live against the real host; suite green; DESIGN §13.28

# Context-aware speculation (2026-09-14)

- [x] Fetch and inspect current main; preserve v0.22 integrations
- [x] Set up isolated worktree and Sol workers
- [x] Task 1: Compatibility fixtures/baseline (Sol review approved; native account routing spike passed both)
- [x] Task 2: Live route bridge and candidate ingress (Sol review approved after permission/state corrections)
- [x] Task 3: Session cross-server learner (Sol review approved after retained-state/close corrections)
- [x] Task 4: Claude transparent model transport (Sol review approved after lifecycle fixes; 47 focused tests)
- [x] Task 5: Codex Responses and WebSocket transport (Sol review approved; 72 focused tests; native relay smoke passed both)
- [x] Task 6: Intent and completed-stream prediction (Sol review approved; 227 focused tests plus 77 callback-fix tests)
- [x] Task 7: Symmetric session launch and diagnostics (Sol review approved; native routing and wrapper startup verified)
- [x] Task 8: Both clients consume existing registered MCP results (Sol review approved; paired ready-hit/invalidation/permission tests pass)
- [x] Task 9: Recovery/isolation verification (final production review approved at e6bf986; 1,362 tests passed, 8 skipped)
- [x] Task 10: Benchmarks, documentation, final review and push main

## Context-aware review evidence

- Tasks 1–6 core snapshot `9fa3064`: build passed; full suite passed 1,197 tests with 8 skipped (84.05s). Launcher and final branch verification remain pending.
- Task 7 snapshot `f65e38f`: build passed; full suite passed 1,257 tests with 8 skipped (84.69s). Actual Claude and Codex native-account launcher smoke passed expected final response, completed turn, active proxy mode, and zero relay failures. Configuration-parsing and ownership findings were fixed and approved through `d3391a7`. Native MCP transfer passed both clients in all three modes; observer performance remains pending.

- Task 8 snapshot `1514c8d`: 10 paired real MCP consumption tests passed; focused gate passed 176 tests and build. Independent review approved.
- Task 9 snapshot `b39ced7`: build passed; full suite passed 1,298 tests, skipped 8, and failed one permission-classification assertion. Recovery review also requires actual owner queue/inflight/cache revocation after tracking loss; both findings are assigned and Task 9 remains incomplete.
- Task 10: existing repeated core benchmark completed with historical issue/use/miss counts preserved. Experimental documentation is drafted; new observer benchmark and final integration remain pending.

- Task 9 final snapshot `3755e34`: independent review approved; build and TypeScript checks passed; full suite passed 1,300 tests with 8 skipped (84.31s). Tracking loss revokes queued, in-flight, and ready owner work; permission fixtures are isolated from ambient managed settings.

- Final production review reopened three paths: Claude ordinary prediction authorization, strict MCP source isolation, and cache invalidation for received native/unknown writes. Scoped fixes and regression coverage are required before push.

- Final production snapshot `e6bf986`: independent review approved after narrowly scoped permission, strict-source, native-write overlap, analysis-budget, and async supersession fixes. Build and strict TypeScript passed; full suite passed 1,362 tests with 8 skipped in 84.54s. Full 1,000-record benchmark is running on that immutable source snapshot.

- Full observer benchmark completed at `e6bf986`: all 1,000 records, zero correctness/consent/isolation violations and no extra predictor model calls. Relay p95 and mixed-p95 gates passed; median speedup and waste gates failed for both clients. Raw release verdicts remain `remove`; the approved plan permits retaining the source-only implementation as experimental. No thresholds or implementation were tuned on held-out results. Results and compressed aggregate records are documented; final evidence/documentation review and strict documentation build passed. The normal main push was verified at `981a6ce`.


## Post-push platform verification

GitHub run `34926910149` passed Linux but exposed one macOS and seven Windows assertions. The source delivery is on main; platform verification is reopened until these are resolved.

- [x] Diagnose and fix the persistent-connection and provider-cancellation test synchronization failures.
- [x] Diagnose and fix Windows launcher, benchmark-launcher, and hook-recovery failures without weakening coverage.
- [x] Review the scoped corrections and run the affected tests and build.
- [x] Push the corrections normally and verify Linux, macOS, Windows, and docs CI.

- Post-CI corrections at `894a8e3` passed independent scoped review, build, strict TypeScript, and the full suite: 1,365 tests passed, 8 skipped, 84.13s. Native invocation reuses existing platform helpers; timing-sensitive fixtures now synchronize through explicit events. Benchmark timing paths and recorded thresholds are unchanged.

- Final code delivery `c6a588e` is verified on main. GitHub CI run `34927756544` passed Linux, macOS, and Windows, including native Codex integration checks; docs run `34927756534` passed build and deployment.


# Headroom-informed adaptive speculation (2026-09-15)

Goal: adapt Headroom's selective, usage-informed optimization and evaluation practices to useful speculative tool execution, with Claude Code and Codex as equal clients.

- [x] Pin and inspect Headroom's implemented feedback, selectivity, and evaluation mechanisms.
- [x] Audit current observer admission and the replay's day-to-day representativeness.
- [x] Record a concrete bounded design, its Headroom sources, and unchanged correctness/permission requirements before implementation.
- [x] Implement the selected production adjustment and meaningful regression tests.
- [x] Add a focused multi-turn evaluation that preserves the prior replay and distinguishes synthetic opportunity from native benefit.
- [ ] Independently review, verify, document measured results, and deliver the changes.

Research is limited to 15 minutes per agent. Reuse existing executors, cache ownership, admission, and client adapters. The original 1,000-record results remain historical evidence; no thresholds will be changed to make those results pass.


## Bounded design and implementation plan

Headroom reference: `9f32800b86ad277201c2a2ce75192534f8e94b03`. Its TOIN collector groups downstream retrieval feedback by tool signature, and its measurement separates conversation holdouts from modeled savings. Its Rust dispatcher does not yet consume the published TOIN recommendations. The transferable principle here is selective optimization based on actual consumption; Speculate retains its existing online MCP admission and cache.

1. Production owner: scope internal observer feedback IDs by client, signal source, registered host alias, exposed tool, and upstream tool using a bounded digest. Replay IDs, route generations, prompts, arguments, and results must not enter this identity. Use existing operational hit/waste effectiveness in observer utility scoring, once only; preserve ordinary next-call calibration, permission checks, exact cache identity, and feedback persistence format. Test selective suppression before the hard cutoff, stable identities across registration, persistence, and ordinary predictor isolation.
2. Evaluation owner: add a separately versioned synthetic multi-turn diagnostic with actual result-derived next arguments and independently generated training/holdout entities. Exercise both client adapters, early intent/transition opportunity, completed-call dispatch lag, and an unpredictable negative. Provider/relay lifecycle stays outside task timing. Predeclare parameters and retain source attribution, correct result verification, and settled waste. This diagnostic does not replace the original replay or qualify a release.
3. Parent: document the exact adaptation and old replay's demonstrated limitations, then run build, type checks, the relevant/full suite, and the bounded diagnostic on a fixed source snapshot. Independent reviewer checks the production diff and evidence. Commit and push normally to the already-authorized main only after review and verification; check platform CI.

Existing observer defaults remain experimental. Compression, a new offline policy publisher, native transcript collection, and production holdout routing are outside this bounded implementation. Actual lead-time learning remains a documented limitation of the existing count/latency model.


Pre-measurement diagnostic parameters: 2 workflows × 3 repetitions × 2 clients × 5 arms = 60 records; warm training has 4 untimed episodes; all actual MCP calls use 120 ms injected latency; model turns use 80 ms and post-complete-arguments dispatch uses 8 ms. Training latency was changed from zero before measurement to avoid teaching the persisted latency model an artificial fast-tool distribution. The harness must use the actual wrapper, admission, executor, and MCP client path. No cache simulation is accepted as production evidence.

Production focused verification: 90 tests passed, including both-client feedback identity/persistence/recovery and owner-ingress tests. Review refined cold behavior to preserve its prior and fractional decayed feedback to recover toward neutral; ordinary prediction scoring and the persistence schema remain unchanged.

Final harness source review approved. Build and 44 focused benchmark tests passed; the harness uses cumulative real-result history, identical paired request schemas, exact response-byte checks, actual MCP owners, and settled source accounting. Full suite and immutable-source timed diagnostic remain pending.

Final pre-measurement verification: strict TypeScript passed; full suite passed 1,383 tests with 8 skipped in 84.42 seconds. Production and harness source reviews approved. The next commit is the immutable source for the supplemental diagnostic.

The first immutable-source diagnostic at `d672181` stopped after 156.03 seconds with `MCP error -32001: Request timed out` before producing an artifact. The failed attempt is retained in verification metadata; bounded diagnosis is in progress before any rerun. Source and parameters were not changed during the attempt.

The unchanged diagnostic completed at `d672181` in 164.41 seconds: 60/60 records, 12/12 paired blocks with identical request/result digests, 150 demanded and physical MCP calls, 66 speculative issues consumed through joins, zero waste and correctness failures. Warm C-vs-B paired median improvement was 40.57% for Claude and 41.23% for Codex. The cold case had little benefit. The initial timeout remains unreproduced and is retained in the verification record. Strict docs build passed with the final reports. Independent final evidence review approved the arithmetic, hashes, scope, privacy, and timeout history. Normal push/CI are pending.

Delivery `0769f59` was pushed normally to main. CI `34973817927` passed Ubuntu and macOS, including native Codex checks; docs `34973817549` passed build/deployment. Windows hit the two new integration tests' 15-second Vitest deadline. A scoped test-only increase to 30 seconds is being verified; measured code, workloads, assertions, and release thresholds remain unchanged.

The CI correction changes only the integration-test deadline from 15 to 30 seconds. Independent review approved it; the focused suite passed 6/6 tests in 11.83 seconds. The corrected push and platform CI are pending.
