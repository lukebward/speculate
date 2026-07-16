/**
 * mock-slack — a stand-in for the classic @modelcontextprotocol/server-slack,
 * spoken over stdio. Mirrors its tool names and result shape: Slack Web API
 * JSON serialized into one text content block.
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

interface Message {
  type: 'message';
  ts: string;
  user: string;
  text: string;
  reply_count?: number;
}

const channels = [
  { id: 'C0001', name: 'general', topic: 'Company-wide chatter', num_members: 42 },
  { id: 'C0002', name: 'eng', topic: 'Engineering', num_members: 17 },
];

const historyByChannel = new Map<string, Message[]>([
  [
    'C0001',
    [
      { type: 'message', ts: '1752500000.000100', user: 'U100', text: 'Deploy done', reply_count: 2 },
      { type: 'message', ts: '1752490000.000200', user: 'U200', text: 'Lunch?' },
    ],
  ],
  [
    'C0002',
    [
      { type: 'message', ts: '1752480000.000300', user: 'U200', text: 'Rate limiter fix is up', reply_count: 1 },
      { type: 'message', ts: '1752470000.000400', user: 'U100', text: 'CI is green again' },
    ],
  ],
]);

const repliesByThread = new Map<string, Message[]>([
  [
    'C0001:1752500000.000100',
    [
      { type: 'message', ts: '1752500000.000100', user: 'U100', text: 'Deploy done' },
      { type: 'message', ts: '1752500100.000110', user: 'U200', text: 'Nice — metrics look flat' },
      { type: 'message', ts: '1752500200.000120', user: 'U100', text: 'Rolling to prod-2 next' },
    ],
  ],
  [
    'C0002:1752480000.000300',
    [
      { type: 'message', ts: '1752480000.000300', user: 'U200', text: 'Rate limiter fix is up' },
      { type: 'message', ts: '1752480100.000310', user: 'U100', text: 'Reviewing now' },
    ],
  ],
]);

const users = [
  { id: 'U100', name: 'mara', real_name: 'Mara Quinn' },
  { id: 'U200', name: 'devon', real_name: 'Devon Reyes' },
];

const profiles = new Map<string, Record<string, string>>([
  ['U100', { real_name: 'Mara Quinn', display_name: 'mara', email: 'mara@example.test' }],
  ['U200', { real_name: 'Devon Reyes', display_name: 'devon', email: 'devon@example.test' }],
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

const ok = (payload: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});
const err = (error: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
});

function buildServer(): McpServer {
  const server = new McpServer({ name: 'mock-slack', version: '0.1.0' });

  // ------------------------------------------------------------------ reads

  server.registerTool(
    'slack_list_channels',
    {
      description: 'List public channels in the workspace.',
      inputSchema: { limit: z.number().optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      respond('slack_list_channels', { limit }, () =>
        ok({
          ok: true,
          channels: channels.slice(0, limit ?? channels.length),
          response_metadata: { next_cursor: '' },
        }),
      ),
  );

  server.registerTool(
    'slack_get_channel_history',
    {
      description: 'Recent messages from a channel.',
      inputSchema: { channel_id: z.string(), limit: z.number().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, limit }) =>
      respond('slack_get_channel_history', { channel_id, limit }, () => {
        const messages = historyByChannel.get(channel_id);
        if (!messages) return err('channel_not_found');
        return ok({ ok: true, messages: messages.slice(0, limit ?? messages.length) });
      }),
  );

  server.registerTool(
    'slack_get_thread_replies',
    {
      description: 'All replies in a message thread.',
      inputSchema: { channel_id: z.string(), thread_ts: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, thread_ts }) =>
      respond('slack_get_thread_replies', { channel_id, thread_ts }, () => {
        const messages = repliesByThread.get(`${channel_id}:${thread_ts}`);
        if (!messages) return err('thread_not_found');
        return ok({ ok: true, messages });
      }),
  );

  server.registerTool(
    'slack_get_users',
    {
      description: 'List workspace users.',
      inputSchema: { limit: z.number().optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      respond('slack_get_users', { limit }, () =>
        ok({ ok: true, members: users.slice(0, limit ?? users.length) }),
      ),
  );

  server.registerTool(
    'slack_get_user_profile',
    {
      description: "A user's profile information.",
      inputSchema: { user_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ user_id }) =>
      respond('slack_get_user_profile', { user_id }, () => {
        const profile = profiles.get(user_id);
        if (!profile) return err('user_not_found');
        return ok({ ok: true, profile });
      }),
  );

  // ----------------------------------------------------------------- writes

  server.registerTool(
    'slack_post_message',
    {
      description: 'Post a new message to a channel.',
      inputSchema: { channel_id: z.string(), text: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ channel_id, text }) =>
      respond('slack_post_message', { channel_id, text }, () => {
        const messages = historyByChannel.get(channel_id);
        if (!messages) return err('channel_not_found');
        const ts = `${Math.max(...messages.map((m) => Number(m.ts.split('.')[0]))) + 100}.000900`;
        messages.unshift({ type: 'message', ts, user: 'U999', text });
        return ok({ ok: true, ts });
      }),
  );

  server.registerTool(
    'slack_reply_to_thread',
    {
      description: 'Reply to a message thread.',
      inputSchema: { channel_id: z.string(), thread_ts: z.string(), text: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ channel_id, thread_ts, text }) =>
      respond('slack_reply_to_thread', { channel_id, thread_ts, text }, () => {
        const key = `${channel_id}:${thread_ts}`;
        const thread = repliesByThread.get(key);
        if (!thread) return err('thread_not_found');
        const ts = `${Number(thread_ts.split('.')[0]) + thread.length * 100}.000910`;
        thread.push({ type: 'message', ts, user: 'U999', text });
        const root = historyByChannel.get(channel_id)?.find((m) => m.ts === thread_ts);
        if (root) root.reply_count = (root.reply_count ?? 0) + 1;
        return ok({ ok: true, ts });
      }),
  );

  server.registerTool(
    'slack_add_reaction',
    {
      description: 'Add an emoji reaction to a message.',
      inputSchema: { channel_id: z.string(), timestamp: z.string(), reaction: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ channel_id, timestamp, reaction }) =>
      respond('slack_add_reaction', { channel_id, timestamp, reaction }, () =>
        ok({ ok: true }),
      ),
  );

  return server;
}

async function main(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
  console.error(`[mock-slack] ready on stdio (latency ${LATENCY_MS}ms)`);
}

main().catch((error: unknown) => {
  console.error('[mock-slack] fatal:', error);
  process.exit(1);
});
