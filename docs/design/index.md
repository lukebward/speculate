# Design spec

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
