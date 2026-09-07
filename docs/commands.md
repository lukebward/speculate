# Commands

| Command | What it does |
|---|---|
| `speculate on` | Wrap this project's MCP servers, and keep new ones wrapped |
| `speculate off` | Restore this project exactly, and stop auto-wrapping it |
| `speculate status` | What is wrapped here, what needs a login, and what changed since `on` |
| `speculate auth [server]` | Log in to remote servers that need it (`--forget` to undo) |
| `speculate stats` | Cumulative time saved, hit rate, and waste (`--json` for scripts) |
| `speculate memory` | Retained learning inventory; `clear --all` removes managed learning and usage records |
| `speculate try` | Launch a throwaway session to try it, writing nothing |
| `speculate doctor` | Why a given tool is or is not eligible for speculation |

## `on` and `off`

`on` changes config only through the host's own CLIs and records everything it
did, so `off` can undo it exactly.

!!! tip "`off` is a real undo, not a disable flag"

    It restores the project to the exact server registrations it found, and
    stops auto-wrapping that project. Nothing is left behind to clean up.

`off` covers one project. To stop auto-wrapping globally:

```bash
claude plugin uninstall -s user speculate-autowrap
claude plugin marketplace remove speculate-mcp
```

## `doctor`

The command to reach for when a tool isn't being prefetched. It explains
eligibility per tool — the annotation check, the mode, and any allow/denylist
that applied.

!!! note "`doctor` never prints a credential"

    It shows header **names** and token expiry, never a value.

## `stats`

Cumulative time saved, conservative stdio wait, net estimate, hit/waste rate,
predictor recall, and argument near misses. `--json` emits the full structured
report.

Prediction coverage distinguishes opportunities with no ranked candidate from
candidates that were offered but did not match. The benefit summary uses
recorded hits, joins, and estimated wait; waste is displayed separately. It does not measure total task
time or prove a proxy is currently active. Use `speculate status` for activation.
JSON preserves existing fields and adds a `learning` summary.

```bash
speculate stats --since 7d
speculate stats --workspace . --by-server --by-tool
speculate stats --compact
```

`--since` accepts durations (`30m`, `24h`, `7d`, `4w`) or a date.
`--compact` packs completed records older than 30 days into monthly archives;
it preserves each snapshot and every filter, while avoiding thousands of tiny
files.

The same numbers are available to the agent mid-session as the
`speculate__stats` tool, which also reports how stale served prefetches were and
breaks outcomes down by server and tool.

## `memory`

Learning persists automatically. Inspect aggregate inventory without printing
argument values:

```bash
speculate memory
speculate memory --json
speculate memory --config speculate.config.json
speculate memory clear --config speculate.config.json
speculate memory clear --all
```

`--config` selects an explicit configured state path. `clear --all` removes
recognized learning and usage records from the managed state directory; custom
paths must be cleared using their config. Authentication, host registrations,
and wrapping settings are preserved. Active sessions stop saving into cleared
generations; start a new session to resume persistent learning.

The inventory shows file size, last-save time, and counts with repeated evidence.
Those counts do not prove a call can be predicted now: fresh history, eligibility,
and admission still matter. The bare command displays default limits; use
`--config PATH` to inspect custom limits.

## `wrap`

The primitive the other commands build on, and what you put in a non-Claude-Code
client's config directly:

```bash
# stdio upstream
npx -y speculate-mcp wrap -- github-mcp-server stdio

# streamable-HTTP upstream
npx -y speculate-mcp wrap --url https://api.githubcopilot.com/mcp/ \
    --header "Authorization: Bearer ${GITHUB_TOKEN}"
```

See [Getting started](getting-started.md) for the surrounding config.
