/**
 * The tools the hooks name (DESIGN.md §13.33).
 *
 * The mod answers a call at `tool.run`, and a hook there says which tools it
 * is for. Claude Code treats a tool that a mod may answer with more caution:
 * it keeps that tool's output on its own side of the hook, and it builds
 * some of its own tools differently once a mod may answer a file edit. A
 * hook on every tool call therefore costs every tool something, and a hook
 * that names MCP tools costs only them.
 *
 * The names are not known when hooks register: they are whatever servers the
 * person has connected. So the mod keeps them itself, in the one option its
 * manifest declares, as the names separated by commas. Claude Code reloads a
 * mod when its option changes, and the hooks then register with the new
 * names. This module is the arithmetic of that list; hooks/register.ts does
 * the reading and the writing.
 */

/** The manifest's `userConfig` field that holds the names. */
export const WATCH_OPTION = 'tools';

/**
 * The most names kept. A bound, so the setting cannot grow without limit as
 * servers come and go; the tools of the session at hand are kept first.
 */
export const MAX_WATCHED = 300;

/** An MCP tool's full name as Claude Code spells it, with nothing that would break the list. */
const MCP_TOOL = /^mcp__[^\s,]+__[^\s,]+$/;

/** The names an option value holds, in order, each once. Anything that is not an MCP tool's name is dropped. */
export function watchedTools(option: unknown): string[] {
  if (typeof option !== 'string') return [];
  const names = new Set<string>();
  for (const part of option.split(',')) {
    const name = part.trim();
    if (MCP_TOOL.test(name)) names.add(name);
    if (names.size >= MAX_WATCHED) break;
  }
  return [...names].sort();
}

/**
 * The names to keep once a session offers these MCP tools, or null when the
 * names kept already cover them. Names kept before stay (another project's
 * servers are still the person's), up to the bound.
 */
export function mergeWatched(watched: readonly string[], offered: readonly string[]): string[] | null {
  const have = new Set(watched);
  const mine = [...new Set(offered.filter((name) => MCP_TOOL.test(name)))].sort().slice(0, MAX_WATCHED);
  if (mine.every((name) => have.has(name))) return null;
  const kept = new Set(mine);
  for (const name of [...watched].sort()) {
    if (kept.size >= MAX_WATCHED) break;
    if (MCP_TOOL.test(name)) kept.add(name);
  }
  return [...kept].sort();
}

/** The names as the option stores them. */
export function watchOption(names: readonly string[]): string {
  return names.join(',');
}
