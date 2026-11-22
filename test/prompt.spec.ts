/**
 * What a prompt names (src/prompt.ts): the identifiers the learner may read
 * a first call's arguments from, and nothing else of what the person wrote.
 */
import { describe, expect, it } from 'vitest';
import { PROMPT_TOOL, promptFacts } from '../src/prompt.js';

describe('promptFacts', () => {
  it('reads a number by the word before it', () => {
    expect(promptFacts('Read issue 41 and its comments.')).toEqual({ named: { issue: 41 }, numbers: [41] });
    expect(promptFacts('Read pull request 7 and its diff')).toEqual({ named: { request: 7 }, numbers: [7] });
    expect(promptFacts('look at PR #12, then issue: 9')).toEqual({ named: { pr: 12, issue: 9 }, numbers: [12, 9] });
  });

  it('keeps the first mention of a word and each number once', () => {
    expect(promptFacts('issue 5 blocks issue 6; issue 5 first')).toEqual({ named: { issue: 5 }, numbers: [5, 6] });
  });

  it('leaves versions, decimals and numbers inside words alone', () => {
    expect(promptFacts('upgrade to v2 or 3.5, see build2 and 1.2.3')).toBeNull();
  });

  it('reads a link, its parts, and the number its path names', () => {
    expect(promptFacts('Review https://github.com/acme/api/pull/123.')).toEqual({
      named: { pull: 123 },
      links: [{ url: 'https://github.com/acme/api/pull/123', host: 'github.com', path: ['acme', 'api', 'pull', '123'] }],
      numbers: [123],
    });
  });

  it('holds no link that carries a login', () => {
    expect(promptFacts('fetch https://me:hunter2@example.com/a/1 now')).toBeNull();
  });

  it('tells an owner/name pair from a path', () => {
    expect(promptFacts('In acme/api, what does src/app.ts do? See ./scripts/build.sh and ~/notes/todo.md.')).toEqual({
      repos: [{ owner: 'acme', name: 'api', full: 'acme/api' }],
      paths: ['src/app.ts', './scripts/build.sh', '~/notes/todo.md'],
    });
    // The full stop that ends a sentence is not part of the name.
    expect(promptFacts('Use the repository acme/api.')).toEqual({ repos: [{ owner: 'acme', name: 'api', full: 'acme/api' }] });
  });

  it('reads what is quoted', () => {
    expect(promptFacts('search for "rate limiter" and `burst traffic`')).toEqual({ quoted: ['rate limiter', 'burst traffic'] });
  });

  it('puts the specific reading of a value before the bare one', () => {
    // Key order is the order the learner breaks ties in.
    expect(Object.keys(promptFacts('acme/api issue 4 "x" https://e.test/a src/a.ts')!)).toEqual([
      'named', 'links', 'repos', 'paths', 'quoted', 'numbers',
    ]);
  });

  it('names nothing in prose, and never throws', () => {
    expect(promptFacts('How do I run Python code in Azure Functions?')).toBeNull();
    expect(promptFacts('')).toBeNull();
    expect(promptFacts(undefined as never)).toBeNull();
  });

  it('reads the start of a long prompt and bounds what it takes', () => {
    const many = Array.from({ length: 40 }, (_, i) => `item ${i + 1}`).join(', ');
    const facts = promptFacts(many)!;
    expect(facts.numbers).toEqual([1, 2, 3, 4]);
    expect(facts.named).toEqual({ item: 1 });
    expect(promptFacts(`${'x '.repeat(3_000)} issue 77`)).toBeNull();
  });

  it('has a name no tool can have', () => {
    expect(PROMPT_TOOL).toBe('@prompt');
  });
});
