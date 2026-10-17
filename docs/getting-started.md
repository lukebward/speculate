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

## Upgrading from speculate-mcp

Versions up to 0.25 were an npm package, `speculate-mcp`, that wrapped MCP
server registrations in a local proxy. Before removing it, run the old CLI's
`speculate off` so it restores the registrations it wrapped:

```bash
speculate off
npm uninstall -g speculate-mcp
```

Then install the mod as above. Learning from the old package is not carried
over; the mod relearns from Claude Code's own calls.
