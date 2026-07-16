# Speculate

Speculative prefetching for coding agents. Speculate sits between your MCP client (Claude Code, Cursor, any host) and everything the agent calls (MCP servers *and* workspace CLI commands), predicts the next read-only call, runs it early, and serves the result the moment it's asked for. Like Gmail preloading your inbox, applied to tool calls.

![Demo: a real GitHub workflow run twice, with the second read served from prefetch](demo/speculate-demo.svg)

A live run against real GitHub, captured as-is: the first pass teaches Speculate the workflow, and on the second the PR is already fetched by the time the agent asks. Re-run it with `npm run demo`; `npm run bench` reproduces the measured off/on comparison (71% hit rate, −66% tool wait, zero wasted calls).

## Try it in Claude Code: nothing installed, nothing written

```bash
npx -y github:lukebward/speculate try
```

Launches a normal `claude` session with every MCP server wrapped and CLI speculation on, via a throwaway config. Exit the session and no trace remains.

## Turn it on (Claude Code)

```bash
npm install -g github:lukebward/speculate   # install the CLI once
speculate on                                # enable it for the current project
```

`try` and `on` are Claude Code integrations. Using any other MCP client? Skip to [the wrap prefix](#any-other-mcp-client); nothing in this section is required.

One command, one project, everything the agent uses:

- **Your MCP servers** are re-registered wrapped through `claude mcp`, the host's own CLI, never a hand-edited file. Servers pending approval stay pending: Speculate never widens consent.
- **CLI speculation** is installed as a Claude Code plugin (local scope, this project): a workspace MCP server for git/ripgrep/`gh`/npm tools, plus a Bash hook that serves the agent's native `git status`, `git diff`, `rg`, `ls` from the prefetch cache. On older Claude Code versions without a plugin CLI it falls back to the workspace server alone (`--no-plugin` forces that).

`speculate status` shows what's active and what drifted. `speculate off` restores everything exactly, even without its state file, since wrapped entries carry their original command line after the `--`.

`speculate stats` shows cumulative estimated time saved, hit rate, waste, and per-workspace usage across MCP and CLI speculation. Use `speculate stats --json` for structured output. Collection starts with this version; `speculate try` remains zero-write and is excluded.

No further configuration. Servers are recognized by their live tool lists (a dockerized or renamed server still gets its vetted profile — GitHub, filesystem, and Slack ship built in), workspaces configure themselves by probing the repo, and predictions ship pre-loaded then adapt: the learner watches which call follows which in *your* traffic, and persists per config. A restarted proxy prefetches your workflows from the first trigger — and once it has seen how your sessions open (twice), it prefetches those opening reads at launch, before your first request.

<details>
<summary><code>npm install -g</code> from git fails with <code>ENOTDIR … node_modules/speculate-mcp</code>?</summary>

Some npm versions leave a broken symlink behind when installing from git. Clear it and install a prebuilt tarball:

```bash
npm uninstall -g speculate-mcp 2>/dev/null
rm -rf "$(npm root -g)/speculate-mcp" "$(npm root -g)/".speculate-mcp-*   # sudo if needed

git clone https://github.com/lukebward/speculate && cd speculate
npm install && npm pack && npm install -g ./speculate-mcp-*.tgz
```

`npx … try` is unaffected. A published npm release is the planned durable fix.
</details>

## Any other MCP client

No install and no Claude Code required: prefix the server command already in your client's config:

```jsonc
// before
"github": { "command": "github-mcp-server", "args": ["stdio"] }

// after
"github": {
  "command": "npx",
  "args": ["-y", "github:lukebward/speculate", "wrap", "--", "github-mcp-server", "stdio"]
}
```

The client sees standard MCP: same tools, same results, some just arrive ~200× faster. `wrap --workspace .` gives the same treatment to a repo's CLI tools. Ask the agent to call `speculate__stats` for the current MCP session's live hit rate and time saved; `speculate stats` reports durable cumulative usage.

## Safety

- Speculation only ever executes tools that are affirmatively read-only (`readOnlyHint` + allowlists in `strict` mode; annotations alone in `annotated`, the zero-config default). Unknown tools are never speculated; real calls, including writes, are forwarded verbatim, and any mutation flushes the cache.
- Cached results are byte-identical, single-use, short-TTL, and never written to disk. Persisted learning contains tool names and argument templates, never results.
- CLI commands execute only from a closed, fail-closed table (`git status/diff/log/show/branch/rev-parse`, `rg` with a path, `ls`): fixed binaries, no shell, validated refs, workspace-contained paths, git hooks/pagers/external diff drivers disabled. Learned predictions re-vet through the same table before running. A file watcher flushes the cache within ~300 ms of any workspace change.
- The Bash hook rewrites nothing containing quoting, substitution, chaining, or redirection, and everything fails open: any doubt anywhere means your command runs directly, untouched.
- `speculate on` mutates config only through the host's own CLIs (`claude mcp`, `claude plugin`), records what it did, and `off` restores exactly.

## More control

A config file (JSON with comments) adds per-server modes, allow/denylists, TTLs, budgets, and declarative prediction rules. See [`speculate.config.example.json`](speculate.config.example.json). `speculate init` writes a starter; `speculate doctor` explains per-tool eligibility ("why isn't it speculating?"). Custom CLI tools go in a [command registry](speculate.commands.example.jsonc). `speculate shims install` (opt-in) adds sniffing `npx`/`uvx` shims so MCP servers you add next year in any client wrap automatically.

Architecture, measured results, threat model, and design history: [DESIGN.md](DESIGN.md).

## Development

```bash
npm install     # builds dist/ via the prepare hook
npm test        # 515 unit and end-to-end tests
npm run bench   # speculation off vs on
npm run demo    # the README demo, live against real GitHub (needs gh)
```

Layout: `src/proxy.ts` (router), `src/executor.ts` (speculation + drain queue), `src/predictor.ts`/`learner.ts`/`priming.ts` (prediction), `src/cache.ts`, `src/policy.ts`/`budget.ts` (safety and limits), `src/manage.ts`/`tryRun.ts` (on/off/try), `shell/` + `src/exec*.ts` (CLI speculation), `plugin/` (Claude Code plugin), `mock/`, `bench/`.

## Non-goals

Speculating writes (permanent), owning upstream auth, general response caching, token savings. The win is wall-clock latency.

## License

MIT
