# Appendix A. Market research & prior art

!!! info "Part of the design document"

    Section numbers (§1–§13) run across the whole design document, split here
    into [Design spec](index.md), [Implementation notes](implementation-notes.md),
    [Release notes](releases.md), and [Prior art](prior-art.md).

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
