# Commands

| Command | What it does |
|---|---|
| `speculate on` | Wrap this project's MCP servers, and keep new ones wrapped |
| `speculate off` | Restore this project exactly, and stop auto-wrapping it |
| `speculate status` | What is wrapped here, what needs a login, and what changed since `on` |
| `speculate auth [server]` | Log in to remote servers that need it (`--forget` to undo) |
| `speculate stats` | Cumulative time saved, hit rate, and waste (`--json` for scripts) |
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

Cumulative time saved, hit rate, and waste. `--json` for scripts.

The same numbers are available to the agent mid-session as the
`speculate__stats` tool, which also reports how stale the served prefetches
were.

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
