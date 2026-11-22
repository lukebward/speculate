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

/**
 * Built-in tools that read, ask, or keep the session's own books whatever
 * their input: the ones the host holds read-only on every call.
 */
const READS_ONLY = new Set([
  ...SESSION_BOOKKEEPING,
  'Read',
  'Glob',
  'Grep',
  'ToolSearch',
  'WebSearch',
  'WebFetch',
  'TaskList',
  'TaskGet',
  'BashOutput',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Skill',
]);

/**
 * The same question for a call the hooks hear of only after it ran, with no
 * verdict from the host: by the tool's name alone. A tool not known to only
 * read counts as a write, a shell command included whatever it ran. That
 * discards more than the verdict would; it never keeps what the verdict
 * would have discarded.
 */
export function mayWriteByName(tool: string): boolean {
  return !READS_ONLY.has(tool);
}

export function mayWriteOutside(tool: string, ran: CallVerdict): boolean {
  if (ran.deny !== undefined) return false;
  if (ran.isReadOnly === true) return false;
  return !SESSION_BOOKKEEPING.has(tool);
}
