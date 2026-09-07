# Plugin wrap: the fifth row becomes reachable

**Date:** 2026-08-05 · **Status:** implemented · **Branch:** `claude/plugin-wrapping-mechanism-rnr8ta`

## Problem

DESIGN.md §13.23 records a fifth category of MCP server Speculate cannot
wrap: servers a Claude Code **plugin** declares, registered by the host as
`plugin:<plugin>:<server>`. They include exactly the high-latency hosted
HTTP population Speculate exists for (`plugin:github:github`,
`plugin:sentry:sentry`), and §13.23 closes with "wrapping them needs a
mechanism that does not exist yet". This spec is that mechanism.

The blocker was never discovery — the declarations are readable files — it
was that every insertion point looked wrong:

- The plugin cache is **host-owned**: an edit to
  `<cache>/<plugin>/<version>/.mcp.json` is reverted on plugin update and
  desyncs the plugin's checkout (§13.23).
- A wrapped copy registered at user/local scope does **not** shadow the
  plugin entry: name-precedence (`local > project > user`) never applies,
  because the plugin server's name is `plugin:x:y` and a plain entry cannot
  carry that name. Both run; the tool list doubles — the aggregator shape
  §13.12 explicitly rejected.

## Measured mechanism (Claude Code 2.1.222, this container; corroborated on
macOS by the original investigation — do not redesign around it)

| Question | Result |
|---|---|
| Where are installed plugins recorded? | `<configDir>/plugins/installed_plugins.json`, `{version: 2, plugins: {"<plugin>@<marketplace>": [{scope, installPath, version, …}]}}` |
| Where is enablement recorded? | `settings.json` `enabledPlugins` map, `"<plugin>@<marketplace>": true/false`. `claude plugin disable` writes `false` and the plugin's servers drop out of `claude mcp list` entirely |
| Where are the server declarations? | `<pluginRoot>/.mcp.json` (bare map or `mcpServers`-wrapped) or `plugin.json`'s `mcpServers` (inline map, or a string path) |
| What does `${CLAUDE_PLUGIN_ROOT}` expand to? | The plugin root, substituted per-element in `command`/`args`/`env`/`url`/`headers`. For a **directory-sourced** marketplace the live source directory wins over the cache `installPath` (measured: edits to the source `.mcp.json` take effect; the cache copy is ignored) |
| What else does the host expand? | `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_DATA}`, and plain `${VAR}` from the session environment. It also **injects** `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` as real env vars into stdio plugin children |
| Can one plugin server be disabled? | Yes: the per-project `disabledMcpServers` array in `~/.claude.json`'s project record, holding plugin-qualified names. The host's own `/mcp` UI writes exactly this key; **no CLI writes it**. Verified in the shipped bundle: every connect path checks it (`type: "disabled"`, no launch), and disabled servers are excluded from endpoint dedup. `claude mcp list` still *enumerates* a disabled server — list is not launch |
| Does endpoint dedup suppress a wrapped copy? | No. Plugin dedup matches by endpoint (URL / command line); a wrapped copy is a `speculate wrap` stdio invocation, a different endpoint by construction. That is why the disable is required, not optional |

## Decision

Extend the shadow pattern `on` already uses for `.mcp.json` servers, with
the disable standing in for name-precedence:

1. **Register a wrapped copy at LOCAL scope** through the front door
   (`claude mcp add-json <bareName> … -s local`), named after the plugin
   server's bare name (`plugin:github:github` → `github`). Name taken by
   any existing server, at any scope: **skip**, with a reason — never
   fight over a name.
2. **Disable the original** by adding its qualified name to the project
   record's `disabledMcpServers` array — a surgical read-merge-write of
   that one key in `~/.claude.json`, the first and only place Speculate
   edits a host file directly (see "The invariant amendment" below).
3. **Record** the pair in managed state (`action: 'pluginShadowed'`,
   `pluginServer: '<qualified name>'`), and stamp the copy's env with
   `SPECULATE_PLUGIN_ORIGIN=<qualified name>` so the copy is
   self-describing even with the state file lost.

Order is load-bearing, in both directions:

- **Wrap: copy first, then disable.** A crash between the two leaves both
  running — duplicated tools for one session, self-healed when the next
  pass adopts the marked copy and completes the disable. Disable-first
  would leave the server *gone* on a crash.
- **Restore: re-enable first, then remove the copy.** The mirror image,
  for the mirror reason: a crash leaves both running, never neither.

`off` reverses via the managed record; the no-state fallback recognizes
the `SPECULATE_PLUGIN_ORIGIN` marker, removes the copy AND the disable
entry, and never re-adds an unwrapped copy at local scope (that would leak
a plain clone of a plugin server the plugin should own).

## The invariant amendment (deliberate, narrow, documented)

§13.12's rule — "every mutation is a `claude mcp remove`/`add-json`
invocation, never a JSON edit" — cannot produce a disable: no host CLI
writes `disabledMcpServers`. The choice was: break the letter of the
invariant narrowly, or leave the fifth row permanently unwrapped (the
upstream seam §13.12 pitched remains the durable endgame; it does not
exist today).

The amendment is scoped to keep the invariant's *purpose* intact:

- **One key only.** Speculate writes the `disabledMcpServers` array of the
  current project's record — the same key, in the same shape, that the
  host's own `/mcp` toggle writes. Nothing else in the file is touched.
- **In the user's own `~/.claude.json`**, never a teammate-visible file.
- **Read-merge-write, atomically.** Re-read immediately before writing,
  mutate the one array, write tmp + rename (same discipline as
  `managed.json` and sync's state merge). The write joins entries and
  removes only the exact entry it added.
- **Never create identity.** If the project record does not exist, the
  write fails cleanly and the wrap is rolled back — the record always
  exists by then anyway, because the front-door `add-json` that registered
  the copy creates it.
- **Exact restore.** `off` removes exactly the entry `on` added; a
  pre-existing user disable is never touched (and blocks wrapping — see
  consent).

## Discovery (`src/pluginServers.ts`, pure read)

Mirrors `hostConfig.ts`'s stance: read the host's files, never write,
fail soft with warnings. Reads, per project:

- `settings.json` (user) + `<repoRoot>/.claude/settings.json` +
  `settings.local.json` + the platform's managed (admin) settings:
  `enabledPlugins`, merged the way the host merges them — **most specific
  wins** (measured: user-level `false` plus project-level `true` loads the
  plugin), managed settings above everything. A plugin needs an **explicit
  `true`** somewhere: installed-but-unlisted is NOT loaded by the host
  (also measured), so treating it as enabled would wrap a server the user
  never had running.
- `plugins/installed_plugins.json`: installs per plugin key; a
  project-scoped install record whose `projectPath` is a different project
  is ignored.
- `plugins/known_marketplaces.json` + the marketplace's
  `.claude-plugin/marketplace.json`: for a directory-sourced marketplace,
  the live source directory is the plugin root (measured behavior);
  otherwise the recorded `installPath`. A candidate root must actually
  hold a manifest, or the next candidate is tried; no root, no server.
- The root's `.mcp.json` (bare or wrapped form) or `plugin.json`
  `mcpServers` (inline or string path).
- The project record's `disabledMcpServers` array.

Interpolation at discovery time: `${CLAUDE_PLUGIN_ROOT}` → root,
`${CLAUDE_PROJECT_DIR}` → repo root, across `command`/`args`/`env`/`url`/
`headers`. Everything else is fail-closed:

- A **stdio** entry still carrying any `${…}` placeholder after that is
  skipped with a reason. The host expands `${VAR}` from the session
  environment at launch; a wrapped copy would pass the literal through,
  and resolving it ourselves would bake a secret into config. (HTTP
  `headers` keep their `${VAR}` placeholders — the existing wrap machinery
  resolves those at launch, same contract as v0.14.)
- An entry referencing `${CLAUDE_PLUGIN_DATA}` or `${user_config.*}` is
  skipped: Speculate cannot reproduce the host's expansion.
- An entry with a `headersHelper` is skipped: the wrapped proxy cannot run
  the host's dynamic-header hook.

A wrapped stdio copy replicates the host's env injection of
`CLAUDE_PLUGIN_ROOT`. `CLAUDE_PLUGIN_DATA` is NOT replicated (derivation
unknown) — a stdio plugin server whose *code* reads that env var is a
documented limitation.

## Consent, in both directions

- **A user's own disable blocks wrapping.** A qualified name already in
  `disabledMcpServers` with no managed record claiming it is the user's
  choice; the server is skipped entirely and the entry is never removed.
- **A disabled plugin contributes nothing.** `enabledPlugins: false`, or
  no install record, means no discovery, no wrap — and an existing wrap
  loses its licence (below).
- **The licence-gone rule** (§13.12's revoked-shadow rule, third
  instance): a managed plugin wrap whose plugin server is no longer
  present-and-enabled — plugin uninstalled, disabled, or the server gone
  from its manifest — is removed: re-enable (drop our disable entry),
  remove the copy, drop the record. Gated on the managed record AND the
  entry still being a Speculate wrap; with the state lost, the
  `SPECULATE_PLUGIN_ORIGIN` marker is the fallback proof of ownership.
- **Drift refresh:** a plugin update changes the versioned root, so the
  wrapped copy's baked paths go stale. The managed pass re-wraps a copy
  whose invocation no longer matches the current declaration (remove +
  add-json, never remove without replacement).
- **Remote plugin servers pass the same probe** (`remoteWrapBlocker`):
  wrap only on a definite yes, `needsAuth` flows into the same
  `speculate auth` offer, and an unauthorized server is always left
  working and unwrapped.

## Sync and the hash

`readClaudeServers` now carries `pluginServers` and `disabledMcpServers`
on the view, and `effectiveServerHash` folds in each plugin server
(qualified name + canonicalized interpolated entry) plus the sorted
disable list. This is the same argument that put shadowed `.mcp.json`
entries in the hash: without it, installing, updating, disabling, or
un-disabling a plugin is invisible to sync's fast path forever. The wrap
pass runs inside `wrapEffectiveServers`, so plugin wrapping inherits
sync's lock, budget/deadline, read-merge-write state discipline, and
one-line reporting — and the one-session lag, which applies unchanged.

## Costs, stated

- **Tool names change**: `mcp__plugin_github_github__*` becomes
  `mcp__github__*` (the copy's bare name). Permission rules keyed to the
  old prefix stop matching. Inherent to proxying (§3.4), now with a
  rename attached.
- **Per-project**, like everything `on` touches: the disable is
  per-project, so the copy is registered at local scope per project, and
  other projects pick it up via auto-wrap's per-session sync.
- **`claude mcp list` still shows the disabled original** (list ≠ launch);
  `speculate status` explains the pair.
- **`speculate try` ignores plugin servers** in v1: the trial's
  `--strict-mcp-config` behavior toward plugin servers is unverified, and
  a wrapped copy there could double every tool list. They simply run
  unwrapped during a trial.

## Non-goals

- Wrapping claude.ai connectors (row 4 — closed, §13.22).
- Editing anything under the plugin cache, ever.
- Replacing the upstream pitch (§13.12): a host-provided wrapper seam
  would delete the invariant amendment; this design keeps working until
  then and is strictly removable.

## Testing

- Discovery: fixture config dirs covering bare/wrapped `.mcp.json`,
  `plugin.json` inline and string-path forms, v2 `installed_plugins`,
  directory-source root preference, disabled plugins, interpolation, the
  three fail-closed skips, and the disable list read.
- Manage: fakeRunner round trips — wrap (copy then disable, exact JSON),
  collision skip, user-disable skip, rollback when the disable write
  fails, `off` restore order (enable then remove), licence-gone removal,
  drift refresh, crash-recovery adoption of a marked copy, stateless-net
  handling of marked copies (remove + un-disable, never re-add).
- Hash: plugin server changes and disable-list changes move it; the
  fast path stays byte-cheap.
- Suite green on the CI matrix; no test touches a real host or network.
