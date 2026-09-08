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

Requires Node.js 18 or later. Install, then choose your client:

```bash
npm install -g speculate-mcp

# Claude Code: run from your project
speculate on

# Codex: wrap enabled user-level MCP servers
speculate on --client codex
```

Restart the selected client. Claude Code setup wraps supported, approved servers
for this project and installs a shared session-start hook for new servers.
Codex setup uses its configuration API for enabled user-level stdio and Streamable
HTTP servers, shared by CLI, app, and IDE clients on the same Codex host.
Codex has no auto-wrap hook: rerun `on --client codex` or `sync --client codex`
after adding servers.

Use `speculate off` or `speculate off --client codex` to restore registrations
changed for that client. Stored learning and authentication remain.
See the [setup guide](https://lukebward.github.io/speculate/getting-started/#codex)
for Codex scope, unsupported configurations, and OAuth.

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
