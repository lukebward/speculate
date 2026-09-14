import { describe, expect, it } from 'vitest';
import { candidateSchema, observationSchema } from '../src/observerTypes.js';

const candidate = {
  version: 1 as const,
  launchId: 'launch',
  conversationId: 'thread',
  candidateId: 'one',
  routeId: 'route',
  generation: 1,
  sourceEventId: 'event',
  source: 'intent' as const,
  args: {},
  confidence: 1,
  createdAt: 0,
};

describe('candidateSchema', () => {
  it('accepts the bounded wire envelope', () => {
    expect(candidateSchema.safeParse(candidate).success).toBe(true);
  });

  it.each([
    ['an imported cache key', { ...candidate, key: 'forged' }],
    ['an imported rule id', { ...candidate, ruleId: 'forged' }],
    ['a missing launch session', (({ launchId: _, ...rest }) => rest)(candidate)],
    ['array arguments', { ...candidate, args: [] }],
    ['non-JSON arguments', { ...candidate, args: { value: undefined } }],
    ['nonfinite confidence', { ...candidate, confidence: Number.POSITIVE_INFINITY }],
    ['an unsupported version', { ...candidate, version: 2 }],
    ['an invalid generation', { ...candidate, generation: 0 }],
  ])('rejects %s', (_name, value) => {
    expect(candidateSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an envelope over 64 KiB', () => {
    expect(candidateSchema.safeParse({ ...candidate, args: { value: 'x'.repeat(65_536) } }).success)
      .toBe(false);
  });
});

describe('observationSchema', () => {
  const context = { launchId: 'launch', conversationId: 'thread', agent: 'claude', cwd: '/work' };

  it('accepts each complete observation kind', () => {
    const values = [
      { context, eventId: '1', observedAt: 1, kind: 'prompt', text: 'read it' },
      { context, eventId: '2', observedAt: 2, kind: 'tool-complete', routeId: 'r', args: {}, parsed: null, latencyMs: 4, ordered: true },
      { context, eventId: '3', observedAt: 3, kind: 'stream-call', routeId: 'r', callId: 'c', args: {} },
      { context, eventId: '4', observedAt: 4, kind: 'invalidate', routeIds: ['r'], reason: 'mutation' },
    ];
    expect(values.every((value) => observationSchema.safeParse(value).success)).toBe(true);
  });

  it('rejects unknown fields and incomplete streamed arguments', () => {
    expect(observationSchema.safeParse({ context, eventId: '1', observedAt: 1, kind: 'prompt', text: 'x', secret: true }).success).toBe(false);
    expect(observationSchema.safeParse({ context, eventId: '2', observedAt: 2, kind: 'stream-call', routeId: 'r', callId: 'c', args: { x: undefined } }).success).toBe(false);
  });
});
