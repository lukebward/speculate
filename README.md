# Speculate

**A speculative-prefetching MCP proxy. Make your agent's next tool call instant.**

Speculate is a transparent [Model Context Protocol](https://modelcontextprotocol.io) proxy that sits between any MCP client (Claude Code, Cursor, a custom harness — anything that speaks MCP) and your MCP servers. It watches the conversation's tool traffic, predicts the tool calls the agent is likely to make next, executes the **read-only** ones ahead of time, and serves the cached results the moment the agent actually asks.

Think of it like Gmail preloading your inbox while you type your password — applied to agentic tool calls.

```
┌────────────┐        ┌───────────────────┐        ┌─────────────────┐
│ MCP client │ ◄────► │     Speculate     │ ◄────► │ MCP server(s)   │
│ (any host) │  MCP   │  predict • fetch  │  MCP   │ GitHub, Slack,  │
└────────────┘        │  cache  • serve   │        │ DB, filesystem… │
                      └───────────────────┘        └─────────────────┘
```

## Status: working MVP

Benchmark (bundled mock GitHub upstream at 400 ms latency, 7-call scripted agent session):

```
  tool call                    off       on   outcome
  ─────────────────────────────────────────────────────
  get_issue                 409 ms   408 ms   miss (live call)
  get_issue_comments        405 ms     2 ms   prefetched ✓ 167×
  list_pull_requests        405 ms     2 ms   prefetched ✓ 216×
  get_pull_request          405 ms     2 ms   prefetched ✓ 255×
  get_pull_request_diff     404 ms   153 ms   joined in flight ~ 3×
  list_issues               406 ms   404 ms   miss (live call)
  get_issue                 405 ms     2 ms   prefetched ✓ 247×
  ─────────────────────────────────────────────────────
  total tool wait           2.84 s   972 ms   −66%

  hits/joins 5 of 7 eligible reads (71%) · wasted speculative calls: 0
```

All three MVP success criteria from [DESIGN.md](DESIGN.md) §10 pass: hit rate ≥ 40%, tool-wait reduction ≥ 30%, waste ≤ 2 calls per hit. Reproduce with `npm run bench`, or watch the recorded demo: [`demo/speculate-demo.cast`](demo/speculate-demo.cast) (`asciinema play demo/speculate-demo.cast`).

## Quickstart

```bash
git clone https://github.com/lukebward/speculate && cd speculate
npm install
npm test        # 150+ unit + end-to-end tests
npm run bench   # the demo: same session with speculation off vs on
```

Point Speculate at your real MCP servers with a config file:

```jsonc
// speculate.config.json
{
  "mode": "strict",              // strict | annotated | off
  "servers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." },
      "profile": "github",       // built-in vetted profile: rules + allowlist + TTLs
      "speculation": { "defaultTtlMs": 30000, "maxPerMinute": 30 }
    }
  }
}
```

Then point your MCP client at Speculate instead of the server. For Claude Code:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["tsx", "/path/to/speculate/src/cli.ts", "--config", "/path/to/speculate.config.json"]
    }
  }
}
```

Everything the client sees is standard MCP: same tools, same results — some of them just arrive ~200× faster. Ask the agent to call `speculate__stats` to see hit rate, wasted calls, and estimated time saved, live.

## How it works

1. **Proxy** — Speculate speaks MCP on both sides and forwards everything transparently. With a single upstream, tool names pass through unchanged; resources and prompts pass through too. Disabled speculation (`mode: "off"`) leaves a plain, correct proxy.
2. **Predict** — after each served tool call, profile rules propose likely follow-ups with concrete arguments (`get_issue #42` → `get_issue_comments #42`, `list_pull_requests open`), including arguments extracted from the *result* of the trigger call (structured content when the server provides it, a vetted per-tool parser otherwise — parse failures fail closed to "no prediction").
3. **Prefetch** — predictions that pass the safety policy and budgets are executed speculatively. Over-budget predictions wait briefly in a confidence-ordered queue and fire when a slot frees; stale ones expire unfired.
4. **Serve** — a real call matching a fresh cached entry returns in ~2 ms. A call matching a *still-in-flight* prefetch joins it and waits only for the remainder. Everything else passes through live. Cache entries are single-use, short-TTL (default 30 s), and flushed whenever a mutation goes through the proxy.

## Works with any MCP server

Proxying already works for every MCP server — Speculate forwards anything it doesn't understand. *Speculation* works on any server through three mechanisms, layered from zero-config to hand-tuned:

1. **Zero config: the transition learner.** Speculate watches the session and learns `previous tool → next tool` patterns *and how arguments flow between them*. Once it has seen a transition twice consistently, it starts prefetching it — with arguments that track the new call (learn on `get_ticket(41) → get_ticket_comments(41)`, prefetch for ticket 7 when the agent opens ticket 7). Works on literally any server; the feedback loop suppresses transitions that stop paying.
2. **Declarative rules in your config.** Teach Speculate a server's workflow shape in JSON — no code:

   ```jsonc
   "jira": {
     "command": "jira-mcp-server",
     "rules": [{
       "trigger": "search_issues",
       "predict": [{
         "tool": "get_issue",
         "args": { "issue_key": "$item.key" },
         "forEach": "$parsed.issues",   // prefetch the first N results
         "limit": 2,
         "confidence": 0.6
       }]
     }]
   }
   ```

   Selectors pull arguments from the trigger call (`$args.…`), its parsed result (`$parsed.…`), or each element of a result array (`$item.…` with `forEach`); anything unresolvable fails closed to "no prefetch".
3. **Vetted profiles** (like the bundled GitHub one) for popular servers: reviewed allowlists, tuned rules, per-tool TTLs, and result parsers pinned to server versions.

Result parsing is server-agnostic too: Speculate uses the server's `structuredContent` when provided, else tries JSON-in-text (how most servers respond), else predicts nothing — never guessing.

**Safety on unprofiled servers** is the same default-deny policy: use `"mode": "annotated"` for servers you trust to label their read-only tools honestly (`readOnlyHint: true`), or stay in `strict` and list the read-only tools yourself with `"allowTools": [...]`. Unknown tools are never speculated, in any mode.

## Safety model

Speculate **never speculates on anything that can mutate state.**

- Only tools that are affirmatively read-only are eligible: MCP [tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations) (`readOnlyHint: true`) **and, by default, an operator-controlled allowlist** (annotations are untrusted hints per the MCP spec; the opt-in `annotated` mode trusts annotations alone for servers you control).
- Unknown or unannotated tools are never speculated — default-deny.
- Real calls — including writes — are always forwarded verbatim; cached results are byte-identical to what the upstream returned; speculative *error* results are never cached, and auth failures suspend speculation for that tool until a real call succeeds again.
- The integration suite asserts the invariant end-to-end: a logging mock upstream fails the run if any non-allowlisted tool is ever called speculatively.

Two honest caveats (see DESIGN.md §6, §4): results can be up to one TTL stale relative to *external* writers and to writes made outside MCP (e.g. `git push` in a shell), and a speculative read discloses predicted intent to the upstream server. Both are bounded and configurable (`ttlMsByTool: 0`, per-server `denyTools`, `mode: "off"`).

## Development

```bash
npm test              # vitest: unit + end-to-end (proxy ↔ mock upstream over real stdio MCP)
npm run bench         # latency benchmark, speculation off vs on
npm run mock-github   # run the mock upstream standalone
npx tsc --noEmit      # typecheck
```

Layout: `src/proxy.ts` (router), `src/executor.ts` (speculation executor + drain queue), `src/predictor.ts` + `src/profiles/github.ts` (Tier-1 rules), `src/cache.ts` (single-use TTL buffer with in-flight join), `src/policy.ts` (default-deny eligibility), `src/budget.ts` (rate/concurrency caps, stdio idle-only rule), `mock/` (latency-injectable mock GitHub server), `bench/` (the demo).

The full architecture, market research, and roadmap live in [DESIGN.md](DESIGN.md). MVP deviations from the original design are listed in DESIGN.md §13 (Implementation notes).

## Non-goals

- Speculating destructive or state-mutating tool calls. Not now, not later.
- Replacing your MCP servers' auth — Speculate forwards credentials, it doesn't own them.
- Token savings. Speculate cuts *wall-clock latency*, not model token usage.

## License

MIT
