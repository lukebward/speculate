# Getting started

=== "Claude Code"

    ```bash
    npm install -g speculate-mcp
    speculate on
    ```

    That is the whole setup. `speculate on` re-registers this project's MCP
    servers wrapped, going through Claude Code's own `claude mcp` CLI instead of
    editing files by hand. It also installs a hook, so servers you add later get
    wrapped too.

=== "Codex"

    ```bash
    npm install -g speculate-mcp
    speculate on --client codex
    ```

    Restart Codex. Speculate wraps enabled, supported MCP servers in Codex's
    user configuration. There is no Codex auto-wrap hook; rerun `on --client
    codex` or `sync --client codex` after adding servers. See [Codex](#codex)
    below for scope and authentication.

=== "Any other MCP client"

    No install. Prefix the server command already in your client's config:

    ```js
    // before
    "github": { "command": "github-mcp-server", "args": ["stdio"] }

    // after
    "github": {
      "command": "npx",
      "args": ["-y", "speculate-mcp", "wrap", "--", "github-mcp-server", "stdio"]
    }
    ```

    Or a remote (hosted) server, which is where the latency actually is:

    ```js
    "github": {
      "command": "npx",
      "args": ["-y", "speculate-mcp", "wrap", "--url", "https://api.githubcopilot.com/mcp/",
               "--header", "Authorization: Bearer ${GITHUB_TOKEN}"]
    }
    ```

Speculate wraps remote (streamable HTTP) servers too, which is where most of the
latency lives. For servers needing OAuth, `on` can offer a browser login. Select the same
client for setup and authentication, for example `speculate auth --client codex`.

!!! info "Connectors added in the claude.ai UI are untouched"

    The host holds those, so nothing here can see them.

## Codex

```bash
speculate on --client codex
speculate status --client codex
speculate sync --client codex
speculate off --client codex
```

Native Codex support is maintained by Speculate. It uses Codex's configuration
API to wrap enabled **user-level** stdio and Streamable HTTP MCP servers. The
local CLI, desktop app, and IDE extension share MCP configuration for the same
Codex host. Restart the client after changing registrations. See
[OpenAI's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Server names, tool enable/disable policies, and environment settings are
preserved. Native setup does not install a Codex hook. Rerun `on` or `sync` with
`--client codex` when adding servers; `status --client codex [path]` inspects the
base on-disk configuration and trusted project layers for that directory. A path changes the inspection
context, not the user-level write scope. Add `--codex-bin /path/to/codex` to any
of these commands when the executable is not on PATH.

Setup and policy checks cannot observe session-only `--profile` or `-c`
overrides in another Codex process. If you rely on those overrides to restrict
MCP tools, use explicit configuration or `speculate off --client codex` until
that session context is supported.

Project-owned transports, transports shadowed across configuration layers,
remote executors, header helpers, ChatGPT session authentication, and custom
OAuth settings are reported as unsupported and skipped.
Hosted plugin or app tools outside local MCP registrations are not wrapped.
Speculate does not move these servers into a different configuration scope.

OAuth credentials belong to Speculate's own OAuth client. Existing Codex login
credentials are not reused. Authenticate and rerun setup when needed:

```bash
speculate auth --client codex
speculate on --client codex
```

`off --client codex` restores the transport fields Speculate changed, preserving
unrelated later configuration edits, learned state, and authentication. If a
changed transport no longer matches the recorded wrapper, `off` reports a
conflict instead of overwriting it.

## Keeping your token out of the file

Speculate resolves `${VAR}` in a header value from the environment at startup.
An unset variable fails at startup and names itself; Speculate never sends a
literal `${GITHUB_TOKEN}` upstream.

## What your client sees

Standard MCP: same tools, same results. Predicted reads come back from a local
buffer instead of a network round trip. Ask the agent to call
`speculate__stats` for the live hit rate, time saved, and how stale the served
prefetches were.

??? note "How auto-wrapping behaves"

    `on` installs a hook-only plugin at Claude Code's user scope, shared by every
    project. At each session start it wraps any newly added, already-approved
    servers.

    - **One session behind.** Claude Code reads MCP config before session-start
      hooks run, so a server you add now gets wrapped from your *next* session.
      It works normally meanwhile, just without prefetching.
    - **Approval never widens.** A server pending approval in `.mcp.json` stays
      pending. Revoke it, or delete the server, and the next session start
      removes the wrapped copy.
    - **Session starts include resumes and clears.** The hook runs when Claude
      Code starts, resumes, or clears a session; `speculate on` always wraps on
      the spot.
    - **Removing it everywhere:** `off` covers one project. To stop it globally,
      `claude plugin uninstall -s user speculate-autowrap`, then
      `claude plugin marketplace remove speculate-mcp`.

## Upgrading from retired launch paths

v0.20 removes PATH-shim installation, protocol sniffing, and `speculate try`.
Use `speculate on` for Claude Code, `speculate on --client codex` for Codex,
or the explicit `wrap` configuration above for another MCP client.

If an earlier version installed PATH shims, run:

```bash
speculate shims uninstall
```

Restart your shell afterward so `npx` and `uvx` resolve normally. Uninstall
support remains for migration. Saved `wrap --sniff -- ...` commands now pass
through immediately without speculation. Replace them with `wrap -- ...` only
where the launched program is an MCP server.

To evaluate Speculate, enable it with `on`, inspect `stats`, and use `off` to
restore the selected client's changed server registrations. Learning and aggregate
usage records persist normally; `speculate memory clear --all` removes managed
learning and usage records if you want to clear them afterward. See
[Commands](commands.md#memory) for custom state paths.

## Next steps

- [Commands](commands.md) — everything the CLI does
- [Safety](safety.md) — what speculation can and cannot touch
- [Configuration](configuration.md) — only if you want per-server control
