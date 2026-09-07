# Local learning upgrade implementation plan

> **For agentic workers:** Use test-first implementation and independent task review. User explicitly authorized autonomous execution and conditional release; do not pause for routine design, worktree, push, merge, or release approvals.

**Goal:** Improve recurring-workflow prediction using bounded general memory, protect persisted learning records, and publish only a measured improvement.

**Architecture:** The existing statistical learner gains session-local multi-call sources whose descriptors survive restarts. A persistence boundary sanitizes and bounds the model. Existing stats and a memory command expose outcomes and storage. One shared benchmark exercises old and new implementations.

**Tech Stack:** TypeScript, Node >=18 runtime, MCP SDK, Vitest, existing npm/GitHub Actions release pipeline.

**Spec:** ../specs/2026-09-07-local-learning-upgrade.md

## Global Constraints

- Prediction remains local, automatic, and generic. No service names, workflow-specific logic, or domain examples in production learner code or comments.
- Persist compact learned descriptors, evidence, and aggregate statistics by default. Raw call/result history remains session-local and bounded.
- Preserve exact arguments, read-only policy, budgets, admission, invalidation, scoped state, and transparent real-call forwarding.
- Node >=18 production compatibility and Linux/macOS/Windows support; no external model dependency.
- Work only in C:/Users/Luke/Workspace/speculate-upgrade. Baseline C:/Users/Luke/Workspace/speculate-baseline is immutable. Keep task ownership disjoint; root performs shared-file integration.
- Run tests directly with Node 22 at C:/Users/Luke/AppData/Local/npm-cache/_npx/52027bd8fc0022aa/node_modules/node/bin/node.exe; npm.cmd uses an older installed Node. Test command: `node22 node_modules/vitest/vitest.mjs run <files>`. Build: `node22 node_modules/typescript/bin/tsc`. Eval: `node22 node_modules/tsx/dist/cli.mjs eval/eval.ts`.

## Task 1: Generic recent-call sources

Files: src/learner.ts; test/learner.test.ts or new test/learner-history.test.ts.
Interfaces: retain TransitionLearner observe/predict/exportState/importState; optional sourceTool on SerializedSource and transform bases. No public Predictor API change.

- [ ] Write tests whose changing IDs require argument values from two earlier calls, including reordered optional calls, repeated source tools, server separation, gap/out-of-order reset, absent source after restart, and unchanged cap prefixes. Example sequence: `enumerate({scope:'group-a'}) -> {items:[{id:101}]}`, `inspect({id:101}) -> {revision:201}`, `metadata({}) -> {ready:true}`, `fetch({scope:'group-a', id:101, revision:201})`; repeat with all identifiers changed and assert exact final args before observing fetch.
- [ ] Run against baseline and record expected failures caused by missing older-call values.
- [ ] Implement bounded recent-call source discovery, identity, serialization, resolution, and training order. Existing immediate sources keep their identities. No historical payload is exported.
- [ ] Run focused learner/predictor/persistence tests and offline eval; fix regressions. Independently test no current target leaks into prediction inputs.
- [ ] Remove workflow-specific examples from learner comments; write report with changes, tests, and constraints.

## Task 2: Protected, bounded memory

Files: new src/privacy.ts, src/memory.ts; src/persistence.ts, src/config.ts, src/cli.ts; config section of src/types.ts; test/persistence.test.ts, test/config.test.ts, new test/privacy.test.ts and test/memory.test.ts. Root owns proxy integration and stats schema sections.
Interfaces: extend StateStore with optional retentionDays/maxBytes policy; preserve existing positional call compatibility. Export memory command parser/runner from memory.ts and call it from cli.ts. Provide exact signatures to root before integration.

- [ ] Add behavior tests seeding fake credentials into const values, sensitive argument names, nested literals, transform prefix/suffix, opener args, legacy input and concurrent merge; assert persisted bytes and stderr omit canaries while normal bindings remain usable.
- [ ] Add real filesystem tests for expiration, size cap, oversized reads, malformed data, concurrent writes, managed inventory/clear, custom paths, symlinks, and active-session clear behavior.
- [ ] Implement sanitizer and bounded persistence before writing any temp bytes; preserve structural descriptors including sourceTool. Never replace a needed argument with a redaction string. Add aggregate removal accounting.
- [ ] Implement persistence configuration defaults/validation and memory command. Keep auth/host config out of deletion scope. Resolve and verify each deletion target; no broad recursive deletion.
- [ ] Run focused tests and build. Write report and exact proxy/stats integration requirements.

## Task 3: Comparable repeated-workflow E2E benchmark

Files: bench/repeatedWorkflows.ts, bench/repeated.ts, test/repeated-benchmark.test.ts (names may be refined consistently); existing bench/comparison.ts only if additional backward-compatible fields are needed. Root owns package scripts/docs.
Interfaces: CLI supports baseline/candidate target roots and JSON output artifact. Import/use same driver and source fixtures for both targets, invoking real proxy/MCP transport paths.

- [ ] Create deterministic chronological fixtures for CI investigation, PR review, issue triage, an unfamiliar renamed-tool transfer case, and an unpredictable negative control. Vary identifiers and optional/reordered intermediate calls; do not put future answers in trigger payloads that a real call would not contain.
- [ ] Add harness tests verifying stable fixtures, changed held-out values, independent per-arm state, correct paired accounting, byte-identical real results, and shutdown waste.
- [ ] Run off/baseline/candidate arms with controlled explicitly labeled injected upstream latency. Train earlier sessions, score later sessions, alternate execution order. Record calls, hits, joins, misses, recall, prediction coverage, speculation, terminal waste, p50/p95/mean wait, wall time, CPU/memory/state footprint where feasible.
- [ ] Validate harness on immutable baseline before using candidate results. Retain machine-readable artifacts and exact command/configuration.

## Task 4: Integration and useful reports

Files: src/proxy.ts, src/stats.ts, src/usage.ts, src/metrics.ts, stats sections of src/types.ts; relevant tests; package.json scripts; README.md, docs/configuration.md, docs/commands.md, docs/safety.md, CONTRIBUTING.md.

- [ ] Integrate retention/size policy into proxy store and expose aggregate memory/learning diagnostics without argument material.
- [ ] Test stats with no history, low prediction coverage, argument near misses, useful hits/joins, waste and negative estimated net. Keep existing JSON fields compatible and label estimates.
- [ ] Implement concise explanations in existing stats, preserving old record readability.
- [ ] Document default disk contents/location, limits, deletion, secret filtering limitations, in-memory result handling, new learning behavior and benchmark commands.

## Task 5: Verify, review and release conditionally

- [ ] Run full suite/build/eval and same-driver old/new repeated benchmark against the spec's predeclared gates.
- [ ] Run existing real Git/filesystem E2Es and available hosted-server comparisons with separate state roots. Preserve cold/control and failure outcomes.
- [ ] Independently review learner correctness/leakage and persistence security plus integrated branch. Resolve important findings and rerun affected checks.
- [ ] If gates pass, bump semver, update release notes with measured scope/limits, commit, push branch and PR, wait for three-platform CI, merge, tag and run trusted publish. User has authorized these actions conditional on benefit.
- [ ] Verify published npm version and packed CLI behavior. Final report links release and benchmark artifact, shows before/after times/hits/waste/control results, and identifies unmeasured real-world limitations.
