/**
 * mock-filesystem — a stand-in for @modelcontextprotocol/server-filesystem,
 * spoken over stdio. Mirrors the reference server's plain-text result
 * formats: "[FILE] name" / "[DIR] name" listing lines, one-path-per-line
 * search results, text file contents.
 *
 * Env knobs (same contract as mock-github):
 *   SPECULATE_MOCK_LATENCY_MS  per-call injected latency (default 300)
 *   SPECULATE_MOCK_CALL_LOG    JSONL call log, written before the delay
 */
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const LATENCY_MS = (() => {
  const raw = process.env.SPECULATE_MOCK_LATENCY_MS;
  const parsed = raw === undefined || raw === '' ? NaN : Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 300 : Math.max(0, parsed);
})();

const ROOT = '/ws';

/** Path → contents. Directories are implied by their children. */
const files = new Map<string, string>([
  ['/ws/README.md', '# ws\n\nMock workspace for the filesystem profile.\n'],
  ['/ws/package.json', '{\n  "name": "ws",\n  "version": "1.0.0"\n}\n'],
  ['/ws/src/app.ts', 'export function main(): void {\n  console.log("app");\n}\n'],
  ['/ws/src/util.ts', 'export const clamp = (n: number) => Math.max(0, n);\n'],
  ['/ws/src/lib/limiter.ts', 'export class Limiter {\n  tokens = 10;\n}\n'],
]);

function logCall(tool: string, args: Record<string, unknown>): void {
  const logPath = process.env.SPECULATE_MOCK_CALL_LOG;
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ tool, args, t: Date.now() })}\n`);
}

async function respond(
  tool: string,
  args: Record<string, unknown>,
  produce: () => CallToolResult,
): Promise<CallToolResult> {
  logCall(tool, args);
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  return produce();
}

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});

const norm = (p: string): string =>
  p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;

function isDir(path: string): boolean {
  const prefix = path === '/' ? '/' : `${path}/`;
  return [...files.keys()].some((f) => f.startsWith(prefix));
}

/** Immediate children of `dir` as listing entries. */
function listEntries(dir: string): Array<{ type: 'FILE' | 'DIR'; name: string }> {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  const seen = new Map<string, 'FILE' | 'DIR'>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf('/');
    if (cut === -1) seen.set(rest, 'FILE');
    else if (!seen.has(rest.slice(0, cut))) seen.set(rest.slice(0, cut), 'DIR');
  }
  return [...seen.entries()]
    .map(([name, type]) => ({ type, name }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'mock-filesystem', version: '0.1.0' });
  const pathParam = { path: z.string() };

  // ------------------------------------------------------------------ reads

  const registerRead = (
    name: string,
    description: string,
    handler: (path: string) => CallToolResult,
  ): void => {
    server.registerTool(
      name,
      { description, inputSchema: pathParam, annotations: { readOnlyHint: true } },
      async ({ path }) => respond(name, { path }, () => handler(norm(path))),
    );
  };

  const readText = (path: string): CallToolResult => {
    const content = files.get(path);
    return content === undefined ? err(`ENOENT: no such file: ${path}`) : ok(content);
  };
  registerRead('read_text_file', 'Read the complete contents of a file as text.', readText);
  registerRead('read_file', 'Read the complete contents of a file.', readText);

  registerRead('list_directory', 'List directory contents with [FILE]/[DIR] prefixes.', (path) => {
    if (!isDir(path)) return err(`ENOTDIR: not a directory: ${path}`);
    return ok(listEntries(path).map((e) => `[${e.type}] ${e.name}`).join('\n'));
  });

  registerRead(
    'list_directory_with_sizes',
    'List directory contents with sizes.',
    (path) => {
      if (!isDir(path)) return err(`ENOTDIR: not a directory: ${path}`);
      return ok(
        listEntries(path)
          .map((e) =>
            e.type === 'FILE'
              ? `[FILE] ${e.name} (${files.get(`${path}/${e.name}`)?.length ?? 0} bytes)`
              : `[DIR] ${e.name}`,
          )
          .join('\n'),
      );
    },
  );

  registerRead('directory_tree', 'Recursive JSON tree of a directory.', (path) => {
    if (!isDir(path)) return err(`ENOTDIR: not a directory: ${path}`);
    const tree = (dir: string): unknown =>
      listEntries(dir).map((e) =>
        e.type === 'DIR'
          ? { name: e.name, type: 'directory', children: tree(`${dir}/${e.name}`) }
          : { name: e.name, type: 'file' },
      );
    return ok(JSON.stringify(tree(path), null, 2));
  });

  registerRead('get_file_info', 'Metadata for a file or directory.', (path) => {
    const content = files.get(path);
    if (content === undefined && !isDir(path)) return err(`ENOENT: ${path}`);
    return ok(
      [
        `size: ${content?.length ?? 0}`,
        `type: ${content === undefined ? 'directory' : 'file'}`,
        'permissions: rw-r--r--',
      ].join('\n'),
    );
  });

  server.registerTool(
    'search_files',
    {
      description: 'Recursively search for files matching a pattern.',
      inputSchema: { ...pathParam, pattern: z.string(), excludePatterns: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ path, pattern }) =>
      respond('search_files', { path, pattern }, () => {
        const base = norm(path);
        const prefix = base === '/' ? '/' : `${base}/`;
        const needle = pattern.toLowerCase();
        const matches = [...files.keys()].filter(
          (f) => f.startsWith(prefix) && f.toLowerCase().includes(needle),
        );
        return ok(matches.length > 0 ? matches.join('\n') : 'No matches found');
      }),
  );

  server.registerTool(
    'list_allowed_directories',
    {
      description: 'List the directories this server may access.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => respond('list_allowed_directories', {}, () => ok(`Allowed directories:\n${ROOT}`)),
  );

  // ----------------------------------------------------------------- writes

  server.registerTool(
    'write_file',
    {
      description: 'Create or overwrite a file.',
      inputSchema: { ...pathParam, content: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ path, content }) =>
      respond('write_file', { path, content }, () => {
        files.set(norm(path), content);
        return ok(`Successfully wrote to ${path}`);
      }),
  );

  server.registerTool(
    'move_file',
    {
      description: 'Move or rename a file.',
      inputSchema: { source: z.string(), destination: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ source, destination }) =>
      respond('move_file', { source, destination }, () => {
        const content = files.get(norm(source));
        if (content === undefined) return err(`ENOENT: ${source}`);
        files.delete(norm(source));
        files.set(norm(destination), content);
        return ok(`Successfully moved ${source} to ${destination}`);
      }),
  );

  server.registerTool(
    'create_directory',
    {
      description: 'Create a directory (and parents).',
      inputSchema: pathParam,
      annotations: { readOnlyHint: false },
    },
    async ({ path }) =>
      respond('create_directory', { path }, () => {
        files.set(`${norm(path)}/.keep`, '');
        return ok(`Successfully created directory ${path}`);
      }),
  );

  return server;
}

async function main(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
  console.error(`[mock-filesystem] ready on stdio (latency ${LATENCY_MS}ms)`);
}

main().catch((error: unknown) => {
  console.error('[mock-filesystem] fatal:', error);
  process.exit(1);
});
