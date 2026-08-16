# Speculate

**Speculative prefetching for coding agents.** Speculate sits between your MCP
client and its servers. It predicts the next read-only tool call, runs it early,
and has the answer waiting. Gmail preloads your inbox; this preloads your tool
calls.

![Demo: a GitHub PR workflow run twice, with the second read served from prefetch](https://raw.githubusercontent.com/lukebward/speculate/main/demo/speculate-demo.gif)

```bash
npm install -g speculate-mcp
speculate on
```

!!! quote "On how this was built"

    Built with heavy use of AI coding agents. Everything here is reviewed and
    tested, and the suite runs on Linux, macOS, and Windows, but weigh that as
    you would any other statement about how software was made.

<div class="grid cards" markdown>

-   :material-download:{ .lg .middle } **Getting started**

    ---

    One command for Claude Code, or a config prefix for any other MCP client.

    [:octicons-arrow-right-24: Install](getting-started.md)

-   :material-console-line:{ .lg .middle } **Commands**

    ---

    `on`, `off`, `status`, `auth`, `stats`, `try`, `doctor` — what each one
    changes and what it leaves alone.

    [:octicons-arrow-right-24: CLI reference](commands.md)

-   :material-shield-check:{ .lg .middle } **Safety**

    ---

    Why a speculative call can only ever be a read, and what that does and
    doesn't protect you from.

    [:octicons-arrow-right-24: Safety model](safety.md)

-   :material-tune:{ .lg .middle } **Configuration**

    ---

    Per-server modes, allow/denylists, TTLs, budgets, and the prediction rule
    DSL.

    [:octicons-arrow-right-24: Config reference](configuration.md)

-   :material-file-document-outline:{ .lg .middle } **Design**

    ---

    Architecture, the prediction engine, cache semantics, and the full record
    of what measurement changed.

    [:octicons-arrow-right-24: Design spec](design/index.md)

-   :material-history:{ .lg .middle } **Prior art**

    ---

    The MCP gateway landscape, the academic validation, and why the latency
    lane was unoccupied.

    [:octicons-arrow-right-24: Market survey](design/prior-art.md)

</div>

## What it does

- **No configuration, nothing per-server.** Speculate learns from your own
  traffic, so it works the same on a server nobody has heard of.
- **Read-only, always.** It runs tools the server marks read-only, and nothing
  else.
- **Nothing taken away.** Every change goes through your client's own CLI, and
  `off` puts it all back.

## Measured results

Against real hosted MCP servers, not mocks. Three alternating off/on runs each,
zero config:

| Server | Auth | Warm tool wait | Cut |
|---|---|---|---|
| Context7 | none | 9.4 s to 3.1 s | **-67%** |
| GitHub hosted MCP | token | 5.0 s to 1.6 s | **-67%** |
| Microsoft Learn | none | 2.3 s to 1.1 s | **-54%** |
| Hugging Face Hub | none | 259 ms to 139 ms | **-46%** |

Zero wasted calls on any of them. The saving tracks how slow the server is,
which is the point: a local stdio server answering in single-digit milliseconds
has nothing worth hiding.

!!! warning "Read the caveats before quoting these"

    **Warm** is the median of runs 2 and 3. Expect little from the first pass:
    Speculate cannot predict a call it has never seen, and warming up takes two
    or three runs. The benchmark repeats an identical session, so treat it as
    the best case for a workflow you genuinely repeat.

Three of the four need no credential. Check them yourself:

```bash
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario context7
```

[Release notes](design/releases.md) and
[implementation notes](design/implementation-notes.md) have every run, including
the ones that went the wrong way — see especially
[why the first pass cannot be fast](design/implementation-notes.md#1321-why-the-first-pass-cannot-be-fast-and-why-no-threshold-fixes-it-2026-08-02).

## Non-goals

Speculating writes (permanent), brokering anyone else's credentials, general
response caching, token savings. The win is wall-clock latency.
