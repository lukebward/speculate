# Getting started

```bash
npm install -g speculate-mcp
speculate on
```

`on` enables both Claude Code and Codex. It wraps supported MCP servers and
installs session-start hooks that pick up new registrations. Restart your
clients afterward. In Codex, review and trust the Speculate hook through
`/hooks` before it can run automatically.

To manage one client, add `--client claude` or `--client codex`:

```bash
speculate off --client codex   # leave Claude Code enabled
speculate on --client codex
speculate off                  # disable both
```

The command is global after installation. Configuration applies to the local
client host: it does not reach another machine, hosted connectors, built-in
agent tools, or ordinary shell commands. Unsupported registrations are reported
and left alone. See the client scopes below.

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
preserved. Setup installs a user-level session-start hook for automatic sync.
Codex requires review and trust through `/hooks`; installation does not approve
the hook. See [Codex hook controls](https://learn.chatgpt.com/docs/hooks) for
trust and administrator restrictions. You can also run `sync --client codex`
directly after adding servers.
New registrations may take another session to load.
`status --client codex [path]` inspects the
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

`off --client codex` disables automatic sync, removes Speculate's hook, and
restores the transport fields Speculate changed, preserving
unrelated later configuration edits, learned state, and authentication. If a
changed transport no longer matches the recorded wrapper, `off` reports a
conflict instead of overwriting it.

## Claude Code

Claude Code setup wraps user-scope MCP servers across projects and approved
servers in known project directories. It uses Claude Code's own CLI to change
registrations. Shared `.mcp.json` files stay intact; approved entries receive
local wrapped copies. A user-level session-start hook discovers new projects
as you open them and wraps newly added, approved servers.

`off --client claude` disables automatic wrapping everywhere and restores
recorded registrations across projects. Conflicts are reported and retained
for recovery. Learning and authentication remain.

## Keeping your token out of the file

Speculate resolves `${VAR}` in `--header` values from the environment at startup.
An unset variable fails at startup and names itself. Codex static `http_headers`
are preserved literally; use its environment-backed header settings to reference
environment variables.

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
    - **Turning it off everywhere:** `speculate off --client claude` stops
      automatic wrapping and restores managed registrations across projects.

## Upgrading from retired launch paths

v0.20 removes PATH-shim installation, protocol sniffing, and `speculate try`.
Use `speculate on` for both clients, select one with `--client claude` or
`--client codex`, or use explicit `wrap` configuration for another MCP client.

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
