# Jev Integration Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Workers implement bounded owned files, verify them, and report for controller review.

**Goal:** Deliver optional bridge-owned Jev shadow and active ranking without widening speculative execution permissions.

**Architecture:** Existing wrappers retain immutable predictions and final execution ownership. The authenticated session bridge correlates context, calls a bounded Jev service and returns score-only replies. Baseline calibration and semantic demand evaluation stay separate.

**Tech Stack:** TypeScript, Node 18 native fetch, Zod, Vitest, existing MCP/session IPC.

**Spec:** `docs/superpowers/specs/2026-09-17-jev-integration-design.md`

## Global Constraints

- Off is the default and has no provider requests or semantic state. Shadow preserves baseline execution and ordering.
- Exact calls only; keep authorization, eligibility, age, invalidation, feedback and budget gates.
- Both Codex and Claude Code are first-class. Missing or ambiguous context means baseline fallback.
- Credentials remain bridge-owned; no raw semantic data in durable reporting. No new SDK/runtime minimum.
- Keep changes scoped to this integration. No generated-file edits or unrelated refactors.
- Workers use Sol, own disjoint files and do not commit shared work until the controller accepts their final report.

## Shared contracts and ownership

The service worker defines `src/semanticTypes.ts` first and sends exact exports to integration workers. Required data contracts: configuration (off/shadow/rank and spec limits), immutable candidate projections, request/reply bound to batch/source/digest, verified conversation context and aggregate report. Candidate projections include opaque ID, route/generation, server/tool/args, baseline score, latency and effective TTL. Provider scores contain no executable values.

Runtime extension names: `semanticConfig(): SemanticRankingConfig | undefined`, `judgeCandidates(request: SemanticRankingRequest): Promise<SemanticRankingReply | null>`, and `publishDemand(event: ProxyDemandEvent): Promise<boolean>`. Handshake configuration is bridge-authoritative. Existing runtimes can omit these methods and retain baseline behavior. Proxy demand includes stable request ID, owner route/generation, exact args and actual start timestamp; completion shares that ID.

Task 1 owns semantic types, service/provider/context/evaluation modules, config schema/tests. Task 2 owns predictor/proxy/executor/types.ts and their tests. Task 3 owns sessionBridge/runAgent/observerTypes and their tests plus necessary CLI argument wiring. Controller owns documentation, combined verification, integration tests and task log. Communicate interface changes before writing consumers.

### Task 1: Bounded semantic service and configuration

- [x] Define shared contracts and strict configuration defaults matching the spec; add the optional top-level schema while Task 2 adds its type import/property.
- [x] Write failing tests for batched Noul requests, validation, body limits, projection, deadlines, cancellation, request budgets/cooldowns and context isolation.
- [x] Implement HTTP transport with injected fetch/clock, explicit candidate question paths, fixed endpoint, pinned model, finite exact reply IDs, no retries and no secret error bodies.
- [x] Implement bounded context retention and demand-window evaluation including negative/censored distinction and aggregate-only reports. Keep all semantic state launch-local.
- [x] Verify focused tests and strict types; report exact public interfaces and limitations.

### Task 2: Prepared prediction batches and wrapper execution

- [x] Add failing tests for immutable frontier preparation, baseline-equivalent off/shadow, active semantic selection and asynchronous supersession.
- [x] Separate candidate preparation and selection narrowly; keep synchronous learning and baseline next-call telemetry intact. Retain original confidence and rule identity.
- [x] Integrate optional runtime judging at local and observer candidate seams; share source event IDs, snapshot revisions before waiting, use one deadline and baseline fallback only while current.
- [x] Publish demand at arrival even for failures/cancellation; preserve existing candidate timestamps, leases and all execution gates. Stream/openers bypass judging.
- [x] Propagate local scheduling utility for rank mode only; validate at dequeue and never accept priority from provider replies.
- [x] Verify predictor, executor and proxy tests plus targeted race/failure tests.

### Task 3: Session bridge, correlation and both host launchers

- [x] Add failing tests for score-only IPC, owner validation, either arrival order, exactly-once completion correlation, context revision and disconnect cleanup.
- [x] Wire bridge-authoritative configuration and optional semantic service; retain grouped observer candidates per source/destination without changing source caps.
- [x] Correlate demands and completions with shared bounded evidence; never assign latest-launch context to an ambiguous call. Preserve no-context fallback and real-call independence.
- [x] Wire launch configuration through existing CLI conventions (an explicit run `--config` path if needed), startup disclosure, environment key access and aggregate reports for both hosts.
- [x] Verify host fixtures, bridge tests, mode-off compatibility, Node18-compatible APIs and shutdown invalidation.

### Task 4: Integrate, document and measure

- [x] Review each task's interfaces and diffs; resolve cross-component failures without weakening the spec.
- [x] Add meaningful combined fixtures showing actual rank decision changes, baseline-identical shadow behavior, verified context, provider failures and mutation/permission races.
- [x] Document configuration, data disclosure, limitations, reporting and both host invocation examples; update the no-predictor-model README statement conditionally.
- [x] Run deterministic A/B/C fixture comparison with recorded inputs and injected provider, separating correctness from live speed claims. A live Jev experiment requires configured credentials and must never fabricate performance evidence.
- [x] Run build, strict TypeScript, full test suite, isolated scenarios and docs checks. Dispatch independent Sol review, fix demonstrated issues and rerun affected checks.
- [x] Record verified results and any unavailable external measurements; deliver implementation with no push, merge or release.

## Verification commands

```sh
npm test -- test/semantic-ranking.test.ts test/semantic-context.test.ts test/semantic-evaluation.test.ts
npm test -- test/predictor.test.ts test/executor.test.ts test/proxy.test.ts test/session-bridge.test.ts
npm run build
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test
npm run test:scenarios
git diff --check
```

Test names may follow existing repository naming where more precise; workers must report actual commands and counts. Run full builds only when implementation workers have stopped changing source because build deletes dist.
