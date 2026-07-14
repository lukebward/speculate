# Durable Usage Stats Design

## Goal

Add a top-level `speculate stats` command that reports durable, machine-wide usage across MCP proxy and CLI speculation sessions, with per-workspace and per-source breakdowns.

Collection begins when this version runs. Existing session-only analytics remain unchanged, and historical usage cannot be reconstructed.

`speculate try` remains a zero-write trial and does not contribute durable usage records.

## Command

```bash
speculate stats
speculate stats --json
```

The default output is human-readable and includes:

- estimated time saved;
- ready-cache hits and in-flight joins;
- hit rate, calculated as `(hits + joins) / (hits + joins + misses)`;
- speculative and wasted calls;
- waste per successful prefetch;
- recorded session count;
- MCP-versus-CLI totals; and
- per-workspace totals, sorted by estimated time saved.

`--json` returns the same totals and breakdowns as structured data. When no records exist, the command exits successfully and explains that collection starts with this version.

This change adds only `speculate stats`. It does not add a `usage` alias, reset command, time filters, or workspace filters.

## Storage Model

Each MCP proxy process and CLI speculation daemon owns one uniquely named session snapshot under the existing Speculate state directory:

```text
$XDG_STATE_HOME/speculate/usage/<session-id>.json
```

The existing platform-specific fallback for the state home applies when `XDG_STATE_HOME` is unavailable. Session identifiers combine process-independent uniqueness with a start timestamp so concurrent processes never target the same file.

Each versioned snapshot contains:

- source: `mcp` or `cli`;
- absolute workspace path;
- session start and last-update timestamps;
- optional clean-shutdown timestamp; and
- aggregate counters for hits, joins, misses, speculative calls, wasted calls, and estimated milliseconds saved.

Snapshots do not contain command arguments, tool names, server names, tool results, prediction templates, or cache contents. The workspace path is the only persisted identifier.

## Recording Lifecycle

MCP usage is derived from the existing `Metrics` snapshot. CLI usage is derived from the existing daemon counters. A shared usage recorder normalizes both sources into the same snapshot schema.

The recorder creates an initial session snapshot, keeps current counters in memory, and schedules an atomic flush at most once per second after counters change. Clean shutdown performs a final flush and records the shutdown timestamp. A forced process termination can lose at most the final debounce interval.

Recording is an optimization and never affects proxy or command behavior. Directory creation, serialization, or write failures are reported once to stderr and otherwise ignored.

`speculate try` launches its temporary client session with an internal usage-disable environment flag inherited by its wrapped MCP and workspace processes. This preserves the command's existing promise that the trial leaves no trace on disk.

## Aggregation

`speculate stats` scans every supported snapshot in the usage directory and aggregates:

- machine-wide totals;
- totals grouped by `mcp` and `cli`; and
- totals grouped by workspace path.

The earliest session start becomes the reporting start time, the latest update becomes the last activity time, and every readable snapshot contributes one session. Workspace rows are sorted by estimated time saved, then by path for deterministic ties.

Derived fields such as hit rate and waste per hit are calculated while reading, not stored. Empty denominators produce `null` in JSON and a neutral placeholder in human output.

Malformed, unreadable, or version-mismatched snapshots are excluded. The human command warns with the number of ignored records; JSON includes an `ignoredRecords` count so callers receive the same information without mixed stderr parsing.

## Output Shape

JSON output has a stable top-level structure:

```json
{
  "since": "2026-07-14T12:00:00.000Z",
  "updatedAt": "2026-07-14T14:30:00.000Z",
  "ignoredRecords": 0,
  "totals": {},
  "bySource": {
    "mcp": {},
    "cli": {}
  },
  "workspaces": []
}
```

Each totals object contains session count, hits, joins, misses, speculative calls, wasted calls, estimated milliseconds saved, hit rate, and waste per hit.

## Integration Boundaries

The usage recorder is a small persistence component independent of MCP and daemon transports. It accepts complete counter snapshots rather than individual decision events, which avoids duplicating metric semantics and keeps both sources consistent.

The MCP proxy receives a recorder from its CLI construction path and updates it from the existing metrics snapshot. The CLI daemon constructs a recorder using its resolved workspace root and updates it from its existing daemon stats. Tests can inject an isolated usage directory or disable recording.

Existing interfaces remain unchanged:

- `speculate__stats` continues to report the current MCP session;
- `speculate exec --stats` continues to report the current workspace daemon lifetime; and
- `speculate try` continues to write no durable state; and
- the signal-driven MCP session summary continues to print to stderr.

## Security and Permissions

The usage directory is private to the current user and snapshot files are written with mode `0600`. Writes use a temporary file followed by atomic rename. Temporary filenames are unique to the owning session so simultaneous flushes cannot collide.

The stats reader treats all disk contents as untrusted. It validates the schema, rejects invalid numeric values, and never follows data from a record into executable behavior.

## Testing

Tests cover:

- snapshot creation, permissions, updates, and clean shutdown;
- isolated simultaneous sessions without lost counters;
- MCP and CLI counter normalization;
- aggregation across sources and workspaces;
- deterministic workspace ordering;
- hit-rate and waste-per-hit calculations, including empty denominators;
- malformed and version-mismatched record handling;
- human-readable and JSON formatting;
- CLI parsing and empty-state behavior; and
- exclusion of `speculate try` sessions from durable usage; and
- preservation of existing live stats commands.

Verification includes focused tests for the new persistence and CLI modules, the existing metrics and exec-daemon suites, the full test suite, and a production build.
