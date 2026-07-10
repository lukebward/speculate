/**
 * Vetted GitHub profile (DESIGN.md §4, §5.2, §10 item 4).
 *
 * Validated against the bundled mock server (mock/mock-github.ts), which
 * mirrors the github-mcp-server classic tool names and returns each payload
 * JSON-serialized into the first `text` content block — the parsing contract
 * `parseJsonText` below relies on (§5.1).
 */
import type {
  ArgsCanonicalizer,
  Prediction,
  ResultParser,
  Rule,
  ServerProfile,
} from '../types.js';

/** The seven affirmatively read-only tools (the `strict`-mode allowlist). */
const READ_ONLY_TOOLS = [
  'get_issue',
  'get_issue_comments',
  'list_issues',
  'list_pull_requests',
  'get_pull_request',
  'get_pull_request_diff',
  'get_file_contents',
];

/**
 * Shared JSON-in-text parser: error results parse to null; otherwise the
 * first `text` content block is JSON.parsed. Fails closed to null on any
 * missing/malformed input — it must never throw (§5.1).
 */
const parseJsonText: ResultParser = (result) => {
  try {
    if (result.isError) return null;
    const content: unknown = result.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type !== 'text') continue;
      if (typeof b.text !== 'string') return null;
      return JSON.parse(b.text) as unknown;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * §6.1: the server defaults `state` to "open", so `{owner, repo}` and
 * `{owner, repo, state: 'open'}` must share a cache key. No case folding:
 * the validated-against server rejects `state: 'OPEN'` with a validation
 * error, and folding would let a cache hit fabricate a success the live
 * call would never produce. Returns a new object; never mutates the input.
 */
const canonicalizeListState: ArgsCanonicalizer = (args) => {
  const out: Record<string, unknown> = { ...args };
  if (out['state'] === undefined) {
    out['state'] = 'open';
  }
  return out;
};

/** All rules require owner and repo on the trigger args; otherwise they bail. */
function ownerRepo(args: Record<string, unknown>): { owner: unknown; repo: unknown } | null {
  const owner = args['owner'];
  const repo = args['repo'];
  if (owner === undefined || owner === null || repo === undefined || repo === null) {
    return null;
  }
  return { owner, repo };
}

/**
 * First `max` entries of a parsed list that are objects carrying a numeric
 * `number`. Anything that isn't an array (parse failure, wrong shape) → [].
 */
function entryNumbers(parsed: unknown, max: number): number[] {
  if (!Array.isArray(parsed)) return [];
  const numbers: number[] = [];
  for (const entry of parsed) {
    if (numbers.length >= max) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const n = (entry as Record<string, unknown>)['number'];
    if (typeof n === 'number' && Number.isFinite(n)) numbers.push(n);
  }
  return numbers;
}

const rules: Rule[] = [
  {
    // Reading an issue → its comment thread is the canonical next read.
    id: 'gh:issue→comments',
    trigger: 'get_issue',
    predict(call): Prediction[] {
      const ctx = ownerRepo(call.args);
      if (!ctx) return [];
      return [
        {
          server: call.server,
          tool: 'get_issue_comments',
          args: { owner: ctx.owner, repo: ctx.repo, issue_number: call.args['issue_number'] },
          confidence: 0.8,
          ruleId: 'gh:issue→comments',
        },
      ];
    },
  },
  {
    // Issue triage commonly pivots to "is there a PR for this already?".
    id: 'gh:issue→open-prs',
    trigger: 'get_issue',
    predict(call): Prediction[] {
      const ctx = ownerRepo(call.args);
      if (!ctx) return [];
      return [
        {
          server: call.server,
          tool: 'list_pull_requests',
          args: { owner: ctx.owner, repo: ctx.repo, state: 'open' },
          confidence: 0.6,
          ruleId: 'gh:issue→open-prs',
        },
      ];
    },
  },
  {
    // Listing PRs → opening the top of the list.
    id: 'gh:pr-list→pr',
    trigger: 'list_pull_requests',
    predict(call): Prediction[] {
      const ctx = ownerRepo(call.args);
      if (!ctx) return [];
      const confidences = [0.5, 0.35];
      return entryNumbers(call.parsed, 2).map((pullNumber, i) => ({
        server: call.server,
        tool: 'get_pull_request',
        args: { owner: ctx.owner, repo: ctx.repo, pull_number: pullNumber },
        confidence: confidences[i],
        ruleId: 'gh:pr-list→pr',
      }));
    },
  },
  {
    // Opening a PR → reading its diff.
    id: 'gh:pr→diff',
    trigger: 'get_pull_request',
    predict(call): Prediction[] {
      const ctx = ownerRepo(call.args);
      if (!ctx) return [];
      let pullNumber: unknown = call.args['pull_number'];
      if (
        (pullNumber === undefined || pullNumber === null) &&
        call.parsed !== null &&
        typeof call.parsed === 'object' &&
        !Array.isArray(call.parsed)
      ) {
        const n = (call.parsed as Record<string, unknown>)['number'];
        if (typeof n === 'number' && Number.isFinite(n)) pullNumber = n;
      }
      // Without a pull number the prediction could never match: fail closed.
      if (pullNumber === undefined || pullNumber === null) return [];
      return [
        {
          server: call.server,
          tool: 'get_pull_request_diff',
          args: { owner: ctx.owner, repo: ctx.repo, pull_number: pullNumber },
          confidence: 0.7,
          ruleId: 'gh:pr→diff',
        },
      ];
    },
  },
  {
    // Listing issues → opening the top of the list.
    id: 'gh:issue-list→issue',
    trigger: 'list_issues',
    predict(call): Prediction[] {
      const ctx = ownerRepo(call.args);
      if (!ctx) return [];
      const confidences = [0.45, 0.3];
      return entryNumbers(call.parsed, 2).map((issueNumber, i) => ({
        server: call.server,
        tool: 'get_issue',
        args: { owner: ctx.owner, repo: ctx.repo, issue_number: issueNumber },
        confidence: confidences[i],
        ruleId: 'gh:issue-list→issue',
      }));
    },
  },
];

export const githubProfile: ServerProfile = {
  name: 'github',
  validatedAgainst: 'speculate mock-github v0.1 (mirrors github-mcp-server classic tool names)',
  readOnlyAllowlist: [...READ_ONLY_TOOLS],
  defaultTtlMs: 30_000,
  ttlMsByTool: {},
  parsers: {
    get_issue: parseJsonText,
    get_issue_comments: parseJsonText,
    list_issues: parseJsonText,
    list_pull_requests: parseJsonText,
    get_pull_request: parseJsonText,
    get_pull_request_diff: parseJsonText,
    get_file_contents: parseJsonText,
  },
  canonicalizers: {
    list_issues: canonicalizeListState,
    list_pull_requests: canonicalizeListState,
  },
  rules,
};
