# Speculate

[![npm](https://img.shields.io/npm/v/speculate-mcp)](https://www.npmjs.com/package/speculate-mcp)
[![CI](https://github.com/lukebward/speculate/actions/workflows/ci.yml/badge.svg)](https://github.com/lukebward/speculate/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/lukebward/speculate)](LICENSE)

Speculate is a Claude Code mod that cuts the time Claude spends waiting on MCP
tools. It learns which read-only calls tend to follow which, starts the likely
next call while the model is still thinking, and answers the model's call from
that result when it asks for exactly the same thing.

Nothing is wrapped or proxied. Speculate runs inside Claude Code, uses Claude
Code's own MCP connections, and leaves every call it does not answer exactly as
it was.

## Install

Requires Claude Code 2.1.296 or later. In a terminal session:

```
/plugin install speculate --marketplace lukebward/speculate
```

Answer `y` to add the marketplace and choose the user scope. Or install from
npm (Node.js 18 or later):

```bash
npm install -g speculate-mcp
speculate install
```

Either way, Speculate starts working in that session (run `/reload-plugins`
in one already open) and needs no configuration. With npm, Claude Code runs
the mod from the installed package, so `npm update -g speculate-mcp` updates
it.

**Upgrading from 0.x.** Speculate 0.25 and earlier wrapped your MCP server
registrations in a local proxy. `speculate install` restores them first, using
0.25's own `off`, and removes 0.x's auto-wrap plugin. Until you run it,
servers that 0.x wrapped keep working through a plain pass-through.

## What it does

- **Learns from real calls.** Every MCP call the model makes runs through
  Claude Code as normal. Speculate learns transitions, such as `list_issues`
  followed by `get_issue` for a number from that list.
- **Prefetches likely reads.** After a call, Speculate starts the most likely
  next reads through Claude Code's own connection to the server. It also does
  this when your prompt names a read outright ("review
  https://github.com/acme/api/pull/7") and when a session starts with its
  usual first reads.
- **Answers exact matches.** When the model then asks for a call with the same
  server, tool and arguments, the result is already there or on its way.
  Anything else runs normally.

Run `/speculate` to see what was served, what was wasted, and the estimated
time saved, for this session and across sessions. `/speculate forget` clears
everything Speculate has learned.

## Safety

- **Reads only, by the host's verdict.** A tool is a candidate only after a
  real call through Claude Code reported it read-only. Claude Code takes that
  from the server's `readOnlyHint`. Speculate never prefetches a tool it has
  not seen run, or one that reported otherwise.
- **Only calls you already allow.** A prefetch starts only when your
  permission settings would run that exact call without asking. Speculate
  checks again when the result arrives and again before it answers. It never
  causes a permission prompt.
- **Your PreToolUse hooks still decide.** A served call goes through your
  PreToolUse hooks first. If a hook denies, asks, or rewrites the call, it runs
  exactly as it would have without Speculate. Prefetches are real calls, so
  your hooks see them too.
- **Exact bytes, once, briefly.** A served result is exactly what the server
  returned for that call. It is used at most once and kept for at most 30
  seconds, in memory only. Any call that is not read-only flushes everything
  prefetched from that server.

See [safety and storage](https://lukebward.github.io/speculate/safety/) for the
full rules and what is stored on disk.

## Limits

- It covers MCP tools only. Built-in tools such as Bash and Read are not
  prefetched.
- PostToolUse hooks do not run for a served call, because no tool ran. They do
  run for the prefetch that produced it. A PostToolUse hook whose matcher names
  a specific tool keeps that tool out of speculation entirely.
- Where an organization manages Claude Code, installed plugins cannot hook
  PreToolUse. Speculate then still prefetches and learns, but it never answers
  a call. Every call runs as usual.
- An unused prefetch is an extra upstream read. It costs server time and may
  cost quota. `/speculate` shows the waste, so you can see whether Speculate
  pays for itself in your workflow.

## Documentation

- [Getting started](https://lukebward.github.io/speculate/getting-started/): install, check it works, uninstall.
- [Safety and storage](https://lukebward.github.io/speculate/safety/): eligibility, permission and hook handling, what persists.
- [Design](https://lukebward.github.io/speculate/design/): how learning and prefetching work, with benchmark history.
- [Contributing](CONTRIBUTING.md): tests, the mod's test kit, and the offline evaluation.

[MIT license](LICENSE)
