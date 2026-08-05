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

A per-server bigram model over observed transitions: `P(next_tool | prev_tool)`, learned live from the session. Argument prediction via templates mined per transition — for each argument of the follow-up call, candidate sources (same-named trigger arg, path into the trigger's parsed result, constant) are held as COMPETING hypotheses and scored against the traffic: every source that could have produced an observed value is credited, a value none of them explains is recorded as a miss and admits whatever new source does explain it, and the strongest few resolvable sources become several ranked argument sets from one transition (§13.18). One unexplainable value cannot disable the transition for good (§13.17). A transition predicts only when every argument remains derivable, with arguments resolved against the *current* call. Two consistent observations arm a transition; confidence ramps with count (capped at 0.55, below hand-written rules); ranking and eviction go by a time-decayed score rather than raw count (§13.16); the §5.6 feedback loop suppresses transitions that stop hitting. v0.2 scope: in-memory, per-session, capacity-bounded. Cross-session persistence (per-user/per-project priors) remains post-MVP.

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

- **Per-tool TTL** from the server profile, defaulting to **30 s**, capped at a few minutes. The prefetch-to-use gap for intra-turn chains is seconds, so short TTLs retain most of the win while bounding staleness. **The 30 s is an unmeasured guess** — chosen from that gap, never validated against how often a 30 s-old answer is actually wrong; §13.19 records the shadow-validation experiment that would replace it with a number, and why it is deliberately unbuilt.
- **A long-horizon TTL lever exists, and ships as the identity.** A prediction that reads *anything* off the call that just completed claims "this is the next call"; one where **no** argument does — every argument a remembered literal, or a §13.15 session opener with no trigger at all — claims only "you will ask for this at some point" (`Prediction.horizon === 'standing'`). Standing bets can be fetched at a fraction of the resolved TTL via `speculation.longHorizonTtlFactor`, applied to whatever the normal resolution order produced, so an operator's per-tool freshness decision still sets the ceiling and a per-tool TTL of 0 stays disabled rather than being revived. **`LONG_HORIZON_TTL_FACTOR` defaults to 1** — the premise that standing bets wait longer is measured false (§13.19: lead 1.000, identical to derived predictions) while the cost is measured real (a factor of 0.5 destroys the whole class once an agent's inter-call gap passes half the TTL). §13.19 records the counters that must move before turning it on.
- **Age at consumption is measured, not assumed** (§9): every hit records how long the entry had been ready and what fraction of its TTL that was, because better prediction fires earlier and further ahead and can only push that number up.
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
3. **Transition learner (§5.3).** Session-scoped, zero-config: two consistent observations of a transition arm it; argument templates (arg-copy / parsed-path / const, scored as competing hypotheses, fail-closed) generalize across argument values. Verified end-to-end: an unprofiled server in `annotated` mode reaches its first prefetch hit on the third occurrence of a repeated workflow step.

Safety posture for unprofiled servers is unchanged and now documented user-facing: `annotated` mode (trust `readOnlyHint`) or `strict` + per-server `allowTools`. Test suite: 216 tests (learner 30, config rules 30, plus two new end-to-end tests); the GitHub benchmark is unchanged (71% / −66% / 0 waste — learner transitions need two sightings, and the benchmark's workflow has none repeated).

Known limits recorded for v0.3: ~~learner state is per-session~~ (addressed in §13.6); predictions never cross servers (a GitHub issue mentioning a Slack thread won't prefetch Slack); config-rule selectors don't interpolate inside nested object literals; profile-quality vetted rules still beat both generic tiers on cold sessions — community profiles remain worth shipping.

### 13.6 v0.3 — learned-state persistence (2026-07-10)

The learner's model and per-rule feedback now survive restarts, so a proxy that has seen your workflows prefetches from its first trigger of a new session (verified end-to-end: session 2 hits on its first repeated-workflow trigger with no relearning).

**What persists** — two things, in one versioned JSON state file:
1. The transition model: (server, prevTool → nextTool) entries with observation counts, decayed evidence scores with the clock reading each was taken at (§13.16), and argument templates. Templates reference argument *provenance* (copy-this-arg, this-path-into-the-parsed-result) plus constant argument values by canonical repr. Chain heads are session-local and excluded.
2. Per-rule feedback counters (hits/wasted/speculated), so suppression knowledge survives too.

**What never persists:** tool results. The §6.4 memory-only cache promise is untouched — the state file contains tool names, argument-shape templates (including constant *argument* values, which is why the file is 0600 under a 0700 dir), and counters. Since v0.13 a template keeps up to `MAX_SOURCES_PER_ARG` competing literals per argument rather than the single one the old intersection narrowed to, so more user-supplied values (paths, ids, search queries) now sit in that 0600 file than before: measured 419 to 1,207 bytes on a 12-transition workload, the same class of data inside the same boundary, and more of it.

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

**Pre-loaded priors that adapt per user (learner priming).** The product now ships prediction knowledge that activates before any learning: (a) vetted profiles carry curated `primes` pairs; (b) on connect, lister→getter tool-name morphology (`list_X`→`get_X`, `search_X`→`get_X`, prefix and suffix forms, plural-tolerant stems) is detected on ANY server. A primed (server, prev, next) pair reaches the prediction threshold after **one** observed sighting instead of `minObservations` — a threshold change, not fabricated knowledge: argument templates still come exclusively from the user's real traffic, primes only target speculation-eligible tools, and once observed the transition is an ordinary learned one — it grows with use, gets suppressed by feedback if it doesn't match this user, persists per config (§13.6), and is capacity-bounded (§13.16). Unobserved primes cost one Set entry and are recomputed per session from live tool lists (never persisted). `doctor` reports each server's primed pairs.

Demo/readme: the benchmark is rendered as an animated terminal (generated from captured ANSI output — svg-term-cli proved incompatible with modern casts) embedded at the top of the README alongside the numbers table. Originally an animated SVG; now a GIF (scripts/gen-demo-gif.mjs), one keyframe per revealed line, rasterized from the same model via resvg and encoded by ffmpeg.

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

Known limits (v0.11 candidates): openers fire only on the MCP proxy path; the exec daemon that once carried the `cli` label was removed in v0.11. The 2-sighting opener threshold deliberately trades one cold session for evidence; opener recording keys on exact argument reprs, so a workspace whose opening reads vary (e.g. issue-of-the-day) never primes — by design, never by accident.

### 13.16 v0.13 — evidence decay and value-based eviction (2026-08-01)

The learner scored purely by lifetime frequency and never forgot, so last quarter's finished project outranked this week's work indefinitely, and its transition cap evicted **FIFO** — the entry seen a hundred times at session start was dropped to make room for a one-off seen a second ago.

Each transition and opener now carries a second number beside its count: a **decayed evidence score**, `score * e^(-elapsed/TAU)` with TAU = 14 days, aged to *now* and incremented by 1 on each new observation. It drives **ranking and eviction only**. `count` is untouched and keeps gating `minObservations` and feeding the confidence ramp: decaying it would have silently stopped stale-but-valid transitions from firing at all, which is a different (and unasked-for) behavior change. A transition proven a year ago is still real; it is just no longer topical.

**Recency persists.** `(score, lastUpdated)` travel together in the state file (§13.6), undecayed, so the gap across a restart is charged on load instead of forgiven — without this the mechanism would reset every session and be cosmetic. Deserialization stays defensive and backward-compatible: a pre-existing file with neither field loads with `score = count` and `lastUpdated = now()`, a junk score falls back to `count`, and a stamp from a clock running ahead of ours is clamped to now (no entry buys permanent freshness).

**Admission is an invariant, not a detail.** Ranking eviction by value must exempt the entry the current observation just wrote. Without that exemption a full table can never learn anything new: a first sighting scores 1, an incumbent with two recent sightings scores just under 2, so the newcomer is the weakest entry and is deleted by the same `observe()` that created it — then recreated and re-deleted on every later sighting, so it never reaches `minObservations`. That is the FIFO bug pointed the other way (FIFO discarded the *best* entry; unprotected value-eviction admits *nothing*), it fails silently as a frozen model rather than an error, and because `(score, lastUpdated)` persist, a saturated state file would carry the stall across restarts. Both caps — transitions and per-server openers — exempt the just-written key, and both have a regression test at the DEFAULT `minObservations`.

Measured (offline recall@K harness, seeds 1,2,3, 1020 workflow pairs), decay on vs. the pre-decay learner on the same corpus:

| archetype | no decay | with decay | Δ recall@3 |
|---|---|---|---|
| list-detail-varied | 0.430 | 0.423 | −0.007 |
| return-visits | 0.497 | 0.497 | 0.000 |
| multi-arg | 0.883 | 0.883 | 0.000 |
| **regime-shift** | **0.000** | **0.900** | **+0.900** |
| WORKFLOW (headline) | 0.532 | 0.636 | **+0.104** |
| adversarial (floor) | 0.087 | 0.087 | 0.000 |

The `regime-shift` archetype (a 45-day idle gap, then the workflow changes) is what makes staleness measurable at all: without decay it scores **0.000** at k=3 with *infinite* waste per hit, because the pre-gap regime's higher lifetime counts pin the top 3 forever. Its recall@**5** is 0.950 either way — the post-gap answer was always in the candidate set, just ranked below the cap — so on this corpus decay is a pure **ranking** win. The other three archetypes space sessions 600 s apart, deep inside a 14-day TAU, so they contain no stale evidence and show only tie-break jitter (−0.007 on one). TAU was not tuned to the fixture; 14 days comes from the deployment story above.

Scope note: this corpus never reaches `maxTransitions`, so the eval exercises **ranking only** — the eviction policy and the admission invariant are covered by unit tests, not by these numbers.

Composition note: the headline **+0.104 is a property of the corpus mix, not a transferable property of the learner**. `regime-shift` supplies 120 of the 1020 workflow pairs (11.8%) and moves +0.900, which is +0.106 of the total by arithmetic alone; the other three archetypes net −0.002. Give the fixture more phase-2 sessions and the same code change reports a bigger number. The per-archetype rows, not the pooled figure, are what attributes the change. `regime-shift` also has near-zero cross-seed variance by construction (the seed varies names and branches, never the transition structure), so running more seeds confirms determinism rather than robustness: the uncertainty in +0.104 lives in the fixture design, not in sampling.

Reach note: the shipped `Predictor.selectBatch` ranks by `confidence × effectiveness`, and learner confidence is derived from the **undecayed** `count`. So decay decides which ≤3 transitions the learner *proposes*, and downstream it survives as the emission-order tie-break between candidates of equal `confidence × effectiveness`. That tie is not an edge case: `effectiveness` returns exactly 0.5 for every rule that has never fired, and learner confidence is two-valued (0.45 at count 2, capped 0.55 at count ≥ 3), so among equal-count learner candidates at cold start the product ties outright and decay orders the **whole** batch. The eval calls `learner.predict` directly, so the table above remains an upper bound on decay's reach in production, but the reach is wider than a tie-break note suggests.

### 13.17 v0.13 — one underivable value no longer disables a transition (2026-08-02)

An argument template was killed by a **single** observation it could not explain, forever. Two latches enforced it and only releasing both changes anything: `ArgTemplate.underivable` was sticky, and `updateTemplates` intersected the candidate sources with the ones that reproduced the new value, so an unexplainable value emptied the list — after which `resolveSources` failed and `materializeArgs` returned null whatever the boolean said. Releasing the boolean alone is a measured no-op. On the eval corpus this scored two whole list→detail legs at exactly **0.000**: an agent opening the second row of a list instead of the first, once, disabled the transition for the rest of the process's life.

The boolean is now **evidence**: `derived` and `missed` counts per argument. An observation no candidate explains records a miss and **retains** the candidate list; an observation some candidate explains still intersects (the derivation narrows as before). An argument is underivable when it has never been derived (`derived === 0`, including the empty source set), when evidence is thin (< 4 observations) and there is any miss at all, or when the miss rate reaches 75% thereafter. The first clause is the fail-closed one and is absolute — **an argument no source has ever produced is never fabricated**, and a prediction whose arguments cannot all be resolved is still dropped. The thin-evidence clause keeps a template quiet while its rate is unmeasurable, so the change costs nothing at cold start; the rate clause bounds the waste a surviving template imposes **in the limit** at roughly three wasted predictions per hit (a derivation wrong at rate m costs m/(1−m) per hit).

That bound is a lifetime average, not a cap, and it is the one soft spot worth naming: `derived`/`missed` are the only evidence in this file that does **not** decay, so a derivation that used to work must accumulate misses in proportion to its whole history before the gate closes — measured, a template with 200 clean derivations still fires after 400 consecutive wrong ones and needs 600 to cross 75%. The production backstop is the §5.6 feedback loop, which suppresses a learner ruleId after 8 speculations below 0.15 effectiveness and so reacts in tens of calls rather than hundreds; the offline eval does not model it, so the harness sees the pessimistic case. Decaying these counters is a candidate for the same treatment §13.16 gave the transition scores, deliberately not done here.

`derived`/`missed` persist beside the sources. `underivable` is still written, carrying the current verdict for older builds, but a build that understands the counters recomputes the verdict from them — otherwise a rate-poisoned template would come back from disk permanently dead. A pre-v0.13 file (boolean, no counters) loads exactly as before: `underivable: true` stays sourceless and silent, `false` loads as one derivation and no misses.

Measured (offline recall@K harness, seeds 1,2,3, 1020 workflow pairs):

| archetype | before | after | Δ recall@3 |
|---|---|---|---|
| **list-detail-varied** | 0.423 | **0.527** | **+0.103** |
| **return-visits** | 0.497 | **0.717** | **+0.220** |
| multi-arg | 0.883 | 0.883 | 0.000 |
| regime-shift | 0.900 | 0.900 | 0.000 |
| WORKFLOW (headline) | 0.636 | **0.731** | **+0.095** |
| adversarial (floor) | 0.087 | 0.087 | 0.000 |

The attribution is the point: the movement is entirely in the two archetypes built around a moving list position (`board_list_cards→card_get` 0.000 → 0.207, `svc_list_alerts→alert_get` 0.000 → 0.440), the two that never had a latched template do not move at all, and the noise floor does not move — a change that merely made the learner fire harder would have lifted the floor first. Workflow waste per hit goes 1.45 → 1.54, which is the price: transitions that emitted nothing now emit something, and on these corpora they are right more often than the rate gate's worst case.

Still capped at one hypothesis per transition. `board_list_cards→card_get` lands at 0.207 because the template keeps whichever row the first sighting used; emitting row 0/1/2 as competing hypotheses is a separate change — §13.18.

### 13.18 v0.13 — argument sources compete, and a transition offers several (2026-08-02)

§13.17 stopped one unexplainable value from killing a template, but the template could still hold only **one** answer per argument: `updateTemplates` intersected, so the candidate list only ever shrank, and `resolveSources` returned the first entry that resolved in a fixed arg-copy > parsed-path > const order. Two consequences, both structural. The surviving derivation was whichever row index the **first sighting** happened to use — measured, seed 1's survivor for `board_list_cards→card_get` was `cards.2.cardId` at a **90%** miss rate, gated off by the rate clause, while seeds 2/3 drew `cards.0.cardId` and scored. And one transition materialized exactly **one** argument set, so it could never offer index 0 *and* index 1: recall@K was pinned to recall@1 whatever the budget. PASTE (arXiv 2603.18897, Appendix A) infers arguments through the same shape and names the missing piece — choosing an element by index with a fallback: use the first result, and if it fails, try the next.

Each source now carries its own evidence: a **decayed score** (the §13.16 helper, same 14-day TAU), the clock reading it was taken at, and a count of observations it explained **alone**. On each observation every stored source that would have produced the value is credited — not just the first one tried — and any source the observation *reveals* is admitted, evicting the weakest at the per-argument cap instead of refusing it (the §13.16 admission invariant, third site). `derived` still counts only what an **already-stored** source explained; crediting sources mined from the value itself would make every template trivially derivable and silently disable the fail-closed gate.

On predict, each argument ranks its resolvable sources by decayed score, and a **beam** walks the lattice of choices best-first: the all-best combination, then the next-best substitution one argument at a time, ordered by the product of the per-argument weights, deduped by materialized args. The all-best combination weighs exactly 1, so a transition's first candidate ranks and scores exactly where it did before; variants rank below it, and the ranking is **global** across transitions, so a variant has to beat another transition's first choice to take its slot. Confidence is the existing ramp — same 0.55 ceiling, applied *before* the discount — times the combination's weight, so §5.6 sees a speculative third choice as the weaker candidate it is.

**A hedge is weighted by its share of the argument's evidence, not by its distance from the leader.** Normalizing against the leader looks natural and is wrong: twelve one-off literals that all tie score the same as a genuine 25/9/5 split of a list position, so each would rank as though it were *the* answer and one transition would spend a whole batch on memorized junk. Measured, that cost `doc_read→doc_list_backlinks` −0.127 (it fell out of the top 3 while a transition with an underivable `query` argument hedged, in the window before the miss-rate gate closed on it); weighting a hedge as `score / Σ scores` over all admissible values leaves −0.025. The share is computed **before** anything truncates the options, and the option list itself is cut at a fixed `MAX_OPTIONS_PER_ARG` rather than at the caller's cap, so the weights and the lattice are both identical whatever the trigger is allowed: `predict` at k=3 is exactly the first three of `predict` at k=5, by construction rather than by observation, which is what makes an eval measured at k=5 a faithful reading of production at 3. Slicing the options to the caller's cap instead made the k=5 lattice a strict superset of the k=3 one, and since an incoherent combination is skipped but still expanded, a k=5 run could emit at rank 2 a value a k=3 run could not reach at all. Corpus impact was nil (0 divergences over 1,770 lockstep trigger comparisons across all seven archetypes and seeds 1,2,3), which is exactly why it needed fixing rather than recording: the eval measures at 5 and production runs at 3, and that equivalence is the instrument's load-bearing assumption. The counterexample is now a test.

**A source may not answer for an argument just because it resolves.** The best-evidenced one always may; any other needs `solo ≥ 2` — two observations it explained when nothing else stored did. That single gate does two jobs: it demands recurrence (the same bar `minObservations` sets for transitions, so a literal seen once is a coincidence, not a hypothesis), and it rejects **domination** (a source that has only ever matched alongside a better one has no evidence of its own — whenever the two disagree, which is the only time offering it changes anything, the other has been right). Concretely: rows 0/1/2 of a list explain disjoint observations and each earn a slot; the const mined from a template's first sighting, which merely echoes an arg-copy, never does. Without the gate that const is a permanent fallback resolving on every call forever — a value seen *once*, months ago, answering for a derivation that found nothing today.

**Fail-closed moved, in both directions, and the honest statement of it is narrower than "unchanged".** What is absolute and untouched: an argument no source has ever produced is never fabricated, and a prediction whose arguments cannot all be resolved is dropped whole — pinned by `still refuses to guess an argument it has never derived` and, for the beam specifically, by a case where three ranked ids are dropped because a second argument is absent. What *changed* is the rule one level down. "The derivation did not resolve, so predict nothing" is now "…so fall back to a literal that has **recurred**": a memorized value with `solo ≥ 2` may stand in when the best-evidenced source finds nothing on this call. Measured against the pre-§13.18 build, a template that derived six values from `rows.0.id` and then saw one unexplainable literal emits nothing on an empty list (as before); after that literal recurs *once*, it answers with it. That is the same mechanism that makes an entity the user keeps returning to predictable — it is what `svc_list_alerts→alert_get` 0.440 → 1.000 is made of — and it is looser than the old build, not tighter. `falls back to a memorized literal only once that literal has recurred` pins both sides of the line. The gate below is what keeps it at "recurred" rather than "seen once".

Measured (offline recall@K harness, seeds 1,2,3, 1020 workflow pairs — the corpus as of this change, before `direct-recall` and `paired-args` were added):

| archetype | before | after | Δ recall@3 | waste/hit |
|---|---|---|---|---|
| **list-detail-varied** | 0.527 | **0.727** | **+0.200** | 2.56 → 3.24 |
| **return-visits** | 0.717 | **0.997** | **+0.280** | 1.27 → 1.26 |
| multi-arg | 0.883 | 0.883 | 0.000 | 0.82 → 0.84 |
| regime-shift | 0.900 | 0.900 | 0.000 | 2.33 → 2.33 |
| WORKFLOW (headline) | 0.731 | **0.873** | **+0.141** | 1.54 → 1.75 |
| adversarial (floor) | 0.087 | 0.087 | 0.000 | 9.08 → 9.08 |

Eight seeds, re-measured at the two pinned trees (`967320c` and `d42b6c9`) rather than pooled from mixed builds, because this table is the only evidence that +0.141 is not a lucky draw: workflow **0.7353 → 0.8710**, recall@1 0.6000 → 0.6173, waste/hit 1.50 → 1.77, floor identical in every counter (720 issued, 647 wasted, both bands 0.0912). Per archetype: list-detail-varied 0.519 → 0.730, return-visits 0.746 → 0.999, multi-arg 0.875 → **0.873**, regime-shift 0.900 → 0.900.

Per transition, the movement is *only* in the two legs built around a moving list position — `board_list_cards→card_get` 0.207 → 0.607 and `svc_list_alerts→alert_get` 0.440 → 1.000 — and every other transition in the corpus is unchanged to three decimals. Over 8 seeds one is not: `doc_read→doc_list_backlinks` 0.937 → 0.911 (−0.025 on 79 pairs, which is the whole of multi-arg's −0.002), a rare branch losing rank 3 to a hedge from a frequent one. recall@**1** rises too (0.607 → 0.626 at 3 seeds, 0.600 → 0.617 at 8): the ranking is not trading precision for recall. Per transition at 8 seeds, recall@1 goes `board_list_cards→card_get` 0.185 → **0.347** (evidence picks the row the agent actually opens, instead of the row the first sighting used) against `svc_list_alerts→alert_get` 0.495 → 0.455 — the one place rank 1 got worse, and it is a coin flip either way between two favourites that alternate 50/50, on a leg whose recall@3 went 0.495 → 1.000. The floor is byte-identical — 262 predictions issued, 236 wasted, 26 hits, before and after — because its ids never repeat, so no source ever accumulates evidence and every template stays gated.

Waste is the price and it is not free: the workflow pool issues 1892 → 2449 predictions at the shipped cap of 3 for 746 → 890 hits, i.e. 1.54 → 1.75 wasted per hit. It is concentrated exactly where the recall came from (`list-detail-varied` 2.56 → 3.24, a leg that used to emit one candidate and now emits three), and `return-visits` bought its +0.280 while its waste/hit went *down*, because the second candidate it now offers is right almost every time. The §5.6 loop's arithmetic happens to come out roughly unchanged: effectiveness ≈ recall@K / K either way (0.207/1 before vs 0.607/3 after on the hard leg), so on these corpora the beam does not suppress itself. **Nothing enforces that**, and it is worth naming as a watch item rather than a property. Variants share the transition's ruleId, so a transition emitting three candidates for one hit runs at an effectiveness near 1/3 of its recall@K, against a 0.15 suppression floor at ≥8 speculations — a transition whose hedges are worthless drags its own first choice toward silence. The `solo ≥ 2` gate does *not* protect against that: it tests whether a hypothesis has ever explained something independently, never whether it has ever been RIGHT when predicted. A hedge that has explained history and keeps missing the future is exactly the case nothing currently catches, and per-variant feedback (a ruleId per source, at the cost of fragmenting §5.6 onto a moving target) is the obvious lever if it shows up in production.

**Arguments that move together are one hypothesis, not two.** Ranking each argument on its own marginal evidence assumes they are independent, and when two arguments come off the same row of a list — a releaseId and its buildId, an id and its lane — the marginals lie: of the nine pairings three rows admit, only three have ever occurred, and the six that have not are the CHEAPEST substitutions in the lattice (one step from the best combination). So the batch fills with pairings that never happened and the one real alternative falls past the cap. Note what this is: the exact defect §13.18 set out to fix, reappearing one level up. Recall@3 collapses back onto recall@1 — measured **0.420 / 0.420 / 0.493** at k=1/3/5 on the new archetype's hard leg, the extra two slots buying literally nothing.

The fix is provenance, not more ranking. Each source keeps a 32-bit window of *which* of the transition's last 32 observations it explained, shifted for every source of every argument on every observation so the bit positions mean the same thing across arguments. A substitution whose chosen values have non-overlapping windows has positive evidence of never having been right together, and is skipped — but still expanded, since the coherent pairing is only reachable through it. Two windows that do not overlap is evidence; a window that is empty (a pre-v0.13 file, or sightings aged out) is *not* evidence and never blocks anything, and the all-best combination is never skipped, so the check can only remove candidates that a strictly independent model would have invented. On the `paired-args` archetype: recall@3 **0.647 → 0.887**, recall@5 0.720 → 0.923, recall@1 unchanged at 0.537, and waste/hit **4.23 → 2.70**. Recall up and waste down together, which is the signature of removing combinations rather than adding them; every other archetype, including the floor, is unchanged to the unit.

`paired-args` exists because nothing else in the corpus could see this: no other transition has two arguments with more than one live hypothesis each, so the whole class of bug reported 0.000 everywhere. A corpus test asserts the co-variation is real (the two ids always come from the same row, and row 0 is not always the one opened) rather than trusting the generator's comment.

**The rate clause fires strictly less often, which was the open question from §13.17.** Terminal state after a seed-1 replay: `board_list_cards→card_get [cardId]` went from one source at a 90% miss rate (RATE-GATED, silenced) to three sources at **38%** (ok); `svc_list_alerts→alert_get [alertId]` from one memorized literal at 55% to both of the operator's two favourites plus two array paths at **3%**. Where it still fires it is for the right reason: `doc_read→space_search [query]` stays gated at 93%, because a brand-new search query is derivable from nothing and always was. A bad source now loses to a good one instead of dragging the whole template to silence.

Costs, measured: `observe()` goes 2.9 µs → 7.2 µs per call (it now indexes the previous call's args and result paths once per observation and tests every stored source, instead of only mining on a first sighting) — irrelevant beside an MCP round trip, and the index is shared across the follow-up's arguments so a wide result is walked once rather than once per argument. A state file roughly doubles (the whole eval corpus: 15 KB → 30 KB) since templates now persist up to `MAX_SOURCES_PER_ARG` scored sources instead of the one they narrowed to. Back-compat: a source with no `score` loads with **zero** evidence rather than borrowed credit, which makes the old priority order the fallback ranking for a pre-scoring file and offers no variants until real traffic scores something. That cuts one way in particular and it is worth stating plainly: an upgraded file goes **quieter**, not louder. Its sources import with `solo = 0` and an empty provenance window, so a const that the pre-scoring build would have fallen back on when the derivation failed is withheld until traffic gives it standing — one observation is enough to start scoring it, and the fail-closed direction is the right one to err in. `a state file with no scores goes quieter, not louder, after the upgrade` pins it.

One behaviour deliberately changed, with its test: a template whose constant goes stale can now learn the new one. `x1, x2, x2, x2` used to stay silent forever (the only candidate was the const from the first sighting, and it never produced `x2`); it now mints `x2` as a hypothesis when nothing else explains the value and speaks once it has recurred. That is the same mechanism that finds the operator's *second* favourite alert, and it is what makes `svc_list_alerts→alert_get` reach 1.000. It does not weaken fail-closed: a value that never repeats is never predicted, which `still refuses to guess an argument it has never derived` continues to pin over eight sightings of eight distinct values.

**0.846 is an upper bound, and the DEFAULT transport may not reach it.** recall@3 is what a batch of three is worth once all three are actually issued, which is what an http server does and what the offline harness assumes; on stdio, speculation is serial and idle-only (§7), so the 2nd and 3rd candidates queue behind the 1st and `enqueue` evicts the lowest-confidence tail at the queue cap, which is precisely the beam's hedges. What decides it is how long the agent thinks between calls, measured end to end at seed 1 on stdio for list-detail-varied / paired-args / return-visits: **0.740 / 0.880 / 1.000** when the inter-call gap is 3x upstream latency or more (equal to the eval, and equal to http), 0.470 / 0.600 / 1.000 at 2x, and 0.420 / 0.590 / 0.940 at 1x. So the win converts fully once the agent's gap is roughly 3x upstream latency, and `queue-full` and `queue-expired` in `speculate_stats` are the two counters that say which regime a session is actually in. This is not a regression and the beam is not the cause: at the same 1x spacing a learner capped at one candidate, the pre-beam world, reads 0.360 / 0.560 / 0.600 against K=3's 0.420 / 0.590 / 0.940, so K=3 is ahead at every point. It matters because `speculate wrap` and the plugin both make stdio the default, so a tight-loop session is the shape most likely to read below the headline.

### 13.19 v0.13 — measuring how stale a served prefetch was (2026-08-02)

Prediction quality and freshness pull in **opposite directions**, and §13.16–§13.18 only improved one of them. Each of those changes makes the proxy prefetch more, earlier, and further ahead, which can only raise the **age of an entry at the moment it is consumed** — and every number in the report was age-blind, so the whole sequence could have been trading freshness for recall with nothing showing it. What already bounds the damage is unchanged: TTL from completion, single-use entries, a full per-server flush on any non-read-only call. What was missing was any measurement of the **distribution** inside that bound.

**Runtime.** A cache hit now carries `ageMs` (how long the entry had been ready — the same instant the TTL counts from, so the payload itself is up to `upstreamLatencyMs` older) and `ttlFraction`. `Metrics` bins those into a 100 ms histogram out to 60 s and reports `ageAtHit` through the existing `speculate_stats` surface and the session summary: count, p50/p95 (bin midpoints; `maxMs` is exact so a tail is never rounded away), the share consumed in the **last quarter of their TTL**, counts per age band, and counts per TTL quarter. Aggregate only, like every other counter in §9 — durations and counts, never a key, an argument, or a result. A **joined** call contributes nothing: it never sat in the buffer, and folding it in as age 0 would drag the distribution toward "everything is fresh", which is the comforting lie the metric exists to prevent. `count` and the TTL quarters describe the same sample by construction — a hit missing either half of the measurement is admitted to neither — so every share reported is a share of the same denominator. **Scope, stated because it is easy to over-read:** `ageAtHit` measures what was *served*. An entry that expired unclaimed never appears in it; that cost lands in `expired` and per-rule `wasted`, and any question about entries that died before use has to be asked there.

**Offline.** `eval/replay.ts` now replays the same predictions through a simulated speculation buffer alongside the rank scoring — single-use, TTL from completion, first-put-wins on a key (dedupe keeps the *older* entry, which is itself one of the mechanisms that raises age). It is strictly an observer: nothing it does feeds back into what the learner predicts, so recall is bit-identical with it and without it, which is pinned by test.

Measured (seeds 1,2,3, 30 s TTL, 1.5 s between calls):

| | hits | median | p95 | max | last TTL ¼ | mean lead | unclaimed |
|---|---|---|---|---|---|---|---|
| all | 1273 | 1460 ms | 1460 ms | 2960 ms | 0.000 | 1.006 | 2428 |
| next-call | 1158 | 1460 ms | 1460 ms | 2960 ms | 0.000 | 1.007 | 1963 |
| standing (memorized) | 115 | 1460 ms | 1460 ms | 1460 ms | 0.000 | 1.000 | 465 |
| adversarial (floor) | 29 | 1460 ms | 2960 ms | 2960 ms | 0.000 | **1.276** | 117 |

**On this corpus age is a restatement of lead, and the report says so.** Calls are a fixed 1 500 ms apart, so age = `lead × 1500 − 40` exactly: median, p95 and max carry no information the mean-lead column does not, and `last TTL ¼` cannot be non-zero below a lead of 15 at this spacing. Three columns of the same number read as three independent measurements, which is why the printed table now states the identity underneath itself. The floor is reported on its own row for the same reason: `adversarial` is the **only** archetype with any lead depth (1.276 against 1.000 everywhere else), and pooled into a population forty times its size it disappears.

**The answer to the question the instrument was built to ask is: no, better prediction did not move entries toward expiry.** Against a deliberately narrower model (`maxPredictionsPerTrigger: 1`, roughly the pre-§13.18 one-candidate world) recall@3 is 0.571 vs 0.846 — and the age distribution is *identical*: p50/p95/max unchanged, mean lead 1.0092 → 1.0063, i.e. very slightly **fresher**. The extra hits are all claimed by the very next call (1265 of 1273 at lead 1, 8 at lead 2), so they arrive at the same 1460 ms as everything else. The suite pins that the ages do move when consumption is delayed (triple the spacing, triple the age) or the TTL is shrunk, so the flatness is a property of the corpus and not of the instrument.

**The long-horizon TTL lever, and why it ships as the identity** (§6.2). `Prediction.horizon` is `'standing'` when **no** argument was read off the call that just happened — every argument a remembered literal — or when the prediction is a §13.15 session opener, which has no trigger at all. The test is `every`, not `some`, and that distinction is the whole classification: horizon is about whether the TARGET was derived from the trigger, not whether every argument was. `get_issue {repo, number: <from the trigger's result>, per_page: 100}` is a next-call prediction that happens to carry a constant, and real profiles are full of constant `per_page` / `state: 'open'` / `format` arguments — classifying on `some` caught the modal next-call prediction (measured: 243 of 1273 simulated hits, including *all* of `return-visits`, versus 115 under `every`).

**One inconsistency survives that fix, and is recorded here rather than repaired.** An argument set that is entirely constant still classifies as `standing`, while a zero-argument one classifies as `next`, and the principle just stated says both are `next`: in each case nothing was read off the trigger, and the transition that fired is itself the derivation. The corpus sides with the principle rather than with the code, since the standing class is consumed at a lead of exactly 1.000 calls, the same instant as a derived one. It is inert at the shipped factor of 1, and it is not a one-line repair: making the learner consistent empties the class outright, leaving openers as the only standing bets, and takes with it the `standing (memorized)` row above and the sweep below that prices the lever. The narrower rule worth measuring first is one that separates an argument holding a single never-varying literal (`state: 'open'`) from one holding several competing memorized entities (an operator's two favourite alerts), since only the second is a bet on *which* thing rather than a fixed shape parameter. Left to whoever turns the factor down, which is the only person the difference can reach.

The premise of shortening is that a standing bet waits longer in the buffer and so is served nearer expiry. **The corpus measures the opposite.** Standing predictions are consumed at a lead of exactly **1.000** calls in every archetype that has any — the same instant as derived ones. And the cost is not unmeasurable, as an earlier version of this note claimed; the harness has a `callSpacingMs` knob, so sweeping an agent's inter-call gap prices it directly (seeds 1,2,3, hits at factor 1 → factor 0.5):

| spacing | 1.0 | 0.5 | standing hits at 0.5 |
|---|---|---|---|
| 1 500 ms | 1273 | 1273 | 115 |
| 10 000 ms | 1273 | 1273 | 115 |
| 16 000 ms | 1265 | **1150** | **0** |
| 20 000 ms | 1265 | **1150** | **0** |

A factor of 0.5 is free only while the gap stays under half the TTL, and the moment it passes, every standing bet expires before the call that wanted it. Unmeasured benefit against measured loss is not a trade worth a default, so `LONG_HORIZON_TTL_FACTOR` is **1** and the knob is the opt-in. The sweep above is a test, not a footnote.

The argument survives for **openers**, where the evidence is missing rather than contrary: they fire in `proxy.start()` right after `connectUpstreams()`, before the MCP handshake finishes and before the user has typed, so proxy-start-to-first-call routinely exceeds 15 s and they are the class most likely to be served at 25–30 s of age. The corpus cannot see them (it has no proxy-start-to-first-call gap, and inventing one would just return the number chosen), and — correcting the same earlier note — **`ageAtHit` cannot settle it either**: it is fed on `outcome === 'hit'`, so an opener that expired before the agent's first call never appears in it at all. The instrument for that trade is `expired` and `perRule['opener:*'].wasted`, which is where an opener killed by a shorter TTL actually lands. Turning the factor down without watching those two would hide the entire cost of the change.

**Shadow validation: recorded, deliberately unbuilt.** The way to replace the 30 s guess with a measured number is to re-issue a served prefetch immediately after serving it and compare the two results: the disagreement rate *as a function of age* is exactly the curve nobody has, and it would let per-tool TTLs be set from evidence instead of intuition (a `git_show` on an immutable sha never disagrees; a PR list disagrees within seconds). It is not built, for two reasons that are not fixable by implementing it more carefully. It **doubles upstream calls** on precisely the hot path speculation already spends quota on — the cost lands on the user whose quota it is, for a measurement that benefits the defaults. And it **detects a stale answer only after that answer was already served**, so it is a tuning instrument, never a correctness guarantee; a design that treated it as one would be strictly worse than the current honest bound. If it is ever built it belongs behind an explicit opt-in (a sampling rate, off by default), reporting only an aggregate disagreement rate per (tool, age bucket) — never the differing results, which is exactly the payload §9 has never logged. Until then the 30 s stays what it is: a guess, labelled as one in §6.2, with `ageAtHit` at least making its *consequences* visible.

Unchanged on purpose: the safety policy, the budget, and the invalidation rules. And the sharpest staleness caveat in the design is untouched by any of this — mutations made outside the proxy (a teammate merges the PR, a file changes on disk) remain invisible to invalidation, bounded only by the TTL (§6.2, §11 risk 3). Measuring age does not narrow that window; it makes the width of it observable.

### 13.20 v0.14: authenticated remote upstreams, and the first non-mock measurement (2026-08-02)

§13.2 onward, every latency number in this document came from `mock/mock-github.ts` with an injected delay. That was a reasonable way to develop the mechanism and a poor way to know whether it works, and the gap had a specific cause: **Speculate could not connect to a single authenticated remote MCP server.** `upstream.ts` constructed `new StreamableHTTPClientTransport(new URL(url))` with no options and the config schema had no `headers` field, so the only upstreams reachable were local stdio servers and anonymous HTTP ones, precisely the population with the least latency to hide (§13.7 v0.11 rationale: value scales with upstream latency).

**Config.** A `url` server takes `headers`, whose values may carry `${VAR}` placeholders resolved from the environment at load, so a bearer token never has to be written into a file that is commonly committed. Three decisions are load-bearing and all three are *loud*:

- An **unset or empty** variable is a fatal config error naming the variable. The two lenient alternatives are both worse than a clear message here: substituting nothing puts `Authorization: Bearer ` on the wire, and leaving the text alone puts the literal `${GITHUB_TOKEN}` on the wire. Each produces a confusing 401 from the server instead of an actionable error, and the second one leaks the placeholder to a third party. An empty variable counts as unset because an empty credential is never what anybody meant.
- **CR/LF in a resolved value is fatal.** Values come from the environment, so this is the header-injection boundary.
- `headers` on a **stdio** server is a config error, alongside the existing `command` XOR `url` refinement. Stdio credentials go in `env`, and silently ignoring a misplaced key is how a user concludes their token is being sent when it is not.

There is no escape syntax for a literal `${NAME}`, and `${VAR:-default}` is deliberately unmatched (it stays literal rather than resolving to something unintended).

**Secrecy is the property this change lives or dies on**, because the failure is unrecoverable: a token in a log has to be rotated. The guard is layered rather than placed at each log site.

- Nothing prints a value. `doctor` prints header **names**, which answers the only question a user has ("did my Authorization header get through?"), and marks them redacted. `speculate status`, the startup summary, and the §9 decision log never held server config to begin with.
- `Upstream#redact` scrubs any configured header value out of text, and `connect`/`callTool` run every error they throw through it. The scrub sits at that boundary **on purpose**: upstream error text is arbitrary remote-influenced data that several modules write straight to stderr (proxy connect failures, `executor.ts` suppression reasons, the decision log), and covering the boundary once covers call sites added later for free. It mutates `message` in place rather than re-wrapping, so `instanceof` checks and message regexes downstream are unaffected. Values under 8 characters are skipped: redacting `2` would corrupt unrelated messages far more often than it would protect anything.
- The test for this is not a mock. A loopback HTTP server records the request headers and echoes the `Authorization` header back in its 401 body; the suite asserts the header arrived *and* that the token appears in neither the thrown error nor `friendlySpawnError`.

`speculate wrap --url <url> [--header "K: V"]` was unblocked by the same work and ships with it, sharing the config path's resolver so the two have one contract rather than two. `--sniff` is rejected with `--url` (sniffing degrades to piping the wrapped command's bytes, and there is no child to pipe to).

**Measured, against GitHub's hosted MCP server** (`https://api.githubcopilot.com/mcp/`, 44 tools, 27 annotated `readOnlyHint: true`). `bench/remote.ts`, gated on `SPECULATE_E2E_LIVE=1` plus a credential, discovers the tool list rather than assuming names (this server exposes the consolidated `issue_read`/`pull_request_read`, not the classic `get_issue`, so `detectProfile` matches **nothing** and the run below is genuinely zero-config), refuses to call anything not affirmatively read-only, and alternates off/on sessions so a slow minute on the network hits both arms. Session: 8 read-only calls across 3 user turns (skim open issues, open the top two and read their comments, switch to PRs, read the changed files).

Three independent invocations, `modelcontextprotocol/servers`, total tool wait per session:

| run | off | speculating | | off | speculating | | off | speculating |
|---|---|---|---|---|---|---|---|---|
| 1 (cold) | 10.21 s | 3.71 s | | 4.01 s | 5.10 s | | 4.59 s | 4.11 s |
| 2 | 3.90 s | 3.08 s | | 4.14 s | 3.62 s | | 4.71 s | 2.16 s |
| 3 | 3.86 s | **0.57 s** | | 6.45 s | 0.54 s | | 5.65 s | 0.55 s |
| 4 | | | | 4.46 s | 0.52 s | | 3.68 s | 0.54 s |
| 5 | | | | | | | 4.32 s | 0.78 s |

Warm sessions: **7 of 8 calls served from the buffer, 88% hit rate, 0 wasted speculative calls, ~0.55 s total tool wait against a ~4.3 s baseline (−85%)**. Per-call, a prefetched read returns in 1–3 ms against 320–780 ms live. The one call that is never prefetched is the **first** one of the session, which is correct: nothing has happened yet to predict from.

**Three honest caveats, none of which the table above should be read without.**

1. **Run 1 is a wash, and can be slower.** Across the three invocations the cold session went 3.71 s / 5.10 s / 4.11 s against baselines of 10.21 s / 4.01 s / 4.59 s: once clearly better, once 27% *worse*, once level. A cold learner has nothing armed and issues **no speculative calls at all** (§13.21 measures this), so the cold arm is the baseline plus one proxy hop, and the spread above is dominated by the same network variance caveat 3 describes. This is the fail-closed design working (§5.3: an argument no source has produced is never fabricated), not a defect, but "Speculate makes your first session faster" is not a claim this data supports.
2. **It takes two to three passes through the same workflow to arm.** Run 2 is partial (3.08 / 3.62 / 2.16 s) and run 3 is the first fully warm one. §13.21 traces this to the shape of the model rather than to a tunable: a transition does not exist until its follow-up call has been seen once. The benchmark shares one state file across a mode's runs precisely because that is what a real user experiences (persistence is on by default), and reporting only the cold number would understate the tool exactly as much as reporting only the warm one overstates it.
3. **The baseline itself is noisy.** Off-mode totals ranged 3.68–10.21 s for an identical 8-call script; the 10.21 s outlier is the first run against a cold connection. The benchmark interleaves the arms and reports every run rather than a single pair for this reason. The measured per-call latency of this server, 320–780 ms, is also notably *worse* than the ~233 ms median that motivated the work, which strengthens the premise rather than weakening it.

What this does **not** measure: a second concurrent user, a server with tighter rate limits than GitHub's, or a workflow that varies more between passes than this one does. And the §6.2 staleness caveat is if anything sharper against a live SaaS backend than against a mock: a teammate commenting on the issue between the prefetch and the read is invisible to invalidation, bounded only by the TTL.

### 13.21 Why the first pass cannot be fast, and why no threshold fixes it (2026-08-02)

§13.20 caveats 1 and 2 asserted a cause without checking it: that `minObservations` (2) and `MIN_TEMPLATE_EVIDENCE` (4) are what hold the cold session back, and that a cold run pays for wasted prefetches. Both claims were wrong, and the way to find that out was to replay §13.20's exact 8-call script (`list_issues`, four `issue_read`, `list_pull_requests`, two `pull_request_read`) through the real `TransitionLearner` and the real priming path, and count what `predict()` actually emits.

**Priming does fire against this server.** `morphologicalPairs` over the hosted tool names yields `list_issues → issue_read` and `list_pull_requests → pull_request_read`. This was not obvious and is worth recording: the lister is *prefix*-form (`list_issues`, `LISTER_PREFIX`) while the getter is *suffix*-form (`issue_read`, `GETTER_SUFFIX`), and they only meet because `stemCandidates` bridges the plural — `issues → {issues, issue}` intersects `issue → {issue}`. Priming is doing real work here: it takes pass 2 from 1 of 7 predictable calls served to 3 of 7. It simply cannot help pass 1.

**Pass 1 emits zero predictions**, and that is the whole answer. A transition is created by `observe()` at the moment its follow-up call arrives, which is strictly after the instant it would have had to predict. Priming lowers the *count* threshold to one sighting; it cannot make a transition exist before it has happened, and argument templates come only from real traffic by construction (§5.3). So the first occurrence of any transition is unpredictable no matter what the thresholds say. **Neither threshold is the gate**, and a cold run therefore issues no speculative upstream calls at all — the cold cost is one proxy hop, not wasted work.

Both knobs were swept against `npm run eval` anyway, since "is 4 the right value" is a fair question independent of cold start. The floor is the control: it is adversarial, unpredictable traffic, so a *rise* in floor recall is the model finding structure in noise.

| `MIN_TEMPLATE_EVIDENCE` | workflow recall@3 | workflow waste/hit | floor recall@3 | floor waste/hit |
|---|---|---|---|---|
| 1 | 0.8510 | 2.01 | 0.0833 | **39.88** |
| 2 | 0.8510 | 2.01 | 0.0833 | **39.88** |
| 3 | 0.8490 | 2.00 | 0.0833 | 23.72 |
| **4 (shipped)** | **0.8463** | **2.00** | **0.0867** | **9.08** |
| 5 | 0.8456 | 2.00 | 0.0867 | 9.08 |
| 6 | 0.8449 | 1.99 | 0.0867 | 9.08 |
| 8 | 0.8401 | 1.98 | 0.0867 | 9.08 |

| `minObservations` | workflow recall@3 | workflow waste/hit | floor recall@3 | floor waste/hit |
|---|---|---|---|---|
| 1 | 0.8510 | 2.00 | **0.1367** | 22.41 |
| **2 (shipped)** | **0.8463** | **2.00** | **0.0867** | **9.08** |
| 3 | 0.8408 | 2.00 | 0.0467 | 9.21 |

**Nothing changed.** Both shipped values sit exactly on the knee. Dropping `MIN_TEMPLATE_EVIDENCE` to 1 or 2 buys +0.005 workflow recall and multiplies floor waste by 4.4x; dropping `minObservations` to 1 buys the same +0.005 and lifts floor recall 58% (0.0867 → 0.1367) with 2.5x the floor waste. Both are the trade §13.17 named and refused: "a change that merely made the learner fire harder would have lifted the floor first", which is precisely what `minObservations = 1` does. Raising either only loses recall. And on the replayed live workflow, `MIN_TEMPLATE_EVIDENCE = 1` changes pass 1 from *0 hits, 0 calls issued* to *0 hits, 2 calls issued* — strictly worse, which is the cleanest possible demonstration that it was never the gate.

Fidelity limit, stated so the numbers are not over-read: the replay uses synthetic result payloads, and reaches a steady state of 5 of 7 where the live run measured 7 of 7. The pass-1 conclusion does not depend on payload shape, because it follows from whether a transition exists at all.

**The honest statement of cold-start behaviour**, which the README now carries too: it takes two to three passes through the same workflow before speculation is fully armed, the first pass gets no benefit, and a first session can measure slower than no speculation at all.

### 13.22 The four kinds of MCP server, and which ones Speculate can reach (2026-08-02)

Auto-wrap (§13.19) made "which servers get wrapped" a question with a real answer, and the answer was uncomfortable: **we wrapped most of what is fast and little of what is slow.** Sorting every way a server can reach a host:

| | How the host reaches it | Reachable? |
|---|---|---|
| 1 | stdio, local child process | yes, and wrapped since v0.1. Low value: single-digit ms |
| 2 | streamable HTTP, token in the config entry | yes, since v0.14 (§13.20) |
| 3 | streamable HTTP, OAuth held by the host | **yes, as of this section** |
| 4 | claude.ai connector | **no, permanently** |

Row 3 is where the latency actually is: Sentry, Notion and Linear are all OAuth-protected, and none of them carries a token in `~/.claude.json`.

**Row 4 was tested, not assumed, and is closed.** A `SessionStart` hook of type `mcp_tool` does successfully call a claude.ai connector with the host's own auth and does get real data back, but the host discards it (`Hook JSON output had unrecognized keys (ignored): …`), an A/B with sentinel tokens confirmed the result never reaches the model, and the connectors are fetched *after* session-start hooks run (hook at 01:21:58.240, `[claudeai-mcp] Fetched 6 servers` at 01:21:58.620). More fundamentally these servers have no local config entry, and rewriting local config is Speculate's entire insertion mechanism. There is nothing to rewrite. OAuth does not help: holding our own Notion token does not put us between the host and a connector the host talks to directly.

**A bug found on the way in, and the rule that fixes it.** A row-3 entry is *byte-identical* to an unauthenticated self-hosted one: `{"type":"http","url":"…"}` either way. `planRemoteWrap` called that wrappable, so `on` and the unattended session-start hook would rewrite it, and the wrapped proxy would connect with no credential and 401. A server that worked yesterday would fail today with no user action to blame. Config shape cannot answer the question, so the rule is now **ask the server**: one MCP `initialize` with exactly the credentials the wrapped proxy would send, before any config is touched, and wrap only on a definite yes (`src/remoteProbe.ts`). `${VAR}` is resolved for the probe the same way the proxy resolves it, or the placeholder itself earns the 401. Cost is one round trip per *new* remote server; already-wrapped servers return earlier, so steady-state `sync` pays nothing.

**Row 3: our own OAuth client, not the host's token.** Borrowing the access token out of `~/.claude/.credentials.json` is the obvious zero-friction move and it is wrong twice. It buys exactly one token lifetime unless Speculate also takes over refresh; and once it does, on any server that rotates refresh tokens the first refresh invalidates the host's copy and breaks the user's real connection. It is also platform-contingent (that file exists on Windows; macOS uses the Keychain). So Speculate registers itself (RFC 7591), verified working unauthenticated against `mcp.sentry.dev` and `mcp.notion.com`, and discovery resolves cleanly against Sentry, Notion and Linear through our own code path.

The friction is held to one browser click, and the click is *offered* rather than left as homework. `on` carries the servers that need a login out of the wrap pass (`WrapOutcome.needsAuth`), asks once, and on a yes re-runs the wrap so they are live immediately instead of next session. `speculate auth` from the other direction does the same in reverse: authorize, then re-wrap, but only where `on` has already been run, since wrapping a project that never opted in would be a config change nobody asked for.

Three gates keep that from becoming a nuisance. The prompt exists only when the caller supplies `onNeedsAuth`, which only the interactive CLI does, so a hook or a script never sees it; it additionally requires a TTY on both ends, because it opens a browser. And `sync`, which is the unattended path, names the servers exactly once rather than every session: its hash gate means the reporting block is only reached when the effective server set actually changed. Silence there was the wrong default, though, and was the first thing fixed after shipping: a user who added an OAuth-protected server would otherwise get prefetching on everything *except* the server that would benefit most, and never learn that one command fixed it.

A server that has not been authorized is always left working and unwrapped, whichever path found it.

**Expiry is ours, because the SDK has none.** `Date.now()` appears nowhere in the SDK's auth or transport code, so it learns a token is dead only by sending a request and reading the 401 — and `_hasCompletedAuthFlow` makes the retry after that a *one-shot* circuit breaker. For a prefetcher that is a correctness bug rather than an inefficiency: a speculative call burns the single retry and the user's real call behind it fails outright. `tokens()` therefore refreshes ahead of expiry (120 s skew), which works because the transport awaits `tokens()` on every outbound request. Single-flight in-process, and under a cross-process lock that **re-reads inside the lock** — without that re-read two proxies both refresh, and against a rotating server the loser holds a token the server already invalidated.

Three smaller things that each have a specific failure behind them:

- **Every candidate loopback port is registered at once.** Neither Sentry nor Notion returns a `registration_access_token`, so RFC 7592 client management is unavailable and a registration can never be updated or deleted. Registering only the bound port would strand a dead client on the authorization server every time the port changed.
- **An `Authorization` header alongside a stored token is a startup error.** `streamableHttp.js` spreads `requestInit.headers` *after* the bearer it derives from the provider, so the hand-set header wins silently and presents as a 401 from a token that is perfectly valid and never sent.
- **The callback promise is marked handled at creation.** `auth()` opens the browser from inside `connect()`, so a fast redirect rejects that promise while `connect` is still unwinding. An unhandled rejection in that window terminates the process on Node >= 15.

**Two limits stated rather than papered over.** The SDK puts the resource server's advertised `scopes_supported` ahead of the client's own, so on Sentry our token carries `project:write team:write event:write`. That is the same scope set the host already holds, not a widening, and Speculate never *exercises* it: the policy layer only ever executes affirmatively read-only tools. Narrowing was rejected because Sentry advertises no `project:read`, so a narrowed token would break reads. Separately, `mode: 0o600` is a **verified no-op on Windows** (Node writes 666; protection comes only from the `%LOCALAPPDATA%` ACL). `doctor` says so rather than implying a guarantee that is not there.

### 13.23 The project is the repo root, and two categories we still cannot see (2026-08-03)

A user in a monorepo reported `speculate status` listing one server while `claude mcp list` listed sixteen. Two distinct causes, both found by running the real CLI rather than reading its docs.

**Discovery was anchored to the wrong directory.** Claude Code scopes both LOCAL entries and `.mcp.json` to the **repository root**; Speculate resolved both against `cwd`. Verified directly: `claude mcp add-json` run from `<repo>/infrastructure/reviewStacks` wrote its entry under the `<repo>` key, and `claude mcp list` from that same subdirectory picked up `<repo>/.mcp.json`. So from any subdirectory Speculate saw *none* of the project's servers, and reported success while doing nothing, which is the most confusing way this tool can fail. `projectRoot()` now walks up to `.git` (tested with `existsSync`, since a worktree or submodule has a `.git` FILE) and falls back to the directory itself outside a repository. That root is now the single project identity: discovery, the managed-state key, and sync's hash all use it, so `on` from a subdirectory and `off` from the root are the same project.

A separate, smaller bug found on the way: the `projects` lookup was an exact string match, and on Windows `claude mcp add-json` writes the key with forward slashes while `resolve()` returns backslashes, so local scope was invisible there too. Keys are now compared normalized (separators, trailing slash, case folded on Windows only).

**Plugin-provided servers are a fifth row.** The same report showed six servers registered as `plugin:<plugin>:<server>`, including hosted HTTP ones (`plugin:github:github`, `plugin:sentry:sentry`) that are exactly the high-latency population Speculate exists for. They are declared in `<plugin-install-path>/.mcp.json` and interpolate `${CLAUDE_PLUGIN_ROOT}`. Speculate cannot currently wrap them, and the reason is not the same as row 4: there *is* a file, but it belongs to a plugin cache that Claude Code owns and rewrites on update, so an edit there would be silently reverted and would also desync the plugin's git checkout. Wrapping them needs a mechanism that does not exist yet, and is recorded here rather than attempted.

### 13.24 A second non-mock measurement, on a server anyone can reach (2026-08-03)

Every latency number in this document except §13.20's came from a mock with injected delay, and §13.20's needed a GitHub token, so nobody could reproduce it without one. `bench/remote.ts` now takes a `--scenario`, and `bench/scenarios.ts` holds the servers. Three alternating off/on runs each, zero-config (no bundled profile matched either server):

| Server | Credential | Warm median (runs 2-3) | Best run (run 3) | Waste |
|---|---|---|---|---|
| Context7 | none | 9.40 s -> 3.09 s (-67%) | 9.31 s -> 1.32 s, 5 of 6 buffered | 0 |
| GitHub hosted MCP | token | 5.09 s -> 1.51 s (-70%) | 5.43 s -> 605 ms, 7 of 8 buffered | 0 |
| Microsoft Learn | none | 2.30 s -> 1.05 s (-54%) | 2.62 s -> 783 ms, 5 of 6 buffered | 0 |
| Hugging Face Hub | none | 259 ms -> 139 ms (-46%) | 258 ms -> 10 ms, 6 of 6 buffered | 0 |

**Which column is the claim matters, and the first draft of the README got it wrong.** The bench prints both a warm median (runs 2-3) and a per-call table against the warmest single run, and the README quoted the latter under the word "warm". For Hugging Face that is the difference between -96% and -46%. The headline is now the median; the best run is kept beside it as a visible ceiling rather than deleted, because the gap between them is itself the finding: warming is gradual, not a step change.

Three of the four need no credential, which matters more than the size of any single number: they are the first figures in this document a stranger can check. Spanning four servers also makes the shape of the benefit unarguable, because the same code and the same session structure produce a 3.6 s saving against Context7 and a 120 ms saving against the Hub. **Value scales with upstream latency**, exactly as §13.7 argued when the CLI tier was cut, and the table is now the evidence rather than the assertion.

Microsoft Learn is the most informative of the four and was chosen for it: it answers in JSON (`results[].contentUrl`), so the learner can PARSE the next argument out of the previous result instead of only recalling one it has seen. Context7 and the Hub both answer in markdown, where no parsed path exists and memorisation across repeats is all that is available. That the markdown pair still reach -67% and -46% says the memorisation path carries real weight on its own.

Every run reproduces the cold-start cost rather than hiding it. GitHub run 1 was 5.14 s off versus 5.00 s on (no benefit); Hugging Face run 1 was 248 ms off versus 271 ms on, i.e. **measurably slower**. Full warmth arrived only at run 3 in both. The headline is therefore always quoted warm-only and always beside that caveat.

Findings from surveying candidates, worth recording because they bound what this tool can ever do. **DeepWiki, GitMCP and grep.app annotate no `readOnlyHint` at all**, so Speculate speculates nothing against any of them, correctly and by design, in either shipped mode. Cloudflare's docs server annotates both its tools but exposes a single search entry point, so there is no list-then-detail transition to learn. Cloudflare Radar and Chroma require credentials. A server has to annotate its read-only tools AND expose a chained workflow before any of this machinery can help; of the candidates probed, more failed that bar than passed it.

### 13.25 Vetted profiles removed (2026-08-03)

Asked whether the mock's examples were realistic. They were not, and chasing that turned up a shipped defect which in turn argued the whole subsystem away.

**The defect.** GitHub's hosted server consolidated its per-operation readers into two tools discriminated by a `method` argument (`get_issue` -> `issue_read {method:'get'}`, `get_pull_request_diff` -> `pull_request_read {method:'get_files'}`). Only 3 of the `github` profile's 7 allowlisted tools survive there, which is 0.43 against a 0.6 fingerprint threshold, so `detectProfile` returned NO MATCH. Every hosted-GitHub user ran with no vetted rules at all. Nothing failed, no test caught it, and the bundled mock still used the classic names and matched at 100%, so `npm run bench` exercised a rules path no real GitHub user had. **Profiles rot silently, and the benchmark hid the rot.**

**The measurement that settled it.** A `github-hosted` profile was written and did work: the cold run went 5.65 s off versus 1.60 s on, where before it had been 5.14 s versus 5.00 s, i.e. no benefit. So profiles buy cold start, and buy it decisively, because vetted rules fire on first sighting where the learner must observe a transition before predicting it. But three benchmark servers (Context7, Microsoft Learn, Hugging Face) match no profile, never have, and reach -67%, -54% and -46% on the learner alone. And `morphologicalPairs` already derives `list_issues -> issue_read` generically from tool names, including on the hosted server that no hand-written list covered. What a profile uniquely supplied was ARGUMENTS: the `method: 'get'` constant, `issue_number` versus `pullNumber`, the `issues` envelope.

**The trade, taken deliberately.** Cold start on servers somebody had written code for, against ~1,700 lines, a silent-rot failure mode, and a correctness hazard: per-tool canonicalizers folded a missing argument into a server's default, and a default guessed wrong does not merely miss a cache share, it serves one query's answer for another. The learner needs no per-server code, cannot go stale, and covers every server rather than four.

What went: `src/profiles/` entirely, `detectProfile` fingerprinting, per-tool parsers and canonicalizers, `ServerProfile`, `--profile`, and the `profile` config field (accepted and ignored now, never fatal, because failing a working setup over a dead field is the worse outcome). What stayed: the config `rules` DSL, `morphologicalPairs` priming, and the generic JSON-in-text parsing that every deleted parser was a copy of.

**Two costs worth naming, since neither is zero.** `strict` mode now takes its allowlist only from `allowTools`, which is what the name always implied but used to be softened by a profile. And a server answering in NON-JSON TEXT loses result-derived prediction entirely: the filesystem mock returns newline-joined paths, the old profile shipped a parser to split them, and the `rules` DSL copies values rather than computing them. Such servers keep memorisation across repeats and nothing else, which S10 now asserts directly rather than papering over.

### 13.26 The fifth row wrapped: plugin servers (2026-08-05)

§13.23 ended "wrapping them needs a mechanism that does not exist yet, and is
recorded here rather than attempted." The mechanism exists; this section
supersedes that sentence. Full spec:
docs/superpowers/specs/2026-08-05-plugin-wrap-design.md.

**The mechanism was measured, not designed first.** Running the real CLI
(Claude Code 2.1.222, isolated `CLAUDE_CONFIG_DIR`) established: installed
plugins are recorded in `plugins/installed_plugins.json` (v2, per-plugin
install arrays) with enablement in `settings.json` `enabledPlugins`; server
declarations live at the plugin root as `.mcp.json` (bare or wrapped) or in
`plugin.json`; `${CLAUDE_PLUGIN_ROOT}` substitutes per-element across
command/args/env/url/headers — and for a DIRECTORY-sourced marketplace it is
the live source directory, not the versioned cache copy, that wins; the host
injects `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as real env vars into
stdio plugin children; and — the load-bearing fact — the per-project
`disabledMcpServers` array in `~/.claude.json` disables a single plugin
server at every connect path (the shipped bundle checks it before launch,
reconnect, and OAuth resume, and excludes disabled servers from endpoint
dedup), while `claude mcp list` still *enumerates* it, because list is not
launch. The host's own `/mcp` screen writes exactly that key. No CLI does.

**The shape: a shadow whose precedence is a disable.** A plain entry cannot
carry a `plugin:x:y` name, so the scope contest can never shadow a plugin
server; and endpoint dedup cannot suppress a wrapped copy, whose endpoint is
a `speculate wrap` invocation by construction. So `on` registers the wrapped
copy at LOCAL scope under the server's bare name through the front door,
then adds the qualified name to `disabledMcpServers` — a surgical
read-merge-write of that one array, tmp+rename atomic, never creating the
project record (the preceding `add-json` already made the host create it).
Order is load-bearing in both directions: copy before disable, and on
restore, re-enable before removal — each so that a crash between the two
steps leaves both halves running for a session, never neither. The copy
carries `SPECULATE_PLUGIN_ORIGIN=<qualified name>` in its env (plus
`CLAUDE_PLUGIN_ROOT`, replicating the host's injection), so a stateless
`off` can prove ownership, lift the disable, and remove the copy without
ever re-adding an unwrapped clone. Verified end-to-end against the real
host: wrap, both halves in place, exact restore.

**The invariant amendment, named rather than smuggled.** §13.12's "never a
JSON edit" cannot produce a disable, and the alternatives measured worse:
editing the plugin cache is reverted on update (§13.23), and a copy without
the disable is the duplicate-tool-list aggregator §13.12 rejected. So the
rule is amended, narrowly: Speculate writes exactly one key it does not own
— the `disabledMcpServers` array of the current project's record, in the
user's own `~/.claude.json`, in the same shape the host's own UI writes —
and nothing else, with `off` removing exactly the entry `on` added. The
upstream seam §13.12 pitched remains the durable endgame; this mechanism is
strictly removable when it lands.

**Consent runs through the host's own switches, in both directions.** A
qualified name already in `disabledMcpServers` that no managed record
claims is the user's disable: skipped, never removed. A plugin disabled via
`enabledPlugins` contributes nothing, and an existing wrap whose plugin is
uninstalled, disabled, or no longer declares the server is torn down —
disable lifted, copy removed (the §13.12 revoked-shadow rule's third
instance). Disabling the wrapped COPY in `/mcp` is the per-server opt-out:
the wrap is torn down and not re-created while that entry stands. The one
deliberate asymmetry: re-enabling the plugin ORIGINAL under a live wrap is
repaired (re-disabled) rather than read as revocation, because the state is
degraded (every tool doubled) rather than expressive — the opt-outs are the
copy-disable and `speculate off`, and the repair says so out loud.

**Fail-closed discovery.** Interpolation covers `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PROJECT_DIR}`; anything else refuses the wrap with a reason:
`${CLAUDE_PLUGIN_DATA}` and `${user_config.*}` (host expansions Speculate
cannot reproduce), `headersHelper` (a hook the wrapped proxy cannot run),
and any stdio entry still carrying `${…}` after interpolation — the host
resolves those from the session env at launch, and a wrapped copy would
pass the literal through, while resolving them ourselves would bake a
secret into config. HTTP `headers` keep the v0.14 `${VAR}` contract.
Remote plugin servers pass the same §13.22 probe, join the same
`needsAuth` → `speculate auth` flow, and an unauthorized server is always
left working and unwrapped. The sync hash covers the plugin server set
(post-interpolation, so a version bump moves it), each unwrappable reason,
and the sorted disable list — the same argument that put shadowed
`.mcp.json` entries in the hash, §13.23's monorepo fix having already made
the project identity shared.

**Costs, stated.** Tool names follow the copy (`mcp__plugin_github_github__*`
becomes `mcp__github__*`), so permission rules keyed to the old prefix stop
matching — §3.4's proxying caveat with a rename attached. The disable is
per-project, so the wrap is too, with auto-wrap carrying other projects one
session behind as ever. `claude mcp list` shows original and copy both
(list is not launch); `status` ties each pair together. `speculate try`
ignores plugin servers for now — `--strict-mcp-config`'s treatment of them
is unverified, and a wrapped copy in the trial could double every tool
list. And a stdio plugin server whose *code* reads `CLAUDE_PLUGIN_DATA`
loses that env var under the wrap: derivation unknown, documented rather
than approximated.

## v0.11 (2026-08-01): MCP-only focus

CLI speculation (exec daemon, Bash hook, workspace shell server) is removed.
Rationale: speculation value scales with upstream latency, and MCP/SaaS reads
(hundreds of ms) dominate local CLI reads (~30 ms, often net-negative after
hook spawn overhead); read-only vetting of arbitrary argv has no
deterministic cross-platform answer short of per-OS sandbox machinery,
while MCP's readOnlyHint gives it for free; and the tier carried the
project's POSIX-only surface (unix sockets, uid checks) plus a Windows
.git/index watcher loop that flushed every prefetch. `on`/`off` now clean
up artifacts a ≤0.10 install left behind. Full trail:
docs/superpowers/specs/2026-08-01-focus-mcp-design.md.

`speculate exec` survives as a verbatim pass-through (no shell, no rewriting,
the child's exit code) so the ≤0.10 Bash hook keeps working. That hook
rewrites the agent's `git status`/`rg`/`ls` into `speculate exec -- …` in
every project until `speculate on` removes it. Compatibility only, for one
release: removed in 0.12.

Windows: npm installs `claude` as a `.cmd` shim, which Node refuses to spawn
(CVE-2024-27980), so `on`/`off`/`status` reach the front door through cmd.exe.
Arguments are quoted for the child's CommandLineToArgvW, then escaped twice
for cmd (the shim's `%*` re-parses one of the rounds), with `%` stepped
outside the quotes (a caret inside quotes is literal), so a `%APPDATA%` in an
MCP entry can neither expand nor inject. Two limits are cmd's own: the command
line cannot exceed ~8191 characters (fails loud with "The command line is too
long.", exit 1) and a raw `\n`/`\r` inside an argument truncates the line
(JSON-escaped `\\n`, what `mcp add-json` payloads carry, is unaffected).

Benchmark re-verified after the removal (the harness was always MCP-only, so
the §11 numbers carry forward unchanged): hit rate 71%, waste 0.00/hit, both
deterministic across runs; tool-wait cut −64%…−67% over four runs (timing
jitter; −66% is the central value). Test suite: 431 tests, 424 passing, 7
skipped on Windows. The §10 caveat still governs: this is a scripted,
workflow-shaped ceiling, and §10 item 8's adversarial floor script remains
unwritten, so no measured lower bound exists yet.

## v0.12 (2026-08-02): auto-wrap

`speculate on` now also installs a second, minimal plugin at Claude Code's
user scope: `speculate-autowrap`, shipping exactly one `SessionStart` hook
that runs a new `speculate sync` command. Unlike the wrap `on` performs on
the spot, sync targets servers added to any project after the fact, without
a person ever running `on` there again.

**The one-session lag is measured, not assumed.** Testing against Claude
Code on Windows with an isolated `CLAUDE_CONFIG_DIR` established: a
`SessionStart` command hook fires before auth completes; `claude mcp
add-json` run from inside that hook succeeds; but the server it adds does
not launch in the current session, only in the next one. Claude Code
snapshots MCP config before running `SessionStart` hooks, so no hook,
however early, can make a wrap take effect in the session that triggered it.
A server added now runs unwrapped, exactly as if speculation were off, for
one more session, then wraps starting the session after. Both the plugin's
own summary line and `speculate status` state this plainly rather than
implying instant pickup. One further limit of the same shape, stated here
because nothing else in the product can state it: the hook is registered
with `matcher: "startup"`, so it fires only for a fresh session. Someone
who works entirely in `claude --resume` or `claude --continue` never fires
it and therefore never gets auto-wrap at all; for them `speculate on`
remains the only thing that wraps anything. Widening the matcher to
`resume`/`compact` would run the hash check on far more session events for
a wrap that is one session late regardless, so the narrow matcher stands —
but as a choice, not as an oversight.

**Sync is cheap on the common path and fails open on every other one.**
Before spawning anything, it hashes the project's effective server set
(name, scope, approval state, and canonicalized entry for every server) and
compares it to a stored per-project hash; when they match, which is the
overwhelming majority of session starts since most sessions add no server,
sync returns after a couple of file reads: no subprocess, no lock. Only a
changed hash proceeds to acquire a host-wide lock file, one per state
directory rather than per project, because every session ultimately
read-modifies-writes the same global `~/.claude.json`; a session that
cannot get the lock exits immediately and leaves the work for whichever
session next finds the config unlocked, which costs nothing given the lag
already puts everything one session behind. `on` and `off` deliberately do
not take that lock — they are interactive, and blocking a person behind a
background hook would be the worse trade — so sync's final write is a
read-merge-write, not a write-back: it re-reads the state file immediately
before saving and touches only this project's own two keys. Writing its
whole in-memory copy back silently reverted an `off` that completed in
another project mid-sync, erasing the opt-out that `off` had just recorded
and resurrecting the project record it had just deleted, so the project the
user had turned off was re-wrapped at its next session start. One residual
is recorded rather than fixed: since `on`/`off` still take no lock, an `off`
in the SAME project as an in-flight sync can still have its project record
resurrected by that sync's merge. The opt-out itself now survives, so the
consequence is a stale entry list, and a later `off` reporting spurious
failures as it chases servers that are already unwrapped — not a project
that gets re-wrapped. Closing it properly means `on`/`off` taking the lock,
which trades a silent data race for a person waiting on a background hook. The wrap pass itself runs under
a cooperative deadline, 5 s by default: checked only between servers, never
between one server's `remove` and its paired `add-json`, so a session that
runs out of budget mid-list leaves a clean host, nothing deleted without a
replacement, rather than a fully wrapped one. Above that sits a last-resort
process exit for a hang no layer below can end, set at 120 s — the 5 s
budget plus three 30 s `execFile` timeouts, with slack, because that 30 s is
not a hard bound: `execFile` SIGTERMs and then waits for stdio to close, so a
child that ignores SIGTERM runs past it. The plugin's own hook timeout
(150 s) and the stale-lock window (180 s) are stacked above that in turn,
since a host-side kill lands wherever it lands, including in exactly the
window the cooperative deadline exists to protect, and a lock holder that
legitimately runs to either cap must not look stale to the next session.
Arithmetic is the weak form of this guarantee, and the code says so: the
strong form is a marker held across the `remove`→`add-json` pair, so the
exit can refuse to fire while one is open and the restore is replayable if
the process dies anyway. That is the right long-term fix. Every failure path returns
success and sync prints at most one summary line: a session start must
never be blocked or sprayed with diagnostics on auto-wrap's account, so
`speculate status` remains the place to look when something needs
attention.

**`off` opts a project out; it does not uninstall the plugin.** Running
`speculate off` records a per-project opt-out that sync's hash check
consults before anything else, so the global hook will not silently
re-wrap that project again, even though the plugin stays installed for
every other project on the machine. `off` prints the command to remove the
plugin everywhere (`claude plugin uninstall -s user speculate-autowrap`)
for anyone who wants auto-wrap gone entirely, plus the command to remove
the marketplace registration that supplied it (`claude plugin marketplace
remove speculate-mcp`), since a host-global registration is exactly the
kind of artifact `off`'s per-project framing could otherwise leave
unmentioned. It also names the limit that framing hides. The servers `off`
unwraps at USER scope are shared by every project on the machine, while the
opt-out it records covers one project, so any OTHER project's next session
start re-wraps them at user scope — and this project sees them wrapped
again, within a single session, without auto-wrap having disobeyed its
opt-out at all. Whenever `off` unwrapped anything at user scope it now says
so, and names the plugin uninstall as the only thing that actually stops
it. `speculate status` closes the same loop from the other side: with the
plugin installed it used to report "installed (new servers wrap at the next
session start)" purely on detection, which is exactly wrong in a project
that has just run `off`; it now reports the opt-out and names `speculate
on` as the way back in, and that is the only place the opt-out is visible
at all. What `off` still does not touch or mention is the staged
plugin copy under `<state>/autowrap` (the same directory that holds
`managed.json`) that `on` wrote in order to install the plugin in the
first place; that copy is inert once the plugin is uninstalled, since
nothing on the host points at it any more, and is safe to delete by hand
alongside the uninstall.

**Install repairs itself by uninstalling first.** Measured against the
real host: with the plugin already installed, `claude plugin install`
no-ops ("already installed") and `plugin update` reports "already at the
latest version"; neither re-copies a cached plugin. So when the staged
hook command or the plugin's own version no longer matches what is
installed, for example after an npm move changed the baked CLI path, or
after a new Speculate release, `on` uninstalls the old copy first and
immediately reinstalls the current one; a plain install or update cannot
get there, since both treat "already installed" as done. If the uninstall
half of that repair fails, `on` aborts rather than attempting the install
against an unknown state, and prints the exact recipe to finish the job by
hand: `claude plugin uninstall -s user speculate-autowrap`, then
`speculate on`. The two are printed on separate lines rather than chained
with `&&`, because PowerShell 5.1 is the default shell on stock Windows and
parse-errors on `&&`, which would leave a stuck user running neither half.
The honest cost of that abort: between the failure and someone
running the recipe, the user has no auto-wrap plugin installed at all,
which is a worse position than the stale copy they started with, and
exactly the reason the message names the fix instead of only the
uninstall half of it.

One correction to the v0.11 record above: it committed to removing the
`speculate exec` compatibility pass-through in 0.12. That did not happen,
and 0.12 still ships it. Nothing about auto-wrap depends on it either way,
but a ≤0.10 Bash hook can still be sitting in a project nobody has run
`speculate on` in yet, so the shim keeps earning its place. Removal moves
to 0.13.

**Consent, in both directions.** Sync wraps only servers
`wrapEffectiveServers` would already wrap through `on`, including the
`.mcp.json` approval gate, so nothing sync does can turn a pending server
into a running one — and, as of this release, revoking an approval takes
the wrapped server away again. The second half was missing, and 0.12 is
what made it matter. Once an approved project server is shadowed by the
wrapped copy registered at local scope, the local entry wins the scope
contest, so the project entry's approval flag stopped reaching the
per-project hash: revoking the approval changed nothing sync could see,
sync made zero calls, and the shadow stayed registered and running at a
scope that has no approval gate at all. That was already true of `on` in
0.11; 0.12 escalated it, because shadows are now created unattended in
projects where nobody ever ran `speculate on`. Both halves are fixed: the
hash covers a shadowed project entry as well as the effective one, so a
revoke moves it, and `sync`/`on` then REMOVE a shadow whose `.mcp.json`
counterpart is no longer *both present and approved*, leaving whatever the
project actually declares — a pending entry, or nothing at all — as the only
thing left. Present matters as much as approved: a server dropped from
`.mcp.json` by a pull, a branch switch, an edit, or a deleted file is the
commoner trigger, and it used to leave the wrapped shadow running forever
for a server the project no longer declares. Only shadows Speculate created
are removed — the managed state records those with action `shadowed`, and
the entry must still be a Speculate wrap — so a local entry the user wrapped
themselves is never touched, and neither is one whose record has been lost
with the state file. That last case is deliberately conservative: without the
record there is no proof the entry is ours, which is exactly the stance `off`
takes in the same situation. The other honest consent-adjacent fact:
because the plugin installs at user scope, opening a brand-new project also
gets its already-approved servers wrapped automatically at that project's
next session start, without `speculate on` ever having run there.

Full trail: docs/superpowers/specs/2026-08-02-auto-wrap-design.md.

## v0.13 (2026-08-02): prediction quality

Five defects in the learner, each found by measurement rather than by reading
the code. §13.16 through §13.19 carry the detail; this section is the ledger
and the honest reading of the numbers.

**The instrument came first, because the old headline was circular.**
`npm run bench` replays a scripted 7-call GitHub session against the mock and
reports hit rate, tool-wait cut and waste. What it measures is **prefetch
mechanics**: whether a predicted call is issued early enough, completes in
time, and is served rather than forwarded. It cannot measure prediction
quality, because the script and the hand-written GitHub rules that predict it
were authored together, so quoting its 71% as evidence that the learner
predicts well was reasoning in a circle. The sharper form of the same point:
the learner contributes **nothing** to that 71%, since a learned transition
needs two sightings and the benchmark's workflow repeats none of its calls.
`npm run eval` is the separate
instrument, and it was built before any change to `src/`. It scores offline
**recall@K over transition pairs**: one pair is a consecutive (call i-1, call
i) inside a scored session, a hit requires tool **and** arguments to match
under `canonicalKey` (the same key the cache uses, so a right tool with a
wrong id is a miss), and recall@K is hits at rank ≤ K over pairs. It drives a
real `TransitionLearner` and imports nothing else: no `ServerProfile`, no
`Predictor`, so no hand-written rule can contribute a prediction by
construction, and a test asserts no corpus tool name collides with the
bundled github, filesystem or slack profiles. Seeds 1, 2 and 3 are pooled;
the clock is injected and neither `Date.now` nor `Math.random` appears under
`eval/`. Both commands still ship, and they answer different questions.

**Where it ends up** (seeds 1,2,3; recall@3 is the headline band because 3 is
the shipped per-trigger cap, §5.6; recall@5 is visible only because the
harness raises the learner's cap to 5):

| archetype | pairs | recall@1 | recall@3 | recall@5 | waste/hit |
|---|---|---|---|---|---|
| list-detail-varied | 300 | 0.373 | 0.727 | 0.790 | 3.24 |
| return-visits | 300 | 0.593 | 0.997 | 0.997 | 1.26 |
| multi-arg | 300 | 0.803 | 0.883 | 0.883 | 0.84 |
| regime-shift | 120 | 0.900 | 0.900 | 0.950 | 2.33 |
| direct-recall | 150 | 0.267 | 0.587 | 0.627 | 2.38 |
| paired-args | 300 | 0.537 | 0.887 | 0.923 | 2.70 |
| **WORKFLOW (headline)** | **1470** | **0.571** | **0.846** | **0.875** | **2.00** |
| adversarial (floor) | 300 | 0.087 | 0.087 | 0.087 | 9.08 |

**The adversarial floor sat at 0.087 through every task in this plan**, with
its waste per hit pinned at 9.08 and, at several stages, byte-identical
counters on both sides of a change. That is the control that makes every
other number here mean anything. A learner that bought recall by firing more
speculations at noise would have lifted the floor first, since the floor's
entity ids are minted once and never repeated, so the flat floor establishes
exactly this and no more: no gain below came from firing at noise. It is not
the claim that the gains came without firing more, which would be false. The
workflow pool went from 1,892 predictions issued to 2,449 over the same span,
and that cost is priced in the waste column below. The floor is reported
beside the headline, never pooled into it, and the two are only ever quoted
together.

**The headline is not one number improving in place, and the denominator is
why.** The first pooled baseline this branch recorded was **0.6033 over 900
pairs**; it now reads **0.8463 over 1470**. Three archetypes joined the
corpus in between, each of them added because an existing defect was
invisible without it, and each addition moved the headline on its own:
`regime-shift` took 900 pairs to 1020 (0.6033 to 0.6363), `direct-recall`
took 1020 to 1170 (0.8725 to 0.8359), and `paired-args` took
1170 to 1470 (0.8359 to 0.797, both measured without the coherence check).
The last two moved with no code changing at all; the first is the one place
this paragraph has to qualify itself, because its two endpoints straddle
Task 2's decay change as well as the corpus addition, and 0.002 of that
0.6033 to 0.6363 is code rather than corpus. So the
end state is a harder corpus **and** a better learner, and the pooled
endpoints cannot separate the two. The attribution lives in the per-task
deltas, each measured against a corpus held fixed across the change:

| change | pairs | before | after | Δ recall@3 |
|---|---|---|---|---|
| Evidence decays, and eviction goes by value (§13.16) | 1020 | 0.532 | 0.636 | **+0.104** |
| A template holds evidence, not a latch (§13.17) | 1020 | 0.636 | 0.731 | **+0.095** |
| Sources compete, and a transition offers several (§13.18) | 1020 | 0.731 | 0.873 | **+0.141** |
| Co-varying arguments are one hypothesis (§13.18) | 1470 | 0.797 | 0.846 | **+0.049** |

The five defects those four rows close: lifetime-frequency ranking that never
forgot, paired with FIFO eviction that dropped the best-evidenced entry to
admit a one-off; a single unexplainable value latching a transition off
permanently; one hypothesis per argument, fixed to whichever row index the
first sighting happened to use; one argument set per transition, which pinned
recall@K to recall@1 whatever the budget allowed; and two arguments read off
the same row scored as independent, so the cheapest substitutions in the beam
were pairings that had never occurred. A sixth was introduced and caught in
review rather than shipped: value-based eviction let a brand-new transition
be its own victim, freezing the model silently and, because the score
persists, across restarts. Both eviction sites now exempt the key the current
observation just wrote, with a regression test at the default
`minObservations`.

Waste is the price and it is visible: the workflow band reads 2.00 wasted
predictions per hit against 1.27 at the first baseline, moved by the same mix
of corpus growth and model change as the headline, and it is concentrated in
the archetypes the recall came from. That column bills every prediction
issued at the shipped cap, including the batch fired after each session's
last call that nothing can ever claim, so it is a deliberately pessimistic
production estimate and not the instrument §10's ≤2 per hit criterion was
written against (the bench still reads 0.00). Even read that way it now sits
exactly on that bar, which makes it the number to watch next rather than one
with headroom left in it.

**Calibration against PASTE, read the unflattering way.** PASTE (arXiv
2603.18897) reports **27.8% top-1 and 43.9% top-3** predictor recall on Deep
Research Bench, SWE Bench and ScholarQA, which are real traces. Our 0.571 and
0.846 are on a corpus we wrote ourselves. These are not comparable numbers,
and ours reading higher is most likely evidence that our corpus is easier,
not that this learner is better: we authored the archetypes knowing what the
learner can derive, and a synthetic workflow is predictable in ways real
traffic is not. A real-trace figure for this learner would most likely land
somewhere between our floor of 0.087 and our headline of 0.846, and nothing
measured here establishes where. Two differences do run in our favour, and
they are facts about scope rather than about accuracy: PASTE describes no
staleness or invalidation mechanism, and no decay, since its patterns are
mined once and applied uniformly. One runs the other way: it has a string
formatting and normalization transform as a third kind of argument source,
where we have only argument copy, parsed result path and memorized constant,
and it launches greedily on utility rather than against a fixed cap. Real
numbers for this proxy still come from §9 telemetry, not from either corpus.

**What did not ship, recorded because the plan called for it.**

- **Widening the learnable array-index window** (indices 0..2 to 0..7,
  `pushArrayPaths`) is **deferred**, measured at **+0.003** (3 pairs of 900),
  not the ~0.06 first estimated. Under a per-trigger cap of 3 and a
  monotonically decreasing index distribution, the top three indices by
  frequency are always {0,1,2}. `src/learner.ts` still reads
  `Math.min(arr.length, 3)`.
- **Entity frecency** as a separate mechanism is **dropped**: Task 3's
  per-source scoring already implements it generically. The `direct-recall`
  archetype was authored as a negative control, isolating the case where the
  target id appears nowhere in the trigger's arguments or result (verified 0
  of 180 sessions) while six wrong ids sit at enumerable array positions. It
  came back positive at 0.835 recall@3 on its common leg, with the transition
  holding four `const` sources, one per pinned entity, ranked by decayed
  score. The control on the control, the same shape with entities never
  reused, scores 0.000 at zero waste. What remains is scope, not memory:
  constants are keyed per (server, prevTool, nextTool, argName), so the same
  entities reached from a rarer trigger get nothing (0.733 / 0.667 / 0.389 /
  0.000 as that trigger thins from every 2 to every 16 sessions), priced at
  about +0.03 on the headline.
- **Utility ranking** (PASTE's `p·T`, cutting the per-trigger cap on expected
  time saved rather than probability) landed and was **reverted** as a
  measured no-op. Two reasons, both measured: the bundled bench injects one
  latency for every tool, so `score × ms` is `score` times a constant and the
  ranking is provably identical, and the per-trigger cap never binds on the
  bundled profile (zero cap-suppression events across a full session, since
  it offers at most 2 to 3 candidates against a cap of 3). Only a constructed
  heterogeneous workload at cap 1 moved it, 4.50 s to 4.05 s. The eval was
  unchanged to every digit. The plan's own rule is that a change which does
  not move the measurement does not land; it is worth revisiting once the cap
  starts binding, which the beam makes likelier.
- **The long-horizon TTL lever ships inert.** `speculation.longHorizonTtlFactor`
  exists per server and `LONG_HORIZON_TTL_FACTOR` defaults to **1**, so
  nothing is shortened unless someone asks for it. Shortening bought zero
  measured freshness (standing bets are consumed at a lead of exactly 1.000
  calls, the same instant as derived ones) and cost about 9% of all hits once
  inter-call spacing passed roughly half the TTL (1265 to 1150 at factor 0.5
  from 16 s spacing, with the standing class going to zero). The
  instrumentation it was built alongside did ship: `ageAtHit` reports median,
  p95 and max age at consumption, the share consumed in the last quarter of
  their TTL, and mean lead, in both the runtime and the offline replay.

**What the numbers still do not cover.** The corpus is synthetic and
authored, not sampled traffic. `derived`/`missed` are the only evidence in
the learner that does not decay, so a derivation that stops working must
accumulate misses in proportion to its whole history before the rate gate
closes; the §5.6 feedback loop is the production backstop and the offline
harness does not model it. No surviving array-index derivation remains in the
corpus, so if `pushArrayPaths` broke outright the headline would not move.
Session-start openers (§13.15) do not fit a recall@K-over-pairs frame and are
unmeasured. `return-visits` has saturated at 0.997 and no longer discriminates
anything.

Two corrections to the record above. The v0.11 note said §10 item 8's
adversarial floor remained unwritten, so no measured lower bound existed;
that is no longer true, and the floor is the 0.087 row. The v0.12 note said
the `speculate exec` compatibility pass-through would be removed in 0.13.
That did not happen either, and 0.13 still ships it.

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
