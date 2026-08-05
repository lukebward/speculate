# Feature request: a host-provided MCP server wrapper seam

**Status:** drafted 2026-08-05, ready to file against `anthropics/claude-code`.
Verified against Claude Code 2.1.222: no wrapper/middleware seam exists in the
shipped host (`mcpCommandWrapper`, `commandWrapper`, `mcpMiddleware`,
`serverWrapper`, `mcpProxy` — zero hits in the bundle; the plugin manifest's
capability surface is `commands` / `agents` / `hooks` / `mcpServers` /
`skills`).

Everything below the line is the issue body, written to stand alone.

---

## Feature request: let a tool sit between Claude Code and its MCP servers

**A one-line summary:** a supported way to say "launch/connect my MCP servers
*through this command*" — either a settings key (`mcpCommandWrapper`) or a
plugin capability (`mcpMiddleware`) — so protocol middleware (caching,
speculative prefetch, observability, security gateways) can exist without
rewriting the user's server config.

### The problem

MCP is the one layer of the agent stack every tool call passes through, and
it has no middleware seam. A tool that wants to sit between Claude Code and
an MCP server — to cache, prefetch, trace, rate-limit, or policy-check — has
exactly one insertion point today: **rewrite the user's server config so the
entry launches the middleware instead of the server**. We built
[Speculate](https://github.com/lukebward/speculate), a speculative-prefetch
proxy, on that insertion point, and this issue is a field report of what it
costs. Each mechanism below exists in shipped code, each behavior was
measured against the real CLI rather than assumed, and every one of them
disappears the day a host seam exists.

### What the absence of a seam forced us to build

1. **Config rewriting through the front door.** `speculate on` re-registers
   every user/local-scope server wrapped in place via `claude mcp remove` +
   `claude mcp add-json`, recording originals for exact restore. This is
   inherently non-transactional (a kill between remove and add-json loses
   the server; we carry restore state and crash-recovery passes to
   compensate).

2. **Shadow copies for project servers.** `.mcp.json` is checked in and
   shared, so it must never be edited; we register a wrapped copy at local
   scope and accept the "conflicting scopes" diagnostic. Consent tracking
   (the host's per-project approval records) has to be re-derived and
   re-checked on every pass so an unapproved server is never wrapped.

3. **Plugin-declared servers need a disable no CLI writes.** Servers from
   plugins (`plugin:github:github` …) cannot be shadowed by name (their
   namespace is unreachable from plain entries) and endpoint dedup ignores
   a wrapped copy (different command line). The only mechanism that exists
   is the per-project `disabledMcpServers` array in `~/.claude.json` — the
   key the `/mcp` screen writes and **no CLI does** — so a wrapper is forced
   to edit a host-owned file directly. We do it as a surgical
   read-merge-write of that one key, with ordering rules so a crash never
   leaves a server gone, but it is the one place our "mutate only through
   the host's own CLIs" invariant had to be amended.

4. **Auto-wrap needs a hook and inherits a one-session lag.** New servers
   should get wrapped without the user re-running anything, so we ship a
   user-scope plugin whose SessionStart hook runs a sync command. Measured:
   the host snapshots MCP config *before* SessionStart hooks run, so a wrap
   can never take effect in the session that performs it — everything is
   permanently one session behind. The hook layer also inherits every
   GUI-launch fragility (a dock-launched app's minimal PATH resolves neither
   `node` nor `claude`; we now bake absolute paths with shell fallback
   chains, but none of that machinery should need to exist).

5. **Tool identity changes underneath the user.** A wrapped server is a
   different server to the host, so permission rules keyed
   `mcp__github__*` or `mcp__plugin_github_github__*` silently stop
   matching after wrapping. Only the host can wrap a server *while keeping
   its identity*.

6. **claude.ai connectors are unreachable, permanently.** They have no
   local config entry to rewrite, so no config-side mechanism can ever
   cover them (measured: a hook can call a connector with the host's auth,
   but its result never reaches the model, and connectors are fetched after
   SessionStart hooks run). A host-side seam is the only design that could.

### The ask

Either shape works; both are strictly host-side and change nothing for
users who don't opt in.

**Option A — a settings key** (smallest possible surface):

```jsonc
// settings.json (user / project / local / managed — normal precedence)
{
  "mcpServerWrapper": {
    "command": ["speculate", "wrap", "--sniff", "--"],
    "servers": "*",            // or an allowlist / denylist of server names
    "fallback": "direct"       // wrapper missing or failing to spawn → launch the server directly
  }
}
```

Semantics: for each configured MCP server the wrapper applies to, the host
launches the wrapper command and hands it the original server definition —
append the original command line after the `--` for stdio servers, and pass
the full original entry (URL, headers, transport) over stdin or an
environment variable rather than argv for remote ones, since headers carry
credentials. The host keeps the server's name, tool prefixes, permission
identity, and consent state exactly as they are; the wrapper is a transport
detail.

**Option B — a plugin capability** (composes with the plugin ecosystem):

```jsonc
// plugin.json
{
  "name": "speculate",
  "mcpMiddleware": {
    "command": "${CLAUDE_PLUGIN_ROOT}/bin/wrap --sniff --",
    "servers": "*"
  }
}
```

Same launch semantics; installing/enabling the plugin is the consent
gesture, uninstalling it removes the seam, and two middlewares could chain
in plugin-load order if the host ever wants that.

### Why this is safe to offer

- **Over-wrapping is harmless by construction.** Our wrapper's entry point
  is a protocol sniffer: the first line of stdin decides MCP (run the
  proxy) versus anything else (become a byte-transparent pipe, exit codes
  and signals forwarded). A wrapper applied too broadly degrades to a pipe;
  MCP clients send `initialize` immediately, so real sessions decide on the
  first line, not a timeout. Any wrapper can adopt the same contract, and
  the host could require it ("must forward a non-MCP byte stream
  unchanged").
- **`fallback: "direct"` keeps sessions alive** when the wrapper is
  uninstalled or broken — the failure mode is "no middleware", never "no
  servers".
- **Consent stays where it is.** The host still enforces approvals,
  `disabledMcpServers`, managed policy, and permission rules against the
  same server identities as before. The wrapper never gains access it
  didn't already have as a process the user configured; for stdio children
  the credentials stay in the child's env exactly as today.
- **Everything is observable.** The host knows a wrapper is configured and
  can label it in `/mcp` and `claude mcp list` — unlike today, where a
  wrapped config entry is indistinguishable from a hand-edited one.

### What it unlocks

Speculative prefetching is our use case (measured 46–85 % tool-wait
reductions against hosted MCP servers once warm — numbers and methodology in
the repo), but the seam is generic: org-wide security/policy gateways,
tracing and cost observability, response caching, failover — the middleware
layer every mature protocol grows. Today each of those tools must reinvent
the config-rewriting machinery above, and each copy of it carries the same
crash windows and consent hazards. One host seam retires the whole
category.

### References

- Implementation and measurements: https://github.com/lukebward/speculate —
  `DESIGN.md` §13.12 (config-rewrite mechanism), §13.22 (connector
  unreachability, measured), §13.23/§13.26 (plugin servers and the
  `disabledMcpServers` write), §13.27 (hook fragilities on GUI-launched
  hosts), v0.12 notes (the measured one-session lag).
- The sniffing pass-through that makes over-wrapping safe:
  `src/wrap.ts` / DESIGN.md §13.12 mechanism 1.
