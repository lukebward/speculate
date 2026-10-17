# Getting started

Speculate is a Claude Code mod. It runs inside Claude Code and needs nothing
else: no proxy, no wrapped server configuration, no separate process.

## Install

Requires Claude Code 2.1.296 or later. In a terminal session:

```
/plugin install speculate --marketplace lukebward/speculate
```

Answer `y` to add the marketplace, then choose the user scope so Speculate runs
in every project. It is active in that session at once, and in every session
after.

### From npm

Requires Node.js 18 or later:

```bash
npm install -g speculate-mcp
speculate install
```

`speculate install` registers the installed package as a plugin marketplace
and installs the mod from it for every project. Claude Code reads the mod
straight from the package folder, so `npm update -g speculate-mcp` updates it;
run `/reload-plugins` in an open session to pick up a change. Run through
`npx`, which keeps packages in a cache, it installs from GitHub instead.

To try it without installing, start a session with a local checkout:

```bash
git clone https://github.com/lukebward/speculate
claude --plugin-dir ./speculate
```

## What to expect

Speculate learns from the MCP calls Claude makes, so the first session with a
server mostly teaches it. From then on:

- after a read, the reads that usually follow it start in the background;
- a prompt that names a read outright, such as reviewing a GitHub pull request
  by URL or listing a directory, starts that read before the model asks;
- a session's usual opening reads start when its first prompt arrives.

Only tools that have already run read-only, and that your permission settings
already allow without asking, are ever prefetched. A tool that always prompts
for permission is never touched. To let Speculate help with a server, allow
its read tools in `/permissions` (for example `mcp__github__get_issue`).

## Check that it helps

```
/speculate
```

This reports, for this session and across sessions, how many calls were served
from a prefetch, how many prefetches were wasted, the estimated time saved
(net of any wait behind a prefetch), and how often the first prediction was
right. While calls are being served, the status line shows a running count.

Waste is real work against your servers. If `/speculate` shows mostly waste in
your workflow, Speculate is not paying for itself there; disable it with
`/plugin disable speculate`.

## Forget, disable, uninstall

```
/speculate forget            # delete everything learned, and the totals
/plugin disable speculate    # stop it, keep what it learned
/plugin uninstall speculate  # remove it
```

Installed from npm, `speculate uninstall` removes the mod and its marketplace,
and `npm uninstall -g speculate-mcp` removes the command.

## Upgrading from 0.x

Versions up to 0.25 wrapped MCP server registrations, in Claude Code and in
Codex, so each server launched through Speculate's local proxy. Upgrade with:

```bash
npm install -g speculate-mcp
speculate install
```

`speculate install` finds registrations 0.x wrapped and restores them with
0.25's own `off` (`npx speculate-mcp@0.25.0 off`, which handles every scope and
both clients and leaves later edits alone). It then removes 0.x's auto-wrap
plugin and installs the mod. If a registration is still wrapped afterwards
(0.x kept no record of it), the command lists it.

Until then nothing breaks: a local server 0.x wrapped keeps starting through
the 1.0 package, which now runs its original command as a plain pass-through.
A remote server 0.x wrapped cannot be passed through; it reports the restore
command when Claude Code tries to start it. Learning from 0.x is not carried
over; the mod relearns from Claude Code's own calls.
