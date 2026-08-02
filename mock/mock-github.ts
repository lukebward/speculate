/**
 * mock-github — a stand-in for the GitHub MCP server, spoken over stdio.
 *
 * Used by Speculate's integration tests and the terminal demo. Serves the
 * fixture repo acme/api (mock/fixtures.ts) and mirrors github-mcp-server's
 * result format: one text content block whose text is JSON.
 *
 * Env knobs:
 *   SPECULATE_MOCK_LATENCY_MS  per-call injected latency in ms (default 300),
 *                              awaited by every tool handler before returning.
 *   SPECULATE_MOCK_LATENCY_BY_TOOL
 *                              JSON object of tool name -> ms, overriding the
 *                              flat latency for those tools only. Real servers
 *                              are not uniform (a PR diff is not a get_issue),
 *                              and a uniform mock has nothing to prioritize.
 *                              Unset (the default) leaves behaviour identical.
 *   SPECULATE_MOCK_CALL_LOG    when set, appends one JSON line per tool call
 *                              ({"tool", "args", "t"}) BEFORE the latency delay.
 *
 * Run: tsx mock/mock-github.ts   (stdout is reserved for the MCP protocol;
 * informational messages go to stderr.)
 */
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  addIssueComment,
  createIssue,
  getFileContents,
  getIssue,
  getIssueComments,
  getPullRequest,
  getPullRequestDiff,
  isKnownRepo,
  listIssues,
  listPullRequests,
  mergePullRequest,
} from './fixtures.js';

const DEFAULT_LATENCY_MS = 300;

function resolveLatencyMs(): number {
  const raw = process.env.SPECULATE_MOCK_LATENCY_MS;
  if (raw === undefined || raw === '') return DEFAULT_LATENCY_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LATENCY_MS;
  return Math.max(0, parsed);
}

/** Per-tool overrides; malformed input is ignored (the flat latency stands). */
function resolveLatencyByTool(): Record<string, number> {
  const raw = process.env.SPECULATE_MOCK_LATENCY_BY_TOOL;
  if (raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [tool, ms] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) out[tool] = ms;
    }
    return out;
  } catch {
    return {};
  }
}

const LATENCY_MS = resolveLatencyMs();
const LATENCY_BY_TOOL = resolveLatencyByTool();

function latencyFor(tool: string): number {
  return Object.prototype.hasOwnProperty.call(LATENCY_BY_TOOL, tool)
    ? LATENCY_BY_TOOL[tool]!
    : LATENCY_MS;
}

function logCall(tool: string, args: Record<string, unknown>): void {
  const logPath = process.env.SPECULATE_MOCK_CALL_LOG;
  if (!logPath) return;
  // Synchronous append so the line is durable before the latency delay.
  appendFileSync(logPath, `${JSON.stringify({ tool, args, t: Date.now() })}\n`);
}

function delay(tool: string): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, latencyFor(tool)));
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function notFound(details: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: 'not found', ...details }) }],
  };
}

/**
 * Shared per-call plumbing: log the call (synchronously, before the delay),
 * await the injected latency, then produce the result. Mutations happen
 * inside `produce`, i.e. after the latency window — like a real server.
 */
async function respond(
  tool: string,
  args: Record<string, unknown>,
  produce: () => CallToolResult,
): Promise<CallToolResult> {
  logCall(tool, args);
  await delay(tool);
  return produce();
}

const repoParams = {
  owner: z.string(),
  repo: z.string(),
};

const stateFilter = z.enum(['open', 'closed', 'all']).optional();

function buildServer(): McpServer {
  const server = new McpServer({ name: 'mock-github', version: '0.1.0' });

  // ------------------------------------------------------------------ reads

  server.registerTool(
    'get_issue',
    {
      description: 'Get details of a specific issue in a GitHub repository.',
      inputSchema: { ...repoParams, issue_number: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, issue_number }) =>
      respond('get_issue', { owner, repo, issue_number }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const issue = getIssue(issue_number);
        if (!issue) return notFound({ owner, repo, issue_number });
        return ok({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          body: issue.body,
          labels: issue.labels,
          comments_count: issue.comments_count,
        });
      }),
  );

  server.registerTool(
    'get_issue_comments',
    {
      description: 'Get comments for a specific issue in a GitHub repository.',
      inputSchema: { ...repoParams, issue_number: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, issue_number }) =>
      respond('get_issue_comments', { owner, repo, issue_number }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const comments = getIssueComments(issue_number);
        if (!comments) return notFound({ owner, repo, issue_number });
        return ok(comments.map(({ id, user, body }) => ({ id, user, body })));
      }),
  );

  server.registerTool(
    'list_issues',
    {
      description: "List issues in a GitHub repository, filtered by state (default 'open').",
      inputSchema: { ...repoParams, state: stateFilter },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, state }) =>
      respond('list_issues', { owner, repo, state }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const issues = listIssues(state ?? 'open');
        return ok(issues.map(({ number, title, state: issueState }) => ({ number, title, state: issueState })));
      }),
  );

  server.registerTool(
    'list_pull_requests',
    {
      description: "List pull requests in a GitHub repository, filtered by state (default 'open').",
      inputSchema: { ...repoParams, state: stateFilter },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, state }) =>
      respond('list_pull_requests', { owner, repo, state }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const pulls = listPullRequests(state ?? 'open');
        return ok(
          pulls.map(({ number, title, state: prState, head_ref }) => ({
            number,
            title,
            state: prState,
            head_ref,
          })),
        );
      }),
  );

  server.registerTool(
    'get_pull_request',
    {
      description: 'Get details of a specific pull request in a GitHub repository.',
      inputSchema: { ...repoParams, pull_number: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, pull_number }) =>
      respond('get_pull_request', { owner, repo, pull_number }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const pr = getPullRequest(pull_number);
        if (!pr) return notFound({ owner, repo, pull_number });
        return ok({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          head_ref: pr.head_ref,
          base_ref: pr.base_ref,
          body: pr.body,
          changed_files: pr.changed_files,
        });
      }),
  );

  server.registerTool(
    'get_pull_request_diff',
    {
      description: 'Get the unified diff of a pull request.',
      inputSchema: { ...repoParams, pull_number: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, pull_number }) =>
      respond('get_pull_request_diff', { owner, repo, pull_number }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const diff = getPullRequestDiff(pull_number);
        if (diff === undefined) return notFound({ owner, repo, pull_number });
        return ok({ number: pull_number, diff });
      }),
  );

  server.registerTool(
    'get_file_contents',
    {
      description: 'Get the contents of a file in a GitHub repository.',
      inputSchema: { ...repoParams, path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, path }) =>
      respond('get_file_contents', { owner, repo, path }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const content = getFileContents(path);
        if (content === undefined) return notFound({ owner, repo, path });
        return ok({ path, content });
      }),
  );

  // ----------------------------------------------------------------- writes

  server.registerTool(
    'create_issue',
    {
      description: 'Create a new issue in a GitHub repository.',
      inputSchema: { ...repoParams, title: z.string(), body: z.string().optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ owner, repo, title, body }) =>
      respond('create_issue', { owner, repo, title, body }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const issue = createIssue(title, body);
        return ok({ number: issue.number, title: issue.title, state: issue.state });
      }),
  );

  server.registerTool(
    'add_issue_comment',
    {
      description: 'Add a comment to a specific issue in a GitHub repository.',
      inputSchema: { ...repoParams, issue_number: z.number(), body: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ owner, repo, issue_number, body }) =>
      respond('add_issue_comment', { owner, repo, issue_number, body }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const comment = addIssueComment(issue_number, body);
        if (!comment) return notFound({ owner, repo, issue_number });
        return ok({ id: comment.id });
      }),
  );

  server.registerTool(
    'merge_pull_request',
    {
      description: 'Merge a pull request in a GitHub repository.',
      inputSchema: { ...repoParams, pull_number: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ owner, repo, pull_number }) =>
      respond('merge_pull_request', { owner, repo, pull_number }, () => {
        if (!isKnownRepo(owner, repo)) return notFound({ owner, repo });
        const pr = mergePullRequest(pull_number);
        if (!pr) return notFound({ owner, repo, pull_number });
        return ok({ number: pr.number, merged: true });
      }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; informational output goes to stderr.
  console.error(`[mock-github] ready on stdio (latency ${LATENCY_MS}ms)`);
}

main().catch((error: unknown) => {
  console.error('[mock-github] fatal:', error);
  process.exit(1);
});
