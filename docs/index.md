# Speculate

**Speculative prefetching for Claude Code.** Speculate is a Claude Code mod that
learns which read-only MCP calls tend to come next, starts them while the model
is still thinking, and answers the model's call from that result when it asks
for exactly the same thing.

```
/plugin install speculate --marketplace lukebward/speculate
```

!!! quote "On how this was built"

    Built with heavy use of AI coding agents. Everything here is reviewed and
    tested, but weigh that as you would any other statement about how software
    was made.

<div class="grid cards" markdown>

-   :material-download:{ .lg .middle } **Getting started**

    ---

    Install, check that it helps, and upgrade from the old npm package.

    [:octicons-arrow-right-24: Install](getting-started.md)

-   :material-console-line:{ .lg .middle } **Commands**

    ---

    `/speculate` reports what was served and wasted; `/speculate forget`
    clears what was learned.

    [:octicons-arrow-right-24: Commands](commands.md)

-   :material-shield-check:{ .lg .middle } **Safety and storage**

    ---

    Which calls can be prefetched, how permission and hooks stay in charge, and
    what is kept on disk.

    [:octicons-arrow-right-24: Safety model](safety.md)

-   :material-file-document-outline:{ .lg .middle } **Design**

    ---

    Architecture, prediction, cache semantics, release history, and benchmark
    methodology.

    [:octicons-arrow-right-24: Design spec](design/index.md)

</div>

## What it does

- **Lives inside Claude Code.** Calls go over Claude Code's own MCP
  connections, with its credentials. No server configuration is wrapped or
  rewritten.
- **Learns from real calls.** Transitions between reads, a session's usual
  opening reads, and prompts that name a read outright.
- **Prefetches only what you already allow.** A tool must have run read-only,
  and your permission settings must already allow the exact call.
- **Answers exact matches only, after your hooks.** A served call still runs
  through your PreToolUse hooks. A miss, a write, or any call your hooks object
  to runs exactly as it would have.

## Non-goals

Speculating writes, general response caching, and token savings are outside
scope. The benefit is less wall-clock waiting when a prediction is right; a
workload with poor predictions adds upstream reads, which `/speculate` shows.
