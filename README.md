# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/speculate-mcp)](LICENSE)

**Speculative prefetching for coding agents.** Speculate sits between your MCP client and its MCP servers, predicts the next read-only tool call, runs it early, and serves the result the moment it is asked for. Like Gmail preloading your inbox, applied to tool calls.

> Built with heavy use of AI coding agents. Everything here is reviewed and tested, and the suite runs on Linux, macOS, and Windows, but weigh that as you would any other statement about how software was made.

![Demo: a GitHub PR workflow run twice, with the second read served from prefetch](demo/speculate-demo.gif)

- **No configuration.** Servers are recognized by their live tool lists, and the rest is learned from your own traffic.
- **Read-only, always.** Speculation runs tools that are affirmatively read-only and nothing else.
- **Nothing is taken away.** Every change goes through your client's own CLI, and `off` restores exactly.

Against a real server (GitHub's hosted MCP, one machine, one network): once warm, 7 of 8 calls come from the buffer and tool wait drops from about 4.3 s to about 0.55 s. Getting there takes two or three passes through the same workflow, and the first pass gets no benefit at all, because nothing can be predicted before it has been seen once. [DESIGN.md](DESIGN.md) has every run, including the ones that went the wrong way.

## Install

```bash
npm install -g speculate-mcp
speculate on
```

That is the whole setup. `speculate on` re-registers this project's MCP servers wrapped, using Claude Code's own `claude mcp` CLI rather than editing any file by hand, and installs a small hook so servers you add later get wrapped too.

Remote (streamable HTTP) servers are wrapped too, which is where most of the latency is. Ones that need a login (Sentry, Notion, Linear) are offered during `on`: say yes, click once in the browser, and they are wrapped straight away.

Connectors you added in the claude.ai UI are never wrapped: the host holds them, so nothing here can see them.

## Commands

| Command | What it does |
|---|---|
| `speculate on` | Wrap this project's MCP servers, and keep new ones wrapped |
| `speculate off` | Restore this project exactly, and stop auto-wrapping it |
| `speculate status` | What is wrapped here, what needs a login, and what changed since `on` |
| `speculate auth [server]` | Log in to remote servers that need it (`--forget` to undo) |
| `speculate stats` | Cumulative time saved, hit rate, and waste (`--json` for scripts) |
| `speculate try` | Launch a throwaway session to try it, writing nothing |
| `speculate doctor` | Why a given tool is or is not eligible for speculation |

## Safety

- Speculation only ever executes tools that are affirmatively read-only (`readOnlyHint` plus allowlists in `strict` mode; annotations alone in `annotated`, the zero-config default). Unknown tools are never speculated; real calls, including writes, are forwarded verbatim, and any mutation flushes the cache.
- Cached results are byte-identical, single-use, short-TTL, and never written to disk. Persisted learning holds tool names and argument templates, never results.
- `speculate on` mutates config only through the host's own CLIs, records what it did, and `off` restores exactly.
- Speculate registers as its own OAuth client and never reads another application's credential store, so refreshing its token cannot disturb Claude Code's. Header values are never logged; `doctor` shows names and expiry, never the token.

**Non-goals:** speculating writes (permanent), brokering anyone else's credentials, general response caching, token savings. The win is wall-clock latency.

<details>
<summary><b>How auto-wrapping behaves</b></summary>

`on` installs a hook-only plugin at Claude Code's user scope, shared by every project. At each session start it wraps any newly added, already-approved servers.

- **One session behind.** Claude Code reads MCP config before session-start hooks run, so a server you add now is wrapped from your *next* session, not this one. It works normally in the meantime, just without prefetching.
- **Approval is never widened.** A server still pending approval in `.mcp.json` stays pending. Revoke an approval, or delete the server, and the wrapped copy is removed at the next session start.
- **`--resume` and `--continue` do not trigger it.** The hook runs on fresh sessions only; `speculate on` always wraps on the spot.
- **Removing it everywhere:** `off` covers one project. To stop it globally, `claude plugin uninstall -s user speculate-autowrap`, then `claude plugin marketplace remove speculate-mcp`.

</details>

<details>
<summary><b>Any other MCP client</b> (no install, no Claude Code)</summary>

Prefix the server command already in your client's config:

```jsonc
// before
"github": { "command": "github-mcp-server", "args": ["stdio"] }

// after
"github": {
  "command": "npx",
  "args": ["-y", "speculate-mcp", "wrap", "--", "github-mcp-server", "stdio"]
}

// or a remote (hosted) server, which is where the latency actually is
"github": {
  "command": "npx",
  "args": ["-y", "speculate-mcp", "wrap", "--url", "https://api.githubcopilot.com/mcp/",
           "--header", "Authorization: Bearer ${GITHUB_TOKEN}"]
}
```

`${VAR}` in a header value is resolved from the environment when Speculate starts, so the token stays out of the file. An unset variable is a startup error naming the variable, never a literal `${GITHUB_TOKEN}` sent upstream.

The client sees standard MCP: same tools, same results, except predicted reads come back from a local buffer instead of a network round trip. Ask the agent to call `speculate__stats` for the live hit rate, time saved, and how stale the served prefetches were.

`speculate shims install` is the equivalent of auto-wrapping for these clients: opt-in `npx`/`uvx` shims that wrap any MCP server any client launches. It edits one marked block in your shell rc file, and it is POSIX-only.

</details>

<details>
<summary><b>Per-server configuration</b></summary>

A config file (JSON with comments) adds per-server modes, allow/denylists, TTLs, budgets, and declarative prediction rules. See [`speculate.config.example.json`](speculate.config.example.json); `speculate init` writes a starter.

</details>

## More

Architecture, measured results, and threat model: [DESIGN.md](DESIGN.md). Building and testing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
