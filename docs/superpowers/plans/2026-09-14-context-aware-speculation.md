# Context-Aware Speculation Implementation Plan

## Execution addendum: current-main reconciliation

Implementation starts from `d2445a5` (`origin/main`, v0.22.0), not the v0.10 checkout inspected during planning. This addendum overrides obsolete implementation references below:

- Both clients already have native/global `on`, `off`, `sync`, policy, and hook support. Reuse `codexClient.ts`, `codexPolicy.ts`, `codexHooks.ts`, `codexManage.ts`, `hostConfig.ts`, and `manage.ts`; preserve those current behaviors.
- `tryRun.ts`, bundled workspace/shell tools, the exec daemon, and built-in profiles were intentionally retired. Do not restore them. The new optional session launcher uses current native configuration APIs; Task 8 verifies registered filesystem/git MCP tools on both hosts. Native shell calls may supply observations but are not intercepted or prefetched by this change.
- Intent candidates must resolve through live tool schemas and explicit, unambiguous mappings. A historical built-in GitHub/filesystem profile is not available or implied.
- Existing adaptive admission, privacy filtering, single-use cache lifecycle, and measurement accounting remain authoritative. Observer candidates use the same scoring/admission and executor path.
- Existing `npm run bench` runs the repeated-workflow benchmark; `npm run bench:mock` is the old synthetic GitHub benchmark. Use current scripts, existing fixtures, and real Codex tests.
- The user's current instruction authorizes implementation and a normal fast-forward push of the completed branch to `main`, not a release/default enablement. Keep new model observation opt-in/experimental until real-client authentication and incremental performance gates are demonstrated. Report unverified live paths explicitly; do not substitute fixture success for live verification.
- A separate isolated branch is used so remote work is preserved. No merge, rebase, force-push, or publish is included.


> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Steps use checkboxes for tracking. This document is a proposed plan; no implementation has been authorized or completed by this planning pass.

**Goal:** Improve Speculate's predictions using task context, cross-server observations, and streamed tool calls, with Codex and Claude Code supported equally from the first release.

**Architecture:** One session bridge connects host lifecycle adapters and an optional transparent model observer to the existing live MCP wrappers. A shared predictor emits validated candidates to the existing executors and caches. Claude and Codex keep dedicated launch/protocol adapters and share correctness, recovery, and performance gates.

**Tech stack:** Existing TypeScript/Node ESM, MCP SDK, Zod, Vitest, and Node HTTP/IPC. Use the installed MCP SDK's JSON Schema validator. Add a direct WebSocket dependency only for the Codex relay; select and pin a supported Node-18-compatible release during Task 5, rather than implementing WebSocket framing.

**Spec:** [Context-aware speculation design](../specs/2026-09-14-context-aware-speculation-design.md). Read it before execution; its compatibility and release requirements are authoritative.

## Global constraints

- Codex and Claude Code are first-class peers in the initial release, including setup, authentication, transport, diagnostics, recovery, benchmarks, and documentation.
- Retain Node `>=18`, ESM, existing command meanings, and existing persisted learner/usage formats.
- Keep the original tool executors, cache owners, read-only policy, TTLs, permissions, and host-selected models/effort.
- No prompt compression, model/effort routing, additional prediction LLM, credential acquisition, or proxy-owned tool loop.
- No unrelated renames, file consolidation, refactoring, global configuration changes, broad permission grants, or generated-code edits.
- Session candidates and raw observations stay in memory. Reports contain aggregate values only.
- Candidate limits: 3/event, 64 KiB/envelope, 1-second maximum age; observation queue: 256 events; transitions: 500/conversation; replay IDs: 4,096 with 120-second retention.
- Observation limits: 2 MiB/request, 64 KiB/assembled candidate, 8 MiB/conversation, 32 MiB/session. Overflow drops analysis, not traffic.
- Both clients must pass independently. Never label an untested auth/transport path supported or use combined performance to hide a regression.
- Native-shell acceleration requires equivalent execution and unchanged authorization on both clients; shared workspace MCP support is required on both regardless.
- Use `origin/master` when a base comparison is needed. This plan contains no rebase, merge, deployment, or publishing operation.

## Delivery order and review boundaries

| Stage | Tasks | Independently reviewable result |
| --- | --- | --- |
| Establish compatibility | 1 | Both host contracts, synthetic fixtures, baseline and recorded gaps |
| Shared tool coordination | 2–3 | Validated same-cache delivery and cross-server learning |
| Transparent model observation | 4–5 | Claude Messages and Codex Responses/SSE/WebSocket relays |
| Earlier prediction | 6 | Explicit-intent and completed-stream candidates through the same bridge |
| Product integration | 7–8 | Symmetrical launch/diagnostics and verified tool-consumption paths |
| Demonstrate benefit | 9–10 | Correctness/recovery proof, per-client results, release decision |

Tasks 4 and 5 can be developed independently after the shared contracts are fixed, but form one compatibility milestone. No Claude-only release is an intermediate product milestone. Task 3 remains useful even if proxy observation misses its performance target.

## File ownership and shared contracts

New production modules and their responsibilities:

| File | Responsibility |
| --- | --- |
| `src/observerTypes.ts` | Runtime schemas and normalized observation/candidate contracts |
| `src/sessionBridge.ts` | Session IPC, live route registry, generation/replay checks, delivery |
| `src/sessionPredictor.ts` | Cross-server learner adapter, explicit intent, source dedup, feedback |
| `src/llmProxy.ts` | Transparent HTTP/SSE/WebSocket transport and bounded observation delivery |
| `src/agentAdapters/claude.ts` | Claude launch configuration and Messages/hook normalization |
| `src/agentAdapters/codex.ts` | Codex launch configuration and Responses/hook normalization |
| `src/runAgent.ts` | New symmetrical `run` command, lifecycle, reporting |
| `plugin/hooks/session-observer.mjs` | Standalone, dependency-free hook event sender for both hosts |

Existing touchpoints: `src/proxy.ts`, `src/hostConfig.ts`, `src/wrap.ts`, `src/cli.ts`, `src/executor.ts`, and tests. Change `src/cache.ts` only if generation tests show its existing invalidation cannot fence late completions. Change `src/execDaemon.ts`/`src/execClient.ts` only for Task 8's verified native-consumption path. Reuse `tryRun.ts`'s pure Claude config assembly; do not move or rename it.

Define these interfaces in Task 2; later tasks consume them rather than inventing incompatible envelopes:

```ts
export type AgentKind = 'claude' | 'codex';
export type ObserverMode = 'off' | 'hooks' | 'proxy';
export type SignalKind = 'intent' | 'transition' | 'stream';

export interface SessionContext {
  launchId: string;
  conversationId: string;
  agent: AgentKind;
  cwd: string;
}

export interface RegisteredRoute {
  routeId: string;
  generation: number;
  instanceId: string;
  hostServerAlias: string;
  exposedTool: string;
  upstreamServer: string;
  upstreamTool: string;
  inputSchema: Record<string, unknown>;
}

export interface Candidate {
  version: 1;
  launchId: string;
  conversationId: string;
  candidateId: string;
  routeId: string;
  generation: number;
  sourceEventId: string;
  source: SignalKind;
  args: Record<string, unknown>;
  confidence: number;
  createdAt: number;
}

export type Observation = {
  context: SessionContext;
  eventId: string;
  observedAt: number;
} & (
  | { kind: 'prompt'; text: string }
  | { kind: 'tool-complete'; routeId: string; args: Record<string, unknown>;
      parsed: unknown; latencyMs: number; ordered: boolean }
  | { kind: 'stream-call'; routeId: string; callId: string;
      args: Record<string, unknown> }
  | { kind: 'invalidate'; routeIds: string[]; reason: string }
);

export interface LaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  upstreamBaseUrl: string;
  transport: 'messages' | 'responses';
  cleanup(): Promise<void>;
}
```

`RegisteredRoute` is bound to a launch and owner connection by registry state, not trusted from a candidate. Credential-bearing launch plans are never logged or serialized into reports. The bridge authenticates owner connections before registration; registration contains no model credentials. Observations use a Zod discriminated union and candidates a strict object schema that rejects unknown fields such as `key` or `command`.

## Task 1: Establish both client contracts and baseline fixtures

**Files:** Create `test/fixtures/observer/claude.json`, `test/fixtures/observer/codex.json`, `test/helpers/observerHarness.ts`, `test/observer-baseline.test.ts`, `docs/observer-compatibility.md`; extend `bench/bench.ts` only to expose reusable measurements without changing existing output.

**Consumes:** Current source, both host CLIs, official documentation linked in the design.
**Produces:** Sanitized synthetic protocol fixtures, exact tested-version matrix, and an offline harness with mock provider/tool endpoints and measured event ordering.

- [ ] Record installed versions and supported per-invocation config controls using each CLI's help and current official schemas. Resolve Headroom's reference commit. Record evidence URLs and command outputs excluding credentials.
- [ ] Define fixture cases for full/incremental requests, tool definitions and aliases, deferred tools, multiple calls, subagents, SSE byte splits, WebSocket continuation, auxiliary endpoints, errors, cancellation, and hooks. Use fictitious IDs and synthetic headers; never check in a captured bearer token or user transcript.
- [ ] Add a baseline test that round-trips the existing MCP proxy and proves result identity, ready hit, in-flight join, and mutation invalidation. Reuse the existing mock GitHub server and integration helpers.
- [ ] Give the harness these operations: `startProvider({ transport })`, `startToolServer({ alias, latencyMs })`, `exchange({ request, chunks })`, and `close()`. `exchange` returns original/received payload buffers, call records, and monotonic timestamps; every fixture owns its clocks and cleanup.
- [ ] Run `npm test -- test/observer-baseline.test.ts test/integration.test.ts` and `npm run bench -- --latency 400`; save baseline metrics with the version matrix.
- [ ] Prove separately that both clients can retain API-key and native subscription identity with temporary routing. This is a compatibility spike, not a new auth implementation. Use existing client sign-in, and record missing access as unverified rather than switching billing paths.
- [ ] Check native hook ordering/permission behavior and transient hook configuration on both. Record the lowest version actually verified; do not infer a version floor from current docs alone.

**Acceptance:** Both clients have explicit fixture/transport/auth rows. Any unresolved native-auth path is a recorded blocking condition for the full proxy release. Hook-only stages can proceed without pretending that blocker is solved.

## Task 2: Register live wrappers and validate candidate delivery

**Files:** Create `src/observerTypes.ts`, `src/sessionBridge.ts`, `test/observer-types.test.ts`, `test/session-bridge.test.ts`; modify `src/proxy.ts`, `src/hostConfig.ts`, `src/wrap.ts`, `src/executor.ts` and their existing tests.

**Consumes:** Fixture harness and contracts above.
**Produces:** Exported `candidateSchema` and `observationSchema`; `SessionBridge.start(context)`, `register(owner, routes)`, `submit(candidate)`, `invalidate(owner)`, `close()`; `SpeculateProxy.submitObservedCandidates(candidates: unknown): void`. Define the owner handle as an authenticated live connection allocated by the bridge, not caller-controlled PID metadata.

- [ ] Write schema tests first. The candidate schema must reject a supplied cache key, missing session, malformed args, nonfinite confidence, excess size, and unsupported version.

```ts
it('rejects an imported cache key', () => {
  const candidate = {
    version: 1, launchId: 'launch', conversationId: 'thread',
    candidateId: 'one', routeId: 'route', generation: 1,
    sourceEventId: 'event', source: 'intent', args: {},
    confidence: 1, createdAt: 0, key: 'forged',
  };
  expect(candidateSchema.safeParse(candidate).success).toBe(false);
});
```

- [ ] Run `npm test -- test/observer-types.test.ts test/session-bridge.test.ts` and confirm meaningful failures before implementing the new modules.
- [ ] Pass launch coordinates and original MCP alias through optional wrapper configuration. Publish routes after `rebuildRoutes` and on tool-list changes, without changing existing model-facing tool names. Register a new generation after reconnect.
- [ ] Deliver candidates over the existing owner's bridge connection. At the proxy ingress, compile validators through `@modelcontextprotocol/sdk/validation/ajv`, verify envelope/route/schema/age/replay checks and adapter-verified host preauthorization for the exact tool/args in the current permission context, assign bounded internal rule IDs, and call the existing executor without `Prediction.key`.
- [ ] Apply the existing predictor's confidence/feedback criteria before direct submission; inspect and reuse the current formula rather than bypassing it or creating a second policy. Maintain per-destination budgets and an event cap across sources.
- [ ] Write integration cases with two independent wrappers both named internally `upstream` and both exporting `read`. Prefetch into one and assert exactly that subsequent real call consumes the entry; the other process must miss.
- [ ] Test disconnects, tool-list changes, unknown/ambiguous routes, host-denied and approval-required tool/argument combinations for both clients, unverifiable host authorization, permission-context changes, strict/off modes, duplicate candidates, stale generations, queue expiry, and mutation while queued/in flight. Add generation fencing only where required to prevent old results from being published.
- [ ] Run focused bridge/proxy/executor/cache/wrapper tests and `npm run build`.

**Acceptance:** An external candidate reaches the correct existing cache, cannot inject a key or broaden tool eligibility, and never delays a real call while waiting for the observer.

## Task 3: Add session-local cross-server learning

**Files:** Create `src/sessionPredictor.ts`, `test/session-predictor.test.ts`; extend `src/sessionBridge.ts` and the real-call completion event in `src/proxy.ts`. Leave the stored learner schema unchanged.

**Consumes:** Registered routes and normalized `Observation` events.
**Produces:** `SessionPredictor.observe(event: Observation): Candidate[]`, `invalidate(routeIds: string[]): void`, and per-source feedback keyed by route generation.

- [ ] Write cases for an issue lookup followed by a workspace search, copied arguments, parsed-result argument derivation, two separate conversations, overlapping calls, route restart, and duplicate hook/wrapper events.
- [ ] Run `npm test -- test/session-predictor.test.ts` and confirm the cross-server case fails before implementation.
- [ ] Reuse `TransitionLearner`: represent each live route by its opaque ID as the tool name, use one synthetic server per conversation, and map output back to registered destinations. Do not pass these candidates through the existing same-server-only predictor validator.
- [ ] Feed only completed real calls. Preserve host order when available; suppress adjacency across overlapping calls whose order is ambiguous. Do not learn from speculative runs or count one real result twice.
- [ ] Keep the new learner session-local with the design's caps. Drop route-derived state on disconnect/mutation and never persist raw observation fields.
- [ ] Verify the underlying `test/learner.test.ts` and `test/persistence.test.ts` still pass, then run the session tests and build.

**Acceptance:** A repeated cross-server workflow can prefetch the destination into its owning cache without changing existing same-server learning or persisted formats.

## Task 4: Implement transparent transport and the Claude adapter

**Files:** Create `src/llmProxy.ts`, `src/agentAdapters/claude.ts`, `test/llm-proxy.test.ts`, `test/claude-adapter.test.ts`.

**Consumes:** Launch/session contracts, Task 1 fixtures, bridge event sink.
**Produces:** `startLlmProxy({ upstreamBaseUrl, adapter, onObservation })` returning `{ baseUrl, close }`; `claudeAdapter` implementing request, stream, hook, and launch normalization. Define the shared adapter interface in `observerTypes.ts` alongside these contracts before Task 5 starts.

- [ ] Add transport tests asserting exact request/response body buffers and preserved end-to-end headers, including unknown fields. Feed headers/body without reserializing model JSON. Remove only hop-by-hop transport headers where required.
- [ ] Add byte-split SSE tests across UTF-8 and JSON boundaries, slow-reader backpressure, observer exceptions, oversized bodies, cancellation, `401`, `429`, `5xx`, and abrupt upstream disconnect. Prove a later observer event cannot delay an already available response chunk.
- [ ] Run `npm test -- test/llm-proxy.test.ts test/claude-adapter.test.ts` to confirm failures, then implement Node HTTP/HTTPS forwarding with independently bounded observation work.
- [ ] Support Messages and required count/model-discovery/pass-through endpoints identified in Task 1. Preserve incoming beta/version/auth headers, original configured endpoint, model selection, and cache-sensitive request bytes.
- [ ] Normalize complete request context and call blocks to shared observations. Do not execute provider-owned tools or touch reasoning blocks. Candidate generation remains disabled until Task 6.
- [ ] Bind only loopback, constrain upstream origin, disable cross-origin credential redirects, and keep IPC authorization separate from forwarded provider credentials.
- [ ] Run focused tests and build. Confirm startup, active cancellation, and shutdown free all sockets/timers.

**Acceptance:** Claude's model path functions identically through the relay with observation enabled or disabled, while malformed observations merely reduce coverage. This is not yet a standalone release.

## Task 5: Implement Codex Responses and WebSocket parity

**Files:** Create `src/agentAdapters/codex.ts`, `test/codex-adapter.test.ts`, `test/codex-websocket.test.ts`; extend `src/llmProxy.ts`, `src/observerTypes.ts`; update `package.json`/`package-lock.json` only for the selected WebSocket transport dependency.

**Consumes:** Shared adapter/relay interface and Codex fixtures.
**Produces:** `codexAdapter` with the same capabilities and event contracts as `claudeAdapter` plus Responses WebSocket support.

- [ ] Reuse the same byte-preservation/error/backpressure tests with Codex fixtures; add function-call argument deltas, completed items, opaque reasoning, tool namespaces, deferred definitions, and free-form code-tool passthrough.
- [ ] Add WebSocket tests for upgrade headers, frame/message ordering, ping/pong, close/error propagation, cancelled generation, incremental `previous_response_id`, multiple stream IDs, and reconnection without reusing old route generations.
- [ ] Run `npm test -- test/codex-adapter.test.ts test/codex-websocket.test.ts` and confirm failures before adding the implementation.
- [ ] Forward Responses JSON/SSE and WebSocket traffic using a maintained Node-compatible library. Preserve the client's selected transport; do not claim support by forcing HTTP or creating a fresh upstream socket for every continuation.
- [ ] Implement the verified per-launch provider override from Task 1. Preserve custom-provider auth sources and native ChatGPT account routing separately; never substitute an API key for a subscription. Do not override reserved built-in provider tables.
- [ ] Keep any incremental observation reconstruction bounded and local. Missing prior context must cause abstention, not rewriting the request or pretending to have the full conversation.
- [ ] Run both adapters' tests, all relay tests, and build. Execute the Task 1 native-account/API fixture and live smoke matrix for both clients before closing the compatibility milestone.

**Acceptance:** Both clients reach their original providers/accounts, preserve models and transport semantics, and produce the same normalized observations for equivalent fixture workflows. An unverified Codex transport/auth path blocks parity completion.

## Task 6: Add explicit-intent and completed-stream candidates

**Files:** Extend `src/sessionPredictor.ts`, both adapters, and `src/observerTypes.ts`; create `test/observer-signals.test.ts`.

**Consumes:** Current prompt events, complete streamed tool-call events, live routes/schemas, existing profile argument mappings.
**Produces:** `intent` and `stream` candidates through the exact same validated ingress as cross-server predictions.

- [ ] Write paired Claude/Codex fixtures for an explicitly requested PR URL, a requested workspace directory listing, missing/ambiguous repository identity, quoted/negated instructions, unknown tools, and unsupported shell/code syntax.
- [ ] Add streaming cases where a JSON prefix parses but arguments are not yet complete; no candidate may issue until the provider's completion boundary. Include multiple interleaved call IDs and a completed call whose eventual real request has different arguments.
- [ ] Run `npm test -- test/observer-signals.test.ts test/session-predictor.test.ts` and confirm the intended new cases fail.
- [ ] Implement only deterministic extractors with fully materialized, schema-valid args. Match known live profile/tool capabilities; never fetch a URL solely because text contains one. No model call, dynamic code evaluation, or hidden reasoning inspection is introduced.
- [ ] Deduplicate repeated history, hook/proxy copies, and repeated stream events by stable source identity; preserve later intentional repeated calls. Preserve current single-use cache semantics.
- [ ] Attribute outcomes by client and signal, reuse feedback suppression, and measure the time between candidate issue and actual dispatch. Do not count speculative completion as a hit.
- [ ] Run signal, adapter, bridge, and predictor tests and build.

**Acceptance:** A read can begin before the first host tool dispatch on both clients, and stream-only improvements are measurable independently from existing prefetch and hook context.

## Task 7: Ship symmetrical launch, hook, and diagnostics paths

**Files:** Create `src/runAgent.ts`, `plugin/hooks/session-observer.mjs`, `test/run-agent.test.ts`, `test/session-hook.test.ts`; modify `src/cli.ts`, both adapters, and `src/hostConfig.ts` only where temporary alias/bridge metadata is required.

**Consumes:** Both adapters, bridge, predictor, relay.
**Produces:** `parseRunArgs(argv)`, `runAgent(args)`, `buildLaunchPlan(context)` on each adapter, and the six command variants in the design.

- [ ] Add parser and real-process fake-client tests for both clients, all observer modes, `--` argument forwarding, invalid client/mode, missing executable, selected model/provider preservation, and exit/signal propagation.

```ts
it.each(['claude', 'codex'] as const)('parses %s symmetrically', (agent) => {
  expect(parseRunArgs([agent, '--observe', 'proxy', '--', '--help']))
    .toEqual({ agent, observe: 'proxy', clientArgs: ['--help'], jsonReport: null });
});
```

- [ ] Run `npm test -- test/run-agent.test.ts test/session-hook.test.ts` and confirm failures.
- [ ] Route the explicit public `run <client>` command through a distinct internal `agent-run` discriminator. The CLI already uses internal `run` for its implicit MCP-proxy mode; preserve `speculate --config <path>` and its existing dispatch.
- [ ] Build temporary per-client launch configuration through supported controls. Reuse Claude `buildTryConfig`; implement a separate Codex config reader/override within its adapter rather than converting or renaming existing Claude management files.
- [ ] Preserve inherited unwrapped/remote MCP entries and host approval state. Start only servers the host already permits. Independently require host tool/argument preauthorization before a speculative call; server launch consent alone is not execution consent. Register bridge metadata only for wrappers that the launch actually owns.
- [ ] Install prompt/tool/session observation hooks through the verified temporary configuration path for each client. The standalone sender emits no model-visible stdout/context and cannot approve/block/rewrite a tool. Drop delivery after 20 ms and let the host continue.
- [ ] Implement `--json-report <path>` and bounded per-source session summary. Reuse existing rule accounting; keep transport overhead and coverage separate from estimated tool savings. Include report schema version, client version, mode, transport, measurements, and disabled-capability reasons only.
- [ ] Before launching in proxy mode, preflight endpoint and relay health. On preflight failure explain the issue and launch through the original route with hook mode; report that proxy observation is inactive. Do not change billing/auth to make the launch work.
- [ ] Test existing `try/on/off/status/update/wrap` paths, both new launch paths, malformed configuration, cleanup on signals, and two concurrent launches in the same workspace.

**Acceptance:** Users get the same setup and reporting experience on both clients, without durable host changes or a misleading active-proxy status.

## Task 8: Verify workspace and native command consumption on both clients

**Files:** Extend `test/shell-integration.test.ts`, `test/run-agent.test.ts`, `test/session-hook.test.ts`; if the native gate passes, modify `src/execDaemon.ts`, `src/execClient.ts`, and host-specific hook payload handling; extend `test/execDaemon.test.ts`/`test/execClient.test.ts`.

**Consumes:** The live workspace MCP path, current command classifier/cache, host hook and permission contracts.
**Produces:** Verified workspace MCP acceleration for both clients; native acceleration only if the paired gate below passes.

- [ ] Prove an identical workspace MCP read can be prefetched and consumed through each client's real tool path. Assert stdout/stderr/exit behavior, cwd, filesystem invalidation, and no duplicate underlying execution.
- [ ] Test native hook rewriting against each host's actual permission evaluation. Include previously denied commands, commands requiring approval, sandbox restrictions, altered cwd/env, login-shell state, complex syntax, and missing binaries. A Codex hook `allow` must not be used to manufacture permission parity.
- [ ] If unchanged authorization and execution equivalence are demonstrated on both, add a separate bounded daemon `prefetch` operation using `classify`/`materialize` and `beginSpeculative`. Never use `exec` for speculative requests. Apply aggregate concurrency/rate limits and per-session namespace/generation in the existing workspace daemon so both the prediction and the eventual `exec` lookup address the same cache namespace.
- [ ] If that proof fails, leave native execution unchanged on both new adapters and record the unsupported optimization. Do not issue observer-native prefetches that cannot be consumed; both clients retain required workspace MCP support and native-call observation.
- [ ] Run `npm test -- test/shell-integration.test.ts test/execDaemon.test.ts test/execClient.test.ts test/session-hook.test.ts test/run-agent.test.ts` and build.

**Acceptance:** Both clients have a demonstrated consumption path for every advertised acceleration. No command is run early in a different environment, or treated as authorized because a model emitted it.

## Task 9: Prove lifecycle, isolation, and recovery

**Files:** Create `test/observer-recovery.test.ts`; extend bridge/relay/adapter integration tests and fix only demonstrated gaps in the owning modules.

**Consumes:** Integrated launch paths and both adapters.
**Produces:** Equal failure behavior and bounded cleanup on both clients.

- [ ] Add paired fixtures for concurrent sessions, subagent interleaving, resumed sessions, auth-header refresh, changed model, provider retry, cancelled tool/model requests, observer callback failure, relay death, stale sockets, and wrapper restarts.
- [ ] Verify locally observed interrupted/unknown write calls invalidate session candidates at start and settle, queued stale work never executes after invalidation, and late speculative results cannot repopulate an invalidated cache. Control/invalidation messages bypass the droppable prediction queue. Test dropped hook start/settle events separately: detected delivery gaps invalidate session candidates, and undetected native/external changes remain subject to documented TTL/watcher bounds. Do not assert an absolute freshness guarantee for unobserved changes.
- [ ] Verify callback/queue failures leave the relay forwarding; relay-process failure is surfaced and restarted without replaying partially forwarded requests. The client owns inference retry. The next fresh launch must not retain a dead endpoint override.
- [ ] Assert temporary config permissions and cleanup, no credentials in logs/reports, bounded observer state, and no duplicate durable usage accounting. Test cleanup after failed child spawn and forced termination where cleanup is deferred to next startup.
- [ ] Run all observer and existing regression tests, `npm run build`, and `git diff --check`.

**Acceptance:** Recovery claims match demonstrated behavior; neither host can receive another launch's cached result or suffer hidden prompt/model/config changes.

## Task 10: Measure benefit and prepare the paired release

**Files:** Create `bench/observer.ts`, `bench/observer-workflows.ts`, `test/observer-benchmark.test.ts`, `docs/observer-results.md`; update `README.md` and `docs/observer-compatibility.md`.

**Consumes:** Stable host versions, both adapters, independent baseline/experiment modes, design thresholds.
**Produces:** Reproducible per-client results and an explicit enable/retain-experimental/remove decision per signal.

- [ ] Implement the A/B/C/D/E comparison specified in the design. Keep all three candidate sources independently switchable inside the benchmark harness; public CLI modes remain simple. Tag every measurement with client/version, model/effort, signal set, cold/warm state, workflow, and repetition.
- [ ] Add benchmark correctness tests for head-start math, percentile/interval calculation, dedup attribution, expired waste accounting, and no saved-time claims for unused results.
- [ ] Run at least 20 held-out workflows × 5 repetitions per client/arm in deterministic replay, with independently seeded training and randomized order. Report per-workflow as well as aggregate results; do not tune on the held-out set.
- [ ] Run native account and API-key live smoke cases for both clients, then representative matched live tasks with token/tool usage and actual task correctness recorded. Mark skipped credentials/versions unverified, not passed.
- [ ] Apply the fixed gates: zero correctness/consent/isolation failures; no extra predictor model calls; at most 5 ms p95 local relay overhead; at least 10% median improvement versus current Speculate for each client with 95% interval excluding zero; at most 5% p95 regression on mixed tasks; at most 20% waste after settlement.
- [ ] Evaluate proxy/stream increments against hook mode, not only against no Speculate. If those increments fail, keep the observer explicitly experimental or remove the unhelpful signal. Do not silently relax either client's criteria.
- [ ] Write equal Claude/Codex examples, tested compatibility rows, credential-preservation behavior, measured results, known limitations, and recovery instructions. Label all estimated versus measured values.
- [ ] Run final `npm run build`, `npm test`, `npm run test:scenarios`, `npm run bench -- --latency 400`, and the new observer benchmark. Run `git diff --check`; inspect the diff for scope and accidental user/customer identifiers before any later commit/PR.

**Acceptance:** Release readiness is established independently for both clients. Publishing itself is outside this plan execution; report the concrete validated change and any remaining failed gates.

## Plan review and execution notes

- The first implementation task resolves host-version/auth/hook contracts through evidence; neither an API-compatible endpoint nor a successful mock is proof of native subscription support.
- Both clients are present in the initial fixtures, adapters, launcher, diagnostics, recovery tests, and results. One cannot be deferred to a follow-up release.
- The bridge fixes the specific lost-alias/cache-owner problem without replacing MCP runtimes or modifying persistent learner schemas.
- New observation never calls `exec` to prefetch, accepts a caller cache key, bypasses feedback, or infers authorization from a model response.
- Hooks provide a lower-cost comparison point; an LLM proxy must justify its incremental complexity and latency.
- This document defines future verification commands. This planning pass does not claim those tests or performance gates have passed.
