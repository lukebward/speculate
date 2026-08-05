# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/speculate-mcp)](LICENSE)

**Speculative prefetching for coding agents.** Speculate sits between your MCP client and its servers. It predicts the next read-only tool call, runs it early, and has the answer waiting. Gmail preloads your inbox; this preloads your tool calls.

> Built with heavy use of AI coding agents. Everything here is reviewed and tested, and the suite runs on Linux, macOS, and Windows, but weigh that as you would any other statement about how software was made.

![Demo: a GitHub PR workflow run twice, with the second read served from prefetch](demo/speculate-demo.gif)

- **No configuration, nothing per-server.** Speculate learns from your own traffic, so it works the same on a server nobody has heard of.
- **Read-only, always.** It runs tools the server marks read-only, and nothing else.
- **Nothing taken away.** Every change goes through your client's own CLI, and `off` puts it all back.

Measured against real hosted MCP servers, not mocks. Three alternating off/on runs each, zero config:

| Server | Auth | Warm tool wait | Cut |
|---|---|---|---|
| Context7 | none | 9.4 s to 3.1 s | -67% |
| GitHub hosted MCP | token | 5.0 s to 1.6 s | -67% |
| Microsoft Learn | none | 2.3 s to 1.1 s | -54% |
| Hugging Face Hub | none | 259 ms to 139 ms | -46% |

Zero wasted calls on any of them. The saving tracks how slow the server is, which is the point: a local stdio server answering in single-digit milliseconds has nothing worth hiding.

**Warm** is the median of runs 2 and 3. Expect little from the first pass: Speculate cannot predict a call it has never seen, and warming up takes two or three runs. The benchmark repeats an identical session, so treat it as the best case for a workflow you genuinely repeat. Three of the four need no credential. Check them yourself:

```bash
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario context7
```

[DESIGN.md](DESIGN.md) has every run, including the ones that went the wrong way.

## Install

```bash
npm install -g speculate-mcp
speculate on
```

That is the whole setup. `speculate on` re-registers this project's MCP servers wrapped, going through Claude Code's own `claude mcp` CLI instead of editing files by hand. It also installs a hook, so servers you add later get wrapped too.

Speculate wraps remote (streamable HTTP) servers too, which is where most of the latency lives. For the ones needing a login (Sentry, Notion, Linear), `on` offers to sign you in: say yes, click once in the browser, done.

Servers that come from Claude Code **plugins** (`plugin:github:github` and friends) are wrapped too: `on` registers a wrapped copy under the server's bare name and switches the plugin's own copy off through the host's per-project disable list — the same switch the `/mcp` screen uses. One visible cost: tool names follow the copy, so permission rules keyed `mcp__plugin_github_github__*` become `mcp__github__*`. Disabling either half in `/mcp` is respected: the plugin server stays disabled if you disabled it, and disabling the wrapped copy makes Speculate stand down and put the original back.

Speculate never touches connectors you added in the claude.ai UI. The host holds those, so nothing here can see them.

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

- Speculate only ever executes tools the server marks read-only (`readOnlyHint` plus your own `allowTools` in `strict` mode; annotations alone in `annotated`, the zero-config default). It never speculates on an unknown tool. It forwards every real call verbatim, writes included, and flushes the cache on any mutation.
- Cached results are byte-identical, single-use, short-lived, and never hit the disk. What Speculate persists is tool names and argument templates, never results.
- `speculate on` changes config only through the host's own CLIs and records everything it did, so `off` can undo it exactly. The one scoped exception: to wrap a plugin's server it also adds that server's name to the `disabledMcpServers` list in your own `~/.claude.json` — the key the `/mcp` screen writes, for which no CLI exists — and `off` removes exactly that entry.
- Speculate registers as its own OAuth client and never reads another application's credential store, so refreshing its token cannot disturb Claude Code's. It never logs a header value: `doctor` shows names and expiry, never the token.

**Non-goals:** speculating writes (permanent), brokering anyone else's credentials, general response caching, token savings. The win is wall-clock latency.

<details>
<summary><b>How auto-wrapping behaves</b></summary>

`on` installs a hook-only plugin at Claude Code's user scope, shared by every project. At session start — fresh, `--resume`, or `/clear` — it wraps any newly added, already-approved servers, plugin-declared ones included.

- **One session behind.** Claude Code reads MCP config before session-start hooks run, so a server you add now gets wrapped from your *next* session. It works normally meanwhile, just without prefetching.
- **Approval never widens.** A server pending approval in `.mcp.json` stays pending. Revoke it, or delete the server, and the next session start removes the wrapped copy.
- **GUI-launched apps work too.** The hook bakes absolute paths for both `node` and `claude` with PATH fallbacks, so a desktop app opened from a dock icon — whose minimal OS PATH has neither — still auto-wraps. If the hook ever stops firing, `speculate status` says so instead of leaving it silent.
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

Speculate resolves `${VAR}` in a header value from the environment at startup, so your token stays out of the file. An unset variable fails at startup and names itself; Speculate never sends a literal `${GITHUB_TOKEN}` upstream.

Your client sees standard MCP: same tools, same results. Predicted reads come back from a local buffer instead of a network round trip. Ask the agent to call `speculate__stats` for the live hit rate, time saved, and how stale the served prefetches were.

`speculate shims install` is auto-wrapping for these clients: opt-in `npx`/`uvx` shims that wrap any MCP server any client launches. It edits one marked block in your shell rc file. POSIX only.

</details>

<details>
<summary><b>Per-server configuration</b></summary>

A config file (JSON with comments) adds per-server modes, allow/denylists, TTLs, budgets, and declarative prediction rules. See [`speculate.config.example.json`](speculate.config.example.json); `speculate init` writes a starter.

Rules are the only hand-written prediction source, and you need them for one thing: skipping the warm-up. A rule fires on the first call, where the learner must watch a transition happen before predicting it. Rules select values out of the trigger's arguments or its parsed result (`$args.owner`, `$item.number`, `forEach: "$parsed"`). A server that answers in non-JSON text can therefore be learned but not ruled.

</details>

## More

Architecture, measured results, and threat model: [DESIGN.md](DESIGN.md). Building and testing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
