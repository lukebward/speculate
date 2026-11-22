/**
 * The list of tools the hooks name (src/watch.ts): what an option value is
 * read as, and when a session's tools change it.
 */
import { describe, expect, it } from 'vitest';
import { MAX_WATCHED, mergeWatched, watchedTools, watchOption } from '../src/watch.js';

const A = 'mcp__gh__get_issue';
const B = 'mcp__gh__list_issues';
const C = 'mcp__docs__search';

describe('watchedTools', () => {
  it('reads the names, each once, in a fixed order', () => {
    expect(watchedTools(`${B}, ${A},${B}`)).toEqual([A, B]);
  });

  it('drops what is not the name of an MCP tool', () => {
    expect(watchedTools(`Bash,${A},mcp__broken,Edit,, mcp__a b__c ,*`)).toEqual([A]);
  });

  it('reads nothing from an option that is not text', () => {
    expect(watchedTools(undefined)).toEqual([]);
    expect(watchedTools(['mcp__a__b'])).toEqual([]);
    expect(watchedTools('')).toEqual([]);
  });

  it('round-trips what it stores', () => {
    expect(watchedTools(watchOption([A, B, C].sort()))).toEqual([A, B, C].sort());
  });
});

describe('mergeWatched', () => {
  it('has nothing to change when every offered tool is already named', () => {
    expect(mergeWatched([A, B, C], [B, A])).toBeNull();
    expect(mergeWatched([A], [])).toBeNull();
  });

  it('adds the tools a session offers and keeps the ones named before', () => {
    expect(mergeWatched([C], [B, A, 'Bash'])).toEqual([C, A, B].sort());
    expect(mergeWatched([], [A])).toEqual([A]);
  });

  it('is settled by its own answer', () => {
    const first = mergeWatched([C], [A, B])!;
    expect(mergeWatched(first, [A, B])).toBeNull();
  });

  it('keeps the session at hand first when there are more names than it keeps', () => {
    const old = Array.from({ length: MAX_WATCHED }, (_, i) => `mcp__old__t${String(i).padStart(3, '0')}`);
    const merged = mergeWatched(old, [A, B])!;
    expect(merged).toHaveLength(MAX_WATCHED);
    expect(merged).toContain(A);
    expect(merged).toContain(B);
    // And it does not ask again for what did not fit.
    const many = Array.from({ length: MAX_WATCHED + 20 }, (_, i) => `mcp__new__t${String(i).padStart(3, '0')}`);
    const capped = mergeWatched([], many)!;
    expect(capped).toHaveLength(MAX_WATCHED);
    expect(mergeWatched(capped, many)).toBeNull();
  });
});
