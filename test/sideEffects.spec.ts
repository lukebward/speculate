/**
 * Which calls outside MCP may have changed what an MCP read returns
 * (DESIGN.md §6.2): the host's read-only verdict decides, absence of one
 * counts as a write, and session bookkeeping is exempt.
 */
import { describe, expect, it } from 'vitest';
import { mayWriteByName, mayWriteOutside } from '../src/sideEffects.js';

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

describe('mayWriteByName', () => {
  it.each([
    ['a shell command, whatever it ran', 'Bash', true],
    ['a file edit', 'Edit', true],
    ['a file write', 'Write', true],
    ['a notebook edit', 'NotebookEdit', true],
    ['a subagent, whose own calls are heard one by one', 'Task', true],
    ['a tool this build has never heard of', 'SomeNewTool', true],
    ['a file read', 'Read', false],
    ['a search of file names', 'Glob', false],
    ['a search of file contents', 'Grep', false],
    ['the host loading tool definitions', 'ToolSearch', false],
    ['a web search', 'WebSearch', false],
    ['the todo list', 'TodoWrite', false],
    ['a task update', 'TaskUpdate', false],
  ] as Array<[string, string, boolean]>)('%s (%s)', (_what, tool, expected) => {
    expect(mayWriteByName(tool)).toBe(expected);
  });

  it('never keeps what the verdict would have discarded', () => {
    // Whatever the name says may only read, the verdict agrees when the host held the call read-only.
    for (const tool of ['Read', 'Glob', 'Grep', 'ToolSearch', 'WebSearch', 'TodoWrite']) {
      expect(mayWriteByName(tool)).toBe(false);
      expect(mayWriteOutside(tool, { isReadOnly: true })).toBe(false);
    }
  });
});
