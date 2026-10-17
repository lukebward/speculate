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
  them it may prefetch.
- The most common reasons a prediction was not started this session, such as
  `host-permission` (your settings would ask), `policy:not-read-only`,
  `low-utility` (too fast to be worth it), or `dedup`.

Saved time is estimated: a served call is credited with the upstream time its
prefetch took, and a joined call with the time the prefetch had already run.

## `/speculate forget`

Deletes everything Speculate has learned and its cumulative totals, in the
store and in the running session.
