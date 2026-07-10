# Speculate — Design Document

**Status:** Draft for review
**Last updated:** 2026-07-10

Speculate is a transparent MCP proxy that reduces perceived agent latency by *speculatively prefetching read-only tool calls* — predicting what the agent will ask for next and having the answer cached before it asks.

---

## 1. Problem

Agentic loops are dominated by two kinds of waiting: model generation and tool round-trips. Tool round-trips are pure dead weight from the user's perspective — a GitHub API call costs 300–800 ms, a Slack search or warehouse query can cost seconds, and a single agent turn commonly chains 3–10 such calls sequentially. The model cannot reason about results it doesn't have, so these latencies stack up serially even in otherwise fast harnesses.

At the same time, an agent session is full of idle windows in which the upstream servers sit unused:

| Window | Typical duration | What's happening |
|---|---|---|
| User is typing / reading | seconds to minutes | Nothing. Servers idle. |
| Model is generating reasoning/text before a tool call | 1–10 s | Nothing. Servers idle. |
| Between chained tool calls in one turn | per-call | Only one call in flight. |

Tool-call sequences are also highly predictable. Agent workflows are workflow-shaped: `get_issue` → `list_pull_requests`; `list_*` → `get_*` on a returned item; read a file → read its siblings or its test file. This combination — serial latency, idle capacity, predictable next actions — is exactly the setup in which speculative prefetching pays for itself (CPUs, browsers, and Gmail all exploit the same structure).

## 2. Goals and non-goals

### Goals

1. **Cut perceived tool-call latency** for read-only calls that Speculate correctly predicted — a cache hit should return in ≤10 ms proxy overhead instead of the upstream round-trip.
2. **Work with any MCP client and any MCP server, unmodified.** The proxy speaks standard MCP on both sides. No SDK, no harness plugin, no server changes.
3. **Be provably harmless.** A wrong prediction must never change any system's state, never corrupt a result, and never make a real call slower in any meaningful way.
4. **Be observable.** Operators must be able to see hit rate, wasted-call rate, latency saved, and upstream quota consumed by speculation.

### Non-goals

1. **Speculating on state-mutating tools — permanently out of scope.** Speculation is only ever safe for reads. This is not an MVP restriction to relax later; executing a `create_*`/`update_*`/`delete_*` call the agent never made is unacceptable regardless of how confident the prediction is. (Serving *cached reads* is a freshness trade-off; *executing writes* speculatively is a correctness violation.)
2. **Reducing token usage.** The model still reads the same results; the win is wall-clock, not tokens.
3. **Auth ownership.** Speculate forwards the session's existing credentials to upstream servers; it does not mint, store, or broker credentials beyond what a normal MCP proxy holds in memory for the session.
4. **General-purpose response caching for correctness-sensitive reads.** Speculate's cache is a short-lived speculation buffer, not a CDN. When in doubt it misses.
5. **Multi-tenant cache sharing.** Cache entries are strictly per-session (see §6.4, security).

## 3. Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                  Speculate                   │
                       │                                              │
 ┌────────────┐  MCP   │  ┌─────────┐   ┌─────────┐   ┌────────────┐  │  MCP   ┌──────────────┐
 │ MCP client │ ◄────► │  │ Router  │──►│  Cache  │   │ Upstream   │  │ ◄────► │ MCP servers  │
 │ (any host) │        │  │         │   │ (per-   │   │ connection │  │        │ (GitHub,     │
 └────────────┘        │  │         │◄──│ session)│◄──│ pool       │  │        │  Slack, DB…) │
                       │  └────┬────┘   └─────────┘   └─────┬──────┘  │        └──────────────┘
                       │       │ observed traffic           │        │
                       │  ┌────▼──────────┐  predictions ┌──▼─────┐  │
                       │  │ Prediction    │─────────────►│ Specu- │  │
                       │  │ engine        │              │ lation │  │
                       │  │ (pluggable)   │              │ executor│ │
                       │  └───────────────┘              └────────┘  │
                       └──────────────────────────────────────────────┘
```

### 3.1 Components

**Router.** Terminates the client's MCP connection, aggregates one or more upstream servers behind a single endpoint (namespacing tools as `server__tool` when aggregating), and forwards every request. For `tools/call`: check cache → on fresh hit, return cached result; on miss, forward upstream and return the live result. Everything that is not a cacheable `tools/call` (initialization, resources, prompts, notifications, sampling, unannotated tools) passes through untouched.

**Prediction engine.** Consumes the stream of observed calls (tool name, normalized arguments, timestamps, results metadata) and emits *predictions*: `(tool, concrete_args, confidence)` triples. Pluggable, with three built-in tiers (§5).

**Speculation executor.** Takes predictions, filters them through the safety policy (§4), deduplicates against the cache and in-flight speculative calls, applies budgets (§7), and executes survivors against upstream servers, writing results into the cache. Speculative traffic is strictly lower priority than real traffic: real calls are never queued behind speculative ones, and in-flight speculation yields connection-pool capacity to real calls.

**Cache.** Per-session, in-memory, keyed by `(server, tool, canonical_json(args))` with per-tool TTLs and event-based invalidation (§6).

### 3.2 Deployment shapes

- **Local sidecar (MVP):** a single binary/process on the developer's machine. Client config points at Speculate over stdio or streamable HTTP; Speculate's config lists upstream servers exactly the way the client's config used to.
- **Shared gateway (later):** one Speculate instance in front of an organization's MCP servers. Requires per-session identity plumbing and stricter cache isolation; out of MVP scope.

### 3.3 What flows through where

A key property: **Speculate degrades to a plain transparent proxy.** If the prediction engine is disabled, crashes, or has no opinion, every call behaves exactly as if the proxy weren't there (plus sub-millisecond forwarding overhead). Speculation is purely additive on the read path.

## 4. Safety policy: read-only, provably

The single most important design rule: **a speculative call may only be issued if Speculate has affirmative evidence the tool is read-only.** The failure mode being prevented — speculatively firing a mutation the agent never requested — is unrecoverable, so the policy is default-deny.

Eligibility is the conjunction of:

1. **MCP annotation check.** The tool's declared annotations must include `readOnlyHint: true`. Tools with no annotations, or with `readOnlyHint` absent/false, are ineligible. (Annotations are untrusted *hints* per the MCP spec, which is why this check alone is insufficient — hence layer 2.)
2. **Operator policy.** A config-level allowlist/denylist with three modes:
   - `strict` (default): only tools that are both annotated `readOnlyHint: true` **and** explicitly allowlisted by the operator are eligible.
   - `annotated`: any tool annotated `readOnlyHint: true` is eligible unless denylisted. For servers the operator trusts to annotate honestly.
   - `off`: no speculation; pure pass-through proxy.
3. **Ships with vetted profiles.** Speculate bundles reviewed allowlist profiles for popular servers (GitHub, filesystem, Slack, web-fetch/search…) so `strict` mode is usable out of the box.

Additional hard rules, regardless of mode:

- **Real calls are never blocked, transformed, or reordered** — including mutations. Speculate is a proxy first.
- **Speculative results are never fabricated or merged.** A cache hit returns exactly the bytes the upstream server returned earlier; a miss goes upstream. Speculate never synthesizes tool output.
- **Tool-side effects we can't see:** even a "read" can have side effects (audit-log entries, read receipts, usage-based billing, rate-limit consumption). This is exactly why `strict` mode requires human allowlisting and why per-server budgets exist. Vetted profiles must exclude reads with user-visible side effects (e.g. anything that marks messages as read).
- **Error results are cacheable only briefly and never for auth errors.** A speculative call that fails with an auth/permission error is dropped (not cached) and that tool is circuit-broken for the session, so speculation can't mask or amplify permission problems.

## 5. Prediction engine

Predictions must name a tool **and concrete arguments** — "the agent will probably look at PRs" is useless unless it becomes `github__list_pull_requests({repo: "acme/api", state: "open"})` that byte-matches (after canonicalization) the agent's eventual call. Argument prediction is the hard part, and hit rate lives or dies on it. Three tiers, composable and pluggable:

### Tier 1 — Static co-occurrence rules (MVP)

Hand-written, per-server-profile rules of the form *"after call X with args A, predict calls Y₁…Yₙ with args derived from A and X's result."* Examples from the GitHub profile:

- `get_issue(owner, repo, n)` → `list_pull_requests(owner, repo, state: open)`, `issue_read(comments)(owner, repo, n)`
- `list_pull_requests(...)` → `pull_request_read(get)(...)` for the first K PRs in the result
- `get_file_contents(path)` → `get_file_contents(dir(path))` sibling listing

Rules may reference the *result* of the trigger call (e.g. "the PR numbers that came back"), which is where much of the argument-prediction power comes from. Deterministic, auditable, zero added latency. Expected to capture the bulk of the win for workflow-shaped servers.

### Tier 2 — Learned transition model (post-MVP)

A per-user/per-project Markov-style model over normalized call n-grams: `P(next_call | last_k_calls)`, learned from the session log. Catches user-specific and project-specific patterns static rules miss. Argument prediction via templates learned from co-occurring argument values (same `repo` propagates; entity IDs flow from results to subsequent args). Cold-start: falls back to Tier 1.

### Tier 3 — Small-LLM predictor (post-MVP, optional)

On idle (user typing) or after each turn, ship the recent conversation window + available read-only tool list to a small fast model (e.g. Haiku-class) prompted to emit the 1–3 most likely next calls with full arguments. Highest ceiling (it can read intent, not just call patterns), highest cost, and it adds its own latency/token spend — so it runs only in idle windows, never on the critical path. Requires an API key and an explicit opt-in, since it exfiltrates conversation traffic to a model provider the upstream servers didn't know about.

### 5.1 When prediction runs

- **On each completed real call** (the main trigger; predict follow-ups from the call+result).
- **On turn boundaries** — when the client goes quiet after a burst of calls, predict the *next turn's* opening reads (Tier 2/3 territory).
- Never on the critical path of a real call. Prediction work is async and yields to real traffic.

### 5.2 Confidence and ranking

Each predictor emits confidence scores; the executor takes predictions in descending confidence until the budget (§7) is exhausted. Observed hit/waste rates per rule feed back into scores (a rule that never hits gets suppressed) — this feedback loop is in-scope for MVP in its simplest form (per-rule hit counters).

## 6. Cache semantics

The cache is a **speculation buffer**, not a general cache: small, short-lived, per-session, biased toward missing rather than serving anything questionable.

### 6.1 Keying and canonicalization

Key = `(server, tool, canonical_args)`. Canonicalization: JSON with sorted keys, defaults materialized from the tool's input schema (so `{state: "open"}` and omitted-but-default `state` collide correctly), obvious normalizations (case-insensitive enum values where the schema says so). No fuzzy matching in MVP — near-miss args are a miss. Fuzzy/subsumption matching (e.g. a cached `limit: 50` list serving a `limit: 10` request) is a possible later optimization with real correctness pitfalls; explicitly deferred.

### 6.2 Freshness

- **Per-tool TTL** from the server profile, defaulting to **30 s**, capped at a few minutes. The prefetch-to-use gap is typically seconds, so short TTLs retain most of the win while bounding staleness.
- **Session-scoped mutation invalidation:** any *real* mutating call through the proxy to server S invalidates all cached entries for S (coarse by design; per-resource invalidation is a profile-level refinement later). This gives read-your-own-writes within the session for everything the agent does *through the proxy*.
- **External writes are invisible.** Someone else can merge the PR between prefetch and use; the agent then sees a ≤TTL-stale snapshot. This is the core freshness trade-off and it's bounded by the TTL. It is identical in kind to the race that already exists between a live tool call and the model acting on it — the TTL just widens that window slightly. Per-tool TTLs let operators set 0 (never speculate) for reads where even seconds of staleness matter.
- **A cache hit consumes the entry** (single-use). If the agent asks the same thing twice, the second ask goes upstream (unless re-prefetched). This keeps semantics close to "you got the answer a bit early" rather than "you got a cached worldview." Single-use is deliberately conservative for the MVP; relaxing to TTL-bounded multi-use per tool profile is a later option — an idempotent read within its TTL is semantically the same answer, so the conservatism buys simplicity more than correctness.

### 6.3 Consistency stance (explicit)

Speculate provides, per session: **read-your-own-writes** (via mutation invalidation) and **bounded staleness** (≤ TTL) for external changes. It does not provide cross-session consistency or monotonic reads across different tools. This stance is documented user-facing, per server profile.

### 6.4 Security properties of the cache

- Per-session only; two clients never share entries even if arguments match, because upstream authorization may differ.
- In-memory only; no persistence of tool results to disk.
- Results are stored with the identity/credential fingerprint they were fetched under; a credential change (re-auth, token refresh with scope change) flushes the session cache.

## 7. Budgets, rate limits, and backpressure

Speculation spends someone's quota. It must be visibly and configurably bounded:

- **Per-server concurrency cap** for speculative calls (default: 2) and **per-turn call cap** (default: 5 speculative calls per observed real call, across all rules).
- **Rate-limit awareness:** profiles declare how to read the server's rate-limit state where the API exposes it in a way that passes through MCP responses; otherwise operators can set a hard speculative-calls-per-minute budget per server (default when unknown: conservative, e.g. 30/min). When remaining quota falls below a floor (default 20%), speculation for that server stops entirely — real calls get the quota.
- **Cost accounting:** every speculative call is logged as such. The dashboard (§9) shows waste explicitly. Nothing about speculation is silent.
- **Kill switch:** `off` mode at runtime (config reload or admin endpoint) instantly reverts to pass-through.

## 8. Latency model (why this wins)

Let a turn contain `n` sequential eligible reads with mean upstream latency `L`. Perceived tool time ≈ `n·L`. With hit rate `h` on those reads, perceived time ≈ `n·(1−h)·L + n·h·ε` where `ε` ≈ cache-read + proxy overhead (target ≤10 ms).

Illustrative (not measured): GitHub-backed code-review turn, `n = 6`, `L = 500 ms` → 3.0 s of tool waiting. Tier-1 rules hitting half the reads (`h = 0.5`) cut that to ≈ 1.5 s per turn, every turn. The MVP ships with a benchmark harness (§10) precisely so real numbers replace this arithmetic.

Two structural notes:

- The **between-turn window** (user typing/reading) is seconds-to-minutes long — far longer than any prefetch needs — and is invisible to the user. Speculation that lands there is effectively free latency-wise; its only cost is upstream quota.
- As harnesses get better at *parallelizing* the calls the model already knows it wants, the marginal win shrinks for intra-turn chains but not for the between-turn window: the harness cannot parallelize a call the model hasn't emitted yet. Speculation and parallelization are complementary, and both remain serial-bounded by result-dependent chains (can't fetch PR #42's diff until something returns "42" — unless a rule predicted it from an earlier result, which is exactly what Tier 1 does).

## 9. Observability

MVP ships with:

- **Structured log** of every speculative decision: prediction source, confidence, executed or suppressed (and why), hit/expired/invalidated/wasted outcome.
- **Session summary + `/stats`:** hit rate, wasted calls, estimated wall-clock saved (sum of upstream latencies of hits), speculative quota consumed per server.
- **Standard MCP-level logs** for the proxy function itself.

The honest metric to watch is **estimated seconds saved per wasted call** — it prices the trade-off directly and decides whether a rule (or the whole tool, for a given workload) is worth it. Hit rate has no universal target; a 20%-hit rule that saves 2 s per hit at trivial quota cost is worth keeping, and the per-rule feedback loop (§5.2) suppresses rules that don't pay.

## 10. MVP scope

**In (v0.1):**

1. Single-binary local proxy (Go or TypeScript — decision pending; Go favored for single-static-binary distribution and concurrency ergonomics, TS favored for MCP SDK maturity), stdio + streamable-HTTP client transport, N upstream servers (stdio + HTTP), tool namespacing.
2. Safety policy: `strict` / `annotated` / `off`; annotation check; allowlist/denylist config.
3. Tier-1 static rule engine with result-referencing rules; simplest per-rule hit-rate feedback (§5.2).
4. **One vetted profile: GitHub** (rules + read-only allowlist + TTLs) — chosen because its workflows are the most predictable and it's the demo everyone understands. Filesystem/Slack profiles follow post-MVP.
5. Per-session in-memory cache: canonical keying, TTL, single-use hits, mutation invalidation, credential-change flush.
6. Budgets: concurrency cap, per-turn cap, per-minute per-server budget, quota floor where visible, kill switch.
7. Observability: decision log, `/stats`, session summary.
8. Benchmark harness: scripted agent sessions replayed with speculation on/off, reporting per-turn wall-clock, hit rate, waste. (Predictability of the benchmark's scripted workflows will overstate real-world hit rate; the harness should include at least one adversarial/low-predictability script so the floor is measured too, and real-world numbers come from §9 telemetry.)

**Out (explicitly):**

- Tier-2/Tier-3 predictors; shared/multi-tenant deployment; fuzzy cache matching; resource/prompt prefetching (MCP resources with subscriptions are arguably *better* suited to prefetching than tools — deliberately deferred, tools first); persistence; per-resource invalidation; any speculation on non-read-only tools (permanent).

**MVP success criteria:**

- On the benchmark's GitHub workflows: ≥40% hit rate on eligible reads, ≥30% reduction in per-turn tool wall-clock, waste ≤2 speculative calls per hit — measured against the harness's optimistic bias (see §10.8), with real-world validation via §9 telemetry.
- Zero mutations ever issued speculatively (asserted by test suite: a mock server that fails the run if any non-allowlisted tool is called speculatively).
- Pass-through overhead ≤ 5 ms p99 on real calls.

## 11. Market research & prior art

*(Research pass in progress — this section will be populated with findings on existing MCP proxies/gateways, caching middleware, academic work on speculative agent execution, and an assessment of novelty before this doc is considered review-ready.)*

## 12. Risks and open questions

| # | Risk / question | Current position |
|---|---|---|
| 1 | **Low hit rate in the wild** — real usage may be less workflow-shaped than benchmarks. | Benchmark honestly (incl. adversarial scripts), ship per-rule feedback, treat GitHub profile as the proving ground. If Tier 1 can't clear ~30% there, revisit before building Tier 2/3. |
| 2 | **Argument mismatch** — agent asks with slightly different args than predicted. | Canonicalization + defaults materialization in MVP; measure near-miss rate explicitly (log key distance on misses) to size the fuzzy-matching opportunity before building it. |
| 3 | **Stale reads mislead the agent.** | Short TTLs, single-use hits, mutation invalidation, per-tool TTL=0 opt-out. Staleness is bounded and documented; identical in kind to pre-existing read-then-act races. |
| 4 | **Quota/cost blowup on busy servers.** | Default-conservative budgets, quota floor, waste metrics on the dashboard, kill switch. |
| 5 | **Reads with side effects** (read receipts, audit noise, metered billing). | `strict` mode + vetted profiles exclude them; documented reviewer checklist for profile contributions. |
| 6 | **Dishonest/wrong `readOnlyHint` annotations.** | `strict` mode doesn't trust annotations alone (allowlist required); `annotated` mode is opt-in per deployment. |
| 7 | **Client-visible protocol quirks** — MCP progress notifications for calls that were prefetched can't be replayed meaningfully. | Cached hits return final results without intermediate progress events; believed benign (clients must handle absent progress anyway — it's optional in the spec) but needs verification against real clients in MVP testing (Claude Code, Cursor at minimum). |
| 8 | **Where does turn-boundary detection come from?** MCP has no "user is typing" signal. | MVP proxies infer idle from traffic quiescence (no requests for T ms). Good enough for between-turn prefetch triggered by the *last* call of a turn; true typing signals would need host cooperation (out of scope). |
| 9 | **Language/runtime choice** (Go vs TypeScript). | Decide at MVP kickoff; §10.1 lists the trade-off. Leaning Go. |
| 10 | **Sampling/elicitation pass-through** — MCP server→client requests (sampling, elicitation) must traverse the proxy correctly, including for speculative calls. | Speculative calls that trigger server→client requests are **aborted, not surfaced** (the client never asked, so nothing may reach it); such tools get circuit-broken for the session. Pass-through for real calls is table stakes and in MVP tests. |

## 13. Review checklist (what "this design makes sense" means)

- [ ] A wrong prediction can never mutate state — enforced by default-deny eligibility, not by prediction quality.
- [ ] A disabled/failed speculation subsystem leaves a correct transparent proxy.
- [ ] Staleness is bounded, documented, and per-tool tunable to zero.
- [ ] Speculation cost is capped, measured, and visible.
- [ ] The MVP is small enough to build and honest enough to falsify the core hypothesis (hit rate ≥ ~40% on workflow-shaped servers).
