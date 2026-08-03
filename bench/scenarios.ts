/**
 * The real hosted MCP servers `bench:remote` can measure against.
 *
 * Every number elsewhere in this repo comes from a mock with injected
 * latency. These are the only ones that do not, so what varies between them
 * matters: transport, auth model, tool shape, and whether the server annotates
 * `readOnlyHint` at all. A scenario is just "which server, which read-only
 * workflow, and how do we find real arguments for it".
 *
 * Adding one is deliberately cheap. The bar for including a server here:
 *   - it annotates the tools we call `readOnlyHint: true` (the runner refuses
 *     otherwise, and refusing is the point)
 *   - the workflow is a genuine list-then-detail shape, since that is what
 *     speculation can act on
 *   - the calls are cheap and few, because these hit somebody else's service
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resultText } from '../src/upstream.js';

export interface ScriptStep {
  kind: 'call' | 'think' | 'turn';
  label?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
}

/** Calls the server directly (no proxy) to turn a query into real arguments. */
export type CallDirect = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export interface Scenario {
  readonly key: string;
  readonly label: string;
  readonly url: string;
  /**
   * Environment variable holding the credential, or null when the server
   * needs none. A scenario with no credential is the more valuable
   * measurement: anyone can reproduce it.
   */
  readonly tokenEnv: string | null;
  /** Every tool the session calls. All are checked against readOnlyHint. */
  readonly needTools: string[];
  /** Prose for the header line, so a reader knows what was exercised. */
  readonly describe: (ctx: ScenarioContext) => string;
  /** Fetch real ids, then build the session from them. */
  readonly plan: (call: CallDirect) => Promise<ScenarioContext>;
  readonly script: (ctx: ScenarioContext) => ScriptStep[];
}

/** Whatever `plan` needs to hand `script`; opaque to the runner. */
export type ScenarioContext = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/**
 * `number` fields out of a JSON tool result, whether the payload is a bare
 * array or an object wrapping one under `key`. Tolerant on purpose: the
 * benchmark should fail with a clear message, not a stack trace, if the
 * server changes its envelope.
 */
function extractNumbers(text: string, key: string | null): number[] {
  try {
    const parsed: unknown = JSON.parse(text);
    const arr = Array.isArray(parsed)
      ? parsed
      : key !== null && isRecord(parsed) && Array.isArray(parsed[key])
        ? (parsed[key] as unknown[])
        : [];
    return arr
      .map((e) => (isRecord(e) && typeof e['number'] === 'number' ? e['number'] : null))
      .filter((n): n is number => n !== null);
  } catch {
    return [];
  }
}

const GITHUB_OWNER = process.env['SPECULATE_BENCH_OWNER'] ?? 'modelcontextprotocol';
const GITHUB_REPO = process.env['SPECULATE_BENCH_REPO'] ?? 'servers';

/**
 * GitHub's hosted MCP server: an issue-and-PR triage session.
 *
 * Tool names are read from the server rather than assumed, because hosted
 * servers rename and consolidate (this one exposes `issue_read`, not the
 * classic `get_issue`), which is also why no bundled profile matches it and
 * the run below is genuinely zero-config.
 */
const github: Scenario = {
  key: 'github',
  label: 'GitHub hosted MCP',
  url: process.env['SPECULATE_REMOTE_URL'] ?? 'https://api.githubcopilot.com/mcp/',
  tokenEnv: 'GITHUB_TOKEN',
  needTools: ['list_issues', 'issue_read', 'list_pull_requests', 'pull_request_read'],
  describe: (ctx) => `repository ${String(ctx['owner'])}/${String(ctx['repo'])}`,
  async plan(call) {
    const repo = { owner: GITHUB_OWNER, repo: GITHUB_REPO };
    const issues = extractNumbers(
      resultText(await call('list_issues', { ...repo, state: 'OPEN', perPage: 10 })),
      'issues',
    ).slice(0, 2);
    const pulls = extractNumbers(
      resultText(await call('list_pull_requests', { ...repo, state: 'open', perPage: 10 })),
      null,
    );
    if (issues.length < 2 || pulls.length < 1) {
      throw new Error(
        `${GITHUB_OWNER}/${GITHUB_REPO} needs at least 2 open issues and 1 open PR for this ` +
          `session (found ${issues.length} and ${pulls.length}); pass --owner/--repo`,
      );
    }
    return { ...repo, issues, pull: pulls[0]! };
  },
  script(ctx) {
    const repo = { owner: ctx['owner'], repo: ctx['repo'] };
    const [first, second] = ctx['issues'] as [number, number];
    const pull = ctx['pull'] as number;
    return [
      { kind: 'turn', label: `user: "what is open on ${String(ctx['owner'])}/${String(ctx['repo'])}?"` },
      { kind: 'call', tool: 'list_issues', args: { ...repo, state: 'OPEN', perPage: 10 } },
      { kind: 'think', ms: 1000 },
      { kind: 'call', tool: 'issue_read', args: { ...repo, method: 'get', issue_number: first } },
      { kind: 'think', ms: 1200 },
      { kind: 'call', tool: 'issue_read', args: { ...repo, method: 'get_comments', issue_number: first } },
      { kind: 'turn', label: 'user: "and the next one?"', ms: 2000 },
      { kind: 'call', tool: 'issue_read', args: { ...repo, method: 'get', issue_number: second } },
      { kind: 'think', ms: 1200 },
      { kind: 'call', tool: 'issue_read', args: { ...repo, method: 'get_comments', issue_number: second } },
      { kind: 'turn', label: 'user: "any pull requests in flight?"', ms: 2000 },
      { kind: 'call', tool: 'list_pull_requests', args: { ...repo, state: 'open', perPage: 10 } },
      { kind: 'think', ms: 1000 },
      { kind: 'call', tool: 'pull_request_read', args: { ...repo, method: 'get', pullNumber: pull } },
      { kind: 'think', ms: 1200 },
      { kind: 'call', tool: 'pull_request_read', args: { ...repo, method: 'get_files', pullNumber: pull } },
    ];
  },
};

/** `### owner/name` headings out of the Hub's markdown search results. */
function extractRepoIds(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^###\s+(\S+\/\S+)\s*$/.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * The Hugging Face Hub: browsing models, then reading two of them.
 *
 * The one scenario here that needs NO credential, which makes it the one
 * anybody can reproduce. It is also the harder case for prediction, and
 * deliberately kept: results come back as MARKDOWN, so the learner cannot
 * parse an id out of the previous result the way it can with JSON. What is
 * left is memorising arguments across repeats, which is exactly the "second
 * and third pass through the same workflow" this tool claims to help with.
 */
const huggingface: Scenario = {
  key: 'huggingface',
  label: 'Hugging Face Hub MCP',
  url: 'https://huggingface.co/mcp',
  tokenEnv: null,
  needTools: ['hub_repo_search', 'hub_repo_details'],
  describe: (ctx) => `queries ${(ctx['queries'] as string[]).map((q) => `"${q}"`).join(' then ')}`,
  async plan(call) {
    const queries = ['text classification', 'summarization'];
    const picked: string[][] = [];
    for (const query of queries) {
      const ids = extractRepoIds(
        resultText(await call('hub_repo_search', { query, repo_types: ['model'], limit: 5 })),
      ).slice(0, 2);
      if (ids.length < 2) {
        throw new Error(`hub_repo_search("${query}") returned ${ids.length} usable repo ids, need 2`);
      }
      picked.push(ids);
    }
    return { queries, picked };
  },
  script(ctx) {
    const queries = ctx['queries'] as string[];
    const picked = ctx['picked'] as string[][];
    const steps: ScriptStep[] = [];
    queries.forEach((query, i) => {
      const [a, b] = picked[i] as [string, string];
      steps.push({ kind: 'turn', label: `user: "find me models for ${query}"`, ms: i === 0 ? undefined : 2000 });
      steps.push({
        kind: 'call',
        tool: 'hub_repo_search',
        args: { query, repo_types: ['model'], limit: 5 },
      });
      steps.push({ kind: 'think', ms: 1000 });
      steps.push({ kind: 'call', tool: 'hub_repo_details', args: { repo_ids: [a], repo_type: 'model' } });
      steps.push({ kind: 'think', ms: 1200 });
      steps.push({ kind: 'call', tool: 'hub_repo_details', args: { repo_ids: [b], repo_type: 'model' } });
    });
    return steps;
  },
};

export const SCENARIOS: Record<string, Scenario> = { github, huggingface };
