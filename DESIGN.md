# Speculate — Design Document

**Status:** Draft for review (v2 — revised after adversarial design review)
**Last updated:** 2026-07-10

Speculate is a transparent MCP proxy that reduces perceived agent latency by *speculatively prefetching read-only tool calls* — predicting what the agent will ask for next and having the answer cached (or already in flight) before it asks.

---

## 1. Problem

Agentic loops are dominated by two kinds of waiting: model generation and tool round-trips. Tool round-trips are pure dead weight from the user's perspective — a GitHub API call costs 300–800 ms, a Slack search or warehouse query can cost seconds, and a single agent turn commonly chains 3–10 such calls sequentially. The model cannot reason about results it doesn't have, so these latencies stack up serially even in otherwise fast harnesses. Published measurements back this up: serving-system studies attribute [35–61% of agent request time](https://www.arxiv.org/pdf/2510.16276) to tool execution, and for web-search-heavy research agents tool time averages [73% of end-to-end latency](https://arxiv.org/abs/2605.21965).

At the same time, an agent session is full of idle windows in which the upstream servers sit unused:

| Window | Typical duration | What's happening |
|---|---|---|
| User is typing / reading | seconds to minutes | Nothing. Servers idle. |
| Model is generating reasoning/text before a tool call | 1–10 s | Nothing. Servers idle. |
| Between chained tool calls in one turn | per-call | Only one call in flight. |

Tool-call sequences are also highly predictable. Agent workflows are workflow-shaped: `get_issue` → `list_pull_requests`; `list_*` → `get_*` on a returned item; read a file → read its siblings or its test file. This combination — serial latency, idle capacity, predictable next actions — is exactly the setup in which speculative prefetching pays for itself. CPUs, browsers, and Gmail all exploit the same structure, and a 2025–2026 wave of research systems has validated speculation on agent actions specifically (reported 20–50% latency cuts) — but all of it lives inside agent runtimes or inference engines; no shipping MCP proxy or gateway does it. **Appendix A** has the full market survey; the short version is that the mechanism is proven and the protocol-middleware layer is unoccupied.

## 2. Goals and non-goals

### Goals

1. **Cut perceived tool-call latency** for read-only calls that Speculate correctly predicted. Latency budgets: a completed-prefetch cache hit returns in **≤10 ms**; pass-through adds **≤5 ms p99** to real calls. (These two budgets are the only overhead numbers in this doc; §3, §8 and §10 reuse them.)
2. **Work with any MCP client and any MCP server, unmodified.** The proxy speaks standard MCP on both sides. No SDK, no harness plugin, no server changes. (What *is* client-visible — e.g. tool naming under aggregation — is enumerated honestly in §3.4.)
3. **Never invoke a state-mutating tool speculatively — enforced by default-deny eligibility, not prediction quality.** Residual risks that remain even with read-only speculation (server-side read side effects, intent disclosure, quota contention, transport-level queuing) are explicitly bounded, configured, and surfaced — see §4, §7, and the risk register (§11).
4. **Be observable.** Operators must be able to see hit rate, wasted-call rate, latency saved, and upstream quota consumed by speculation.

### Non-goals

1. **Speculating on state-mutating tools — permanently out of scope.** Speculation is only ever safe for reads. This is not an MVP restriction to relax later; executing a `create_*`/`update_*`/`delete_*` call the agent never made is unacceptable regardless of how confident the prediction is. (Serving *cached reads* is a freshness trade-off; *executing writes* speculatively is a correctness violation.)
2. **Reducing token usage.** The model still reads the same results; the win is wall-clock, not tokens.
3. **Auth ownership beyond what any MCP client holds.** For HTTP upstreams Speculate necessarily *is* the MCP client (including OAuth flows — §6.4); it does not mint or broker credentials beyond that, and for stdio upstreams it never even sees them.
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

**Router.** Terminates the client's MCP connection, aggregates one or more upstream servers behind a single endpoint (naming rules in §3.4), and forwards every request. For `tools/call`, three cases:

1. **Completed hit** — a fresh cache entry matches: return it (≤10 ms).
2. **In-flight join** — the matching speculative call is still executing upstream: the router *joins* it (awaits the same in-flight request) rather than firing a duplicate. The agent waits only for the remaining upstream time, and no extra quota is spent. This is the common case for intra-turn chains, where the prefetch head start is only the model's think time.
3. **Miss** — forward upstream and return the live result.

Everything that is not a cacheable `tools/call` (initialization, resources, prompts, notifications, sampling, unannotated tools) passes through untouched.

**Prediction engine.** Consumes the stream of observed calls (tool name, normalized arguments, timestamps, parsed results — §5.1) and emits *predictions*: `(tool, concrete_args, confidence)` triples. Pluggable, with three built-in tiers (§5).

**Speculation executor.** Takes predictions, filters them through the safety policy (§4), deduplicates against the cache and in-flight speculative calls, applies budgets (§7), and executes survivors against upstream servers, writing results into the cache. Speculative traffic is strictly lower priority than real traffic, with transport-specific enforcement:

- **HTTP upstreams:** real calls always get connection capacity first; speculative calls use spare concurrency only.
- **stdio upstreams:** a single child process on one pipe, and many community servers handle requests serially — an in-flight speculative call *cannot* be preempted (`notifications/cancelled` is advisory). So for stdio upstreams the executor issues a speculative call **only when no real request is pending or in flight for that server, at most one at a time**. Worst case, a real call arriving mid-speculation waits for one upstream call to drain; this bounded delay is the price of speculating on serial transports, it is measured (§9), and per-server `off` removes it entirely.
- **Drain queue (added during MVP benchmarking — §13):** predictions denied *only* by a busy slot are not dropped; they wait in a small per-server queue ordered by confidence and fire when the slot frees (a speculative call settles, or a real call completes — after mutation invalidation, never before). Queued predictions expire unfired after 5 s rather than firing stale, and are re-checked against policy/dedup at fire time. Without this, the idle-only rule silently discarded every prediction after the first on serial upstreams — measured cost: 14 points of hit rate on the benchmark workload.

**Cache.** Per-session, in-memory, keyed by `(server, tool, canonical_args)` with per-tool TTLs and event-based invalidation (§6).

### 3.2 Deployment shapes and session identity

- **Local sidecar (MVP):** a single binary/process on the developer's machine, spawned or connected by **exactly one client** — Speculate-instance-per-client is the MVP deployment model, stated as an assumption rather than enforced multi-tenancy. The *session* is the lifetime of that client connection/process. Client config points at Speculate over stdio or streamable HTTP; Speculate's config lists upstream servers exactly the way the client's config used to.
- **Shared gateway (later):** one Speculate instance in front of an organization's MCP servers, multiple clients. Requires a real session-identity layer (the 2026-07-28 stateless protocol removes `Mcp-Session-Id`, so identity must come from auth context) and strict per-identity cache isolation. Also note: multiple clients sharing one *spawned stdio upstream* would share that upstream's credentials — a second reason multi-client is deferred, not just unimplemented.

### 3.3 Degradation property

A key property: **Speculate degrades to a plain transparent proxy.** If the prediction engine is disabled, crashes, or has no opinion, every call behaves exactly as a proxied call — the only cost is the pass-through budget (≤5 ms p99, §2). Speculation is purely additive on the read path.

### 3.4 Protocol plumbing (the unglamorous load-bearing part)

What a builder hits in week one, specified up front:

- **Tool naming.** With a **single upstream** (common sidecar case), tool names pass through **unchanged**. With multiple upstreams, names stay unprefixed until they collide; colliding names get `server__tool` (operators can opt into always-prefix for stability). Honest client-visible caveat: any proxy changes the *server identity* the client sees — e.g. Claude Code permission rules keyed `mcp__github__*` become `mcp__speculate__*` once GitHub sits behind Speculate. That's inherent to proxying, unavoidable, and goes in user-facing docs and the migration guide.
- **Initialization & capability merging.** Speculate initializes with each upstream independently and negotiates with the client the protocol version it can actually translate for every upstream. Advertised capabilities are the union of upstream capabilities (tools, resources, prompts, logging, subscriptions), routed per-server; client capabilities (sampling, elicitation, roots) are forwarded to each upstream. Upstream `instructions` are concatenated with server labels.
- **Server-initiated traffic.** Notifications (`tools/list_changed`, resource updates, log messages) are fanned in, renamed per the naming rules, and forwarded. A `tools/list_changed` from server S flushes S's cache entries and re-runs eligibility (§4) against the new tool list. Server→client *requests* (sampling, elicitation) pass through transparently for real calls; for **speculative** calls they cause the call to be **aborted, never surfaced** (the client never asked, so nothing may reach it), and the tool is suspended from speculation (§4).
- **Progress/streaming.** Progress notifications for real calls pass through. Cached hits return final results without intermediate progress events — believed benign (progress is optional in the spec) but verified against real clients (Claude Code, Cursor) in MVP testing.
- **Unavailable upstreams.** An upstream that's down at client-initialize time simply contributes no tools; when it comes up, `tools/list_changed` announces its tools. No client-visible failure for servers the turn never touches.

## 4. Safety policy: read-only, default-deny

The single most important design rule: **a speculative call may only be issued if Speculate affirmatively classifies the tool as read-only.** The failure mode being prevented — speculatively firing a mutation the agent never requested — is unrecoverable, so the policy is default-deny: unknown means no.

A tool is **eligible** only if both conditions hold:

1. **Annotation check.** The tool's declared annotations include `readOnlyHint: true`. Tools with no annotations, or with `readOnlyHint` absent/false, are ineligible. (Annotations are formally *untrusted hints* per the MCP spec — the official guidance is explicit about this — which is why this check alone is insufficient; hence condition 2.)
2. **Operator policy**, one of three modes:
   - `strict` (default): the tool must **also** be on an explicit operator allowlist.
   - `annotated`: annotation alone suffices unless the tool is denylisted. For servers the operator trusts to annotate honestly. (Caveat: in this mode a *falsely* annotated tool is doubly dangerous — it becomes speculation-eligible *and* stops triggering cache invalidation (§6.2). This compounding is why `strict` is the default.)
   - `off`: no speculation; pure pass-through proxy.

To make `strict` usable out of the box, Speculate ships **vetted profiles** — reviewed allowlists + rules + TTLs for popular servers (GitHub first; filesystem, Slack, web-search to follow). Profile contributions follow a documented reviewer checklist.

Hard rules, regardless of mode:

- **Real calls are never blocked, transformed, or reordered** — including mutations. Speculate is a proxy first. (Transport-level queuing on serial stdio upstreams is bounded and mitigated per §3.1 — this is the one qualified exception, and it is a delay bound, not a semantic change.)
- **Speculative results are never fabricated or merged.** A cache hit returns exactly the bytes the upstream server returned earlier; a miss goes upstream. Speculate never synthesizes tool output.
- **Tool-side effects we can't see:** even a "read" can have side effects (audit-log entries, read receipts, usage-based billing, rate-limit consumption). This is exactly why `strict` mode requires human allowlisting and why per-server budgets exist. Vetted profiles must exclude reads with user-visible side effects (e.g. anything that marks messages as read). Gmail's own prefetching produces 1–6% "false opens" in email analytics — the cautionary example.
- **Speculation reveals intent.** A speculative call discloses to the upstream service — before the agent commits to anything — what the user is *probably* about to do. "Read-only" bounds state mutation, not information disclosure; recent work formalizes this as issue-time privacy leakage ([Ghost Tool Calls, 2026](https://arxiv.org/abs/2606.02483)). Speculate's position: speculation only targets servers the session is already sending real traffic to (never a server the agent hasn't touched), and privacy-sensitive deployments should use per-server denylists or `off`. Documented, not solved.
- **Auth errors suspend, successes reset.** A speculative call failing with an auth/permission error is dropped (not cached) and that tool is suspended from speculation — **until a subsequent real call to the same tool succeeds**, which resets the breaker. (Permanent suspension would let one expired token during an idle window disable speculation for the rest of the session, even though the very next real call would have triggered a routine re-auth.)
- **Server→client requests from speculative calls are aborted, never surfaced** (§3.4), and the tool is suspended from speculation for the session — a tool that needs user interaction is by definition not prefetchable.

## 5. Prediction engine

Predictions must name a tool **and concrete arguments** — "the agent will probably look at PRs" is useless unless it becomes `list_pull_requests({repo: "acme/api", state: "open"})` that matches (after canonicalization) the agent's eventual call. Argument prediction is the hard part, and hit rate lives or dies on it.

### 5.1 Result access — the prerequisite nobody else states

The most powerful rules derive arguments from the *result* of the trigger call ("the PR numbers that came back"). But MCP `tools/call` results are content blocks — overwhelmingly free-form text whose shape is server- and version-specific. Structured access cannot be assumed; it must be engineered:

1. **`structuredContent` first.** Where a server declares `outputSchema` and returns `structuredContent` (in the spec since 2025-06), rules consume it directly. This is the durable path and will grow with server adoption.
2. **Profile parsers otherwise.** For servers that return text (including JSON-serialized-as-text, the GitHub MCP server's common shape), the vetted profile ships **per-tool result parsers**, pinned to upstream server versions and covered by contract tests in CI (parse fixtures recorded from each supported server release; a parser that fails fixtures blocks the profile release).
3. **Fail closed to "no prediction."** If parsing fails at runtime, result-derived rules simply emit nothing (arg-independent rules still fire); a `parser_miss` metric is logged. A parse failure can cost a prefetch opportunity — never correctness.

Parser fragility is a top-3 risk (§11 risk 1a): it is the MVP's main maintenance burden and the reason profiles are versioned artifacts, not static config.

### 5.2 Tier 1 — Static co-occurrence rules (MVP)

Hand-written, per-profile rules: *"after call X with args A (and parsed result R), predict calls Y₁…Yₙ with args derived from A and R."* Examples from the GitHub profile:

- `get_issue(owner, repo, n)` → `list_pull_requests(owner, repo, state: open)`, `issue_read(comments)(owner, repo, n)`
- `list_pull_requests(...)` → `pull_request_read(get)(...)` for the first K PRs in the parsed result
- `get_file_contents(path)` → `get_file_contents(dir(path))` sibling listing

Deterministic, auditable, zero added latency. Expected to capture the bulk of the win for workflow-shaped servers.

### 5.2b Tier 1.5 — Declarative config rules (v0.2: implemented)

Tier-1-shaped rules authored by the operator in `speculate.config.json` rather than in code — the "works with any connector" workhorse. A small selector language (`$args.<path>`, `$parsed.<path>`, `$item.<path>` with `forEach` over result arrays, `$$` escaping) maps trigger args and parsed results into predicted args; anything unresolvable fails closed. Compiled into the same `Rule` interface as profile rules and run through the identical validation/feedback/dedupe/cap pipeline.

### 5.3 Tier 2 — Learned transition model (v0.2: session-scoped version implemented)

A per-server bigram model over observed transitions: `P(next_tool | prev_tool)`, learned live from the session. Argument prediction via templates mined per transition — for each argument of the follow-up call, candidate sources (same-named trigger arg, path into the trigger's parsed result, constant) are intersected across observations; a transition predicts only when every argument remains derivable, with arguments resolved against the *current* call. Two consistent observations arm a transition; confidence ramps with count (capped at 0.55, below hand-written rules); the §5.6 feedback loop suppresses transitions that stop hitting. v0.2 scope: in-memory, per-session, LRU-bounded. Cross-session persistence (per-user/per-project priors) remains post-MVP.

### 5.4 Tier 3 — Small-LLM predictor (post-MVP, optional)

On idle or after each turn, ship the recent conversation window + available read-only tool list to a small fast model prompted to emit the 1–3 most likely next calls with full arguments. Highest ceiling (it can read intent, not just call patterns), highest cost — runs only in idle windows, never on the critical path. Requires an API key and an explicit opt-in, since it exfiltrates conversation traffic to a model provider the upstream servers didn't know about.

### 5.5 When prediction runs

- **On each completed real call** (the main trigger; predict follow-ups from the call + parsed result). This also covers turn boundaries in the MVP: the follow-ups of a turn's *last* call are frequently the next turn's opening reads, and they stay useful for one TTL (§6.2) into the idle gap.
- **On turn-boundary quiescence** (no requests for T ms) — Tier 2/3 territory, post-MVP: predicting the next turn's opening reads from more than the last call.
- Never on the critical path of a real call. Prediction work is async and yields to real traffic.

### 5.6 Confidence, ranking, and how many to fire

Each predictor emits confidence scores; the executor takes predictions in descending confidence until budgets (§7) are exhausted. The default per-trigger cap is **3 predictions per observed real call** — derived from the waste target (§10 accepts ≤2 wasted calls per hit, i.e. speculative calls must hit ≥⅓ of the time; firing fewer, higher-confidence predictions is the main lever for staying above that line, and published top-1/top-3 next-action accuracies of ~28–55% in systems with *more* context than a proxy suggest 3 is already generous). Observed per-rule hit/waste rates feed back into scores — a rule that never hits gets suppressed. This feedback loop is in-scope for MVP in its simplest form (per-rule hit counters).

## 6. Cache semantics

The cache is a **speculation buffer**, not a general cache: small, short-lived, per-session, biased toward missing rather than serving anything questionable.

### 6.1 Keying and canonicalization

Key = `(server, tool, canonical_args)`. Canonicalization: JSON with sorted keys, plus **profile-supplied normalizations** — default-materialization maps (so `{state: "open"}` and omitted-`state` collide when the profile says the server defaults to open) and case-folding for enums the profile marks case-insensitive. These live in the profile because JSON Schema generally *doesn't* carry them: most real servers apply defaults server-side and invisibly, and the schema has no case-insensitivity vocabulary. No fuzzy matching in MVP — near-miss args are a miss, but **near-miss key distance is logged from day one** (§9) to size the fuzzy-matching opportunity (e.g. a cached `limit: 50` list serving a `limit: 10` request) before building it.

### 6.2 Freshness and invalidation

- **Per-tool TTL** from the server profile, defaulting to **30 s**, capped at a few minutes. The prefetch-to-use gap for intra-turn chains is seconds, so short TTLs retain most of the win while bounding staleness.
- **Mutation invalidation, conservatively classified:** any real call **not affirmatively classified read-only** (same classification machinery as §4 — allowlist/annotation) invalidates all cached entries for its server. Unknown tools are treated as writes. Coarse per-server invalidation is deliberate; per-resource invalidation is a profile-level refinement later.
- **Writes outside the proxy are invisible — and for coding agents they're the common case.** An agent that runs `git push` in a shell and then reads the repo through a cached entry can see a pre-push snapshot up to one TTL old. The proxy cannot see non-MCP tools (shell, file edits, other harness tools). This is the sharpest staleness caveat in the design; it is bounded by the TTL, called out in user-facing docs, and per-tool TTL=0 exists for reads where even that is unacceptable.
- **External writes are likewise invisible.** Someone else can merge the PR between prefetch and use; the agent sees a ≤TTL-stale snapshot. Same bound, same mitigations. Both cases are identical *in kind* to the race that already exists between a live tool call and the model acting on its result — the TTL widens that window, bounded and configurably to zero.
- **A cache hit consumes the entry** (single-use). If the agent asks the same thing twice, the second ask goes upstream (unless re-prefetched). This keeps semantics close to "you got the answer a bit early" rather than "you got a cached worldview." Deliberately conservative for MVP; TTL-bounded multi-use per tool profile is a later option.
- **Spec alignment:** the MCP spec's [draft caching metadata](https://modelcontextprotocol.io/specification/draft/server/utilities/caching) (`ttlMs`, `cacheScope`; SEP-2549, slated for the 2026-07-28 release) explicitly contemplates caching intermediaries — but it applies to list/read operations, **not** `tools/call` results. Speculate honors it where it applies (list caching); the tool-result speculation buffer operates outside — though not against — spec vocabulary, one more reason it stays conservative. Prefetch is prediction-triggered, never TTL-expiry-triggered background polling (which the spec explicitly discourages). If cacheability metadata is later extended to tool results, server-declared TTLs take precedence over profile defaults (bounded by the operator cap).

### 6.3 Consistency stance (explicit)

Per session, Speculate provides: **read-your-own-writes for writes issued through the proxy** (via mutation invalidation) and **bounded staleness** (≤ TTL) for everything else — external writers *and the agent's own non-MCP side channels* (§6.2). It does not provide cross-session consistency or monotonic reads across tools. This stance is documented user-facing, per server profile.

### 6.4 Credentials and cache security

Per transport:

- **stdio upstreams:** credentials live in the child process's environment; Speculate never sees a token. Isolation is process-level: each Speculate instance spawns its own upstreams for its one client (§3.2). Cache entries for a stdio server are flushed if its process restarts (new process ⇒ possibly new identity/config).
- **HTTP upstreams:** Speculate *is* the MCP client, which means it owns the client side of OAuth — discovery, authorization, token refresh, and re-auth on 401, surfacing auth prompts to the user exactly as a directly-connected client would. Tokens are held in memory for the session only. A token refresh that changes scope/identity flushes that server's cache entries.
- Cache entries are per-session only and in-memory only; no persistence of tool results to disk. Two clients never share entries (enforced trivially in MVP by one-client-per-instance; a real isolation layer is the price of the shared-gateway deployment, which is deferred).

## 7. Budgets, rate limits, and backpressure

Speculation spends someone's quota. It must be visibly and configurably bounded:

- **Per-server concurrency cap** for speculative calls (default: 2 for HTTP; hard-fixed at 1, idle-only, for stdio — §3.1) and **per-trigger cap** (default: 3 predictions per observed real call — derivation in §5.6).
- **Rate-limit awareness where quota is visible; honest fallback where it isn't.** Profiles declare how to read rate-limit state when the server exposes it through MCP responses; when remaining quota falls below a floor (default 20%), speculation for that server stops entirely. **Caveat for the MVP profile: the GitHub MCP server does not currently pass rate-limit state through tool results, so the quota floor is inoperative there** — the operative guard for GitHub is the per-minute budget (default: 30 speculative calls/min per server), plus the waste metrics that make overspend visible.
- **Cost accounting:** every speculative call is logged as such. Nothing about speculation is silent.
- **Kill switch:** `off` mode at runtime (config reload or admin endpoint) instantly reverts to pass-through.

## 8. Latency model (why this wins)

Let a turn contain `n` sequential eligible reads with mean upstream latency `L`. Perceived tool time ≈ `n·L`.

What a hit saves depends on the **head start** — the gap between prefetch issuance and the agent's ask:

- **Completed prefetch** (gap ≥ L): the agent waits ~ε (≤10 ms). Saves ≈ L.
- **In-flight join** (gap < L): the router joins the in-flight call (§3.1); the agent waits L − gap. Saves ≈ gap.

So per-hit savings = **min(gap, L)**, and perceived tool time ≈ `n·(1−h)·L + n·h·(L − E[min(gap, L)])`. For intra-turn chains the head start is the model's think time between calls (typically 1–10 s against sub-second L, so most intra-turn hits complete); for the first calls of a *new* turn, prefetches issued at the end of the previous turn have had the whole user gap to complete — if they haven't expired.

Illustrative (not measured — the benchmark harness in §10 exists to replace this arithmetic): a GitHub-backed review turn with `n = 6`, `L = 500 ms` → 3.0 s of tool waiting; at `h = 0.5` with fully-completed prefetches, ≈ 1.5 s. If half those hits are instead mid-flight joins with 250 ms remaining, ≈ 1.9 s. Directionally large either way.

Structural notes, stated honestly:

- **The between-turn window is real but TTL-bounded in the MVP.** Prefetches triggered by a turn's last call survive one TTL (~30 s) into the idle gap — enough for quick follow-up turns ("yeah, show me those PRs"), which is exactly the interaction pattern that motivated this design. For minutes-long idles the entries expire before the next turn; exploiting long idles properly needs either boundary-specific TTL policies (a staleness trade-off) or a host-side "user is typing" signal, both post-MVP (§11 risk 8). The window is structurally durable — no harness improvement removes it — but the MVP only harvests its first 30 seconds.
- **Speculation composes with parallelization rather than competing.** Harness-level parallel tool dispatch accelerates calls the model has *already emitted*; speculation covers calls it hasn't emitted yet, including result-dependent chains a harness cannot parallelize (can't fetch PR #42's diff until something returns "42" — unless a rule predicted it from a parsed earlier result, which is exactly what Tier 1 does).

## 9. Observability

MVP ships with:

- **Structured log** of every speculative decision: prediction source, confidence, executed or suppressed (and why), outcome (hit / joined-in-flight / expired / invalidated / wasted), and per-hit head start.
- **Near-miss logging:** on cache misses, key distance to the nearest cached entry (to size fuzzy matching — §6.1). **Parser-miss logging** for §5.1 failures.
- **Session summary + `speculate__stats`:** current-session hit rate, wasted calls, estimated wall-clock saved (Σ min(gap, L) over hits), speculative quota consumed per server, bounded-delay events on stdio upstreams (§3.1).
- **Durable `speculate stats`:** cumulative MCP and CLI estimated time saved, hit rate, waste, source totals, and per-workspace totals; `--json` emits the same aggregate report as structured output.
- **Standard MCP-level logs** for the proxy function itself.

The honest metric to watch is **estimated seconds saved per wasted call** — it prices the trade-off directly. Hit rate has no universal target; a 20%-hit rule that saves 2 s per hit at trivial quota cost is worth keeping, and the per-rule feedback loop (§5.6) suppresses rules that don't pay.

## 10. MVP scope

**In (v0.1):**

1. Single-binary local proxy (Go or TypeScript — decision pending; Go favored for single-static-binary distribution and concurrency ergonomics, TS favored for MCP SDK maturity), stdio + streamable-HTTP on both sides, protocol plumbing per §3.4.
2. Safety policy: `strict` / `annotated` / `off`; annotation check; allowlist/denylist config; auth-error breaker with real-call reset.
3. Tier-1 rule engine with §5.1 result access (structuredContent + profile parsers + contract tests); per-rule hit-rate feedback.
4. **One vetted profile: GitHub** (rules + read-only allowlist + TTLs + result parsers) — chosen because its workflows are the most predictable and it's the demo everyone understands.
5. Per-session in-memory cache: profile-driven canonicalization, TTL, single-use hits, in-flight join, conservative mutation invalidation, restart/re-auth flush.
6. Budgets: per §7, including the stdio idle-only rule.
7. Observability: decision log, near-miss/parser-miss metrics, `/stats`, session summary.
8. Benchmark harness: scripted agent sessions replayed with speculation on/off, reporting per-turn wall-clock, hit rate, head-start distribution, waste. Scripted workflows overstate real-world predictability, so the harness includes at least one adversarial/low-predictability script to measure the floor; real-world numbers come from §9 telemetry.

**Out (explicitly):**

- Tier-2/Tier-3 predictors; shared/multi-tenant deployment; fuzzy cache matching; resource/prompt prefetching (MCP resources with subscriptions are arguably *better* suited to prefetching than tools — deliberately deferred, tools first); persistence; per-resource invalidation; boundary-specific TTL policies; any speculation on non-read-only tools (permanent).

**MVP success criteria and thresholds:**

- On the benchmark's GitHub workflows: **≥40% hit rate** on eligible reads (target) and **≥30% reduction** in per-turn tool wall-clock. The wall-clock criterion assumes eligible reads dominate benchmark tool time and most hits complete before the ask — both measured by the harness (item 8), not assumed silently.
- **Waste ≤2 speculative calls per hit** — the constraint the per-trigger cap (§5.6) is derived from.
- **Kill threshold:** if after rule iteration on the GitHub proving ground the hit rate can't clear **30%**, the core hypothesis fails *at the proxy layer* (see §11 risk 1 — a proxy sees strictly less than the research systems that hit 40%+), and the project revisits approach (Tier 2/3, host-signal integration) before building further. Between 30–40%: keep iterating rules, don't scale scope.
- **Zero non-eligible tools ever invoked speculatively** — asserted by test suite: a mock server that fails the run if any non-allowlisted tool is called speculatively.
- Pass-through overhead ≤ 5 ms p99; completed-hit response ≤ 10 ms (§2 budgets).

## 11. Risks and open questions

| # | Risk / question | Current position |
|---|---|---|
| 1 | **Low hit rate in the wild** — real usage is less workflow-shaped than benchmarks, **and a protocol-layer proxy sees strictly less than the research systems reporting 40–55% next-action accuracy** (they read model state/plans; Speculate reads only traffic). Expect lower. | Benchmark honestly (incl. adversarial scripts), measure real-world via §9, explicit 30%/40% thresholds in §10. |
| 1a | **Result-parser fragility** (§5.1) — Tier-1's best rules depend on parsing server-specific text formats that can change under us. | `structuredContent` when available; versioned parsers with contract-test fixtures gating profile releases; runtime fail-closed to no-prediction; `parser_miss` telemetry. Main ongoing maintenance cost — accepted. |
| 2 | **Argument mismatch** — agent asks with slightly different args than predicted. | Profile-driven canonicalization in MVP; near-miss key-distance logging from day one to size the fuzzy-matching opportunity before building it. |
| 3 | **Stale reads mislead the agent** — external writers *and the agent's own non-MCP writes* (shell/`git push`) are invisible to invalidation. | Short TTLs, single-use hits, conservative mutation invalidation, per-tool TTL=0 opt-out, §6.3 documented stance. Bounded, not eliminated. |
| 4 | **Quota/cost blowup on busy servers** — worsened where rate-limit state is invisible (incl. the MVP GitHub profile, §7). | Default-conservative budgets (3 per trigger), per-minute caps, waste metrics, kill switch. |
| 5 | **Reads with side effects** (read receipts, audit noise, metered billing). | `strict` mode + vetted profiles exclude them; documented reviewer checklist for profile contributions. |
| 6 | **Dishonest/wrong `readOnlyHint` annotations** — in `annotated` mode a false annotation both enables speculation *and* silently breaks mutation invalidation (§4, §6.2). | `strict` default requires human allowlisting; `annotated` is opt-in per deployment with the compounding risk documented. |
| 7 | **Client-visible protocol differences** — cached hits lack progress notifications; tool naming changes under aggregation (§3.4). | Believed benign / inherent to proxying respectively; both verified against real clients (Claude Code, Cursor) in MVP testing and documented in the migration guide. |
| 8 | **Long idle windows are unharvested in MVP** — no "user is typing" signal exists in MCP; TTLs expire prefetches during minutes-long gaps (§8). | MVP harvests the first TTL-worth of each gap via last-call follow-up rules; quiescence-triggered Tier 2/3 prediction and boundary TTL policies are post-MVP; true typing signals need host cooperation (out of scope). |
| 9 | **Language/runtime choice** (Go vs TypeScript). | Decide at MVP kickoff; §10 item 1 lists the trade-off. Leaning Go. |
| 10 | **stdio serialization** — speculation can delay a real call by up to one upstream call on serial servers. | Idle-only, ≤1 in-flight rule (§3.1); bounded-delay events measured (§9); per-server `off` available. |
| 11 | **Intent leakage** — speculative calls disclose predicted user intent to upstream services before the user acts ([Ghost Tool Calls](https://arxiv.org/abs/2606.02483)). | Speculation restricted to servers already receiving real session traffic; per-server denylist / `off` for sensitive deployments; called out in user-facing docs. Not fully solvable at the proxy layer. |

## 12. Review checklist (what "this design makes sense" means)

- [ ] A wrong prediction can never invoke a non-read-only tool — enforced by default-deny eligibility, not by prediction quality.
- [ ] A disabled/failed speculation subsystem leaves a correct transparent proxy.
- [ ] Staleness is bounded, documented (including the non-MCP-writes caveat), and per-tool tunable to zero.
- [ ] Speculation cost is capped, measured, and visible — including its one bounded latency cost (stdio queuing).
- [ ] The proxy-layer mechanics that differentiate this from research systems have actual designs: result access (§5.1), per-transport concurrency (§3.1), auth per transport (§6.4), handshake/naming aggregation (§3.4).
- [ ] The MVP is small enough to build and honest enough to falsify the core hypothesis (explicit 30%/40% hit-rate thresholds).

---

## 13. Implementation notes — MVP v0.1 (2026-07-10)

What actually got built, what it measured, and where reality amended the design. The code is the reference; this section records the deltas.

### 13.1 Decisions

- **Language: TypeScript** on the official `@modelcontextprotocol/sdk` (1.29). The §10 trade-off resolved in favor of SDK maturity — the protocol plumbing (§3.4) is exactly where an immature SDK would bleed, and `npx`-style install is the MCP-ecosystem norm. A Go single-binary port remains open for v1 if distribution demands it.
- **Test strategy:** 154 tests — unit suites per module (cache single-use/join/doom semantics, policy mode matrix, budget windows and the stdio idle rule, predictor pipeline incl. fail-closed parsing and feedback suppression, per-rule GitHub profile tests) plus an end-to-end suite that runs a real MCP client against the proxy against a latency-injectable **mock GitHub server** over actual stdio transports. The mutation-safety invariant is asserted end-to-end: the mock logs every call it receives, and the test fails if anything not client-requested and not allowlisted ever reaches it.

### 13.2 Measured results (benchmark harness, §10 item 8)

Scripted 7-call review session, mock upstream at 400 ms, think-time gaps of 0.25–2.5 s:

| Criterion (§10) | Target | Measured |
|---|---|---|
| Hit rate on eligible reads | ≥ 40% | **71%** (4 hits + 1 in-flight join of 7) |
| Per-turn tool-wait reduction | ≥ 30% | **66%** (2.84 s → 0.97 s) |
| Waste per hit | ≤ 2 | **0.0** |
| Pass-through / hit overhead | ≤5 ms / ≤10 ms | ~1 ms / ~2 ms observed |

Caveats exactly as §10 predicted: the scripted workflow is workflow-shaped (this is the optimistic ceiling, not the wild-traffic estimate), and the remaining misses are structural — the session's first call and a `list_issues` no rule predicts.

### 13.3 Design refinements the implementation forced

1. **The drain queue (§3.1).** The stdio idle-only rule as originally written silently dropped every prediction beyond the first per trigger; benchmarking exposed it immediately (57% hit rate, `list_pull_requests` never prefetched). Queuing busy-denied predictions (confidence-ordered, 5 s max age, re-validated at fire time) recovered 14 points of hit rate at zero added waste. Rate-limit denials are still dropped, not queued — queuing them would defeat the budget.
2. **Invalidation ordering is settle-then-flush-then-drain.** A mutation that *throws* (e.g. timeout) may still have applied server-side, so the completion-side flush moved into the call's `finally`; and the flush must precede the drain hook or queued speculation fires into the pre-flush window / gets issued-then-instantly-doomed.
3. **Joined-speculation failures are the joiner's to report.** The cache stays silent for claimed entries (the joiner owns the outcome), so the proxy must emit the `spec_error` — otherwise the §5.6 feedback loop is blind to a failing rule whenever the agent asks before the speculation settles.
4. **Canonicalize only what the server provably normalizes.** The GitHub profile originally case-folded `state`; the server validates it case-sensitively, so a fold lets a cache hit fabricate a success the live call would reject with an error. General profile-authoring rule now: default-materialization yes, lossy normalization only with server-behavior evidence.
5. **Builtin tool names are reserved in routing.** `speculate__stats` is claimed before upstream tools; a colliding upstream tool gets collision-prefixed instead of silently shadowed (§4 "real calls are never blocked").

### 13.4 Deviations from §10 / deferred to v0.2+

- **Client-side transport is stdio only.** Every target host launches local sidecars via stdio; streamable-HTTP on the client side moves to the shared-gateway milestone.
- **Sampling/elicitation pass-through is not implemented.** The proxy's upstream client declares no sampling/elicitation capabilities, so a tool that requires them fails behind the proxy (works when directly connected) — documented limitation; neither the GitHub server nor the mock uses them. Until relay exists, the §4 speculative-abort rule is moot in practice; speculative `MethodNotFound` failures do suspend the tool.
- **Resources/prompts pass through only in single-upstream mode**, and only when the upstream actually advertises the capability (multi-upstream aggregation of resource URIs remains out of scope).
- **The §7 quota floor is unimplemented** — as §7 itself noted, it would be inoperative for the only shipped profile anyway; the per-minute budget (default 30/min) is the operative guard.
- **HTTP upstream auth is env/config-based only** (no OAuth flows yet), so the §6.4 scope-change flush has no trigger; the §6.4 **restart flush is implemented** via transport-close detection — a dead upstream is delisted, its cache flushed, and it stays delisted until proxy restart (no auto-reconnect in v0.1).
- **The GitHub profile is validated against the bundled mock** (which mirrors github-mcp-server's classic tool names and JSON-in-text payloads). Validating against the real `github-mcp-server` — and pinning the profile to its release per §5.1 — is the first v0.2 work item.
- **Known debt:** transport policy (serial-ness, concurrency, queueable-denial reasons) is spread across budget/executor/proxy rather than one policy object; near-miss telemetry is a linear scan per miss (memoized parses; fine at MVP cache sizes, revisit if caches grow).

### 13.5 v0.2 — server-agnostic speculation (2026-07-10)

Follow-up to the question "how does this work for servers other than GitHub?" — answered in three shipped mechanisms (all through the existing safety pipeline; nothing about eligibility, budgets, or the cache changed):

1. **Generic result access.** Without a vetted parser, the predictor now uses `structuredContent` when present, else best-effort JSON-in-text extraction (fail closed, no `parser_miss` noise for genuinely-text results). This unlocks result-derived prediction on unprofiled servers, since most real servers serialize JSON into text blocks.
2. **Declarative config rules (§5.2b).** Per-server `rules` in the config file, compiled to the standard `Rule` interface. Schema-validated at startup (unknown `$` directives, `$item` without `forEach`, and dead `forEach` literals are rejected with pointered errors).
3. **Transition learner (§5.3).** Session-scoped, zero-config: two consistent observations of a transition arm it; argument templates (arg-copy / parsed-path / const, intersected across observations, fail-closed) generalize across argument values. Verified end-to-end: an unprofiled server in `annotated` mode reaches its first prefetch hit on the third occurrence of a repeated workflow step.

Safety posture for unprofiled servers is unchanged and now documented user-facing: `annotated` mode (trust `readOnlyHint`) or `strict` + per-server `allowTools`. Test suite: 216 tests (learner 30, config rules 30, plus two new end-to-end tests); the GitHub benchmark is unchanged (71% / −66% / 0 waste — learner transitions need two sightings, and the benchmark's workflow has none repeated).

Known limits recorded for v0.3: ~~learner state is per-session~~ (addressed in §13.6); predictions never cross servers (a GitHub issue mentioning a Slack thread won't prefetch Slack); config-rule selectors don't interpolate inside nested object literals; profile-quality vetted rules still beat both generic tiers on cold sessions — community profiles remain worth shipping.

### 13.6 v0.3 — learned-state persistence (2026-07-10)

The learner's model and per-rule feedback now survive restarts, so a proxy that has seen your workflows prefetches from its first trigger of a new session (verified end-to-end: session 2 hits on its first repeated-workflow trigger with no relearning).

**What persists** — two things, in one versioned JSON state file:
1. The transition model: (server, prevTool → nextTool) entries with observation counts and argument templates. Templates reference argument *provenance* (copy-this-arg, this-path-into-the-parsed-result) plus constant argument values by canonical repr. Chain heads and LRU recency are session-local and excluded.
2. Per-rule feedback counters (hits/wasted/speculated), so suppression knowledge survives too.

**What never persists:** tool results. The §6.4 memory-only cache promise is untouched — the state file contains tool names, argument-shape templates (including constant *argument* values, which is why the file is 0600 under a 0700 dir), and counters.

**Durable usage snapshots:** separate versioned session records are aggregate-only. Beyond schema version and opaque session identity, they contain only source, absolute workspace path, timestamps, and cumulative counters. They never contain command arguments, tool or server names, results, prediction templates, or cache contents; caches and results remain memory-only. `speculate stats` validates and aggregates these records across MCP and CLI sessions, while `speculate try` disables their creation to preserve its zero-write contract.

**Durability semantics (state is an optimization, never a liability):**
- Atomic writes (same-directory tmp + rename); a crash mid-save leaves the previous state intact.
- Load failures of every kind — missing, corrupt, version-mismatched, hostile — are a cold start, never an error; malformed transitions inside an otherwise-valid file are skipped individually.
- Saves are debounced (~1 s after the learner changes) with a final flush on shutdown; a failed save warns once on stderr and the proxy carries on.
- **Feedback decays on load** (counts halve per restart, capped): without decay, a rule suppressed by ancient waste could never redeem itself, since suppressed rules never speculate and so never regain hits. Halving lets old evidence age out over a few restarts.

**Location & control:** one state file per config file (≈ per project), keyed by config-path hash, under `$XDG_STATE_HOME/speculate/` (default `~/.local/state/speculate/`). Config: `persistence.enabled` (default true) and `persistence.path`. The benchmark and test harnesses run persistence-off/hermetic so measurements stay cold-start comparable.

**Known limits (v0.4 candidates):** concurrent proxies sharing one state file are last-writer-wins (lost updates, never corruption — rename is atomic); a save that fails with no subsequent learning is not retried until the next learner change; learned state is per-config, not shared across projects or machines; on Windows the 0600/0700 POSIX modes are no-ops (Node ignores them there) — the file lands under `%LOCALAPPDATA%\speculate`, which is per-user, but ACL hardening is not applied.

### 13.8 v0.5 — CLI speculation, Tier A (2026-07-10)

The prediction stack (learner, rules, feedback, budgets, persistence) never knew it was speaking MCP — what's protocol-specific is the interception seam and the safety signal. v0.5 extends speculation to command-line workflows by giving them both: **speculate-shell**, a bundled MCP server exposing an allowlisted, hardened, read-only command surface (git status/diff/log/show/branch, list_dir, ripgrep search), plus a vetted `shell` profile. Everything upstream of the seam — prediction, caching, stats, persistence — applies unchanged.

**Safety model (arguments are attacker-controlled — the calling model can be prompt-injected):** fixed binary per tool via execFile (no shell); user strings either strictly regex-validated with no leading `-` (refs, globs) or passed only after `--` (search patterns) so nothing becomes a flag — this specifically blocks write-capable flag smuggling like `git log --output=<file>`; workspace path containment; git's config-driven execution paths disabled per invocation (hooksPath override, fsmonitor off, `--no-ext-diff`, pager off, `GIT_TERMINAL_PROMPT=0`) and `GIT_OPTIONAL_LOCKS=0` so the readOnlyHint annotations are literally true; 10 s timeouts and 512 KB output caps. Capability baseline: nothing beyond what the agent's own shell already grants — the hardening makes *speculative* execution safe, it is not a read sandbox.

**Freshness — better than MCP-land:** locally, the dominant invalidator (the agent's own edits) is observable. The server watches the workspace (debounced 300 ms) and emits `tools/list_changed`, which the proxy already answers with a full buffer flush for that server (§3.4). Short TTLs (15 s default; longer for sha-addressed `git_show`) backstop the watcher.

**Roadmap sketched, deliberately not built (Tier B/C):**
- **Tier B — `speculate-sh`, a PATH-shim + daemon:** intercept allowlisted binaries directly (no MCP detour), same prediction core, cache keyed by command + canonical args + cwd + fs fingerprint, invalidation by file watching. Safety would come from OS-level sandboxing of speculative runs (Landlock/bubblewrap; read-only fs view, no network) — the commit/rollback model — because arbitrary CLI has no annotation to trust. Known gaps: shims miss absolute-path invocations and shell builtins. Prior art: sccache/bazel (caching), watchman (invalidation).
- **Tier C — cache warming without serving:** pre-execute likely commands purely for their cache side effects (page cache, incremental compilers, test caches) — zero correctness risk since real commands still run. The standout: **speculative test execution** — pre-run affected tests in a sandbox on each edit so "run the tests" returns seconds-old results. Likely the highest-value CLI play; needs its own design round.

### 13.9 v0.6 — zero-config setup and pre-loaded priors (2026-07-11)

Two friction removals prompted by user feedback ("there's a lot of manual setup"):

**`speculate wrap` — zero config.** Instead of authoring a config file and re-pointing the host, users prefix their existing server command: `npx -y github:lukebward/speculate wrap -- <server cmd>` (npx installs from git; the prepare hook builds). Wrap defaults: mode `annotated` (there is no allowlist to consult — documented trade-off, `--mode`/`--allow` override), auto-detected vetted profiles for known server commands, persistence keyed by the wrapped command line. `wrap --workspace <dir>` spawns the bundled shell server for one-flag CLI speculation. Configs, when used, are now JSONC (comments + trailing commas), `speculate init` writes a commented starter, and the `speculate-mcp` bin alias matches the package name so bare `npx github:…` resolves.

**Pre-loaded priors that adapt per user (learner priming).** The product now ships prediction knowledge that activates before any learning: (a) vetted profiles carry curated `primes` pairs; (b) on connect, lister→getter tool-name morphology (`list_X`→`get_X`, `search_X`→`get_X`, prefix and suffix forms, plural-tolerant stems) is detected on ANY server. A primed (server, prev, next) pair reaches the prediction threshold after **one** observed sighting instead of `minObservations` — a threshold change, not fabricated knowledge: argument templates still come exclusively from the user's real traffic, primes only target speculation-eligible tools, and once observed the transition is an ordinary learned one — it grows with use, gets suppressed by feedback if it doesn't match this user, persists per config (§13.6), and is LRU-bounded. Unobserved primes cost one Set entry and are recomputed per session from live tool lists (never persisted). `doctor` reports each server's primed pairs.

Demo/readme: the benchmark is now rendered as an animated SVG terminal (generated by scripts/gen-demo-svg.mjs from captured ANSI output — svg-term-cli proved incompatible with modern casts) embedded at the top of the README alongside the numbers table.

### 13.10 v0.6 — the custom command registry: anything an agent uses is predictable (2026-07-11)

The shell server's fixed tool set generalizes: `--commands <registry.jsonc>` declares arbitrary read-only CLI commands, each registered as an MCP tool (readOnlyHint) behind the proxy — so profiles, config rules, morphology priming, the learner, and persistence all apply to any tool an agent shells out to (`kubectl`, `gh`, `docker`, `aws`, build/status commands…).

Trust model, stated in the file format itself: declaring a command asserts read-only-ness — the registry author already has shell access, so this grants nothing new; what the registry engineering guarantees is that MODEL-supplied parameters cannot escape their type: numbers bounded, enums closed (values validated at load), strings length-capped/NUL-free/no-leading-dash/optionally pattern-anchored, flags fixed at load time, execFile only. Bad specs fail loudly at startup; bad values fail per-call with clean errors. JSON stdout is passed through as structure (learner-mineable); non-zero exits are isError, never cached. Per-tool freshness comes from the new operator-level `speculation.ttlMsByTool` (which now beats profile per-tool TTLs everywhere — operator wins), plus the existing fs-watcher flush.

What remains for "native harness tools" (the agent's own Bash/Read, not routed through MCP): the Tier B PATH-shim + sandbox design from §13.8 — still the roadmap item, unchanged.

### 13.11 v0.7 — dynamic by default (2026-07-11)

User directive: no manual configuration as the default. Three mechanisms replace the remaining config knobs; every one is opt-out-able, none is opt-in:

1. **Profile fingerprinting by live tool lists.** When a server has no configured profile, its `tools/list` is scored against builtin profiles' allowlists; ≥60% overlap applies the profile (rules, TTLs, canonicalizers, primes) with a stderr notice — in `annotated`/`off` modes only. **In `strict` mode recognition is a logged suggestion, never applied**: auto-allowlisting on a name match would let a server *earn* strict-mode speculation by mimicking a known profile's tool names, hollowing out what strict promises (verification finding). For the same reason fingerprinting never touches the allowlist at all — eligibility stays annotation-based in annotated mode, and a name-colliding unannotated write keeps triggering §6.2 mutation invalidation. Supersedes command-string autodetect for correctness (dockerized/renamed servers fingerprint; `/tmp/github-mcp-server-logs/x` false positives don't survive a tool-list check). Late binding required small hooks: `Predictor.setProfile`, `SafetyPolicy.addToAllowlist`. `"profile": "none"` opts a server out of both profiles and fingerprinting (also the test seam for exercising profile-less behavior).
2. **Workspace-probed CLI catalog (shell/catalog.ts).** Curated read-only command templates ship in the product; relevance probes (binary on PATH, marker files, git-remote shape) decide per workspace which register as tools: gh (github remote), npm (package.json), kubectl/docker (binaries), pip (python project markers). `--no-auto` disables; a user registry (`--commands`) wins name collisions. Curation rules: nothing that mutates, bills surprisingly, or reads secrets. `okExitCodes` supports read-only commands with non-zero success conventions (npm outdated).
3. **Composition is the payoff:** auto-exposed tools are morphology-primed automatically (`gh_pr_list`→`gh_pr_view`; 'view'/'describe' added to getter suffixes), the learner fills in argument flow from real usage, and persistence keeps all of it per config.

Also from the v0.6 verification pass: JSONC block comments now strip to whitespace (`[1/* */2]` stays invalid; newline counts preserved for error positions); the plural stemmer uses candidate-set intersection (issues/issue, releases/release, statuses/status all pair); `init` rejects flag-like paths; `npm run demo:svg` regenerates the README demo. Documented, not changed: wrap's state key ignores env/cwd (identical wrapped command lines share learning — waste-bounded, read-only-gated), and wrap's command-string profile hint remains as a pre-connect fast path that fingerprinting corrects.

Still roadmap: observing the agent's NATIVE harness tools (Bash/Read) via host hooks — cross-host design + privacy story needed (§13.8 Tier B/C).

### 13.12 v0.8 — install-and-it-works (2026-07-11)

User directive: no touching config files at all — an install-and-it-works flow, for MCP and CLI tools. The honest constraint first: interposing on a process you don't launch requires one bit of persisted state *somewhere*; the design freedom is where it lives and who writes it. v0.8 ships a funnel where the user never opens a JSON file and Speculate never hand-edits one it doesn't own:

**1. `wrap --sniff` — protocol-sniffing pass-through (the enabling primitive).** Extends the §3.3 degradation property to the transport: buffer stdin's first line; a JSON-RPC `initialize` request means MCP → unshift the bytes and run the full proxy; anything else (non-JSON, EOF, size cap, or a quiet client past the 500 ms timeout) → spawn the wrapped command and become a byte-transparent pipe, exit code and signals forwarded. MCP clients send `initialize` immediately without waiting for server output, so real sessions decide on the first line, not the clock; a pathologically slow client degrades to the pipe (fail open — it still works, just unspeculated). Over-wrapping is now harmless by construction, which is what makes blind interposition (shims, below) safe. Implementation note: the sniffer leaves stdin explicitly paused; the CLI resumes it only after the proxy's transport attaches its listener, so no byte can flow into the void.

**2. `speculate try` — the zero-write trial.** Reads the user's real Claude Code config (all three scopes, read-only), wraps every stdio entry in memory, adds the workspace shell server, writes a throwaway file, and execs `claude --mcp-config <tmp> --strict-mcp-config`. Nothing persists. Consent is preserved, not widened: checked-in `.mcp.json` servers are included only when the host's own approval records (`enabledMcpjsonServers` / `enableAllProjectMcpServers`, minus disabled) say the user already accepted them — `try` must never turn "pending approval" into "running".

**3. `speculate on`/`off`/`status` — persistent, through the host's front door.** Every mutation is a `claude mcp remove`/`add-json` invocation — never a JSON edit. Empirical findings this design rests on (verified against Claude Code 2.1): same-named servers resolve local > project > user; a local shadow of a project server *works* (exactly one server is used) but draws a "conflicting scopes" diagnostic. Hence the split: user/local-scope servers are re-registered wrapped IN PLACE (original recorded for exact restore); project-scope servers (checked in, shared) are never touched — a wrapped copy shadows them at local scope, diagnostic accepted as the price of not editing a teammate-visible file. Wrapped entries are self-describing (the original command line survives verbatim after the `--`, env carried unchanged), so `off` reconstructs originals even with a lost state file. The state record lives at `$XDG_STATE_HOME/speculate/managed.json`; `status` reports drift (servers added since `on`). Wrapped entries reference the local install by absolute path (`selfCommand()`); teammates are unaffected because `on` never writes to the shared project scope — shadows live at local scope, which is per-machine.

**4. CLI tools without MCP: `speculate exec` + a per-workspace daemon + the Claude Code plugin.** §13.8's Tier B, delivered without PATH shims because the plugin system carries the seam. A PreToolUse hook (dependency-free `bash-rewrite.mjs` — plugins install as git checkouts, no build step) rewrites read-only Bash commands to `speculate exec -- <cmd>` via `updatedInput`; the client connects to (or spawns, detached, idle-exiting) a unix-socket daemon that serves **byte-faithful** output from a single-use TTL cache and prefetches via the same `TransitionLearner`, server label `cli`, primed with curated pairs (status→diff, log→show, …). What made this shippable is the vetted argv table (`execTable.ts`): closed per-class flag sets (an unknown flag disqualifies the whole line), regex-validated refs, workspace-contained paths, patterns only after `--` — and predictions must re-classify through the same table before executing, so persisted learner state (untrusted input) can never assemble an argv a user couldn't have typed. Byte fidelity forces two departures from the MCP shell server: results are the raw bytes (not parsed JSON), and cache keys are exact command lines. Hardening (hooks/fsmonitor/pager off, `--no-ext-diff`, optional locks off) applies identically to real serves and speculative runs, so served bytes are consistent within exec (documented: exotic ext-diff configs would see hardened output). The hook's own guards are strictly conservative: no rewrite when the command contains quoting/substitution/chaining/redirection characters (glob/brace/tilde chars are fine — the same shell expands them identically before and after the prefix); no rewrite without `speculate` on PATH; `SPECULATE_HOOK_OFF=1` kill switch. Capability gate documented: hosts without `updatedInput` ignore the output — fail open. Known UX cost: rewriting changes permission-rule matching (`git status:*` allowrules don't match the rewritten form).

**5. `speculate shims install` — the future-proof seam, opt-in.** POSIX-sh shims for `npx`/`uvx` early on PATH: resolve the real launcher (skipping the shim dir and anything `-ef` itself), pass through directly for TTY use, `SPECULATE_OFF=1`, or a missing `speculate` CLI; otherwise exec `speculate wrap --sniff -- <real> "$@"`. Every MCP server any client launches through those commands — including ones added later — gets wrapped; every non-MCP invocation collapses to the pipe. This is the only Speculate feature that touches a dotfile (one marker-managed PATH block, `uninstall` removes it), which is why it is not part of `on`. Printed limits: GUI-launched clients don't read shell rc files; script-invoked `npx` pays one extra process hop.

Distribution: the repo doubles as a plugin marketplace (`.claude-plugin/marketplace.json` → `./plugin`), so `claude plugin marketplace add lukebward/speculate && claude plugin install speculate@speculate` bundles the workspace MCP server + the Bash hook. The durable endgame remains a host-provided seam — an "MCP middleware" plugin capability or an `mcpCommandWrapper` setting would collapse mechanisms 3–5 into the plugin install; the sniffing pass-through is exactly the safety argument that upstream pitch needs.

Rejected on the way: npm bin-name collisions to steal `npx` (fights npm itself); the gateway/aggregator shape (duplicate tool lists burn context and the originals can't be hidden without config edits); rewriting `.mcp.json` in place (teammate-visible); disk-cached CLI results (would break the "results never touch disk" invariant — the daemon keeps them in memory).

### 13.13 v0.8 adversarial review — hardening pass (2026-07-11)

Four adversarial reviewers (exec daemon, plugin hook/shims/sniff, host-config management, docs accuracy) went over the v0.8 surface. Fixes landed:

- **Consent could be widened by `on` (critical).** The `.mcp.json` skip only fired when the host's approval state was *known*; on a fresh clone (empty enabled/disabled lists — the common case) an un-approved project server was wrapped at local scope, where it runs with no approval gate. Now `on` skips any project server not in `approvedProjectServers`, unconditionally — matching `try`. A stateless `off` also used to re-add the unwrapped original of a `.mcp.json` shadow at local scope, leaking a permanent approval-free copy; it now removes the shadow and lets the project entry resume. Both pinned by tests.
- **Socket squatting (high).** The per-workspace `exec` socket lives at a deterministic path under a world-writable `/tmp` when `XDG_RUNTIME_DIR` is unset. Another local user could bind it first and feed forged command output to the agent. The daemon now refuses to bind, and the client refuses to connect, unless the directory holding the socket is a real directory (lstat, so a symlinked leaf is caught) owned by us with no group/other bits; the socket is also chmod 0600.
- **Path-less `rg` (high).** `rg PATTERN` with no path reads stdin, not the tree; served through the daemon it either hung on an open stdin pipe (10 s timeout) or, with stdin closed, returned an empty-stdin "no match". The table now declines path-less `rg` entirely (passthrough to the real shell, byte-faithful); only `rg` *with* a path — which never consults stdin — is served. Non-interactive reads also get stdin closed as defense in depth.
- **Byte fidelity for custom diff drivers.** Our `--no-ext-diff` hardening would mismatch a `diff.external`/`GIT_EXTERNAL_DIFF` user's real output; the daemon now detects that at startup and forces `git diff`/`git show` to passthrough.
- **Freshness.** The invalidation watcher now watches the git worktree top (`rev-parse --show-toplevel`), not just the spawn cwd, so a change elsewhere in the repo or above `root` still flushes.
- **Robustness/hygiene.** The plugin hook rewrites to the *absolute* `speculate` path it resolved (a differing shell PATH can no longer turn a read-only command into exit 127) and requires an executable file, not a directory named `speculate`; `try` writes its token-bearing temp config 0600 and cleans up on Ctrl-C/SIGTERM; `on` skips leading-dash server names; `CLAUDE_CONFIG_DIR` is honored in config discovery.
- **Exit policy (a v0.8.1 follow-up got this wrong).** `process.exit()` discards buffered stdout, so a large `exec` replay could hand the caller exit 0 with empty output. The first fix drained with a 2 s *timeout* — which just converts a slow reader's backpressure into the same truncation (measured: 589,824 of 1,048,576 bytes delivered, exit 0). The correct policy, applied to every exit site: command paths that don't hold the loop open set `process.exitCode` and return, so Node exits naturally once the loop drains (a full flush, however slow the consumer); paths with live handles (proxy transports/upstreams, the exec daemon, a piped stdin, fatal after transport attach) call an `exitWhenFlushed()` that hands `process.exit` to the stdout/stderr write callbacks — fired only after every buffered byte reached the OS, with no timer. A subprocess-level regression test drives a >pipe-buffer `git show` into a reader that starts 5 s late; the buggy build delivers 0 of ~311 KB, the fixed build delivers all of it.

Documented limitations (real, not yet closed): `on` is not crash-transactional (a kill between `claude mcp remove` and `add-json` can lose a server — the original is only in memory until the end); a stateless `off` in one project can unwrap another project's user-scope wraps; `.mcp.json` is discovered only in `cwd`, not parent directories the host would also read; the `exec` daemon inherits the env of its first spawner, so a later `export GIT_DIR=…` in the agent's shell isn't seen (frozen env); stdout/stderr interleaving isn't preserved (streams returned separately); a branch/tag named in all-hex gets the immutable-sha TTL; the `shims` uninstall re-derives the rc path from `$SHELL` and the fish path uses a universal variable. Distribution: **`npm install -g github:…` builds from source on install and, on some npm versions, leaves a broken symlink into the clone cache** (a reinstall then fails `ENOTDIR … rename … node_modules/speculate-mcp`); `npx … try` and a prebuilt tarball install are unaffected, and publishing to npm is the durable fix. These are tracked here rather than silently; none breaks the read-only or never-widen-consent invariants.

### 13.14 v0.9 — one command does both (2026-07-12)

User feedback: the README offered three activation paths (`on`, plugin install, shims) and it read as complicated as that sounds. The plugin covered CLI tool use (workspace server + Bash hook) but not MCP wrapping; `on` covered MCP wrapping + workspace server but not the hook. v0.9 makes **`speculate on` the one command**: after wrapping servers it installs the plugin through the host's own plugin CLI (`claude plugin marketplace add lukebward/speculate` + `claude plugin install -s local speculate@speculate`) — local scope, so activation stays per-project like everything else `on` touches. When the plugin is active, `on` skips its separate workspace-server registration (the plugin brings one; duplicates would burn context). Fallbacks preserve every old path: no plugin CLI on the host (or `--no-plugin`, or the install fails) → the plain local workspace server, exactly the pre-0.9 behavior; plugin already installed by the user → used as-is and left alone by `off`. `off` uninstalls only a plugin that `on` installed, and removes the (host-global) marketplace registration only when the last project's record lets go — tracked via a `marketplaceAddedByOn` flag plus per-project `action: 'plugin'` entries in managed.json. `status` reports which CLI-speculation shape is live. The README was rewritten around the single golden path (`try` → `on`), with the plugin no longer a separate quickstart step.

### 13.15 v0.10 — session-start priming + filesystem and slack profiles (2026-07-16)

Two additions on top of the durable usage stats work (§9, §13.6), both through existing seams:

**1. Session-start priming — the first-call miss.** Every benchmark shared one structural miss: a session's first call, which sits next to the largest idle window Speculate has (the user typing their first message). The learner now records each session's first 3 read-eligible asks per server as *openers* — keyed by (server, tool, exact args repr), count-ranked, per-server-capped, persisted alongside the transitions with the same defensive deserialization. An opener whose args repeat verbatim across ≥2 sightings fires at the NEXT proxy start: `Predictor.sessionStart` runs the openers through the same validate/feedback/dedupe/cap pipeline as any trigger batch, so policy, budgets, and §5.6 suppression all apply (ruleId `opener:<server>:<tool>`). Constant-args-only is the fail-closed answer to "openers have no trigger call to derive arguments from": an opener with varying args never reaches the threshold. Measured (scenario S9): first-call latency across three sessions 215 ms → 219 ms → 5 ms.

**2. Vetted profiles: filesystem + slack.** Same precedent as the GitHub profile's v0.1 ship: validated against bundled mocks that mirror the reference servers — `@modelcontextprotocol/server-filesystem`'s plain-text result formats ("[FILE] name" listing lines, path-per-line search results; the profile's parsers own that text contract per §5.1) and the classic `@modelcontextprotocol/server-slack` JSON-in-text payloads. Rules: list→read, read→siblings, search→read (fs); channels→history, history→thread, users→profile (slack). Short TTLs throughout on fs (the reference server pushes no change notifications); message-history TTLs shorter than membership/profile TTLs on slack. Curation per §4: nothing allowlisted moves a read cursor, marks anything read, or bills. Both profiles register for §13.11 fingerprinting. Pinning against the real servers remains the follow-up work item, exactly as it was for GitHub in v0.1.

Scenario coverage: S9 (priming curve across three restarts), S10/S11 (profile workloads vs the §10 criteria: both ~60% hit rate, ~58% tool-wait cut on the mock bench), S12 (durable receipts accumulate across sessions through `speculate stats --json`; usage snapshots verified aggregate-only — no tool names, arguments, or result text).

Known limits (v0.11 candidates): openers fire only on the MCP proxy path (the exec daemon's `cli` label doesn't record them); the 2-sighting opener threshold deliberately trades one cold session for evidence; opener recording keys on exact argument reprs, so a workspace whose opening reads vary (e.g. issue-of-the-day) never primes — by design, never by accident.

## v0.11 (2026-08-01): MCP-only focus

CLI speculation (exec daemon, Bash hook, workspace shell server) is removed.
Rationale: speculation value scales with upstream latency — MCP/SaaS reads
(hundreds of ms) dominate local CLI reads (~30 ms, often net-negative after
hook spawn overhead); read-only vetting of arbitrary argv has no
deterministic cross-platform answer short of per-OS sandbox machinery,
while MCP's readOnlyHint gives it for free; and the tier carried the
project's POSIX-only surface (unix sockets, uid checks) plus a Windows
.git/index watcher loop that flushed every prefetch. `on`/`off` now clean
up artifacts a ≤0.10 install left behind. Full trail:
docs/superpowers/specs/2026-08-01-focus-mcp-design.md.

---

## Appendix A. Market research & prior art

*Survey conducted July 2026 via web research. Quantitative figures below are as reported in the cited papers' abstracts and project pages; several full texts were not independently verified — spot-check any number before quoting it externally.*

### A.1 The MCP gateway landscape — nobody competes on latency

The MCP proxy/gateway space is crowded, but every incumbent competes on **security, governance, and aggregation** — auth/RBAC (MCPJungle, TrueFoundry, Portkey, Obot, ToolHive), guardrails and PII scrubbing (Lasso mcp-gateway, Docker MCP Gateway interceptors), zero-trust portals (Cloudflare), federation/registry (IBM ContextForge, agentgateway), transport bridging (sparfenyuk/mcp-proxy, TBXark/mcp-proxy), K8s lifecycle (Microsoft mcp-gateway), or REST→MCP conversion (Unla). **None of them advertises speculative or predictive prefetching of tool calls**; latency, as of this survey, is an unclaimed differentiator in gateway marketing.

The closest existing things:

- **Reactive caching proxies**, tiny and obscure: [duriandrivendesign/mcp-cache](https://github.com/duriandrivendesign/mcp-cache) (transparent proxy caching `tools/call`/`resources/read` on first use, ~month-long default TTLs, ignores `readOnlyHint`, no prefetch), [figma-mcp-cached](https://github.com/Pactortester/figma-mcp-cached) (per-server disk cache to dodge rate limits). Cache-on-first-call only helps *repeated* identical calls; it does nothing for the first ask, which is what speculation targets.
- **`tools/list` caching** is common in SDKs and gateways (e.g. the OpenAI Agents SDK caches `list_tools()`), and industry guidance ([Gravitee](https://www.gravitee.io/blog/mcp-api-gateway-explained-protocols-caching-and-remote-server-integration), [fast.io](https://fast.io/resources/mcp-server-caching/)) explicitly recommends *against* caching `tools/call` results except for deterministic tools — consistent with Speculate's short-TTL, conservative buffer design.
- GitHub searches for "MCP speculative prefetch" return zero repositories. The only speculative-tool-execution open-source artifact found at all is [joelvarun/speculative-tools](https://github.com/joelvarun/speculative-tools) — a 0-star Python library (n-gram next-tool prediction + async execution + 30 s TTL cache) bound to one agent framework, not protocol middleware.

### A.2 Academic validation — speculating agent actions works

Speculative execution of agent actions became an active research area between late 2024 and mid-2026. Key reported results:

| System | Layer | Reported result |
|---|---|---|
| [PASTE / "Act While Thinking"](https://arxiv.org/abs/2603.18897) (Microsoft, 2026) | Serving layer | Pattern-mined tool-sequence prediction; **−48.5% avg task latency, −67% tool-wait time**; 27.8% top-1 / 43.9% top-3 predictor recall (a compounded ~94% system hit rate is reported on repetitive workflow loops — treat as best-case, not typical) |
| [Speculative Actions](https://arxiv.org/abs/2510.04371) (ICLR 2026) | Agent framework | Fast model predicts next action, executes in parallel, slow model verifies; ~55% next-action accuracy → 10–20% latency cut |
| [SPAgent](https://arxiv.org/abs/2511.20048) (2025) | Inference engine | Adaptive speculation for search agents; **1.65× end-to-end speedup** at ~40% action-buffer hit rate |
| [IdleSpec](https://arxiv.org/abs/2605.22154) (2026) | Agent framework | Uses tool-wait idle time for speculative planning; >50% perceived-latency cut on GAIA/FRAMES |
| [DSP](https://arxiv.org/abs/2509.01920) (2025) | Agent framework | Online RL tunes speculation depth against dollar cost; −30% total cost, −60% wasted-speculation cost |
| [Accio](https://arxiv.org/html/2605.16565v1) (2026) | Web agents | Structural-regularity speculation; −33% latency, −1.9× cost, accuracy preserved |
| [SpecHop](https://arxiv.org/abs/2605.21965) (2026) | Retrieval agents | Continuous speculation with commit/rollback; −40% latency; measures tool time at 73% avg of E2E latency |
| [Ghost Tool Calls](https://arxiv.org/abs/2606.02483) (2026) | Analysis | Speculative calls leak inferred intent to external services at issue time — read-only ≠ disclosure-free (addressed in §4 and §11 risk 11) |

Three things follow. First, the mechanism works: reported next-action accuracies of **~28–55%** buy 20–50% latency reductions in these systems. An important asymmetry, though: every cited system sees *more* than a proxy does (model state, plans, sometimes the prompt itself); Speculate sees only protocol traffic, so its achievable hit rate should be assumed lower until measured (§10's thresholds encode this). Second, **every one of these systems lives inside the agent runtime, the serving stack, or the inference engine** — each requires adopting a framework or modifying infrastructure; none is deployable as protocol middleware. Third, the field has already mapped the failure modes (waste cost, staleness, intent leakage), which this design addresses in §4, §6, §7, §11 rather than discovering in production.

Also relevant: a [TDCommons defensive publication (June 2026)](https://www.tdcommons.org/dpubs_series/10773/) describes intent-predicted prefetching of agent retrieval backends with probability-×-value-÷-cost scoring. As deliberately published prior art it forecloses patenting the broad idea (by anyone), which is fine for an open-source project; it is a disclosure, not a product.

Complementary (not competing) lines of work: parallel/async function calling ([LLMCompiler](https://arxiv.org/abs/2312.04511), [AsyncLM](https://arxiv.org/abs/2412.07017)) accelerates calls the model has *already emitted*, while speculation covers calls it hasn't — the two compose (§8). Speculative retrieval ([Speculative RAG](https://arxiv.org/abs/2407.08223), [predictive RAG prefetching](https://arxiv.org/abs/2605.17989), [SpeQL](https://arxiv.org/abs/2503.00714) — which precomputes predicted SQL while the user is still typing, the closest "predict-then-precompute at an intermediary" analogy) shows the same trick working at other layers of the stack.

### A.3 Precedents outside AI — the pattern is proven at planet scale

- **Browsers** are the strongest analogy: Chrome's [Speculation Rules API](https://developer.chrome.com/blog/search-speculation-rules) is declarative, confidence-tiered, side-effect-constrained prefetch/prerender at the platform layer — Google Search prerendering cut LCP measurably, and [Ray-Ban's deployment](https://web.dev/case-studies/rayban-speculation-rules) cut mobile LCP ~43%. Speculate is the same shape: policy-driven speculation at a shared layer, with the "safe to speculate" boundary drawn by the platform, not the app.
- **CPUs** have rested the entire modern performance model on speculative execution behind branch predictors for three decades — predict, execute, cheap rollback.
- **Gmail** prefetches message images so opens render instantly; its known side effect — 1–6% "false opens" polluting email-open analytics — is the concrete cautionary example behind §4's side-effect rules.

### A.4 Spec trajectory — the ground is shifting in Speculate's favor

- **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are ratified spec, and the MCP blog's ["Tool Annotations as Risk Vocabulary"](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) is explicit that they are **untrusted hints** — which §4 already assumes. Precedent for acting on `readOnlyHint` exists: Claude Code uses it for parallel dispatch and plan-mode auto-permitting. Notably, the official annotations guidance never mentions caching/prefetching as a use case — the space is open.
- **SEP-2549 caching metadata** (`ttlMs`, `cacheScope`; final spec expected 2026-07-28) formally acknowledges caching intermediaries — `cacheScope: "public"` is defined so that "any client or intermediary (e.g., shared gateway, caching proxy) MAY cache" — but deliberately excludes `tools/call` results (§6.2 covers how Speculate relates to this).
- The 2026-07-28 RC also makes the protocol **stateless** (no `initialize` handshake, no session pinning), which lowers the cost of building MCP intermediaries — while making session *identity* the deployer's problem, which is why the shared-gateway shape is deferred (§3.2).

### A.5 Verdict

**The mechanism is validated; the layer is unoccupied.** Speculative tool execution is demonstrably effective in research systems, and no shipping MCP proxy/gateway/middleware does it. Speculate's defensible position is precisely the deployment model: *drop-in, protocol-native, agent-agnostic, and model-agnostic* — the browser's speculative-loading trick, placed at the one layer of the agent stack every harness already passes through. The differentiation to maintain is the deployment layer and the safety/observability envelope, **not** prediction-technique novelty (PASTE has already published the pattern-mining approach Tiers 1–2 resemble). Main market risks: incumbent gateways could add this as a feature (mitigant: none has, their roadmaps center on governance, and a focused OSS tool can move faster), and harness-level parallelization eroding part of the intra-turn win (mitigant: parallelization can't touch un-emitted or result-dependent calls, and the TTL-bounded slice of the between-turn window it harvests — §8).
