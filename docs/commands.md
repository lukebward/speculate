# Commands

| Command | What it does |
|---|---|
| `speculate on [--client claude\|codex]` | Wrap supported MCP servers for the selected client |
| `speculate off [--client claude\|codex]` | Restore registrations changed for the selected client |
| `speculate status [path] [--client claude\|codex]` | Inspect wrapping and configuration in the selected client |
| `speculate sync [--client claude\|codex]` | Wrap servers added since the last setup |
| `speculate auth [server] [--client claude\|codex]` | Authorize remote servers (`--forget` removes Speculate's login) |
| `speculate stats` | Cumulative time saved, hit rate, and waste (`--json` for scripts) |
| `speculate memory` | Retained learning inventory; `clear --all` removes managed learning and usage records |
| `speculate doctor` | Why a given tool is or is not eligible for speculation |

## `on` and `off`

`--client claude` is the default. Claude Code setup uses its own CLI to wrap
approved servers for this project and installs a shared session-start hook.
`off` restores the recorded registrations and stops automatic wrapping for that
project; the shared hook, learning, and OAuth credentials remain. To remove the
Claude Code hook globally:

```bash
claude plugin uninstall -s user speculate-autowrap
claude plugin marketplace remove speculate-mcp
```

`--client codex` uses Codex's configuration API and changes enabled, supported
**user-level** MCP registrations. Restart Codex afterward. Server names,
environment settings, and tool policies are preserved. Project-owned or
shadowed transports and unsupported helpers are reported and skipped. See
[Codex setup](getting-started.md#codex) for the supported scope.

Codex `off` restores only transport fields that still match the recorded
wrapper. It preserves unrelated later edits and reports conflicts. Neither
client's `off` deletes learned state or OAuth credentials.

`--mode strict|annotated|off` is available on `on`. The default wrapping mode is
`annotated`. Add `--codex-bin PATH` with `--client codex` to select an executable.
There is no scope flag for Codex: native writes remain user-level.

## `status`, `sync`, and `auth`

Claude Code `status` alone lists managed projects; `status .` inspects this
project. Codex `status --client codex [path]` reads base on-disk configuration
and trusted project layers in the current or selected directory, without
changing the write scope. It does not see another session's `--profile` or
`-c` overrides; see [the scope limit](getting-started.md#codex).

`sync --client codex` explicitly wraps newly added supported servers. Codex has
no auto-wrap hook. Claude Code's installed session-start hook runs `sync` for
its managed projects.

Use `auth --client codex [server]` for Codex registrations, or `auth [server]`
for Claude Code. A server name or URL selects a remote endpoint; without a
target, Codex auth visits remote servers in its user configuration. Speculate
uses its own OAuth client and does not reuse
another client's credential store. `--forget` removes Speculate's saved login.
For Codex, `--forget` requires a server name or URL and first restores managed
Codex registrations sharing that URL.

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

The agent can inspect current-session equivalents through the
`speculate__stats` tool, which also reports how stale served prefetches were and
breaks outcomes down by server and tool. CLI stats aggregate retained sessions.

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
and wrapping settings are preserved. Active sessions can continue using their
in-memory learning, but stop saving into cleared generations. Start a new
session to resume persistent learning from cleared state.

The inventory shows file size, last-save time, and counts with repeated evidence.
Those counts do not prove a call can be predicted now: fresh history, eligibility,
and admission still matter. The bare command displays default limits; use
`--config PATH` to inspect custom limits.

## `wrap`

The primitive the other commands build on, and what you can put in another MCP
client's config directly:

```bash
# stdio upstream
npx -y speculate-mcp wrap -- github-mcp-server stdio

# streamable-HTTP upstream
npx -y speculate-mcp wrap --url https://api.githubcopilot.com/mcp/ \
    --header "Authorization: Bearer ${GITHUB_TOKEN}"
```

See [Getting started](getting-started.md) for the surrounding config.

## Retired launch paths

`speculate try`, `shims install`, and `shims status` were removed in v0.20.
`speculate shims uninstall` remains to clean up an earlier installation. Legacy
`wrap --sniff -- ...` commands pass through immediately without speculation;
protocol sniffing is retired.
Use `on` or an explicit `wrap` configuration; the
[migration guide](getting-started.md#upgrading-from-retired-launch-paths)
covers existing PATH shims and saved commands.
