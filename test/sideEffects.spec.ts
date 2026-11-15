/**
 * Which calls outside MCP may have changed what an MCP read returns
 * (DESIGN.md §6.2): the host's read-only verdict decides, absence of one
 * counts as a write, and session bookkeeping is exempt.
 */
import { describe, expect, it } from 'vitest';
import { mayWriteOutside } from '../src/sideEffects.js';

/** What the case is, the tool, what the host reported for the call, the answer. */
const CASES: Array<[string, string, Record<string, unknown>, boolean]> = [
  ['a shell command with no read-only verdict', 'Bash', { result: {}, text: 'pushed' }, true],
  ['a file edit', 'Edit', { result: {}, text: '' }, true],
  ['a call that failed, which may have run partway', 'Bash', { result: {}, text: 'boom', isError: true }, true],
  ['a tool this build has never heard of', 'SomeNewTool', { result: {}, text: '' }, true],
  ['a call the host held read-only', 'Bash', { result: {}, text: 'a.ts', isReadOnly: true }, false],
  ['a failed call the host still held read-only', 'Read', { result: {}, text: 'no such file', isError: true, isReadOnly: true }, false],
  ['a refused call, since nothing ran', 'Bash', { deny: 'not allowed' }, false],
  ['the todo list', 'TodoWrite', { result: {}, text: '' }, false],
  ['a new task', 'TaskCreate', { result: {}, text: '' }, false],
  ['a task update', 'TaskUpdate', { result: {}, text: '' }, false],
];

describe('mayWriteOutside', () => {
  it.each(CASES)('%s (%s)', (_what, tool, ran, expected) => {
    expect(mayWriteOutside(tool, ran)).toBe(expected);
  });
});
