# Auto-wrap: pick up newly added MCP servers automatically

**Date:** 2026-08-02 · **Status:** approved (Luke, in-session) · **Branch:** `auto-wrap` (off `focus-mcp`)

## Problem

`speculate on` wraps the MCP servers present in the host config at the moment
it runs. A server added afterwards stays unwrapped until the user runs `on`
again. Today the only signal is `speculate status`, which counts unwrapped
servers and prints "N server(s) added since 'speculate on' — run it again to
wrap them". The `shims` feature would close this, but it is opt-in, edits a
dotfile, and is POSIX-only, so it does not exist for Windows users.

## Measured constraint (do not redesign around it)

Tested 2026-08-02 on Windows with an isolated `CLAUDE_CONFIG_DIR`:

| Question | Result |
|---|---|
| Does a `SessionStart` `command` hook fire? | Yes, before auth completes |
| Does `claude mcp add-json` work from inside that hook? | Yes ("Added stdio MCP server specprobe to local config") |
| Does the current session pick up the change? | **No.** The added server never launched |
| Does the next session? | **Yes.** It launched |

Claude Code snapshots MCP config *before* running `SessionStart` hooks. A
**one-session lag is therefore inherent** and no hook can remove it. A newly
added server runs unwrapped (working normally, just without speculation) for
one session, then wrapped from the next. The design states this plainly to the
user rather than hiding it.

## Decision

A **user-scope plugin shipping exactly one `SessionStart` hook**, which runs a
new **`speculate sync`** command.

- Plugin, not a `settings.json` edit: hooks have no CLI, and a plugin installs
  and uninstalls through `claude plugin`, preserving Speculate's rule that host
  config is only ever touched through the host's own CLIs.
- Plugin id **`speculate-autowrap`**, deliberately distinct from the retired
  `≤0.10` `speculate` plugin.
- User scope: one install covers every project, which is the only variant that
  actually delivers automatic pickup.
- Ships **only** the hook. No Bash interception, nothing resembling the CLI
  speculation tier removed in 0.11.

## Components

### 1. `speculate sync` (new command)

Distinct from `on` because it runs unattended on every session start: fast,
quiet, non-interactive. It reuses `on`'s wrap logic and inherits every consent
guarantee unchanged:

- unapproved `.mcp.json` (project-scope) servers are skipped (`manage.ts`
  approval gate)
- already-wrapped entries are skipped (`isWrappedEntry`)
- non-stdio entries are passed through (`isStdioEntry`)
- server names beginning with `-` are skipped

It does **not** perform legacy `≤0.10` cleanup, install plugins, or anything
requiring a decision.

Output: silent when nothing changed. When it wraps servers, one line naming
them plus the lag, e.g.
`[speculate] wrapped 1 new server (github); speculation active next session`.

### 2. Fast no-op path (what makes a per-session hook viable)

The hook fires on every session start, so the unchanged case must cost
near-zero and spawn no subprocess.

`sync` reads the config files directly and hashes the effective server set
(names plus command lines). If the hash equals the stored one, it exits
immediately. Only a changed hash triggers `claude mcp add-json` calls.

The hash is stored **per project**, keyed by cwd, because the effective server
set differs per project (user-scope and project-scope servers combine
differently). A single global hash would give wrong answers in every repo but
the most recently opened one. Stored alongside the existing managed state.

### 3. Per-project opt-out (resolves the `off` conflict)

A global hook plus a per-project `off` conflicts: `off` unwraps, the hook
re-wraps at the next session start, and `off` becomes a no-op that lasts until
restart.

Therefore: `off` records a per-project opt-out in the managed state, and `sync`
skips any project on that list. `on` in that project clears it. `off` continues
to leave the plugin installed and reports that auto-wrap remains active
globally, naming the command to remove it.

### 4. The plugin

`hooks/hooks.json` with a single entry: `SessionStart`, `matcher: "startup"`,
`type: "command"`.

The command is an **absolute** `node <abs>/dist/src/cli.js sync` baked at
install time, not `speculate sync`. Two reasons: Claude Code's exec-form hooks
reject `.cmd` shims on Windows (npm installs `speculate` as one), and an
absolute path survives PATH changes and Node version switches.

Installed at user scope by `speculate on` via `claude plugin install`.

## Failure handling

| Risk | Handling |
|---|---|
| Hook hangs, blocking session start (hooks are synchronous) | Hard 5s cap on the whole run; expiry is treated as success. A slow day never costs a session. |
| Concurrent sessions racing on the global `~/.claude.json` (read-modify-write via `claude mcp add-json`) | Lock file with a stale-lock timeout. The loser exits quietly and picks it up next session, which costs nothing given the lag is already one session. |
| `on` uninstalling the plugin it just installed (`cleanupLegacyArtifacts` hunts plugins matching `speculate`; the adversarial review already caught that matcher being too loose once) | `speculate-autowrap` explicitly excluded from legacy matching. Regression test: run `on` twice, assert the plugin survives. |
| Speculate uninstalled, plugin left behind | Hook exits 0 silently when the target file is absent, rather than erroring on every launch forever. |
| Nested wrapping (proxy of a proxy) | Reuses the existing `isWrappedEntry` guard; explicit test because `sync` is a new caller. |
| Any other `sync` failure | Fail-open and silent: never block, never noise. Diagnosis stays with `speculate status`. |

## Consent note (accepted, stated deliberately)

User scope means opening a brand new repo wraps its servers without the user
running `speculate on` there. That is the intended behavior. The `.mcp.json`
approval gate still holds, so unapproved servers from a fresh clone are still
skipped, and Speculate still never widens consent.

## Non-goals

- Removing the one-session lag (measured as impossible via hooks).
- A `ConfigChange` hook to catch mid-session additions. It would close the lag
  in the common case but adds a second trigger and loop risk; revisit only if
  the lag proves annoying in practice.
- Removing or replacing `shims` (separate decision).
- Any change to the speculation engine, profiles, or the learner.

## Testing

- `sync` unit tests against the existing fake-runner: unchanged config is a
  no-op with zero runner calls; a new server is wrapped; an unapproved
  `.mcp.json` server is skipped; an opted-out project is skipped; an
  already-wrapped server is untouched.
- Per-project hash: two projects with different effective sets do not
  invalidate each other.
- Lock: a held lock makes `sync` exit quietly without mutating config.
- Timeout: a slow runner makes `sync` give up within the cap and exit 0.
- `on` twice leaves `speculate-autowrap` installed (the self-uninstall guard).
- `off` records the opt-out; a following `sync` is a no-op; `on` clears it.
- Windows: the generated hook command is an absolute `node` invocation, never a
  bare `speculate`.
- Full suite green on the CI matrix (ubuntu/macos/windows).
