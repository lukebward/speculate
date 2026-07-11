# Speculate

A speculative-prefetching MCP proxy. It sits between your MCP client (Claude Code, Cursor, any host) and your servers, predicts the agent's next read-only tool calls, executes them early, and serves the results the moment the agent asks — like Gmail preloading your inbox, applied to tool calls.

![Benchmark: the same 7-call agent session with speculation off vs on](demo/speculate-demo.svg)

```
tool call                    off       on
get_issue                 409 ms   408 ms   miss (first call)
get_issue_comments        405 ms     2 ms   prefetched
list_pull_requests        405 ms     2 ms   prefetched
get_pull_request          405 ms     2 ms   prefetched
get_pull_request_diff     404 ms   153 ms   joined in flight
list_issues               406 ms   404 ms   miss
get_issue                 405 ms     2 ms   prefetched
total tool wait           2.84 s   972 ms   −66%
```

71% hit rate, zero wasted upstream calls. Reproduce with `npm run bench`.

## Quickstart (Claude Code)

Try it without installing or modifying anything — one command, one session, zero writes:

```bash
npx -y github:lukebward/speculate try
```

`try` reads your existing Claude Code config, launches `claude` with every MCP server wrapped (plus CLI speculation for the current repo) via a throwaway `--mcp-config`, and leaves no trace when it exits.

Make it stick — still without ever opening a config file yourself:

```bash
npm install -g github:lukebward/speculate
speculate on       # wraps this project's MCP servers via `claude mcp` + adds CLI speculation
speculate status   # what's wrapped, what drifted
speculate off      # exact restore of everything `on` did
```

`on` goes through the host's own front door (`claude mcp remove`/`add-json`): user- and local-scope servers are re-registered wrapped in place; checked-in `.mcp.json` servers are never touched — a wrapped copy at local scope shadows them (local wins; the host may print a benign scope-overlap note). Unapproved `.mcp.json` servers stay unapproved: Speculate never widens consent.

> **Installing globally from git?** npm builds the package from source on install (it needs `git`, network, and its dev toolchain), and some npm versions leave a broken symlink behind — a later reinstall then fails with `ENOTDIR … rename … node_modules/speculate-mcp`. If that happens, clear the stale entry and retry, or install a prebuilt tarball:
>
> ```bash
> npm uninstall -g speculate-mcp 2>/dev/null
> rm -rf "$(npm root -g)/speculate-mcp" "$(npm root -g)/".speculate-mcp-*   # sudo if /usr/local needs it
>
> # reliable prebuilt install (no build-on-install):
> git clone https://github.com/lukebward/speculate && cd speculate
> npm install && npm pack && npm install -g ./speculate-mcp-*.tgz
> ```
>
> The zero-install `npx … try` above never touches your global modules and is unaffected. A published npm release is the planned durable path.

For the agent's **native shell commands** (`git status`, `rg`, …), install the plugin:

```bash
claude plugin marketplace add lukebward/speculate
claude plugin install speculate@speculate
```

The plugin bundles the workspace MCP server and a PreToolUse hook that routes vetted read-only Bash commands through `speculate exec` — a per-workspace daemon that serves byte-faithful cached output and prefetches the likely next command (needs the `npm install -g` above; without it the hook does nothing).

And for servers you add next year, in any client (opt-in — the only Speculate feature that edits a dotfile, one marked PATH block):

```bash
speculate shims install   # sniffing npx/uvx shims: MCP sessions get wrapped, everything else passes through byte-identically
```

## Any other MCP client

Prefix the server command you already have in your client config:

```jsonc
// before
"github": { "command": "github-mcp-server", "args": ["stdio"] }

// after
"github": {
  "command": "npx",
  "args": ["-y", "github:lukebward/speculate", "wrap", "--", "github-mcp-server", "stdio"]
}
```

For CLI speculation on a repo (git, ripgrep, and whatever tools your workspace implies):

```jsonc
"workspace": {
  "command": "npx",
  "args": ["-y", "github:lukebward/speculate", "wrap", "--workspace", "."]
}
```

The client sees standard MCP — same tools, same results, some just arrive ~200× faster. Ask the agent to call `speculate__stats` for live hit rate and time saved (`speculate exec --stats` for the CLI daemon).

## Dynamic by default

No configuration is required for any of this:

- **Servers are recognized by their tools, not their launch command.** If an upstream serves the GitHub tool set, the vetted GitHub profile (rules, TTLs, priors) applies automatically — dockerized or renamed servers included. In `strict` mode recognition is only a logged suggestion: strict always means explicit operator consent. Opt out entirely with `"profile": "none"`.
- **Workspaces configure themselves.** The bundled shell server probes the repo: git tools when `.git` exists, `gh` tools when there's a GitHub remote, `npm` tools next to a `package.json`, kubectl/docker/pip when their binaries and markers are present. All read-only, all curated.
- **Predictions ship pre-loaded and adapt to you.** Profiles carry curated workflow priors, and lister→getter tool names (`list_issues`→`get_issue`) are paired on any server. A primed pair starts prefetching after one sighting in your own traffic. From there the learner takes over: it watches which call follows which and how arguments flow, suppresses what doesn't match your habits, and persists per config — a restarted proxy prefetches your workflows from its first trigger.
- **Unknown servers still work.** Results parse via `structuredContent` or JSON-in-text, and the learner needs no profile at all.

## Safety

- Speculation only ever executes tools that are affirmatively read-only: `readOnlyHint` annotations plus allowlists (`strict` mode, the config default) or annotations alone (`annotated`, the `wrap` default). Unknown tools are never speculated.
- Real calls — including writes — are always forwarded verbatim. A mutation through the proxy flushes the cache, even if it throws.
- Cached entries are byte-identical to upstream results, single-use, short-TTL, and never written to disk. Persisted learning contains tool names and argument templates, never tool results (owner-only file; `"persistence": {"enabled": false}` to opt out).
- The shell server runs fixed binaries via `execFile` — no shell, no user-controlled flags, paths contained to the workspace, git hooks/pagers/external diff drivers disabled. A file watcher flushes its cache within ~300 ms of any workspace edit.
- The `speculate exec` daemon executes only command lines from a closed, fail-closed table (git status/diff/log/show/branch/rev-parse, rg, ls — flags from closed sets, refs regex-validated, paths workspace-contained). Learned predictions are re-vetted through the same table before they can run; results live in daemon memory only. The Bash hook rewrites nothing containing quoting, substitution, chaining, or redirection.
- `wrap --sniff` (used by the shims) engages the proxy only when the first client line is an MCP `initialize`; anything else gets a byte-transparent pipe with the exit code forwarded — over-wrapping is harmless by construction.
- `speculate on` mutates config only through `claude mcp` (the host's own CLI), records everything it does, and `off` restores exactly — wrapped entries also carry their original command line after the `--`, so `off` works even without the record.
- Priors and auto-detection only ever add vetted read-only knowledge; a wrong prediction can waste a call, never mutate anything.

## More control

Write a config file when you want one (JSON with comments allowed):

```bash
node dist/src/cli.js init                                   # starter config
node dist/src/cli.js validate --config speculate.config.json
node dist/src/cli.js doctor --config speculate.config.json  # per-tool "why isn't it speculating?"
```

The config adds per-server modes, allowlists/denylists, TTLs, budgets, and declarative prediction rules:

```jsonc
"jira": {
  "command": "jira-mcp-server",
  "rules": [{
    "trigger": "search_issues",
    "predict": [{ "tool": "get_issue", "args": { "issue_key": "$item.key" },
                  "forEach": "$parsed.issues", "limit": 2 }]
  }]
}
```

Custom CLI tools beyond the built-in catalog go in a command registry (`--commands mytools.jsonc`, see [`speculate.commands.example.jsonc`](speculate.commands.example.jsonc)); declaring a command asserts it is read-only, and model-supplied parameters are typed and can never become flags.

Architecture, measured results, and the full design history live in [DESIGN.md](DESIGN.md).

## Development

```bash
npm install     # builds dist/ via the prepare hook
npm test        # 430 unit and end-to-end tests
npm run bench   # speculation off vs on
npm run demo:svg
```

Layout: `src/proxy.ts` (router), `src/executor.ts` (speculation + drain queue), `src/predictor.ts` + `src/learner.ts` + `src/priming.ts` (prediction), `src/cache.ts` (single-use TTL buffer with in-flight join), `src/policy.ts` / `src/budget.ts` (safety and limits), `shell/` (workspace CLI server + catalog), `mock/` (test upstream), `bench/`.

## Non-goals

Speculating writes (permanent), owning upstream auth, general response caching, token savings — the win is wall-clock latency.

## License

MIT
