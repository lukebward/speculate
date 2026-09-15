import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const cwd = process.cwd();
const callLog = process.env.SPECULATE_CONSUMPTION_CALL_LOG;

function pathInWorkspace(path: string): string {
  const absolute = resolve(cwd, path);
  if (absolute !== cwd && !absolute.startsWith(`${cwd}${sep}`)) throw new Error('path is outside workspace');
  return absolute;
}

function result(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

async function record(
  tool: string,
  args: Record<string, unknown>,
  run: () => CallToolResult,
): Promise<CallToolResult> {
  if (callLog) appendFileSync(callLog, `${JSON.stringify({ tool, args, cwd })}\n`);
  return run();
}

const server = new McpServer({ name: 'mcp-consumption-fixture', version: '1.0.0' });

server.registerTool(
  'list_directory',
  {
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ path }) => record('list_directory', { path }, () => result({
    tool: 'list_directory',
    cwd,
    entries: readdirSync(pathInWorkspace(path), { withFileTypes: true })
      .filter((entry) => entry.name !== '.git-status.json')
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  })),
);

server.registerTool(
  'read_file',
  {
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ path }) => record('read_file', { path }, () => result({
    tool: 'read_file',
    cwd,
    path,
    content: readFileSync(pathInWorkspace(path), 'utf8'),
  })),
);

server.registerTool(
  'git_status',
  {
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => record('git_status', {}, () => result({
    tool: 'git_status',
    cwd,
    changes: JSON.parse(readFileSync(resolve(cwd, '.git-status.json'), 'utf8')),
  })),
);

server.registerTool(
  'write_file',
  {
    inputSchema: { path: z.string(), content: z.string() },
    annotations: { readOnlyHint: false },
  },
  async ({ path, content }) => record('write_file', { path, content }, () => {
    writeFileSync(pathInWorkspace(path), content);
    return result({ tool: 'write_file', cwd, path });
  }),
);

await server.connect(new StdioServerTransport());
