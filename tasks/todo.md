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
- [ ] Task 10: Benchmarks, documentation, final review and push main

## Context-aware review evidence

- Tasks 1–6 core snapshot `9fa3064`: build passed; full suite passed 1,197 tests with 8 skipped (84.05s). Launcher and final branch verification remain pending.
- Task 7 snapshot `f65e38f`: build passed; full suite passed 1,257 tests with 8 skipped (84.69s). Actual Claude and Codex native-account launcher smoke passed expected final response, completed turn, active proxy mode, and zero relay failures. Configuration-parsing and ownership findings were fixed and approved through `d3391a7`. Native MCP transfer passed both clients in all three modes; observer performance remains pending.

- Task 8 snapshot `1514c8d`: 10 paired real MCP consumption tests passed; focused gate passed 176 tests and build. Independent review approved.
- Task 9 snapshot `b39ced7`: build passed; full suite passed 1,298 tests, skipped 8, and failed one permission-classification assertion. Recovery review also requires actual owner queue/inflight/cache revocation after tracking loss; both findings are assigned and Task 9 remains incomplete.
- Task 10: existing repeated core benchmark completed with historical issue/use/miss counts preserved. Experimental documentation is drafted; new observer benchmark and final integration remain pending.

- Task 9 final snapshot `3755e34`: independent review approved; build and TypeScript checks passed; full suite passed 1,300 tests with 8 skipped (84.31s). Tracking loss revokes queued, in-flight, and ready owner work; permission fixtures are isolated from ambient managed settings.

- Final production review reopened three paths: Claude ordinary prediction authorization, strict MCP source isolation, and cache invalidation for received native/unknown writes. Scoped fixes and regression coverage are required before push.

- Final production snapshot `e6bf986`: independent review approved after narrowly scoped permission, strict-source, native-write overlap, analysis-budget, and async supersession fixes. Build and strict TypeScript passed; full suite passed 1,362 tests with 8 skipped in 84.54s. Full 1,000-record benchmark is running on that immutable source snapshot.

- Full observer benchmark completed at `e6bf986`: all 1,000 records, zero correctness/consent/isolation violations and no extra predictor model calls. Relay p95 and mixed-p95 gates passed; median speedup and waste gates failed for both clients. Raw release verdicts remain `remove`; the approved plan permits retaining the source-only implementation as experimental. No thresholds or implementation were tuned on held-out results. Results and compressed aggregate records are documented; final documentation verification and normal main push remain.
