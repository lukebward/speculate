/**
 * Calls outside MCP that may have changed what an MCP read returns
 * (DESIGN.md §6.2).
 *
 * A prefetched read is a snapshot. A shell command or a file edit can change
 * what the same read would return now, on any server, so a call that may
 * have written discards everything prefetched before it settled.
 *
 * Claude Code states which calls it held read-only (`isReadOnly`). Absence
 * means the tool could not say, and counts as a write. The exception is the
 * agent's own bookkeeping, which changes nothing outside the session and
 * which an agent interleaves with its reads all the time.
 */

/** Built-in tools that only keep the session's own task list. */
const SESSION_BOOKKEEPING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

/** What the host reported for a call, as far as this decision reads it. */
export interface CallVerdict {
  /** Set when the call was refused before the tool ran. */
  deny?: unknown;
  /** True when the host held the call read-only. */
  isReadOnly?: unknown;
}

export function mayWriteOutside(tool: string, ran: CallVerdict): boolean {
  if (ran.deny !== undefined) return false;
  if (ran.isReadOnly === true) return false;
  return !SESSION_BOOKKEEPING.has(tool);
}
