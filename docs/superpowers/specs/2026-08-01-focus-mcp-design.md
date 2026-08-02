# Focus Speculate on MCP — remove CLI speculation

**Date:** 2026-08-01 · **Status:** approved (Luke, in-session) · **Branch:** `focus-mcp`

## Decision

Speculate becomes an MCP-only product: a speculative-prefetching proxy for MCP
servers. The entire CLI speculation tier is removed. The `speculate`
management CLI itself (`on`, `off`, `status`, `stats`, `wrap`, `init`,
`doctor`, `validate`, `shims`) **stays** — what goes is speculation *of* CLI
commands, not the CLI.

## Why (short form; full trail in session notes)

- Speculation value scales with latency. MCP/SaaS reads are 200–1000 ms
  (measured 333 ms → 1 ms in the demo); local CLI reads are ~30 ms, and the
  Bash hook's node-spawn overhead (~60 ms) can make interception net
  negative.
- The MCP side already satisfies "dynamic, no hardcoded tools": any server
  annotating `readOnlyHint` gets learner-driven speculation with no profile.
  Deterministic, cross-platform, already shipped.
- Every deterministic scheme for vetting *arbitrary* CLI commands ends in
  per-OS enforcement machinery (Landlock / sandbox-exec / Low-IL) or unsound
  observation heuristics (researched 2026-08-01; see session).
- The CLI tier holds the POSIX-only daemon (unix sockets, uid checks — dead
  on Windows), duplicated cache/safety logic, the Bash hook that breaks
  fine-grained permission rules, and a Windows `.git/index` watcher loop that
  flushes every prefetch before it can hit (`test/platform.ts`).
- Ecosystem (mid-2026): MCP consolidated as the SaaS-integration standard;
  local agent work moved to plain CLI — which is fast and needs no prefetcher.

## Scope

### Delete

- `src/execDaemon.ts`, `src/execClient.ts`, `src/execCache.ts`,
  `src/execTable.ts`
- `shell/` (speculate-shell.ts, catalog.ts, commands.ts)
- `plugin/` (hooks/bash-rewrite.mjs, hooks.json, .claude-plugin/plugin.json)
  and root `.claude-plugin/marketplace.json`
- `src/profiles/shell.ts` (profile for the deleted bundled server)
- `speculate exec` / `exec-daemon` commands; `speculate-shell` bin;
  `wrap --workspace` / `--commands` flags; `--no-plugin` flag
- `manage.ts` plugin-install + workspace-server registration paths;
  `hostConfig.ts` `workspaceEntry`; `wrap.ts` `resolveShellServerCommand`
- Tests: execTable, execDaemon, execClient, shell-server, shell-integration,
  catalog, plugin-hook + CLI-tier cases inside manage/scenarios/stats/usage
  tests
- `speculate.commands.example.jsonc`; `npm run shell` script

### Keep (unchanged)

Proxy, executor, cache, policy, budget, predictor, learner, priming,
persistence, profiles (github/filesystem/slack), metrics, usage/stats
(readers stay tolerant of historical `cli`-source records; nothing writes
them anymore), config, configRules, doctor, jsonc, keys, upstream, sniff,
shims, tryRun (MCP wrapping), wrap (MCP wrapping).

### Change

- `speculate on`: wraps MCP servers only. Must **clean up legacy artifacts**
  from prior versions: uninstall the `speculate` plugin and deregister the
  `speculate-workspace` server if present (via `claude plugin` / `claude
  mcp`), so an upgrade never strands a broken entry.
- `speculate off` / `status`: drop plugin/workspace handling except legacy
  cleanup/reporting.
- `speculate try`: MCP wrapping only.
- CLI `HELP` text, README (rewrite CLI-speculation sections), DESIGN.md
  (append a v0.11 decision record; do not rewrite history).
- Version → 0.11.0. `package.json`: drop `speculate-shell` bin, `dist/shell`
  + `plugin` from `files`, `shell` script.

### Update

- **Benchmark**: already MCP-only (mock GitHub); keep green cross-platform.
- **Demo**: currently drives the *deleted* workspace shell server. Rework to
  wrap the bundled mock GitHub MCP server (hermetic, no `gh` dependency),
  same two-pass learn-then-hit story. Regenerate `demo/speculate-demo.svg`
  via `scripts/gen-demo-svg.mjs` (fix its `/tmp` usage). The untracked
  `demo/speculate-linkedin.{gif,png}` are review-agent artifacts, left for
  Luke.
- **CI**: add `.github/workflows/ci.yml` — build + full test matrix on
  ubuntu/macos/windows. This is the "windows and mac compatible" proof.
- **Windows/mac compat**: baseline commit 06ef239 (fileURLToPath, tsx
  spawning, `test/platform.ts` probes). Remaining POSIX-isms in kept code:
  none known (persistence/manage already branch on win32); CI verifies.

## Non-goals

- `npm publish`, `git push`, tagging — prepared for, executed by Luke.
- `wrap --url`, configRules/shims removal, README benchmark-claims rework —
  separate follow-ups from the 2026-08-01 review; not in this change.
- No migration of learned CLI-tier state (it dies with the tier; MCP
  learning is untouched).

## Testing

Full suite green on Windows locally (the machine this is authored on) and on
the CI matrix. Deleted-tier tests removed, not skipped. `npm run bench` and
`npm run demo` run clean cross-platform. `speculate on` → `status` → `off`
round-trip exercised in manage tests including legacy-artifact cleanup.
