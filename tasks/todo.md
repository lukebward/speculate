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
- [x] Independently review, verify, document measured results, and deliver the changes.

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

Completed delivery: `f796513` is verified on main. CI [34974445299](https://github.com/lukebward/speculate/actions/runs/34974445299) passed Ubuntu, macOS, and Windows, including full tests, TypeScript, and native Codex checks. Docs [34974445314](https://github.com/lukebward/speculate/actions/runs/34974445314) passed strict build and deployment. The final follow-up only records these results; production and benchmark source remain identical to the measured `d672181` snapshot.


# Architecture cleanup and release (2026-09-15)

**Goal:** Remove obsolete code left by the architecture changes, document the released product clearly, and publish the verified release.

**Architecture:** Keep the existing MCP wrapper, per-server predictor, session observer, and authoritative admission/execution/cache path. Remove only paths proven unused or superseded. Claude Code and Codex remain equal supported clients; observer status and performance claims stay evidence-based.

**Execution:** Astra coordinates three GPT-5.6 Sol workers. The user authorized planning, cleanup, documentation, push, and release without another approval step. Reuse the clean isolated checkout; preserve the original checkout and historical benchmark artifacts.

- [x] Audit runtime callsites, public entrypoints, compatibility paths, and candidate removals.
- [x] Audit tooling, package contents, versioned manifests, and the existing release workflow.
- [x] Find and apply a technical-writing skill; audit README and current setup/design documentation.
- [x] Record the concrete removal list and assign disjoint code and documentation edits.
- [x] Remove proven obsolete code and update affected coverage; keep behavior-preserving changes small.
- [x] Rewrite README around installation, Claude/Codex usage, architecture, limitations, and links; update release notes and version metadata.
- [x] Independently review the removals and documentation; run build, TypeScript, full tests, strict docs build, and packed-package smoke checks.
- [x] Push main normally and verify platform CI.
- [x] Create the version tag and publish through the repository's trusted npm workflow; publish concise GitHub release notes and verify registry/tag/release contents.

## Audit and release constraints

- Audit workers have 15 minutes each to identify evidence-backed changes. A code path is not obsolete merely because it predates the observer: off mode, ordinary per-server learning, native client adapters, and exact permission/cache ownership remain active.
- Preserve historical benchmark JSON and measured source tags. Do not rerun or tune long performance experiments for a cleanup.
- Do not delete public compatibility surfaces, migrate persisted state, rename modules, add dependencies, or consolidate large files without evidence that the cleanup requires it.
- Use the established release workflow and the next appropriate unpublished version, verified against tags and the npm registry. Prepare the exact package and release notes before publishing; never overwrite an existing tag or npm version.
- Keep experimental capability labeling. A package release does not establish native speedup or override the original release-performance gates.
- Agents do not commit, push, tag, or publish. The coordinator owns integration and publication after verification.

## Concrete implementation plan

1. Runtime worker removes the unreachable parser-miss wrapper, unused retired-profile constant, three unused profile-era types and fixture, and a test-only memory-generation wrapper. Keep the public stats field and live compatibility loaders.
2. Packaging worker fixes source/build resource resolution for both native observer adapters and verifies real hook delivery from compiled layouts. No runtime dependency or maintained benchmark/demo removal is supported by the audit.
3. Documentation worker rewrites README and current setup/command/design pages using the pinned technical-documentation skill, with installed 0.23.0 commands and equal client coverage. Historical evidence remains intact.
4. Coordinator investigates the demonstrated Windows CI failures, updates all three authoritative version manifests, and verifies the complete package before normal main push and trusted publication.

Windows diagnosis: CI job 104400289236 recorded the literal-argv shell fixture completing after 27.2 seconds against Vitest’s default 5-second deadline, with no functional assertion failure; its native hook has a 50-second contract. The test now bounds the child at 50 seconds and test at 60. S2/S9 timing failures overlapped other subprocess-heavy suites; CI will run the unchanged scenario assertions in a separate step after other tests. This isolation hypothesis still requires the actual Windows run to validate it.

Runtime cleanup removed 87 net lines across its 11 files. All core paths, dependencies, benchmarks, and migration compatibility remain active. Packaging review adds the source/build resource lookup and a real compiled-hook delivery regression for both clients. The complete non-scenario suite passed 1,372 tests with 8 skipped; strict unused-code TypeScript passed. Independent workflow review approved test isolation without threshold or coverage changes. Documentation review corrected managed-versus-explicit-config defaults and removed an unsupported TTL-cap claim.

## Pre-release review

Build and strict unused-code TypeScript passed. The full suite passed 1,384 tests with 8 skipped: 1,372 in the main batch and all 12 timed scenarios separately. Strict MkDocs passed. Independent runtime, package, workflow, and documentation reviews approved after correcting permission wording: host authorization is tool-route scoped; result reuse separately requires exact arguments. Historical benchmark artifacts are unchanged.

The 0.23.0 tarball has 59 files (244,903 bytes packed), contains the runtime and both hook resources, and excludes development/benchmark artifacts. Isolated installed CLI/version/help and real MCP list/call checks passed on Node 18.20.8 and 22.14.0. Both installed observer hooks delivered the exact expected events on Node 18 and 22. The tarball compiled files match the verified build. The packed-root regression initially found only a macOS test path mismatch (`/tmp` versus `/private/tmp`); canonicalizing the test input resolved it, and the exact packed-root regression passed. No runtime change was needed. Tarball SHA-256: `344fa55be7ff70f7204e18ba819854d7f77625e93e78d0e57645d88fab4dd577`.

Main push, platform CI, and registry/GitHub publication remain the delivery gates after this source commit.

The first release-candidate CI at `a8421d0` passed Linux and Windows, including isolated scenario and native Codex checks; docs deployed successfully. macOS exposed a race in the new installed-hook test: its parent supplied piped stdin after spawning a hook whose intentional deadline is 20 ms. A controlled 60 ms parent delay reproduced silent expiry; preloading the same payload into inherited stdin resolved it. The test harness now opens its input before spawning. Production files and the verified tarball are unchanged; the corrected packed-root test and focused hook suite passed. A new three-platform run is required before tagging.

## Completed delivery

Release source `55070024effd534374246752f76ef7d7a764d79f` is on main and tagged `v0.23.0`. [Platform CI](https://github.com/lukebward/speculate/actions/runs/34989119096) passed Linux, macOS, and Windows, including full tests, isolated scenarios, and native Codex checks. The unchanged Windows native fixture initially failed after 30 seconds with a locked-directory cleanup error that masked the primary failure; timing suggests a native command timeout, but its underlying cause was not established. One fresh-run retry of the failed job passed without further code changes. This is retained as an intermittent validation limitation, not a claimed production fix. [Documentation deployment](https://github.com/lukebward/speculate/actions/runs/34988400049) passed for the unchanged final docs.

The [trusted publication workflow](https://github.com/lukebward/speculate/actions/runs/34990424843) succeeded. Public npm metadata now reports `speculate-mcp@0.23.0` as `latest`, with the matching source commit and SLSA provenance statement. All 59 files downloaded from the public package exactly match the tested tarball contents, and the registry SHA-512 integrity matches. The [GitHub release](https://github.com/lukebward/speculate/releases/tag/v0.23.0) is published and marked latest. Observer capabilities remain experimental and historical performance gates remain unchanged.

This final follow-up records completed delivery only; release source, tests, documentation, and package contents are unchanged.

# Default model-proxy launch and release (2026-09-15)

**Goal:** Make context-aware prefetching the normal Speculate session experience for Claude Code and Codex, then publish the verified release.

**Approved design:** The user accepted model-proxy mode as the standard native launch path with automatic hook fallback. Keep observation between agent and model; keep authorization, execution, and exact-result reuse at each MCP wrapper. This is a bounded change to the existing launcher, not a new proxy architecture.

**Version:** Target 0.24.0, subject to confirming that it is unpublished. Node >=18, existing dependencies, and both native clients remain supported.

## Implementation plan

- [x] Runtime worker: change `parseRunArgs` to default `observe` to `proxy` for both clients. Keep explicit `--observe hooks` and `--observe off`, native argument forwarding, provider/model/account/effort selection, permissions, and transports intact.
- [x] Runtime worker: test implicit proxy requests for both clients, explicit overrides, active proxy mode on verified routes, and automatic hook fallback on unsupported/unverifiable routes. Reuse existing fixture clients and production preparation paths. Preserve requested/active mode reporting and add a concise startup fallback reason without raw configuration or credentials if the current output lacks one.
- [x] Runtime worker: lead CLI help with `speculate run claude|codex`, identify proxy as the default, and retain managed `on` plus manual wrapping as supported choices.
- [x] Documentation worker: lead README and getting-started with `speculate run claude` and `speculate run codex` after installation. Explain that `on` manages persistent MCP wrappers and does not itself launch model observation. Update commands, landing page, compatibility, and current design wording for the new default and explicit fallback controls.
- [x] Documentation worker: present context-aware prefetching as the product identity while stating specific unverified integration/performance limits. Preserve historical benchmark artifacts, measured failed gates, and the historical 0.23.0 hook-default release entry. Add a concise 0.24.0 release entry and distinguish broader default enablement from new performance evidence.
- [x] Review worker: independently audit current fallback, permission, and transport boundaries before implementation finishes; review the final code/docs for both-client parity and unsupported-route abstention. No unrequested refactors, prediction changes, dependency updates, or native credential access.
- [x] Coordinator: update package.json, package-lock.json, and plugin manifest to the available version. Run build, strict TypeScript, complete tests with scenarios isolated, and strict documentation build. Inspect the tarball and exercise installed default launches plus CLI/MCP/hook checks on Node 18 and 22.
- [x] Coordinator: push main normally, verify platform CI and documentation deployment, then create an annotated version tag and use the existing trusted npm workflow. Verify npm latest/source/provenance, public tarball contents, and the GitHub release.

## Ownership and verification

Astra coordinates three existing GPT-5.6 Sol workers. Runtime owns `src/runAgent.ts`, CLI help in `src/cli.ts`, and launcher tests. Documentation owns README and relevant docs. Reviewer is read-only. Coordinator owns tasks, manifests, package/build/full-suite work, commits, pushes, tags, and publication. Workers do not run builds or publish. The existing isolated checkout is reused; the original working checkout is untouched.

Focused checks must establish default selection and real preparation/fallback behavior, not merely update snapshots. Installed launch checks use synthetic native-client fixtures and loopback model endpoints, without accounts, durable user configuration, or paid model calls. Existing relay/MCP fixtures establish forwarding and lifecycle behavior; no long benchmark rerun is needed for a default change. Record any validation failure and its disposition rather than silently retrying until green.

## Implementation review

The bounded runtime change is complete for both clients. Focused launcher checks passed 58/58 after seven expected red-phase failures. Independent review approved default selection, explicit modes, startup-only fallback, native authority/argument/transport preservation, and wrapper permission/cache boundaries. CLI wording was narrowed to avoid promising runtime failover. Documentation now leads with native context-aware launch while preserving historical failed gates and distinguishing persistent `on` setup.

Strict unused-code TypeScript, the 1,376-test main batch (8 skipped), and strict documentation build passed. Built-CLI loopback checks passed all eight client/mode combinations, including exact default-relay request/response forwarding and visible fallback reasons. Timed scenarios and final installed-package checks remain in progress.

## Pre-release verification

All 1,388 tests passed with 8 skipped: 1,376 in the main batch and 12 isolated timed scenarios. Build, strict unused-code TypeScript, strict MkDocs, and diff checks passed. Independent final code/documentation review found no release blocker.

The 0.24.0 package contains 59 files (245,106 bytes packed), all matching the final build/source resources, with no test/benchmark/task artifacts. Installed Node 18.20.8 and 22.14.0 checks passed CLI version/help, real MCP list/call, and both compiled observer hook deliveries. Both runtimes also passed eight actual installed-launch cases (Claude and Codex default, unsupported-route fallback, explicit hooks, explicit off), including byte-identical local-provider requests/responses, native model/argument preservation, report modes, and visible bounded fallback reasons. These are synthetic integration checks, not native account or performance measurements. Tarball SHA-256: `d0d4fe90610a666ebf669fc8dbd5a47a6fabee5d10cfcd683cf6c417f70bf81a`.

Main CI, documentation deployment, and publication remain the delivery gates.

## Completed 0.24.0 delivery

Release source `49a894cc41ccf3e3de909014145a4d9158b1e998` is on main and tagged `v0.24.0`. [Platform CI](https://github.com/lukebward/speculate/actions/runs/34995066661) passed Linux, macOS, and Windows on the first attempt, including native Codex integration checks. [Documentation deployment](https://github.com/lukebward/speculate/actions/runs/34995066645) and [trusted npm publication](https://github.com/lukebward/speculate/actions/runs/34995691316) succeeded.

npm accepted the package at 16:35:59 UTC and served it publicly as `latest` by 16:43:43 UTC after registry processing. Public metadata names the correct source commit; the downloaded package matches all 59 tested files, its SHA-512 integrity matches, and the SLSA provenance statement names the release source. The [GitHub release](https://github.com/lukebward/speculate/releases/tag/v0.24.0) is published and latest. Context-aware native launch now requests the model proxy by default for both clients, with explicit modes and startup hook fallback preserved. No new native performance claim is made.

This follow-up records delivery only; tested source, documentation, and published package contents remain unchanged.

# Behavior-preserving repository simplification (2026-09-16)

**Goal:** Reduce maintenance complexity while retaining the context-aware architecture and all 0.24 improvements.

**Scope:** Remove demonstrably unused code and duplicate internal logic where one existing implementation can express the same contract. Preserve model-proxy defaults, explicit hooks/off, startup fallback, client/provider/transport semantics, native permissions, exact-result reuse, learning, diagnostics, supported commands and historical evidence. No broad file reshuffle, new dependencies, public option removal, or architecture rewrite.

## Plan

- [x] Audit session/proxy coordination, client adapters/setup, and repository tooling independently with the existing Sol workers; inspect concrete callers and regression coverage.
- [x] Select bounded simplifications with measurable maintenance benefit; record exact files and contracts before implementation.
- [x] Implement independent changes with clear file ownership, preserving behavior and meaningful regression coverage.
- [x] Review each change independently; reject abstractions that add more indirection than they remove.
- [x] Run build, strict TypeScript, affected tests, complete main test batch and isolated timing scenarios; verify packaged defaults and client compatibility where touched.
- [x] Record net changes, retained guarantees, and verification results.

**Coordination:** Astra owns scope and integration. Sol workers audit and implement bounded independent tasks. Only the coordinator builds or runs the full suite. Reuse this clean isolated checkout from current origin/main; leave the original working checkout untouched.

## Selected implementation

1. **Shared hook handling:** `src/hookBoundaries.ts`, `src/agentAdapters/claude.ts`, `src/agentAdapters/codex.ts`, and one small shared launch helper if needed. Move the identical normalized tool-boundary transition into the existing hook module. Keep payload parsing, ID validation, permission/config gates, Messages/Responses/WebSocket parsing and budget semantics client-specific. Centralize hook command quoting, hook-event merge and observer environment construction. Preserve both exported adapter command functions and Codex-only asynchronous handlers. Use current adapter/run-agent/recovery/installed-hook coverage plus a focused parity case if existing assertions do not establish the shared contract. Sol documentation/adapter worker owns these files and affected tests.
2. **Dead runtime surface:** `src/runAgent.ts`, `src/sessionBridge.ts`, `src/llmProxy.ts`. Collapse the private launcher forwarding hop without changing the exported symbol. Remove the unread callback flag and bridge methods with zero production, test, benchmark or documentation callsites (`setHookHandler`, bridge-side `register`/`invalidate`); make the constructor hook callback readonly. Retain used/tested route lookup, owner APIs and proxy interfaces. Sol core worker owns these three files. Validate launcher, bridge, relay and WebSocket suites.
3. **Repository artifacts:** inspect tracked `.superpowers` scratch output and unreferenced generation paths. Remove only proven disposable scratch or dead tooling, preserving measured benchmark artifacts, user-facing documentation, runtime package resources and reproducibility. Coordinator selects removals after the audit; tooling worker supplies evidence and later reviews runtime changes.

Ruling: Preserve existing serialized key/permission identities and transport-specific state machines; superficially similar implementations differ in ordering, lifecycle or backpressure. Keep all currently used public commands and module entry points. These focused internal consolidations satisfy the requested simplification without redesigning the architecture.

4. **Package layout invariant:** `src/packageResources.ts` and `src/version.ts` will share source/dist package discovery while retaining version fallback and missing-hook failure behavior. The tooling worker owns these files; the coordinator verifies the installed package on Node 18 and 22.

Repository audit found no unused dependency or disposable `.superpowers/archive` content: those files explicitly preserve release decisions. Retain benchmark aliases for compatibility. Remove only the superseded September 14 plan/spec under `docs/superpowers`, which still describe unstarted/opt-in work and have no external inbound references. Current architecture, limits, measured results and release history already live in maintained documentation and remain intact. Remove their now-unused MkDocs navigation exclusion and update the stale observer navigation label to match the current product documentation. Coordinator owns these documentation changes.

## Review progress

The runtime cleanup passed 181 focused launcher/bridge/relay/WebSocket/recovery tests. Package discovery passed six focused checks and independent review. Review caught and corrected a draft regression where a JSON `null` manifest did not fall through; the new temporary-layout test reproduced the failure and verifies the original behavior. Adapter review also caught a draft shell-quoting escape before integration; the original escaping is retained and a regression checks apostrophes. These were refactor-draft issues, not newly discovered defects in the released package.

Strict documentation build passes after removing the superseded plan/spec and their unused navigation exclusion. No references to the deleted files remain. All benchmark evidence, archived release decisions, supported npm scripts and dependencies are retained.

All implementations are stable. Adapter consolidation passed 111 focused tests, including preserved event sets, Codex-only asynchronous handlers and apostrophe quoting. Shared adapter plumbing is +12 production lines while removing 90 lines from the two client adapters; its benefit is a single implementation of duplicated behavior, not a large runtime line reduction. Across the complete cleanup, production code is six lines smaller. The main full-suite batch passes 1,382 tests with 8 skipped; build and strict unused-code TypeScript also pass. Isolated scenarios, final independent review and installed-package checks remain.

## Completed verification

All 1,394 tests passed with 8 skipped: 1,382 in the main batch and 12 isolated timing scenarios. Build, strict unused-code TypeScript, strict MkDocs, diff checks, and independent code/documentation reviews passed. The locally packed package contains 60 files and is 244,771 bytes, with every file matching the final build/resources.

Installed Node 18.20.8 and 22.14.0 checks passed CLI version/help, real MCP list/call, exact loopback relay forwarding and reports for both clients across default/fallback/hooks/off, and both observer hook deliveries. Installation paths included spaces and apostrophes; hook commands executed through a real POSIX shell using the packaged resources. These are synthetic integration checks, not new native performance measurements or a new publication.

The cleanup removes three unused bridge methods, an unread flag and a launcher forwarding hop; shares hook boundary/launch logic and package discovery; and removes 494 lines of superseded implementation instructions. Production source is six lines smaller overall, with substantially less duplicated adapter logic. Current commands, default model observation, fallback behavior, permission checks, exact cache matching, protocol-specific transports, learning and historical evidence are retained. Changes are recorded on the local `simplify-repo` branch from `bcbd582`; package version remains 0.24.0.

# Automatic onboarding (2026-09-16)

**Goal:** Make the standard interactive experience `npm install -g speculate-mcp` followed by `speculate`, retaining first-class Claude/Codex support and all simplified architecture improvements.

**Design:** A bare invocation detects installed native clients without starting either client. One available client launches through the existing context-aware `runAgent` path; two require one explicit terminal choice; zero produce concrete installation instructions. Noninteractive ambiguity never prompts, guesses, or consumes stdin. Every nonempty invocation retains its existing grammar and behavior. Existing native sign-in, permission/trust prompts and MCP policy remain authoritative. Session preparation already wraps supported MCP registrations, so onboarding must not call persistent `on`, edit shell profiles, install native clients, or duplicate setup/config logic. No preference store, onboarding framework, dependency or new model call is needed.

## Plan

- [x] Audit native discovery, launcher/config boundaries, CLI/tests, and user documentation with Sol workers.
- [x] Add a small filesystem-only discovery/selection module and meaningful client/TTY/failure tests. Reuse current client resolution and verify candidate files; retain explicit binary overrides, platform handling and JavaScript entrypoint support.
- [x] Route only the no-argument CLI path to onboarding and the unchanged proxy-default launcher. Preserve explicit native/config/management commands and all native arguments. Add public CLI routing/no-hang checks.
- [x] Lead README, landing page, getting-started and CLI help with install + bare `speculate`. Explain automatic session setup, both-client choice, missing-client guidance, and explicit commands for scripts/options.
- [x] Independently review runtime/UX, run build/strict TypeScript/full main suite/isolated scenarios/docs checks, and exercise installed onboarding and existing client defaults on Node 18/22 using fixtures.
- [x] Record verified results and commit on the current cleanup branch.

**Ownership:** Core Sol worker owns `src/onboarding.ts` and its tests. CLI/docs Sol worker owns CLI dispatch/help and documentation/CLI routing tests. Review Sol worker independently checks parity and preserved host boundaries. Coordinator owns integration, tasks, full verification and commits. Discovery must perform filesystem reads only; actual native session/config processes begin only after client selection.

## Onboarding review and verification

The bounded implementation and documentation are complete. Independent review approved filesystem-only detection, native overrides/platform fallbacks, readable JavaScript entrypoints for both clients, noninteractive no-read behavior, readline EOF/SIGINT settlement, exact proxy-default launch arguments, and unchanged nonempty CLI grammar. The missing-client message links official quickstarts and explains rerunning Speculate/native sign-in. No preference state or configuration migration was introduced.

Core tests passed 16/16; CLI routing and existing management tests also pass. Build, strict unused-code TypeScript and strict MkDocs passed. The main suite passed 1,403 tests with 8 skipped. Built-CLI tests with isolated fake clients and a local model endpoint passed no-client, sole-Claude, sole-Codex, both-noninteractive, actual terminal choice for each client, terminal EOF and Ctrl-C. All four successful selection paths forwarded the exact model request through the existing relay; unsuccessful selections made no native-client invocation. Isolated timing scenarios and final installed Node 18/22 checks remain.

## Completed onboarding verification

All 1,415 tests passed with 8 skipped: 1,403 in the main batch and 12 isolated scenarios. After the final missing-client copy edit, both onboarding suites passed again (21 tests). Build, strict unused-code TypeScript, strict documentation build, diff checks and independent review passed.

The installed package was verified on Node 18.20.8 and 22.14.0 from a directory containing spaces and apostrophes. On each runtime, all eight onboarding cases passed: no clients; sole Claude; sole Codex; both clients with noninteractive open stdin; real PTY selection of Claude; real PTY selection of Codex; terminal EOF; terminal Ctrl-C. Successful launches forwarded an exact request to the local model provider, while unsuccessful selections did not invoke either client. Existing default/fallback/hooks/off launches for both clients, CLI help/version, MCP list/call, and real shell observer-hook delivery also passed on both runtimes. All 61 packed files match the final source/build resources.

The new user flow is install, then bare `speculate`. Automatic session setup reuses the existing native launcher. Both installed clients require an explicit choice; native sign-in/trust/permissions remain native. Existing explicit commands retain their behavior. These changes join the prior simplification on the local `simplify-repo` branch; no new version was published.

# v0.25.0 release (2026-09-16)

**Authorization:** Push the completed simplification and onboarding work to main and publish a release. Use the existing clean isolated checkout; preserve the original working checkout.

- [x] Confirm origin/main is an ancestor, the checkout is clean, and version 0.25.0 is available.
- [x] Complete independent Sol release review of platform assumptions, package resources and documentation claims. No blockers found.
- [x] Update package, lockfile and plugin versions together; document release behavior and retained limits.
- [x] Verify the release build, strict TypeScript, documentation, tests and installed Node 18/22 package behavior.
- [ ] Commit and fast-forward push main; verify Linux, macOS, Windows and documentation CI.
- [ ] Push the release tag and publish through the existing trusted npm workflow; create GitHub release.
- [ ] Verify public package version, source commit, integrity, contents and provenance; record delivery.

Release candidate verification passed: build, strict unused-code TypeScript, strict MkDocs, 1,403 main tests (8 skipped), 12 isolated scenarios and diff checks. All 61 packed files match the final build/resources. Installed Node 18.20.8 and 22.14.0 each passed eight onboarding cases (including real terminal choice/EOF/Ctrl-C), eight explicit launch cases across both clients and observation modes, CLI version/help, real MCP list/call and both shell observer-hook deliveries from a path containing spaces and apostrophes. No new performance measurement is claimed.
