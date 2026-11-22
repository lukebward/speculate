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
  next reads through Claude Code's own connection to the server. Where the
  model has run reads on a server together, it starts them together.
- **Reads your prompt for the subject.** The first call of an exchange takes
  its arguments from your words. After two prompts that named a subject the
  same way ("read issue 41", a pull request link, a file path), Speculate
  starts the read of the third while the model is still reading the prompt.
  A session's usual first reads start the same way.
- **Answers exact matches.** When the model then asks for a call with the same
  server, tool and arguments, the result is already there or on its way.
  Anything else runs normally.

Run `/speculate` to see what was served, what was wasted, and the estimated
time saved, for this session and across sessions. `/speculate forget` clears
everything Speculate has learned.

## Measured

In paired real sessions with Speculate off and on (Claude Code 2.1.330,
Claude Haiku 5.5, four to six warm pairs per workload, 2026-11-22). Hit rate
is the share of the model's MCP calls answered from a prefetch. Tool wait is
the median time a session waited on MCP tools.

| Server | Sessions repeat a scripted workflow | An ordinary question, asked again | A new subject every session |
| --- | --- | --- | --- |
| A mock server that takes 1.5 s per call | 97% hit rate, 59% less tool wait, session 32% shorter | 95%, 83% less, 18% shorter | 50%, 49% less, 13% shorter |
| Microsoft Learn (about 0.4 s per call) | 97%, 87% less, 19% shorter | 53%, 37% less, 14% shorter | 37%, 13% less, no gain |
| Hugging Face Hub (about 70 ms per call) | 97%, 61% less, no gain | 18%, no gain | 0%, nothing prefetched |

- On the mock server the scripted session waited 12.1 s on tools without
  Speculate and 5.0 s with it. On Microsoft Learn it waited 2.4 s and 0.3 s.
- The slower the server, the more of a session Speculate removes. Against a
  server that answers in 70 ms there is too little to remove.
- Of the prefetches started, 71% were used. The rest are extra reads against
  the server.
- The first two sessions teach it. Almost nothing is served in them.
- A new subject is served when the prompt names it ("issue 41"). When the
  model must search for it, the search itself is never predicted.
- The Hub answers in Markdown, which Speculate cannot read arguments from, so
  only an exact repeat of an earlier call is served there.
- Speculate's hooks add less than 10 ms to a call it does not answer.
- In a Claude Code session that offers the Artifact tool (a cloud session),
  any mod that hooks tool calls makes each model request about 170 ms slower.
  That is the host's doing and was measured separately. The numbers above are
  from sessions without that tool.

The
[benchmark guide](https://lukebward.github.io/speculate/design/local-learning-benchmark/)
has the method, every table, the costs, and the limits. The last proxy
release (0.25.0) was measured the day before against an earlier build of the
mod; it has not been run against this one.

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
- It predicts from what a prompt names and from what results say. A call
  whose arguments the model writes itself, such as a search query, is never
  predicted, and which search results a model opens is a judgment. In the
  measured sessions Speculate had about half of those pages ready.
- A new kind of prompt or call must be seen twice before it is predicted.
- A server is used one call at a time until the model itself has run calls
  on it together. On a slow server that the model uses strictly one call at a
  time, a served call still waits for a prefetch that started only when the
  call before it returned.
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
