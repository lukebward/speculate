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

## Quickstart

Prefix the server command you already have in your MCP client config:

```jsonc
// before
"github": { "command": "github-mcp-server", "args": ["stdio"] }

// after
"github": {
  "command": "npx",
  "args": ["-y", "github:lukebward/speculate", "wrap", "--", "github-mcp-server", "stdio"]
}
```

That's the whole setup. For CLI speculation on a repo (git, ripgrep, and whatever tools your workspace implies):

```jsonc
"workspace": {
  "command": "npx",
  "args": ["-y", "github:lukebward/speculate", "wrap", "--workspace", "."]
}
```

The client sees standard MCP — same tools, same results, some just arrive ~200× faster. Ask the agent to call `speculate__stats` for live hit rate and time saved.

## Dynamic by default

No configuration is required for any of this:

- **Servers are recognized by their tools, not their launch command.** If an upstream serves the GitHub tool set, the vetted GitHub profile (rules, allowlist, TTLs) applies automatically — dockerized or renamed servers included. Opt out with `"profile": "none"`.
- **Workspaces configure themselves.** The bundled shell server probes the repo: git tools when `.git` exists, `gh` tools when there's a GitHub remote, `npm` tools next to a `package.json`, kubectl/docker/pip when their binaries and markers are present. All read-only, all curated.
- **Predictions ship pre-loaded and adapt to you.** Profiles carry curated workflow priors, and lister→getter tool names (`list_issues`→`get_issue`) are paired on any server. A primed pair starts prefetching after one sighting in your own traffic. From there the learner takes over: it watches which call follows which and how arguments flow, suppresses what doesn't match your habits, and persists per config — a restarted proxy prefetches your workflows from its first trigger.
- **Unknown servers still work.** Results parse via `structuredContent` or JSON-in-text, and the learner needs no profile at all.

## Safety

- Speculation only ever executes tools that are affirmatively read-only: `readOnlyHint` annotations plus allowlists (`strict` mode, the config default) or annotations alone (`annotated`, the `wrap` default). Unknown tools are never speculated.
- Real calls — including writes — are always forwarded verbatim. A mutation through the proxy flushes the cache, even if it throws.
- Cached entries are byte-identical to upstream results, single-use, short-TTL, and never written to disk. Persisted learning contains tool names and argument templates, never tool results (owner-only file; `"persistence": {"enabled": false}` to opt out).
- The shell server runs fixed binaries via `execFile` — no shell, no user-controlled flags, paths contained to the workspace, git hooks/pagers/external diff drivers disabled. A file watcher flushes its cache within ~300 ms of any workspace edit.
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
npm test        # 320+ unit and end-to-end tests
npm run bench   # speculation off vs on
npm run demo:svg
```

Layout: `src/proxy.ts` (router), `src/executor.ts` (speculation + drain queue), `src/predictor.ts` + `src/learner.ts` + `src/priming.ts` (prediction), `src/cache.ts` (single-use TTL buffer with in-flight join), `src/policy.ts` / `src/budget.ts` (safety and limits), `shell/` (workspace CLI server + catalog), `mock/` (test upstream), `bench/`.

## Non-goals

Speculating writes (permanent), owning upstream auth, general response caching, token savings — the win is wall-clock latency.

## License

MIT
