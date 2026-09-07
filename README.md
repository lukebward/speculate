# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/speculate-mcp)](LICENSE)

**[Documentation](https://lukebward.github.io/speculate/)** · [Setup](https://lukebward.github.io/speculate/getting-started/) · [Commands](https://lukebward.github.io/speculate/commands/) · [Safety](https://lukebward.github.io/speculate/safety/) · [Design](https://lukebward.github.io/speculate/design/)

Speculate is a local proxy for Model Context Protocol (MCP) servers. It learns
patterns in a coding agent's tool calls and starts likely read-only calls early.
When the agent requests a predicted call, Speculate can return the buffered
result or wait for the request already in progress.

It supports Claude Code through automatic setup, and other MCP clients through
an explicit wrapper command. Learning works across server types without custom
prediction rules.

![Demo: repeated GitHub workflow with prefetched results](demo/speculate-demo.gif)

*Demo uses a bundled mock server with simulated latency.*

## Get started

Requires Node.js 18 or later. For Claude Code, run this from your project:

```bash
npm install -g speculate-mcp
speculate on
```

`on` wraps the project's supported, approved MCP servers and installs a
session-start hook shared across projects to detect newly added servers. Start a new Claude Code session to load the
updated registrations. Servers added later may need another session before
their wrappers take effect.

For remote servers that need OAuth, `on` can offer a browser login. Speculate
uses its own credentials. It supports Streamable HTTP servers; connectors
configured through the claude.ai interface are outside this setup.

Plugin-provided servers may get different tool-name prefixes when wrapped.
Check any tool-specific permission rules after setup.

Run `speculate off` to restore the project's recorded server registrations and
stop automatic wrapping there. The shared hook and stored learning remain.

### Other MCP clients

For a client that can launch stdio servers, replace the server's command and
arguments with a wrapper entry like this. Keep any environment variables and
other settings the server needs.

```json
{
  "command": "npx",
  "args": ["-y", "speculate-mcp", "wrap", "--", "github-mcp-server", "stdio"]
}
```

Replace `github-mcp-server stdio` with your server's command and arguments.
For a remote server, use `wrap --url` and supply any required headers. The
[setup guide](https://lukebward.github.io/speculate/getting-started/)
includes examples with environment variables for credentials.

## How it works

Speculate learns how tool calls relate to each other. It uses recent arguments
and results to fill in predicted calls, and saves learned patterns between
sessions. Tool schemas and optional configuration rules can also supply
predictions before a pattern has been learned.

Predicted results are held in a short-lived, single-use memory buffer, keyed by
server, tool, and exact argument values. Calls classified as mutations clear
that server's buffer. Cache misses and requested writes go upstream normally;
Speculate returns the server's results without generating or combining them.

## Safety and stored data

Speculative calls require the server's `readOnlyHint: true` annotation. The
`annotated` mode, used by `on` and `wrap` by default, relies on that annotation.
`strict` mode also requires an explicit allowlist. These annotations are hints
from the server, so their accuracy matters. Reads can still consume rate limits
or incur charges.

Full tool results stay in memory. Saved learning contains tool names, argument
bindings, filtered constants, and aggregate evidence. Defaults are 30 days of
retention and 8 MiB per state file. Known credentials and recognizable secrets
are filtered from learning, but other private values can remain. Registration
backups and OAuth credentials are stored separately. See
[storage and secret handling](https://lukebward.github.io/speculate/safety/#local-learning-and-secrets).

`speculate memory` shows the learning inventory. `speculate memory clear --all`
removes managed learning and usage records while preserving authentication and
host settings. Custom state paths must be cleared with `--config`.

## Check whether it helps

Prefetching helps when a predicted call is used before its result expires.
Unused predictions add upstream work, and fast local tools may be cheaper to
call directly. Run `speculate stats` to inspect useful predictions, wasted
calls, and estimated time saved. An agent can call `speculate__stats` for the
current session.

In a 360-session controlled benchmark, v0.20 matched v0.19's held-out
useful-call counts, waste, and mean tool wait. Those fixtures used injected latency
and do not measure whole-task speedup. The
[benchmark guide](https://lukebward.github.io/speculate/design/local-learning-benchmark/)
contains the results, limitations, and reproduction commands.

## Commands and configuration

| Command | Purpose |
| --- | --- |
| `speculate status [path]` | Inspect registered projects, wrapped servers, and setup issues |
| `speculate stats` | Review retained usage and prediction outcomes |
| `speculate memory` | Inspect stored learning |
| `speculate auth [server]` | Authorize remote servers that need a login |
| `speculate doctor --config <path>` | Check server connections and tool eligibility |
| `speculate off` | Restore this project's recorded server registrations |

Use a configuration file to set allowlists, cache lifetimes, request budgets,
and prediction rules. `speculate init` creates a starter; see the
[example](speculate.config.example.json) and
[configuration reference](https://lukebward.github.io/speculate/configuration/).

PATH shims and `speculate try` were retired in v0.20. Existing shim users should
run `speculate shims uninstall` and restart their shell. See the
[migration guide](https://lukebward.github.io/speculate/getting-started/#upgrading-from-retired-launch-paths)
for saved wrapper commands and other upgrade details.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing, and benchmarks.
Development uses AI coding agents. CI runs on Linux, macOS, and Windows.

## License

[MIT](LICENSE)
