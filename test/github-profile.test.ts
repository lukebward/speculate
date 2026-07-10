/**
 * GitHub vetted-profile tests (DESIGN.md §4, §10 item 4): rules, parsers,
 * canonicalizers, and the read-only allowlist, exercised against fixtures
 * shaped exactly like the bundled mock server's payloads (JSON serialized
 * into the first `text` content block).
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { canonicalKey } from '../src/keys.js';
import { Predictor } from '../src/predictor.js';
import { githubProfile } from '../src/profiles/github.js';
import { builtinProfiles } from '../src/profiles/index.js';
import type { DecisionEvent } from '../src/types.js';

// --- fixtures (mock/mock-github.ts result shapes) ----------------------------

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value));
}

const issueFixture = {
  number: 7,
  title: 'Crash on boot',
  state: 'open',
  body: 'It crashes.',
  labels: ['bug'],
  comments_count: 2,
};

const prListFixture = [
  { number: 101, title: 'Fix crash', state: 'open', head_ref: 'fix/crash' },
  { number: 102, title: 'Add tests', state: 'open', head_ref: 'test/more' },
  { number: 103, title: 'Refactor', state: 'open', head_ref: 'chore/refactor' },
];

const prFixture = {
  number: 101,
  title: 'Fix crash',
  state: 'open',
  head_ref: 'fix/crash',
  base_ref: 'main',
  body: 'Fixes #7',
  changed_files: 3,
};

const issueListFixture = [
  { number: 1, title: 'First', state: 'open' },
  { number: 2, title: 'Second', state: 'open' },
  { number: 3, title: 'Third', state: 'open' },
];

/** Observe one call through a Predictor holding the real GitHub profile. */
function observe(tool: string, args: Record<string, unknown>, result: CallToolResult) {
  const events: DecisionEvent[] = [];
  const predictor = new Predictor({
    profiles: { github: githubProfile },
    maxPerTrigger: 3,
    metrics: {
      record: (ev) => {
        events.push(ev);
      },
      // Laplace-neutral feedback: effectiveness 0.5 for every rule.
      ruleFeedback: () => ({ hits: 0, wasted: 0, speculated: 0 }),
    },
  });
  const predictions = predictor.observe({
    server: 'github',
    tool,
    args,
    result,
    latencyMs: 40,
    timestamp: 1_720_000_000_000,
  });
  return { predictions, events };
}

// --- rules --------------------------------------------------------------------

describe('githubProfile rules', () => {
  it('get_issue predicts the comment thread then open PRs from trigger args', () => {
    const { predictions } = observe(
      'get_issue',
      { owner: 'octo', repo: 'hello', issue_number: 7 },
      jsonResult(issueFixture),
    );
    expect(predictions).toEqual([
      {
        server: 'github',
        tool: 'get_issue_comments',
        args: { owner: 'octo', repo: 'hello', issue_number: 7 },
        confidence: 0.8,
        ruleId: 'gh:issue→comments',
      },
      {
        server: 'github',
        tool: 'list_pull_requests',
        args: { owner: 'octo', repo: 'hello', state: 'open' },
        confidence: 0.6,
        ruleId: 'gh:issue→open-prs',
      },
    ]);
  });

  it('get_issue rules fire even when the result cannot be parsed', () => {
    const { predictions, events } = observe(
      'get_issue',
      { owner: 'octo', repo: 'hello', issue_number: 7 },
      textResult('500 Internal Server Error'),
    );
    expect(predictions.map((p) => p.tool)).toEqual([
      'get_issue_comments',
      'list_pull_requests',
    ]);
    expect(events.filter((e) => e.type === 'parser_miss')).toHaveLength(1);
  });

  it('list_pull_requests predicts get_pull_request for the first two PRs, descending', () => {
    const { predictions } = observe(
      'list_pull_requests',
      { owner: 'octo', repo: 'hello', state: 'open' },
      jsonResult(prListFixture),
    );
    expect(predictions).toEqual([
      {
        server: 'github',
        tool: 'get_pull_request',
        args: { owner: 'octo', repo: 'hello', pull_number: 101 },
        confidence: 0.5,
        ruleId: 'gh:pr-list→pr',
      },
      {
        server: 'github',
        tool: 'get_pull_request',
        args: { owner: 'octo', repo: 'hello', pull_number: 102 },
        confidence: 0.35,
        ruleId: 'gh:pr-list→pr',
      },
    ]);
  });

  it('list_pull_requests predicts one PR from a single-entry list', () => {
    const { predictions } = observe(
      'list_pull_requests',
      { owner: 'o', repo: 'r' },
      jsonResult([{ number: 5, title: 'Only', state: 'open', head_ref: 'x' }]),
    );
    expect(predictions.map((p) => [p.args.pull_number, p.confidence])).toEqual([[5, 0.5]]);
  });

  it('list_pull_requests predicts nothing when the parsed result is not an array', () => {
    expect(
      observe('list_pull_requests', { owner: 'o', repo: 'r' }, textResult('nope')).predictions,
    ).toEqual([]);
    expect(
      observe('list_pull_requests', { owner: 'o', repo: 'r' }, jsonResult({ number: 1 }))
        .predictions,
    ).toEqual([]);
  });

  it('get_pull_request predicts the diff using pull_number from args', () => {
    const { predictions } = observe(
      'get_pull_request',
      { owner: 'o', repo: 'r', pull_number: 101 },
      jsonResult(prFixture),
    );
    expect(predictions).toEqual([
      {
        server: 'github',
        tool: 'get_pull_request_diff',
        args: { owner: 'o', repo: 'r', pull_number: 101 },
        confidence: 0.7,
        ruleId: 'gh:pr→diff',
      },
    ]);
  });

  it('get_pull_request falls back to parsed.number when args lack pull_number', () => {
    const { predictions } = observe(
      'get_pull_request',
      { owner: 'o', repo: 'r' },
      jsonResult({ ...prFixture, number: 55 }),
    );
    expect(predictions).toEqual([
      {
        server: 'github',
        tool: 'get_pull_request_diff',
        args: { owner: 'o', repo: 'r', pull_number: 55 },
        confidence: 0.7,
        ruleId: 'gh:pr→diff',
      },
    ]);
  });

  it('get_pull_request predicts nothing when pull_number is nowhere to be found', () => {
    const { predictions } = observe(
      'get_pull_request',
      { owner: 'o', repo: 'r' },
      textResult('garbage'),
    );
    expect(predictions).toEqual([]);
  });

  it('list_issues predicts get_issue for the first two issues, descending', () => {
    const { predictions } = observe(
      'list_issues',
      { owner: 'octo', repo: 'hello' },
      jsonResult(issueListFixture),
    );
    expect(predictions).toEqual([
      {
        server: 'github',
        tool: 'get_issue',
        args: { owner: 'octo', repo: 'hello', issue_number: 1 },
        confidence: 0.45,
        ruleId: 'gh:issue-list→issue',
      },
      {
        server: 'github',
        tool: 'get_issue',
        args: { owner: 'octo', repo: 'hello', issue_number: 2 },
        confidence: 0.3,
        ruleId: 'gh:issue-list→issue',
      },
    ]);
  });

  it('get_file_contents has no follow-up rules', () => {
    const { predictions } = observe(
      'get_file_contents',
      { owner: 'o', repo: 'r', path: 'README.md' },
      jsonResult({ path: 'README.md', content: '# hi' }),
    );
    expect(predictions).toEqual([]);
  });

  it('every rule returns [] when owner or repo is missing', () => {
    const cases: Array<[string, Record<string, unknown>, CallToolResult]> = [
      ['get_issue', { issue_number: 7 }, jsonResult(issueFixture)],
      ['get_issue', { repo: 'hello', issue_number: 7 }, jsonResult(issueFixture)],
      ['list_pull_requests', { owner: 'octo' }, jsonResult(prListFixture)],
      ['get_pull_request', { pull_number: 101 }, jsonResult(prFixture)],
      ['list_issues', { repo: 'hello' }, jsonResult(issueListFixture)],
    ];
    for (const [tool, args, result] of cases) {
      const { predictions, events } = observe(tool, args, result);
      expect(predictions).toEqual([]);
      expect(events.filter((e) => e.type === 'predicted')).toEqual([]);
    }
  });
});

// --- parsers --------------------------------------------------------------------

describe('githubProfile parsers', () => {
  const parse = githubProfile.parsers['get_issue']!;

  it('covers exactly the seven read-only tools', () => {
    expect(Object.keys(githubProfile.parsers).sort()).toEqual(
      [...githubProfile.readOnlyAllowlist].sort(),
    );
  });

  it('parses JSON from the first text content block', () => {
    expect(parse(jsonResult(issueFixture))).toEqual(issueFixture);
    expect(parse(jsonResult(prListFixture))).toEqual(prListFixture);
  });

  it('returns null on isError results even when the text is valid JSON', () => {
    const r: CallToolResult = {
      content: [{ type: 'text', text: '{"ok":true}' }],
      isError: true,
    };
    expect(parse(r)).toBeNull();
  });

  it('returns null on non-JSON text', () => {
    expect(parse(textResult('<html>rate limited</html>'))).toBeNull();
  });

  it('returns null when no text block exists, without throwing', () => {
    expect(parse({ content: [] })).toBeNull();
    expect(parse({ content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] })).toBeNull();
    expect(parse({} as CallToolResult)).toBeNull();
  });
});

// --- canonicalizers ---------------------------------------------------------------

describe('githubProfile canonicalizers', () => {
  for (const tool of ['list_issues', 'list_pull_requests'] as const) {
    it(`${tool}: defaults state to open and folds case, so keys collide`, () => {
      const canon = githubProfile.canonicalizers[tool]!;
      const bare = { owner: 'octo', repo: 'hello' };
      const upper = { owner: 'octo', repo: 'hello', state: 'OPEN' };

      expect(canonicalKey('github', tool, bare, canon)).toBe(
        canonicalKey('github', tool, upper, canon),
      );
      expect(canon(bare)).toEqual({ owner: 'octo', repo: 'hello', state: 'open' });
    });

    it(`${tool}: does not mutate its input args`, () => {
      const canon = githubProfile.canonicalizers[tool]!;
      const bare = { owner: 'octo', repo: 'hello' };
      const upper = { owner: 'octo', repo: 'hello', state: 'OPEN' };

      const bareOut = canon(bare);
      const upperOut = canon(upper);

      expect(bareOut).not.toBe(bare);
      expect(upperOut).not.toBe(upper);
      expect(bare).toEqual({ owner: 'octo', repo: 'hello' });
      expect('state' in bare).toBe(false);
      expect(upper.state).toBe('OPEN');
    });

    it(`${tool}: keeps genuinely different states distinct`, () => {
      const canon = githubProfile.canonicalizers[tool]!;
      expect(
        canonicalKey('github', tool, { owner: 'o', repo: 'r', state: 'closed' }, canon),
      ).not.toBe(canonicalKey('github', tool, { owner: 'o', repo: 'r' }, canon));
    });
  }

  it('only the two list tools have canonicalizers', () => {
    expect(Object.keys(githubProfile.canonicalizers).sort()).toEqual([
      'list_issues',
      'list_pull_requests',
    ]);
  });
});

// --- profile shape ------------------------------------------------------------------

describe('githubProfile shape', () => {
  it('allowlists exactly the seven read-only tools (no writes)', () => {
    expect([...githubProfile.readOnlyAllowlist].sort()).toEqual([
      'get_file_contents',
      'get_issue',
      'get_issue_comments',
      'get_pull_request',
      'get_pull_request_diff',
      'list_issues',
      'list_pull_requests',
    ]);
  });

  it('uses a 30s default TTL with no per-tool overrides yet', () => {
    expect(githubProfile.defaultTtlMs).toBe(30_000);
    expect(githubProfile.ttlMsByTool).toEqual({});
  });

  it('is registered as the built-in github profile', () => {
    expect(builtinProfiles['github']).toBe(githubProfile);
    expect(githubProfile.name).toBe('github');
    expect(Object.keys(builtinProfiles)).toEqual(['github']);
  });
});
