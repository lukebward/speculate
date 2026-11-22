# Safety and storage

The most important rule: **Speculate only starts a call that Claude Code has
reported read-only, and only when your permission settings would already run it
without asking.** Unknown means no. Prefetching a write the agent never asked
for could not be undone, so the policy is default-deny.

!!! danger "Speculating on writes is a permanent non-goal"

    This is not a restriction to relax later. Serving a *cached read* is a
    freshness trade-off. *Executing a write* nobody asked for is a correctness
    violation, however confident the prediction.

## Which calls can be prefetched

A tool becomes a speculation target only when all of these hold:

1. **It ran read-only through Claude Code.** A real call to the tool came back
   with Claude Code's `isReadOnly` verdict. For an MCP tool, Claude Code takes
   that verdict from the server's `readOnlyHint`. A tool Speculate has never
   seen run is not a target, and a later call that comes back otherwise revokes
   it on the spot.
2. **Its result can stand in.** Claude Code recorded the real call's result
   as MCP content blocks, or as one text (it does that for a tool that
   returns structured content). A prefetched result answers the same call
   only when it takes that same form. Otherwise it is discarded.
3. **You already allow it.** `$.tool.check` reports that Claude Code would run
   this exact call, with these arguments, without asking. Speculate checks
   before starting the prefetch and again when its result arrives. It never
   raises a permission prompt.
4. **Speculate is asked about it before it runs.** It answers a call at the
   point where Claude Code is about to run the tool, and it is asked only
   about the MCP tools it names (see [the tools it watches](#the-tools-it-watches)).
   A tool it does not name yet is learned from, not prefetched.

Annotations are hints the server makes about itself. A server that marks a
writing tool `readOnlyHint: true` misleads Claude Code too. Speculate makes
that no worse in kind, but it makes such a tool eligible for calls you did not
ask for. Your permission settings are the allowlist: if you are unsure of a
server, do not allow its tools without asking, and Speculate will not touch
them.

## How a served call runs

Speculate answers a call at one point only: when Claude Code has allowed the
call and is about to run the tool (`tool.run`). By then the permission check
has passed, your PreToolUse hooks have run, and any question about the call
has been answered.

- If your settings or your hooks deny the call, Speculate is never asked
  about it. The call ends exactly as it would have without Speculate, and the
  prefetch counts as waste.
- If a hook rewrites the call's arguments, Speculate is asked about the call
  as rewritten. It answers only if it holds a result for exactly those
  arguments.
- If the call is allowed as it stands and Speculate holds its result, it
  answers in the tool's place. Your PostToolUse hooks then run on that answer
  as on any result.

Prefetches are real calls through Claude Code, made with `$.mcp.call`. They go
through your permission settings and your PreToolUse and PostToolUse hooks like
any other call, so an audit hook sees every request that actually reached a
server, and sees the served call too.

## The tools it watches

A mod says which tools it wants to be asked about. Claude Code treats a tool
that a mod may answer with more caution, so Speculate asks about MCP tools
only, by name. It does not know the names in advance: they are whatever
servers you have connected. So it keeps the list itself, in its one option:

- When a turn ends in a session that offers an MCP tool it does not name
  yet, Speculate writes the tools' names to its option. Claude Code keeps the
  option in your settings (`pluginConfigs`, under `speculate`) and reloads
  Speculate with the new names. It waits for the end of the turn so that the
  reload interrupts nothing.
- The option shows in `/config` as "Watched MCP tools". Leave it as it is. If
  you clear it, Speculate fills it in again.
- Until the list exists, and where your settings refuse to keep it (an
  organization's may), Speculate is asked about every tool call. It still
  works; `/speculate` says which of the two it is doing.

Speculate hears of every other call only after it ran: a built-in tool such
as Bash or Edit, or an MCP tool it does not name yet.

## Hard rules

- **Calls it does not answer are untouched.** Speculate never blocks, rewrites,
  or reorders a call it does not serve, writes included.
- **Results are never made up or combined.** A served result is exactly what
  the server returned for that server, tool and argument values.
- **Single use, short life, memory only.** A prefetched result answers at most
  one call and is discarded unused after 30 seconds. It is never written to
  disk.
- **Writes flush.** Any call to a server that does not come back read-only,
  including one that failed, discards everything prefetched from that server
  and cancels what was queued.
- **Writes outside MCP flush everything.** A shell command or a file edit can
  change what any server would return. When a built-in tool call settles,
  including one that failed or was interrupted, everything prefetched from
  every server is discarded, unless the tool is one that only reads (Read,
  Glob, Grep, a web search, the tool search) or only keeps the agent's own
  task list. A shell command always discards, whatever it ran: Speculate hears
  of it only afterwards, with no verdict from Claude Code on what it did. A
  write that does not go through Claude Code at all (a teammate, another
  terminal) is still invisible; the 30 seconds bound it.
- **Auth errors suspend.** A prefetch that fails with an authorization error is
  not kept, and the tool is not prefetched again until a real call to it
  succeeds.
- **Real calls come first.** Claude Code does not tell a mod how it reaches a
  server, so Speculate treats every server as serial: it prefetches only while
  no real call to that server is running, one at a time, at most 30 a minute.
- **A server runs calls together only after the model did.** When the model's
  own calls have been in flight on a server at the same time, Speculate may
  prefetch there together too. It never has more calls in flight, its own and
  the model's, than the model alone has had, and never more than three of its
  own.

## What is read from your prompt

When you submit a prompt, Speculate reads the identifiers in it: whole
numbers and the word before each ("issue 41"), links, `owner/name` pairs,
file paths, and text in double quotes or backticks. It reads the first 4,000
characters and ignores a link that carries a login.

It uses them for one thing. The first call of an exchange takes its arguments
from your words, so after two prompts that named a subject the same way,
Speculate can start that read while the model is still reading the prompt.
Only a call that takes a value from the prompt starts this way.

The identifiers stay in memory until the next prompt. What is stored is where
a value was read from (for example, "the number after the word issue"), never
the value and never the prompt.

## What is stored

Speculate keeps its learning in the plugin's own store, a JSON file under
Claude Code's configuration directory (`~/.claude/plugins/store/`). It holds:

- learned transitions: tool names, where each argument came from (an earlier
  argument, a field of an earlier result, an identifier in the prompt, or a
  constant), and filtered constant values;
- each session's usual opening reads, with their arguments;
- per-rule feedback and latency aggregates;
- per tool, whether it ran read-only, the argument **names** it was called
  with, and how many of the model's calls its server has run at the same time;
- cumulative counters for `/speculate`.

One thing is kept outside that store: the names of your MCP tools, in
Speculate's option in your Claude Code settings (see
[the tools it watches](#the-tools-it-watches)). `/speculate forget` does not
clear it; `/config` does.

Tool results are never stored. Before anything is written, values and names
that look like credentials (bearer tokens, private keys, JWTs, URLs with
passwords, fields named like `password` or `api_key`) are dropped. Entries
unused for 30 days expire, and the whole value is kept under 3 MiB. Sessions
that run at the same time merge their learning rather than overwrite it.

Filtering cannot recognize every private string. Ordinary identifiers and paths
can remain as learned constants, and the store is not encrypted. Run
`/speculate forget` to delete everything Speculate has learned.

## Risks that read-only does not solve

!!! danger "Speculation reveals intent"

    A prefetch tells the upstream service what you are *probably* about to do,
    before the agent commits to it. Read-only bounds changes, not disclosure.
    A session's usual opening reads run when its first prompt arrives, and so
    does a read that Speculate has learned to take from what a prompt names.
    If that matters for a server, do not allow its tools without asking.

**Reads with side effects.** Even a read can write an audit entry, mark
something as seen, count against a rate limit, or be billed. An unused
prefetch costs one of those. `/speculate` reports waste so you can judge the
trade.
