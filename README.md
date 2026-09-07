# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-lukebward.github.io%2Fspeculate-teal)](https://lukebward.github.io/speculate/)
[![license](https://img.shields.io/npm/l/speculate-mcp)](LICENSE)

📖 **[Documentation](https://lukebward.github.io/speculate/)** · [Getting started](https://lukebward.github.io/speculate/getting-started/) · [Commands](https://lukebward.github.io/speculate/commands/) · [Safety](https://lukebward.github.io/speculate/safety/) · [Design document](https://lukebward.github.io/speculate/design/)

**Speculative prefetching for coding agents.** Speculate sits between your MCP client and its servers. It predicts the next read-only tool call, runs it early, and has the answer waiting. Gmail preloads your inbox; this preloads your tool calls.

> Built with heavy use of AI coding agents. Everything here is reviewed and tested, and the suite runs on Linux, macOS, and Windows, but weigh that as you would any other statement about how software was made.

![Demo: a GitHub PR workflow run twice, with the second read served from prefetch](demo/speculate-demo.gif)

- **No configuration, nothing per-server.** Speculate learns from your own traffic, so it works the same on a server nobody has heard of.
- **Memory across sessions.** It writes compact learning to your disk automatically. Recent call payloads stay in bounded session memory; argument bindings can reach across intervening calls. `speculate memory` shows what is retained and `speculate stats` shows whether it helps.
- **Read-only, always.** It runs tools the server marks read-only, and nothing else.
- **Nothing taken away.** Every change is recorded, and `off` reverses it exactly.

Measured against real hosted MCP servers, not mocks. Three alternating off/on runs each, zero config:

| Server | Auth | Warm tool wait | Cut |
|---|---|---|---|
| Context7 | none | 9.4 s to 3.1 s | -67% |
| GitHub hosted MCP | token | 5.0 s to 1.6 s | -67% |
| Microsoft Learn | none | 2.3 s to 1.1 s | -54% |
| Hugging Face Hub | none | 259 ms to 139 ms | -46% |

Those historical snapshots reported zero completed waste, but they predated
terminal accounting for the final outstanding batch. The current harness
prints outstanding entries separately and shutdown counts them as abandoned,
so new runs expose that cost rather than letting it disappear. The saving
still tracks how slow the server is, which is the point: a local stdio server
answering in single-digit milliseconds has nothing worth hiding.

**Warm** is the median of runs 2 and 3. Repeated traffic usually helps: the learner can make some schema-backed predictions on a first pass, while learned transitions need evidence. These benchmarks warmed over two or three runs and repeat an identical session, so treat them as a best case for a workflow you repeat. Three of the four need no credential. Check them yourself:

```bash
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario context7
```

The [design document](https://lukebward.github.io/speculate/design/releases/) has every run, including the ones that went the wrong way.

The [v0.19 qualification](docs/design/local-learning-benchmark.md) compares
changing repeated workflows against v0.18: useful prefetches rose from 68.5%
to 83.75% and mean tool wait fell 12.87% across four controlled fixtures with
120 ms injected latency. Most additional useful results were in-flight joins;
ready hits and tail latency did not improve. See the report for cold starts,
waste, negative controls, and the limited gains in live-server checks.

## Install

```bash
npm install -g speculate-mcp
speculate on
```

That is the whole setup. `speculate on` re-registers this project's MCP servers wrapped, going through Claude Code's own `claude mcp` CLI instead of editing files by hand. It also installs a hook, so servers you add later get wrapped too.

Speculate wraps remote (streamable HTTP) servers too, which is where most of the latency lives. For the ones needing a login (Sentry, Notion, Linear), `on` offers to sign you in: say yes, click once in the browser, done.

Servers that **plugins** provide (`plugin:github:github` and friends) are wrapped too: `on` registers a wrapped copy under the bare server name and turns the plugin's own copy off with the same per-project switch the `/mcp` screen uses. Tool names follow the copy, so a permission rule keyed `mcp__plugin_github_github__*` becomes `mcp__github__*` — the one rename to expect.

Speculate never touches connectors you added in the claude.ai UI. The host holds those, so nothing here can see them.

## Commands

| Command | What it does |
|---|---|
| `speculate on` | Wrap this project's MCP servers, and keep new ones wrapped |
| `speculate off` | Restore this project exactly, and stop auto-wrapping it |
| `speculate status [path]` | Every project at a glance; give a path (`.`) for one project's detail |
| `speculate auth [server]` | Log in to remote servers that need it (`--forget` to undo) |
| `speculate stats` | Saved time, conservative net, predictor recall, near misses, and per-server/tool views |
| `speculate memory [--json]` | Inspect retained learning, size, last-save time, and default limits; `clear --all` removes managed learning and usage records |
| `speculate try` | Launch a throwaway session to try it, writing nothing |
| `speculate doctor` | Why a given tool is or is not eligible for speculation |

## Safety

- Speculate only ever executes tools the server marks read-only (`readOnlyHint` plus your own `allowTools` in `strict` mode; annotations alone in `annotated`, the zero-config default). It never speculates on an unknown tool. It forwards every real call verbatim, writes included, and flushes the cache on any mutation.
- Cached results are byte-identical, single-use, short-lived, and remain in memory. Disk learning contains tool names, argument source descriptors, filtered constants, and aggregate evidence. Learner observations have a 30-day retention window; state is capped at 8 MiB per workspace/account by default. There is no raw call/result archive.
- Known credentials and recognizable secret literals are removed before learned state is written or imported. This reduces exposure; arbitrary private strings cannot always be recognized. Local files inherit your account's access controls. See [disk contents and secret handling](docs/safety.md#local-learning-and-secrets).
- `speculate on` changes config through the host's own CLIs and records everything it did, so `off` can undo it exactly. One scoped exception: wrapping a plugin's server also adds that server's name to `disabledMcpServers` in your own `~/.claude.json` — the key the `/mcp` screen writes and no CLI does — and `off` removes exactly that entry.
- Speculate registers as its own OAuth client and never reads another application's credential store, so refreshing its token cannot disturb Claude Code's. It never logs a header value: `doctor` shows names and expiry, never the token.

**Non-goals:** speculating writes (permanent), brokering anyone else's credentials, general response caching, token savings. The win is wall-clock latency.

<details>
<summary><b>How auto-wrapping behaves</b></summary>

`on` installs a hook-only plugin at Claude Code's user scope, shared by every project. At session start — fresh, `--resume`, or `/clear` — it wraps any newly added, already-approved servers, plugin-declared ones included.

- **One session behind.** Claude Code reads MCP config before session-start hooks run, so a server you add now gets wrapped from your *next* session. It works normally meanwhile, just without prefetching.
- **Approval never widens.** A server pending approval in `.mcp.json` stays pending. Revoke it, or delete the server, and the next session start removes the wrapped copy.
- **The `/mcp` switches win.** A plugin server you disabled there is never wrapped, and your entry is never removed. Disable a wrapped copy instead and Speculate stands down: copy removed, plugin original back.
- **GUI-launched apps work too.** The hook bakes absolute paths for `node` and `claude` with PATH fallbacks, so a desktop app opened from a dock icon — whose minimal OS PATH has neither — still auto-wraps. If the hook ever stops firing, `speculate status` says so instead of staying silent.
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

Your client sees standard MCP: same tools, same results. Predicted reads come back from a local buffer instead of a network round trip. Ask the agent to call `speculate__stats` for live cache outcomes, predictor recall, time saved versus possible stdio wait, per-tool near misses, and how stale served prefetches were.

`speculate shims install` is auto-wrapping for these clients: opt-in `npx`/`uvx` shims that wrap any MCP server any client launches. It edits one marked block in your shell rc file. POSIX only.

</details>

<details>
<summary><b>Per-server configuration</b></summary>

A config file (JSON with comments) adds per-server modes, allow/denylists, TTLs, budgets, and declarative prediction rules. See [`speculate.config.example.json`](speculate.config.example.json); `speculate init` writes a starter.

Rules provide explicit predictions from the first matching call. The learner normally builds evidence from repeated transitions, although compatible tool schemas can also support a prediction before a transition has been observed. Rules select values out of the trigger's arguments or its parsed result (`$args.owner`, `$item.number`, `forEach: "$parsed"`). A server that answers in non-JSON text can therefore be learned but not ruled.

</details>

## More

Architecture, measured results, and threat model: [design document](https://lukebward.github.io/speculate/design/). Building and testing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
