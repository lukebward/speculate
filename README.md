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

## Why

Agentic loops spend a surprising amount of wall-clock time waiting on tool round-trips: a GitHub API call is hundreds of milliseconds, a warehouse query can be seconds, and agents chain many of these per turn. Meanwhile there is dead time everywhere — while the user types, while the model streams reasoning, between chained calls. Speculate overlaps tool I/O with that dead time.

If the agent just fetched a GitHub issue, there's a good chance the next call is for the linked PRs. Speculate fetches them *before* the agent asks. On a hit, a 500 ms round-trip becomes a cache read.

## How it works

1. **Proxy** — Speculate speaks MCP on both sides. Point your client at Speculate instead of your real servers; it aggregates and forwards everything transparently. No changes to your orchestrator or servers.
2. **Predict** — after each real tool call (and during idle windows), a prediction engine proposes the next likely calls with concrete arguments. Predictors are pluggable and layered: static co-occurrence rules → learned per-session transition patterns → optional small-LLM prediction from conversation context.
3. **Prefetch** — predicted calls that are provably **read-only** are executed speculatively against the upstream servers, subject to a per-server budget and rate-limit awareness.
4. **Serve** — when the agent makes a call that matches a fresh cache entry (normalized tool + arguments), Speculate returns it immediately. Misses pass through untouched.

## Safety model

Speculate **never speculates on anything that can mutate state.**

- Only tools that are explicitly known to be read-only are eligible for prefetching, based on MCP [tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations) (`readOnlyHint: true`) **and, by default, an operator-controlled allowlist** (annotations are untrusted hints per the MCP spec; an opt-in mode exists to trust annotations alone for servers you control).
- Unannotated or ambiguous tools are **never** speculated — they pass through normally, always.
- Real (non-speculative) calls of any kind are always forwarded verbatim. Speculate is a pure pass-through for everything it doesn't understand.
- Cached results have short TTLs and are invalidated when a mutating call touches the same server.

## Status

🚧 **Design phase.** See [DESIGN.md](DESIGN.md) for the full architecture, speculation policy, cache semantics, market research, and MVP scope. No installable release yet.

## Non-goals

- Speculating destructive or state-mutating tool calls. Not now, not later.
- Replacing your MCP servers' own auth — Speculate forwards credentials, it doesn't own them.
- Token savings. Speculate cuts *wall-clock latency*, not model token usage; the model still reads the same results.

## License

TBD.
