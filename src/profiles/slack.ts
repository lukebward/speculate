/**
 * Vetted Slack profile (§13.15) — for the classic
 * @modelcontextprotocol/server-slack tool surface (slack_* names, Slack Web
 * API JSON serialized into one text block).
 *
 * Validated against the bundled mock (mock/mock-slack.ts), which mirrors
 * those shapes. Curation note: the allowlisted reads are Web-API history/
 * listing calls — none moves a read cursor, marks a channel read, or emits
 * user-visible activity.
 */
import type { Prediction, ResultParser, Rule, ServerProfile } from '../types.js';

const READ_ONLY_TOOLS = [
  'slack_list_channels',
  'slack_get_channel_history',
  'slack_get_thread_replies',
  'slack_get_users',
  'slack_get_user_profile',
];

/** Slack results are JSON-in-text; error results parse to null (§5.1). */
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

/** First `max` array entries carrying a string field `key`. */
function stringField(parsed: unknown, listKey: string, key: string, max: number): string[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const list = (parsed as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (out.length >= max) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const v = (entry as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

const rules: Rule[] = [
  {
    // Listing channels → opening the top channels' history.
    id: 'slack:channels→history',
    trigger: 'slack_list_channels',
    predict(call): Prediction[] {
      const confidences = [0.5, 0.35];
      return stringField(call.parsed, 'channels', 'id', 2).map((id, i) => ({
        server: call.server,
        tool: 'slack_get_channel_history',
        args: { channel_id: id },
        confidence: confidences[i]!,
        ruleId: 'slack:channels→history',
      }));
    },
  },
  {
    // Channel history → the first threaded message's replies.
    id: 'slack:history→thread',
    trigger: 'slack_get_channel_history',
    predict(call): Prediction[] {
      const channel = call.args['channel_id'];
      if (typeof channel !== 'string' || channel.length === 0) return [];
      if (call.parsed === null || typeof call.parsed !== 'object') return [];
      const messages = (call.parsed as Record<string, unknown>)['messages'];
      if (!Array.isArray(messages)) return [];
      const out: Prediction[] = [];
      for (const raw of messages) {
        if (out.length >= 2) break;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const m = raw as { ts?: unknown; reply_count?: unknown };
        if (typeof m.ts !== 'string' || m.ts.length === 0) continue;
        if (typeof m.reply_count !== 'number' || m.reply_count < 1) continue;
        out.push({
          server: call.server,
          tool: 'slack_get_thread_replies',
          args: { channel_id: channel, thread_ts: m.ts },
          confidence: out.length === 0 ? 0.55 : 0.4,
          ruleId: 'slack:history→thread',
        });
      }
      return out;
    },
  },
  {
    // Listing users → the top users' profiles.
    id: 'slack:users→profile',
    trigger: 'slack_get_users',
    predict(call): Prediction[] {
      const confidences = [0.4, 0.3];
      return stringField(call.parsed, 'members', 'id', 2).map((id, i) => ({
        server: call.server,
        tool: 'slack_get_user_profile',
        args: { user_id: id },
        confidence: confidences[i]!,
        ruleId: 'slack:users→profile',
      }));
    },
  },
];

export const slackProfile: ServerProfile = {
  name: 'slack',
  validatedAgainst:
    'speculate mock-slack v0.1 (mirrors @modelcontextprotocol/server-slack classic tool names and JSON-in-text payloads)',
  readOnlyAllowlist: [...READ_ONLY_TOOLS],
  defaultTtlMs: 20_000,
  ttlMsByTool: {
    // Messages arrive constantly; membership and profiles drift slowly.
    slack_get_channel_history: 10_000,
    slack_get_thread_replies: 10_000,
    slack_list_channels: 60_000,
    slack_get_users: 60_000,
    slack_get_user_profile: 60_000,
  },
  parsers: {
    slack_list_channels: parseJsonText,
    slack_get_channel_history: parseJsonText,
    slack_get_thread_replies: parseJsonText,
    slack_get_users: parseJsonText,
    slack_get_user_profile: parseJsonText,
  },
  canonicalizers: {},
  rules,
  primes: [['slack_get_thread_replies', 'slack_get_user_profile']],
};
