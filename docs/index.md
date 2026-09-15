# Speculate

**Speculative prefetching for coding agents.** Speculate sits between an MCP
client and its servers, learns likely read-only calls, and starts useful work
early. A matching real call consumes the exact upstream result or joins the
call already in progress.

![Demo: a GitHub PR workflow run twice, with the second read served from prefetch](https://raw.githubusercontent.com/lukebward/speculate/main/demo/speculate-demo.gif)

```bash
npm install -g speculate-mcp
speculate on
```

`speculate on` enables supported MCP servers for Claude Code and Codex. See
[Getting started](getting-started.md) for each client's scope and hook setup.

!!! quote "On how this was built"

    Built with heavy use of AI coding agents. Everything here is reviewed and
    tested, and the suite runs on Linux, macOS, and Windows, but weigh that as
    you would any other statement about how software was made.

<div class="grid cards" markdown>

-   :material-download:{ .lg .middle } **Getting started**

    ---

    One command enables Claude Code and Codex. Explicit `wrap` configuration
    supports other MCP clients.

    [:octicons-arrow-right-24: Install](getting-started.md)

-   :material-console-line:{ .lg .middle } **Commands**

    ---

    Managed setup, experimental context-aware sessions, authentication,
    diagnostics, and local memory.

    [:octicons-arrow-right-24: CLI reference](commands.md)

-   :material-shield-check:{ .lg .middle } **Safety**

    ---

    How eligibility is restricted to tools declared read-only, and which risks
    that restriction does not remove.

    [:octicons-arrow-right-24: Safety model](safety.md)

-   :material-tune:{ .lg .middle } **Configuration**

    ---

    Per-server modes, allowlists, denylists, TTLs, budgets, and prediction rules.

    [:octicons-arrow-right-24: Config reference](configuration.md)

-   :material-flask-outline:{ .lg .middle } **Experimental observer**

    ---

    Context-aware `run` modes for Claude Code and Codex, with measured limits
    and native compatibility boundaries.

    [:octicons-arrow-right-24: Observer results](observer-results.md)

-   :material-file-document-outline:{ .lg .middle } **Design**

    ---

    Architecture, prediction, cache semantics, release history, and benchmark
    methodology.

    [:octicons-arrow-right-24: Design spec](design/index.md)

</div>

## What it does

- **Starts without a config file.** The default learner adapts to supported MCP
  servers; optional per-server settings control policy, TTLs, and budgets.
- **Requires a read-only declaration.** Only tools with `readOnlyHint: true` are
  eligible. Strict mode also requires an explicit allowlist.
- **Preserves exact results.** Speculate returns an upstream result unchanged,
  joins an identical call in flight, or sends the real call upstream normally.
- **Keeps managed setup reversible.** `off` restores registrations that still
  match Speculate's recorded change and reports conflicts instead of overwriting
  later edits.

## Two prediction paths

Ordinary `speculate on` installs persistent MCP wrappers. They learn repeated
call sequences and can use explicit rules. The registration-sync hooks installed
for Claude Code and Codex discover newly added supported servers; they do not
observe conversation context.

Experimental `speculate run claude|codex` launches one native session and adds
prompt, learned cross-server transition, and supported model-stream signals.
It preserves the client's native account, model, effort, arguments, permission
policy, and transport selection. See the [compatibility matrix](observer-compatibility.md)
for differences between native client surfaces.

## Evidence and limits

The maintained core qualification preserves current predictor behavior. The
1,000-record observer replay passed correctness checks but failed its speedup
and speculative-waste gates for both clients. A later synthetic 60-record
multi-turn diagnostic measured about 40% less warm cross-server task time for
both client fixtures, but it does not establish native performance.

Native MCP transfer is verified for Claude Code and Codex. Native day-to-day
speedup remains unverified. The [benchmark guide](design/local-learning-benchmark.md)
and [observer results](observer-results.md) preserve the methods, historical
results, failed gates, and limitations.

## Non-goals

Speculating writes, brokering another client's credentials, general response
caching, and token savings are outside scope. The intended benefit is lower
wall-clock latency when a prediction is useful; workloads with poor predictions
can add upstream work.
