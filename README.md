# Speculate

Speculative prefetching for coding agents. Speculate sits between your MCP client (Claude Code, Cursor, any host) and its MCP servers, predicts the next read-only call, runs it early, and serves the result the moment it's asked for. Like Gmail preloading your inbox, applied to tool calls.

![Demo: a GitHub PR workflow run twice, with the second read served from prefetch](demo/speculate-demo.svg)

A run against the bundled mock GitHub server with injected latency, captured as-is: the first pass teaches Speculate the workflow, and on the second the PR is already fetched by the time the agent asks. Re-run it with `npm run demo`; `npm run bench` reproduces the measured off/on comparison: 71% hit rate, −66% tool wait, zero wasted calls on a scripted 7-call session against the mock at 400 ms. That is the optimistic ceiling, not a wild-traffic estimate.

## Try it in Claude Code: nothing installed, nothing written

```bash
npx -y github:lukebward/speculate try
```

Launches a normal `claude` session with every MCP server wrapped, via a throwaway config. Exit the session and no trace remains.

## Turn it on (Claude Code)

```bash
npm install -g github:lukebward/speculate   # install the CLI once
speculate on                                # enable it for the current project
```

`try` and `on` are Claude Code integrations. Using any other MCP client? Skip to [the wrap prefix](#any-other-mcp-client); nothing in this section is required.

One command, one project, every MCP server the agent uses: your MCP servers are re-registered wrapped through `claude mcp`, the host's own CLI, never a hand-edited file. Servers pending approval stay pending: Speculate never widens consent.

Upgrading from ≤0.10? `speculate on` also removes the retired CLI-speculation plugin and workspace server. Until you run it, `speculate exec` stays as a compatibility pass-through so that plugin's still-installed Bash hook keeps working. Compatibility only, for one release: it is removed in 0.12.

`speculate status` shows what's active and what drifted. `speculate off` restores everything exactly, even without its state file, since wrapped entries carry their original command line after the `--`.

`speculate stats` shows cumulative estimated time saved, hit rate, waste, and per-workspace usage. Use `speculate stats --json` for structured output. Collection began in v0.10; `speculate try` remains zero-write and is excluded.

No further configuration. Servers are recognized by their live tool lists (a dockerized or renamed server still gets its vetted profile; GitHub, filesystem, and Slack ship built in), and predictions ship pre-loaded then adapt: the learner watches which call follows which in *your* traffic, and persists per config. A restarted proxy prefetches your workflows from the first trigger, and once it has seen how your sessions open (twice), it prefetches those opening reads at launch, before your first request.

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

The client sees standard MCP: same tools, same results, some just arrive ~200× faster. Ask the agent to call `speculate__stats` for the current MCP session's live hit rate and time saved; `speculate stats` reports durable cumulative usage.

## Safety

- Speculation only ever executes tools that are affirmatively read-only (`readOnlyHint` + allowlists in `strict` mode; annotations alone in `annotated`, the zero-config default). Unknown tools are never speculated; real calls, including writes, are forwarded verbatim, and any mutation flushes the cache.
- Cached results are byte-identical, single-use, short-TTL, and never written to disk. Persisted learning contains tool names and argument templates, never results.
- `speculate on` mutates config only through the host's own CLIs (`claude mcp`, `claude plugin`), records what it did, and `off` restores exactly.

## More control

A config file (JSON with comments) adds per-server modes, allow/denylists, TTLs, budgets, and declarative prediction rules. See [`speculate.config.example.json`](speculate.config.example.json). `speculate init` writes a starter; `speculate doctor` explains per-tool eligibility ("why isn't it speculating?"). `speculate shims install` (opt-in) adds sniffing `npx`/`uvx` shims so MCP servers you add next year in any client wrap automatically.

Architecture, measured results, threat model, and design history: [DESIGN.md](DESIGN.md).

## Development

```bash
npm install     # builds dist/ via the prepare hook
npm test        # 431 tests (424 passing, 7 skipped on this platform)
npm run bench   # speculation off vs on
npm run demo    # the README demo, against the bundled mock (injected latency)
```

Running the test suite needs Node >= 20.19 (vitest's native rolldown binding; npm silently skips it on older Node). The runtime floor for *using* speculate is unchanged at Node >= 18.

Layout: `src/proxy.ts` (router), `src/executor.ts` (speculation + drain queue), `src/predictor.ts`/`learner.ts`/`priming.ts` (prediction), `src/cache.ts`, `src/policy.ts`/`budget.ts` (safety and limits), `src/manage.ts`/`tryRun.ts` (on/off/try), `mock/`, `bench/`.

## Non-goals

Speculating writes (permanent), owning upstream auth, general response caching, token savings. The win is wall-clock latency.

## License

MIT
