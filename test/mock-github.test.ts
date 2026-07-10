/**
 * Integration test for the mock GitHub MCP server (mock/mock-github.ts).
 *
 * Talks real MCP over stdio: spawns the server with tsx, connects an SDK
 * client, and exercises the tool contract that Speculate's proxy (and its
 * github profile parsers) are built against.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const TEST_TIMEOUT_MS = 20_000;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const READ_TOOLS = [
  'get_issue',
  'get_issue_comments',
  'list_issues',
  'list_pull_requests',
  'get_pull_request',
  'get_pull_request_diff',
  'get_file_contents',
] as const;

const WRITE_TOOLS = ['create_issue', 'add_issue_comment', 'merge_pull_request'] as const;

let client: Client;
let tmpDir: string;
let callLogPath: string;

/** Every tools/call made in this suite, in order — asserted against the call log. */
const trackedCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

async function callTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  trackedCalls.push({ tool, args });
  return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
}

/** Extract and parse the JSON payload from the single text content block. */
function textPayload(result: CallToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
  }
  return JSON.parse(first.text) as unknown;
}

describe('mock-github MCP server', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'speculate-mock-github-'));
    callLogPath = path.join(tmpDir, 'calls.jsonl');

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.SPECULATE_MOCK_LATENCY_MS = '0';
    env.SPECULATE_MOCK_CALL_LOG = callLogPath;

    client = new Client({ name: 'mock-github-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['node_modules/.bin/tsx', 'mock/mock-github.ts'],
      cwd: projectRoot,
      env,
    });
    await client.connect(transport);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (client) await client.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  test(
    'lists all 10 tools with read-only annotations on reads and not on writes',
    async () => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      expect(tools).toHaveLength(10);
      expect(new Set(byName.keys())).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS]));

      for (const name of READ_TOOLS) {
        expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      }
      for (const name of WRITE_TOOLS) {
        expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
      }
      expect(byName.get('merge_pull_request')?.annotations?.destructiveHint).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'get_issue returns the documented payload',
    async () => {
      const result = await callTool('get_issue', {
        owner: 'acme',
        repo: 'api',
        issue_number: 42,
      });
      expect(result.isError).toBeFalsy();
      expect(textPayload(result)).toEqual({
        number: 42,
        title: 'Rate limiter drops burst traffic',
        state: 'open',
        body: 'Token bucket refill is off by one; see PR #7.',
        labels: ['bug', 'p1'],
        comments_count: 2,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'other read tools return the documented payload shapes',
    async () => {
      const comments = textPayload(
        await callTool('get_issue_comments', { owner: 'acme', repo: 'api', issue_number: 42 }),
      ) as Array<{ id: number; user: string; body: string }>;
      expect(comments).toHaveLength(2);
      expect(comments.map((comment) => comment.body)).toEqual([
        'Repro: 100 rps for 10s, ~3% dropped',
        'Fix in flight on fix/rate-limiter',
      ]);
      for (const comment of comments) {
        expect(typeof comment.id).toBe('number');
        expect(typeof comment.user).toBe('string');
      }

      const pr = textPayload(
        await callTool('get_pull_request', { owner: 'acme', repo: 'api', pull_number: 7 }),
      );
      expect(pr).toEqual({
        number: 7,
        title: 'Fix token bucket refill',
        state: 'open',
        head_ref: 'fix/rate-limiter',
        base_ref: 'main',
        body: 'Closes #42. Off-by-one in refill window.',
        changed_files: 3,
      });

      const diff = textPayload(
        await callTool('get_pull_request_diff', { owner: 'acme', repo: 'api', pull_number: 7 }),
      ) as { number: number; diff: string };
      expect(diff.number).toBe(7);
      expect(diff.diff).toContain('diff --git a/src/limiter.ts b/src/limiter.ts');
      expect(diff.diff).toContain('+    const refilled = Math.floor(elapsedMs / this.refillIntervalMs);');

      const file = textPayload(
        await callTool('get_file_contents', { owner: 'acme', repo: 'api', path: 'src/limiter.ts' }),
      ) as { path: string; content: string };
      expect(file.path).toBe('src/limiter.ts');
      expect(file.content).toContain('class TokenBucket');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'list_pull_requests defaults to open and returns PRs 7 and 8 only',
    async () => {
      const open = textPayload(
        await callTool('list_pull_requests', { owner: 'acme', repo: 'api' }),
      );
      expect(open).toEqual([
        { number: 7, title: 'Fix token bucket refill', state: 'open', head_ref: 'fix/rate-limiter' },
        { number: 8, title: 'Bump dependencies', state: 'open', head_ref: 'chore/deps' },
      ]);

      const all = textPayload(
        await callTool('list_pull_requests', { owner: 'acme', repo: 'api', state: 'all' }),
      ) as Array<{ number: number }>;
      expect(all.map((pr) => pr.number)).toEqual([5, 7, 8]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'create_issue round-trips through get_issue and list_issues',
    async () => {
      const created = textPayload(
        await callTool('create_issue', {
          owner: 'acme',
          repo: 'api',
          title: 'Add request tracing',
          body: 'Propagate trace ids through the middleware stack.',
        }),
      ) as { number: number; title: string; state: string };

      expect(created.title).toBe('Add request tracing');
      expect(created.state).toBe('open');
      expect(created.number).toBeGreaterThan(43);

      const fetched = textPayload(
        await callTool('get_issue', { owner: 'acme', repo: 'api', issue_number: created.number }),
      );
      expect(fetched).toEqual({
        number: created.number,
        title: 'Add request tracing',
        state: 'open',
        body: 'Propagate trace ids through the middleware stack.',
        labels: [],
        comments_count: 0,
      });

      const openIssues = textPayload(
        await callTool('list_issues', { owner: 'acme', repo: 'api' }),
      ) as Array<{ number: number }>;
      expect(openIssues.map((issue) => issue.number)).toContain(created.number);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'merge_pull_request(8) removes it from the open list',
    async () => {
      const merged = textPayload(
        await callTool('merge_pull_request', { owner: 'acme', repo: 'api', pull_number: 8 }),
      );
      expect(merged).toEqual({ number: 8, merged: true });

      const open = textPayload(
        await callTool('list_pull_requests', { owner: 'acme', repo: 'api', state: 'open' }),
      ) as Array<{ number: number }>;
      expect(open.map((pr) => pr.number)).toEqual([7]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'unknown issue and unknown repo return isError results',
    async () => {
      const missingIssue = await callTool('get_issue', {
        owner: 'acme',
        repo: 'api',
        issue_number: 999,
      });
      expect(missingIssue.isError).toBe(true);
      expect(textPayload(missingIssue)).toEqual({
        error: 'not found',
        owner: 'acme',
        repo: 'api',
        issue_number: 999,
      });

      const unknownRepo = await callTool('get_issue', {
        owner: 'evil',
        repo: 'nope',
        issue_number: 41,
      });
      expect(unknownRepo.isError).toBe(true);
      expect(textPayload(unknownRepo)).toEqual({ error: 'not found', owner: 'evil', repo: 'nope' });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'call log contains one line per call with tool and args',
    async () => {
      expect(trackedCalls.length).toBeGreaterThan(0);

      const lines = readFileSync(callLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(trackedCalls.length);

      lines.forEach((line, index) => {
        const entry = JSON.parse(line) as { tool: string; args: Record<string, unknown>; t: number };
        const expected = trackedCalls[index];
        expect(entry.tool).toBe(expected?.tool);
        expect(entry.args).toEqual(expected?.args);
        expect(typeof entry.t).toBe('number');
      });
    },
    TEST_TIMEOUT_MS,
  );
});
