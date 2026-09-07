# Speculate

**Speculative prefetching for coding agents.** Speculate sits between your MCP
client and its servers. It learns likely read-only tool calls and runs them early,
reducing waiting when a prediction is used.

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

    `on`, `off`, `status`, `auth`, `stats`, `memory`, `doctor` — what each one
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

The [benchmark methodology and results](design/local-learning-benchmark.md)
explain each maintained instrument and its limits. The v0.19 qualification
against v0.18 increased useful prefetches from 68.5% to 83.75% and reduced mean
tool wait by 12.87% across four controlled repeated-workflow fixtures with
120 ms injected latency. Most additional useful results were joined in flight;
ready hits and tail latency did not improve.

Historical live-server runs measured larger warm-session savings, but repeated
identical requests and incomplete shutdown-waste accounting limit those
snapshots. The report preserves their scope and links to their raw history.
No measured result guarantees zero wasted calls or whole-task speedup.

## Non-goals

Speculating writes (permanent), brokering anyone else's credentials, general
response caching, token savings. The win is wall-clock latency.
