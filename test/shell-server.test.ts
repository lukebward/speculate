/**
 * Security-focused integration tests for shell/speculate-shell.ts.
 *
 * Talks real MCP over stdio (same pattern as mock-github.test.ts): spawns the
 * server with tsx against a throwaway git fixture repo, then exercises:
 *  - functional round-trips for every tool,
 *  - argument-injection rejection (nothing user-supplied may become a flag),
 *  - workspace path containment,
 *  - the read-only invariant (no writes anywhere in the fixture),
 *  - tool annotations and the non-git-workspace tool surface,
 *  - zod schema boundaries.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const TEST_TIMEOUT_MS = 20_000;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NEEDLE = 'SPECULATE_NEEDLE_7f3a9c';
const COMMIT_1_SUBJECT = 'initial fixture commit';
const COMMIT_2_SUBJECT = 'second: update alpha';

const ALL_TOOLS = [
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'list_dir',
  'search',
] as const;

/** Attacker-goal file paths; asserted to never come into existence. */
const PWNED_OUTPUT = '/tmp/speculate-pwned';
const PWNED_TOUCH = '/tmp/speculate-shell-test-touched';

let client: Client;
let fixtureDir: string;

/** Env for the spawned server and for direct git invocations in tests:
 * inherit PATH etc., but isolate from any host git config and keep our own
 * direct git calls from writing the index (GIT_OPTIONAL_LOCKS). */
function isolatedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function gitInFixture(args: string[]): string {
  return execFileSync('git', args, { cwd: fixtureDir, env: isolatedEnv(), encoding: 'utf8' });
}

async function callTool(tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
}

/** Extract and parse the JSON payload from the single text content block. */
function textPayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`);
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Assert an isError result whose {error} message matches the pattern. */
function expectCleanError(result: CallToolResult, pattern: RegExp): void {
  expect(result.isError).toBe(true);
  const payload = textPayload(result);
  expect(typeof payload.error).toBe('string');
  expect(payload.error as string).toMatch(pattern);
}

/** Call a tool expecting the schema layer to reject: either a JSON-RPC
 * error (client throws) or an isError result — the call must not succeed. */
async function expectSchemaRejection(tool: string, args: Record<string, unknown>): Promise<void> {
  let result: CallToolResult;
  try {
    result = await callTool(tool, args);
  } catch {
    return; // rejected at the protocol layer (McpError / InvalidParams)
  }
  expect(result.isError, `${tool}(${JSON.stringify(args)}) must not succeed`).toBe(true);
}

/** Recursive listing of relative paths (+ file sizes) — write detection. */
function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = path.relative(dir, abs);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else if (entry.isFile()) {
        out.push(`${rel}:${statSync(abs).size}`);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

async function connectServer(workspace: string): Promise<Client> {
  const c = new Client({ name: 'shell-server-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'node_modules/.bin/tsx',
      'shell/speculate-shell.ts',
      '--cwd',
      workspace,
      '--no-watch',
    ],
    cwd: projectRoot,
    env: isolatedEnv(),
  });
  await c.connect(transport);
  return c;
}

describe('speculate-shell MCP server', () => {
  beforeAll(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'speculate-shell-fixture-'));
    const env = isolatedEnv();
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: fixtureDir, env, encoding: 'utf8' });

    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Fixture Tester']);

    // Commit 1: three files; README carries the distinctive searchable
    // string on line 2, alpha.ts carries a leading-dash searchable token.
    mkdirSync(path.join(fixtureDir, 'src'));
    mkdirSync(path.join(fixtureDir, 'sub'));
    writeFileSync(path.join(fixtureDir, 'README.md'), `# fixture repo\nneedle: ${NEEDLE}\n`);
    writeFileSync(
      path.join(fixtureDir, 'src', 'alpha.ts'),
      'export const alpha = 1;\n// -dashpattern-token lives here\n',
    );
    writeFileSync(path.join(fixtureDir, 'sub', 'nested.txt'), 'nested file content\n');
    git(['add', '-A']);
    git(['commit', '-m', COMMIT_1_SUBJECT]);

    // Commit 2: touches only src/alpha.ts.
    writeFileSync(
      path.join(fixtureDir, 'src', 'alpha.ts'),
      'export const alpha = 1;\n// -dashpattern-token lives here\nexport const beta = 2;\n',
    );
    git(['add', 'src/alpha.ts']);
    git(['commit', '-m', COMMIT_2_SUBJECT]);

    // Leave README.md modified (uncommitted) and scratch.tmp untracked.
    writeFileSync(
      path.join(fixtureDir, 'README.md'),
      `# fixture repo\nneedle: ${NEEDLE}\nappended uncommitted line\n`,
    );
    writeFileSync(path.join(fixtureDir, 'scratch.tmp'), 'untracked scratch\n');

    client = await connectServer(fixtureDir);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (client) await client.close();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(PWNED_OUTPUT, { force: true });
    rmSync(PWNED_TOUCH, { force: true });
  }, TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // 1. Functional round-trips
  // -------------------------------------------------------------------------

  test(
    'git_status parses branch, the modified file (unstaged), and the untracked file',
    async () => {
      const result = await callTool('git_status');
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as {
        branch: string;
        entries: Array<{ path: string; status: string; staged: boolean }>;
      };
      expect(payload.branch).toBe('main');
      expect(Array.isArray(payload.entries)).toBe(true);

      const modified = payload.entries.find((e) => e.path === 'README.md');
      expect(modified, 'README.md should appear as modified').toBeDefined();
      expect(modified?.staged).toBe(false);
      expect(modified?.status).toContain('M');

      const untracked = payload.entries.find((e) => e.path === 'scratch.tmp');
      expect(untracked, 'scratch.tmp should appear as untracked').toBeDefined();
      expect(untracked?.status).toBe('??');
      expect(untracked?.staged).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_diff returns the modified file hunk',
    async () => {
      const result = await callTool('git_diff');
      expect(result.isError).toBeFalsy();
      const { diff } = textPayload(result) as { diff: string };
      expect(diff).toContain('diff --git a/README.md b/README.md');
      expect(diff).toContain('+appended uncommitted line');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_diff staged=true is empty when nothing is staged',
    async () => {
      const result = await callTool('git_diff', { staged: true });
      expect(result.isError).toBeFalsy();
      const { diff } = textPayload(result) as { diff: string };
      expect(diff.trim()).toBe('');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_log returns 2 commits newest-first with 40-char shas and subjects',
    async () => {
      const result = await callTool('git_log');
      expect(result.isError).toBeFalsy();
      const { commits } = textPayload(result) as {
        commits: Array<{ sha: string; authorName: string; date: string; subject: string }>;
      };
      expect(commits).toHaveLength(2);
      expect(commits[0]?.subject).toBe(COMMIT_2_SUBJECT);
      expect(commits[1]?.subject).toBe(COMMIT_1_SUBJECT);
      for (const commit of commits) {
        expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(commit.authorName).toBe('Fixture Tester');
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_show HEAD returns text containing the second commit subject',
    async () => {
      const result = await callTool('git_show', { ref: 'HEAD' });
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as { ref: string; text: string };
      expect(payload.ref).toBe('HEAD');
      expect(payload.text).toContain(COMMIT_2_SUBJECT);
      expect(payload.text).toContain('src/alpha.ts');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_show with the full 40-char sha of commit 1 works',
    async () => {
      const logPayload = textPayload(await callTool('git_log')) as {
        commits: Array<{ sha: string }>;
      };
      const firstSha = logPayload.commits[1]?.sha;
      expect(firstSha).toMatch(/^[0-9a-f]{40}$/);

      const result = await callTool('git_show', { ref: firstSha });
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as { text: string };
      expect(payload.text).toContain(COMMIT_1_SUBJECT);
      expect(payload.text).toContain(NEEDLE); // README added in commit 1's patch
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_branch marks main as current',
    async () => {
      const result = await callTool('git_branch');
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as {
        current: string;
        branches: Array<{ name: string; sha: string; current: boolean }>;
      };
      expect(payload.current).toBe('main');
      const main = payload.branches.find((b) => b.name === 'main');
      expect(main?.current).toBe(true);
      expect(main?.sha.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'list_dir returns files with type and sizeBytes',
    async () => {
      const result = await callTool('list_dir');
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as {
        path: string;
        entries: Array<{ name: string; type: string; sizeBytes?: number }>;
      };
      expect(payload.path).toBe('.');
      const byName = new Map(payload.entries.map((e) => [e.name, e]));

      const readme = byName.get('README.md');
      expect(readme?.type).toBe('file');
      expect(typeof readme?.sizeBytes).toBe('number');
      expect(readme?.sizeBytes).toBeGreaterThan(0);

      expect(byName.get('src')?.type).toBe('dir');
      expect(byName.get('sub')?.type).toBe('dir');
      expect(byName.get('scratch.tmp')?.type).toBe('file');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'search finds the distinctive string with correct file and line',
    async () => {
      const result = await callTool('search', { pattern: NEEDLE });
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as {
        matches: Array<{ file: string; line: number; text: string }>;
        truncated: boolean;
      };
      expect(payload.truncated).toBe(false);
      expect(payload.matches).toHaveLength(1);
      // rg echoes the search path as given ('.'), so files come back './'-prefixed.
      expect(payload.matches[0]?.file.replace(/^\.\//, '')).toBe('README.md');
      expect(payload.matches[0]?.line).toBe(2);
      expect(payload.matches[0]?.text).toContain(NEEDLE);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'search glob filter includes and excludes correctly',
    async () => {
      const md = textPayload(await callTool('search', { pattern: NEEDLE, glob: '*.md' })) as {
        matches: Array<{ file: string }>;
      };
      expect(md.matches).toHaveLength(1);
      expect(md.matches[0]?.file.replace(/^\.\//, '')).toBe('README.md');

      const tsResult = await callTool('search', { pattern: NEEDLE, glob: '*.ts' });
      expect(tsResult.isError).toBeFalsy();
      const ts = textPayload(tsResult) as { matches: unknown[]; truncated: boolean };
      expect(ts.matches).toEqual([]);
      expect(ts.truncated).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'search for a nonexistent string returns empty matches, not an error (rg exit 1)',
    async () => {
      const result = await callTool('search', { pattern: 'ZZZ_NO_SUCH_STRING_1a2b3c4d5e' });
      expect(result.isError).toBeFalsy();
      expect(textPayload(result)).toEqual({ matches: [], truncated: false });
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 2. Argument-injection rejection
  // -------------------------------------------------------------------------

  test(
    "git_show ref '--output=/tmp/speculate-pwned' is rejected and writes no file",
    async () => {
      rmSync(PWNED_OUTPUT, { force: true });
      const result = await callTool('git_show', { ref: `--output=${PWNED_OUTPUT}` });
      expectCleanError(result, /invalid ref/);
      expect(existsSync(PWNED_OUTPUT)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "git_show ref '-v' is rejected",
    async () => {
      expectCleanError(await callTool('git_show', { ref: '-v' }), /invalid ref/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "git_show ref 'HEAD; rm -rf /' is rejected (space/semicolon)",
    async () => {
      expectCleanError(await callTool('git_show', { ref: 'HEAD; rm -rf /' }), /invalid ref/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "git_show ref '$(touch ...)' is rejected and never executes",
    async () => {
      rmSync(PWNED_TOUCH, { force: true });
      const result = await callTool('git_show', { ref: `$(touch ${PWNED_TOUCH})` });
      expectCleanError(result, /invalid ref/);
      expect(existsSync(PWNED_TOUCH)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "git_diff path '--output=evil' is rejected (leading dash)",
    async () => {
      expectCleanError(await callTool('git_diff', { path: '--output=evil' }), /invalid path/);
      expect(existsSync(path.join(fixtureDir, 'evil'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "search glob '--pre=/bin/sh' is rejected (leading dash)",
    async () => {
      expectCleanError(
        await callTool('search', { pattern: NEEDLE, glob: '--pre=/bin/sh' }),
        /invalid glob/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'search pattern starting with a dash works safely (goes after --)',
    async () => {
      const result = await callTool('search', { pattern: '-dashpattern' });
      expect(result.isError).toBeFalsy();
      const payload = textPayload(result) as {
        matches: Array<{ file: string; line: number; text: string }>;
      };
      // Not a flag error and not rg misbehavior: the literal '-dashpattern'
      // token in src/alpha.ts must be found.
      expect(payload.matches.length).toBeGreaterThanOrEqual(1);
      const hit = payload.matches.find((m) => m.file.replace(/^\.\//, '') === 'src/alpha.ts');
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(2);
      expect(hit?.text).toContain('-dashpattern-token');
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 3. Path containment
  // -------------------------------------------------------------------------

  test(
    "git_diff path '../outside' is rejected as escaping the workspace",
    async () => {
      expectCleanError(
        await callTool('git_diff', { path: '../outside' }),
        /escapes the workspace/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "list_dir path '/etc' is rejected",
    async () => {
      expectCleanError(await callTool('list_dir', { path: '/etc' }), /escapes the workspace/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "list_dir path '../' is rejected",
    async () => {
      expectCleanError(await callTool('list_dir', { path: '../' }), /escapes the workspace/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_log path containing a NUL byte is rejected',
    async () => {
      expectCleanError(await callTool('git_log', { path: 'sub\0nested.txt' }), /NUL/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a legitimate nested relative path works',
    async () => {
      const logResult = await callTool('git_log', { path: 'sub/nested.txt' });
      expect(logResult.isError).toBeFalsy();
      const { commits } = textPayload(logResult) as { commits: Array<{ subject: string }> };
      expect(commits).toHaveLength(1);
      expect(commits[0]?.subject).toBe(COMMIT_1_SUBJECT);

      const dirResult = await callTool('list_dir', { path: 'sub' });
      expect(dirResult.isError).toBeFalsy();
      const dirPayload = textPayload(dirResult) as {
        path: string;
        entries: Array<{ name: string; type: string }>;
      };
      expect(dirPayload.path).toBe('sub');
      expect(dirPayload.entries).toHaveLength(1);
      expect(dirPayload.entries[0]?.name).toBe('nested.txt');
      expect(dirPayload.entries[0]?.type).toBe('file');
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 4. Read-only invariant
  // -------------------------------------------------------------------------

  test(
    'repeated read tools leave the fixture byte-for-byte unchanged',
    async () => {
      const statusBefore = gitInFixture(['status', '--porcelain']);
      const treeBefore = snapshotTree(fixtureDir);

      for (let i = 0; i < 3; i++) {
        await callTool('git_status');
        await callTool('git_diff');
        await callTool('git_diff', { staged: true });
        await callTool('git_log', { count: 5 });
        await callTool('git_show', { ref: 'HEAD' });
        await callTool('git_branch');
        await callTool('search', { pattern: NEEDLE });
        await callTool('list_dir');
      }

      const statusAfter = gitInFixture(['status', '--porcelain']);
      const treeAfter = snapshotTree(fixtureDir);

      expect(statusAfter).toBe(statusBefore);
      expect(treeAfter).toEqual(treeBefore);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 5. Tool annotations
  // -------------------------------------------------------------------------

  test(
    'all 7 tools are listed with readOnlyHint === true',
    async () => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(new Set(byName.keys())).toEqual(new Set(ALL_TOOLS));
      expect(tools).toHaveLength(7);
      for (const name of ALL_TOOLS) {
        expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 6. Non-git workspace
  // -------------------------------------------------------------------------

  test(
    'a non-git workspace exposes list_dir and search but no git_* tools',
    async () => {
      const plainDir = mkdtempSync(path.join(os.tmpdir(), 'speculate-shell-plain-'));
      writeFileSync(path.join(plainDir, 'plain.txt'), 'just a file\n');
      let plainClient: Client | undefined;
      try {
        plainClient = await connectServer(plainDir);
        const { tools } = await plainClient.listTools();
        const names = tools.map((tool) => tool.name).sort();
        expect(names).toEqual(['list_dir', 'search']);
        expect(names.some((n) => n.startsWith('git_'))).toBe(false);
      } finally {
        if (plainClient) await plainClient.close();
        rmSync(plainDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 7. Zod boundary
  // -------------------------------------------------------------------------

  test(
    'git_log count 0 is rejected by the schema',
    async () => {
      await expectSchemaRejection('git_log', { count: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'git_log count 51 is rejected by the schema',
    async () => {
      await expectSchemaRejection('git_log', { count: 51 });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'search maxResults 501 is rejected by the schema',
    async () => {
      await expectSchemaRejection('search', { pattern: NEEDLE, maxResults: 501 });
    },
    TEST_TIMEOUT_MS,
  );
});
