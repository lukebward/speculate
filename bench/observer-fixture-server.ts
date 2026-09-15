import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const alias = process.env.SPECULATE_OBSERVER_FIXTURE_ALIAS ?? 'fixture';
const latencyMs = Number(process.env.SPECULATE_OBSERVER_FIXTURE_LATENCY_MS ?? '400');
const callLog = process.env.SPECULATE_OBSERVER_FIXTURE_CALL_LOG;
const tools = JSON.parse(process.env.SPECULATE_OBSERVER_FIXTURE_TOOLS ?? '[]') as string[];
let revision = 0;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const server = new McpServer({ name: `observer-${alias}`, version: '1.0.0' });

for (const tool of [...new Set(tools)]) {
  const inputSchema: Record<string, z.ZodType> = tool === 'list_directory' ? { path: z.string() } : { key: z.string() };
  server.registerTool(
    tool,
    {
      inputSchema,
      annotations: { readOnlyHint: tool !== 'write_file' },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const startedAt = performance.timeOrigin + performance.now();
      await delay(latencyMs);
      if (tool === 'write_file') revision++;
      const payload = { alias, tool, ...args, revision, ok: true };
      const completedAt = performance.timeOrigin + performance.now();
      if (callLog) {
        appendFileSync(callLog, `${JSON.stringify({
          alias,
          tool,
          argsDigest: digest(args),
          resultDigest: digest(payload),
          startedAt,
          completedAt,
        })}\n`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  );
}

await server.connect(new StdioServerTransport());
