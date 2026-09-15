# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/speculate-mcp)](LICENSE)

Speculate is a local proxy for Model Context Protocol (MCP) servers. It learns
patterns in a coding agent's tool calls and starts likely read-only calls early.
When the agent requests one, Speculate can return the buffered result or wait
for the call already in progress. Other calls go upstream normally.

![Demo: repeated GitHub workflow with prefetched results](demo/speculate-demo.gif)

## Setup

Requires Node.js 18 or later:

```bash
npm install -g speculate-mcp
speculate on
```

`on` enables both Claude Code and Codex. It wraps supported MCP servers and
installs session-start hooks to pick up new ones across projects. Restart your
clients afterward; in Codex, review and trust the Speculate hook through `/hooks`.
A newly wrapped server may take another session to load.

```bash
speculate off                  # turn off both clients
speculate off --client codex   # turn off only Codex
speculate on --client claude   # turn on only Claude Code
```

### Experimental session observer

The context-aware session launcher is currently available only from a source
build. It remains experimental: the 1,000-case replay passed correctness checks
but failed the speedup and speculative-waste targets:

```bash
npm install
npm run build

# Hook observation is the default for both clients.
node dist/src/cli.js run claude -- --print "Summarize this workspace."
node dist/src/cli.js run codex -- exec "Summarize this workspace."

# Proxy mode also observes the native model transport.
node dist/src/cli.js run claude --observe proxy -- --print "Summarize this workspace."
node dist/src/cli.js run codex --observe proxy -- exec "Summarize this workspace."
```

Add `--json-report <path>` before the separator for an aggregate session report.
`--observe off` keeps existing MCP prediction active while disabling the new
hook and model observers; it is the comparison baseline for this feature.

The launcher uses the existing native account, provider, model, effort,
permissions, and transport. It does not acquire credentials or add tool
permissions. Proxy mode changes only the launched process's provider base URL
and forwards request and response bytes and headers. If the provider route or
temporary controls cannot be verified, the launcher falls back to hook mode or
leaves the affected MCP route native.

Claude speculation requires an exact existing allow rule for the MCP tool.
Codex also keeps its effective per-server tool policy, and its native hook must
already be trusted. Unsupported Codex configuration arguments and server alias
segments are handled by abstaining rather than rewriting them.

Native-account smoke tests completed one correct, wrapper-owned MCP read in
`off`, `hooks`, and `proxy` modes on both clients without duplicate upstream
calls. This proves transfer and result integrity, not a speed improvement.
Live API-key runs and native speedup remain unverified. The replay did not
establish an improvement over existing Speculate. See the
[observer results](docs/observer-results.md) and
[compatibility notes](docs/observer-compatibility.md).

Observer admission learns usefulness separately by client, signal source, and
tool destination. Repeated unused predictions lose priority through the existing
adaptive admission policy. See the
[Headroom-informed design](docs/headroom-informed-speculation.md) for the
mechanisms, measurement changes, and remaining limits.

Claude Code setup covers user servers and approved servers in known projects.
Codex setup covers enabled user-level servers on the same host. Built-in tools,
shell commands, hosted connectors, and unsupported registrations are outside
MCP wrapping. See the [setup guide](https://lukebward.github.io/speculate/getting-started/)
for scope, hook setup, and authentication. Turning off preserves stored learning
and authentication.

### Other MCP clients

For clients that launch stdio servers, replace the server's command and arguments
with a wrapper entry:

```json
{
  "command": "npx",
  "args": ["-y", "speculate-mcp", "wrap", "--", "github-mcp-server", "stdio"]
}
```

Substitute your server's command and arguments; keep its environment variables
and other settings. Remote Streamable HTTP servers use `wrap --url`.
See the [setup guide](https://lukebward.github.io/speculate/getting-started/)
for remote authentication and [migration from PATH shims or `try`](https://lukebward.github.io/speculate/getting-started/#upgrading-from-retired-launch-paths).

## Behavior and limits

Predicted results are held in a short-lived, single-use memory buffer, keyed by
server, tool, and exact argument values. Calls classified as mutations clear that
server's buffer.
Speculate returns upstream results without generating or combining them.

Speculative calls require `readOnlyHint: true` from the server. The default mode
for `on` and `wrap` trusts that hint; `strict` mode also requires an allowlist.
Incorrect annotations can make unsafe tools eligible, and reads can still
consume quota or incur charges.

Full tool results stay in memory. Learned patterns persist locally between
sessions and can include private argument values despite secret filtering.
Registration backups and OAuth credentials are stored separately. See
[safety and storage](https://lukebward.github.io/speculate/safety/) for details.

## Check whether it helps

Run `speculate stats` to inspect useful predictions, wasted calls, and estimated
time saved. An agent can call `speculate__stats` for the current session.
Unused predictions add upstream work; fast local tools may be cheaper to call
directly. The [benchmarks](https://lukebward.github.io/speculate/design/local-learning-benchmark/)
report measured results and limitations, including the use of simulated latency.

## Documentation

- [Commands](https://lukebward.github.io/speculate/commands/): status, authentication, diagnostics, and clearing stored learning.
- [Configuration](https://lukebward.github.io/speculate/configuration/): allowlists, cache lifetimes, request budgets, and prediction rules.
- [Design](https://lukebward.github.io/speculate/design/): how learning and prefetching work.
- [Contributing](CONTRIBUTING.md): building, testing, and benchmarks. Development uses AI coding agents; CI covers Linux, macOS, and Windows.

[MIT license](LICENSE)
