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

## Measured

In paired real sessions against two hosted MCP servers, with Speculate off
and on (Claude Code 2.1.330, Claude Haiku 5.5, six warm pairs per workload,
one day):

- When sessions repeated a scripted workflow, the median time a session
  waited on tools fell 40% on Microsoft Learn (2.1 s to 1.3 s) and 61% on the
  Hugging Face Hub (420 ms to 162 ms), in every pair.
- When every session asked about a new subject, no call was served. On the
  Hub, which answers in about 70 ms, sessions then waited longer on tools
  with Speculate than without.
- An ordinary question asked again came out between those two, from a large
  gain to a loss, depending on whether the model made the same calls again.
- Session time did not measurably change. Tools were at most a fifth of a
  session; the model was the rest.
- Speculate's hooks add about 9 ms to a call it does not answer.
- Hit rate, the share of the model's calls answered from a prefetch, was 67%
  and 100% on the scripted workflow, 56% and 17% on the repeated question,
  and 0% on new subjects. Of the prefetches started, 65% were used.
- The last proxy release (0.25.0), run in the same sessions, did better on
  the scripted workflow: a 100% hit rate on both servers and 96% and 77% less
  tool wait. Its predictor was no more accurate. Run side by side on one
  workload, it started 58 prefetches to Speculate's 27 and used 64% of them
  to Speculate's 89%.

Both servers answer in well under a second. Nothing was measured on a server
that takes seconds per call. The
[benchmark guide](https://lukebward.github.io/speculate/design/local-learning-benchmark/)
has the method, the costs, and the limits.

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
  prefetched from that server. A shell command, a file edit, or any other
  built-in call that Claude Code does not report read-only flushes everything
  prefetched from every server.

See [safety and storage](https://lukebward.github.io/speculate/safety/) for the
full rules and what is stored on disk.

## Limits

- It covers MCP tools only. Built-in tools such as Bash and Read are not
  prefetched.
- A tool that returns structured content is never prefetched. Claude Code
  hands such a result to a mod as text, and Speculate serves only results it
  can hand back in the form they came. The search tool of Microsoft Learn is
  one.
- PostToolUse hooks do not run for a served call, because no tool ran. They do
  run for the prefetch that produced it. A PostToolUse hook whose matcher names
  a specific tool keeps that tool out of speculation entirely.
- Where an organization manages Claude Code, installed plugins cannot hook
  PreToolUse, so Speculate can never answer a call. Once two calls in a row
  that it held an answer for have run anyway, it turns itself off for the
  session, and `/speculate` says so. Every call runs as usual.
- A prefetch still in flight when the model asks is waited for only if the
  tool's usual latency says it will land within about eight seconds. A slower
  read is left to run as a normal call.
- An unused prefetch is an extra upstream read. It costs server time and may
  cost quota. `/speculate` shows the waste, so you can see whether Speculate
  pays for itself in your workflow.

## Documentation

- [Getting started](https://lukebward.github.io/speculate/getting-started/): install, check it works, uninstall.
- [Safety and storage](https://lukebward.github.io/speculate/safety/): eligibility, permission and hook handling, what persists.
- [Design](https://lukebward.github.io/speculate/design/): how learning and prefetching work.
- [Benchmarks](https://lukebward.github.io/speculate/design/local-learning-benchmark/): what was measured in real sessions against hosted MCP servers, how, and what was not.
- [Contributing](CONTRIBUTING.md): tests, the mod's test kit, the offline evaluation, and the live benchmark.

[MIT license](LICENSE)
