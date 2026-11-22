# Commands

Speculate adds one slash command.

## `/speculate`

Shows whether speculation is paying for itself:

- **This session:** calls served from a prefetch (ready, or still in flight
  when the model asked), real MCP calls, prefetches started and wasted, the
  estimated time saved and the same estimate net of real calls that waited
  behind a prefetch, and next-call recall at 1 and at 3.
- **All sessions:** the same counters summed across every session.
- **Known MCP tools:** how many tools Speculate has seen run, and how many of
  them it may prefetch. Under it, how many MCP tools it is asked about by
  name, or that it is asked about every tool call (before the names are
  saved, or where your settings do not keep them).
- The most common reasons a prediction was not started this session, such as
  `host-permission` (your settings would ask), `policy:not-read-only`,
  `policy:not-watched` (an MCP tool Speculate does not name yet),
  `low-utility` (too fast to be worth it), or `dedup`.

Saved time is estimated: a served call is credited with the upstream time its
prefetch took, and a joined call with the time the prefetch had already run.
The estimate leaves out what serving costs: a served call still takes about
25 ms. Against a server that answers in about 70 ms, a
[measured run](design/local-learning-benchmark.md#what-the-mod-costs) saved
less than half of what `/speculate` reported; against a slower one the two
were close.

## `/speculate forget`

Deletes everything Speculate has learned and its cumulative totals, in the
store and in the running session.
