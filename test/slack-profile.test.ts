/**
 * Slack profile (§13.15): JSON-in-text parsing and per-rule prediction
 * behavior. Mirrors the shapes served by mock/mock-slack.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { slackProfile } from '../src/profiles/slack.js';
import type { ObservedCall } from '../src/types.js';

const json = (payload: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});

function observed(tool: string, args: Record<string, unknown>, result: CallToolResult): ObservedCall {
  const parser = slackProfile.parsers[tool];
  return {
    server: 'slack',
    tool,
    args,
    result,
    parsed: parser ? parser(result) : null,
    timestamp: 1_000,
    latencyMs: 100,
  };
}

function rule(id: string) {
  const r = slackProfile.rules.find((r) => r.id === id);
  expect(r, `rule ${id} exists`).toBeDefined();
  return r!;
}

describe('slack profile', () => {
  it('parser reads JSON-in-text and fails closed on errors', () => {
    const parse = slackProfile.parsers['slack_list_channels']!;
    expect(parse(json({ ok: true, channels: [] }))).toEqual({ ok: true, channels: [] });
    expect(parse({ isError: true, content: [{ type: 'text', text: '{}' }] })).toBeNull();
    expect(parse({ content: [{ type: 'text', text: 'not json' }] })).toBeNull();
  });

  it('list_channels → history for the first two channels', () => {
    const preds = rule('slack:channels→history').predict(
      observed(
        'slack_list_channels',
        {},
        json({
          ok: true,
          channels: [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'eng' }, { id: 'C3' }],
        }),
      ),
    );
    expect(preds.map((p) => p.args)).toEqual([{ channel_id: 'C1' }, { channel_id: 'C2' }]);
    expect(preds.every((p) => p.tool === 'slack_get_channel_history')).toBe(true);
  });

  it('history → thread replies only for threaded messages', () => {
    const preds = rule('slack:history→thread').predict(
      observed(
        'slack_get_channel_history',
        { channel_id: 'C1' },
        json({
          ok: true,
          messages: [
            { ts: '1.100', user: 'U1', text: 'plain' },
            { ts: '1.200', user: 'U2', text: 'threaded', reply_count: 3 },
            { ts: '1.300', user: 'U1', text: 'also threaded', reply_count: 1 },
          ],
        }),
      ),
    );
    expect(preds.map((p) => p.args)).toEqual([
      { channel_id: 'C1', thread_ts: '1.200' },
      { channel_id: 'C1', thread_ts: '1.300' },
    ]);
    expect(preds[0]!.confidence).toBeGreaterThan(preds[1]!.confidence);
  });

  it('history rule fails closed without channel_id or messages', () => {
    expect(
      rule('slack:history→thread').predict(
        observed('slack_get_channel_history', {}, json({ ok: true, messages: [{ ts: '1', reply_count: 1 }] })),
      ),
    ).toEqual([]);
    expect(
      rule('slack:history→thread').predict(
        observed('slack_get_channel_history', { channel_id: 'C1' }, json({ ok: true })),
      ),
    ).toEqual([]);
  });

  it('users → profiles for the first two members', () => {
    const preds = rule('slack:users→profile').predict(
      observed(
        'slack_get_users',
        {},
        json({ ok: true, members: [{ id: 'U1' }, { id: 'U2' }, { id: 'U3' }] }),
      ),
    );
    expect(preds.map((p) => p.args)).toEqual([{ user_id: 'U1' }, { user_id: 'U2' }]);
  });

  it('profile shape: writes never allowlisted; primes target reads', () => {
    for (const w of ['slack_post_message', 'slack_reply_to_thread', 'slack_add_reaction']) {
      expect(slackProfile.readOnlyAllowlist).not.toContain(w);
    }
    for (const [, next] of slackProfile.primes ?? []) {
      expect(slackProfile.readOnlyAllowlist).toContain(next);
    }
  });
});
