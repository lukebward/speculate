import { describe, expect, it } from 'vitest';
import {
  collectRuntimeSecrets,
  createSecretGuard,
  sanitizeLearnerState,
} from '../src/privacy.js';
import { TransitionLearner } from '../src/learner.js';

describe('secret filtering', () => {
  it('drops sensitive literals, argument names, transforms, and openers without redaction placeholders', () => {
    const canary = 'canary-secret-value-0123456789';
    const guard = createSecretGuard([canary]);
    const raw = {
      transitions: [
        {
          server: 's', prevTool: 'list', nextTool: 'read', count: 3, score: 3,
          lastUpdated: 100,
          templates: [
            { name: 'id', underivable: false, derived: 3, missed: 0, sources: [
              { kind: 'parsed', sourceTool: 'list', path: ['rows', '0', 'id'], score: 3, lastUpdated: 100 },
              { kind: 'const', repr: JSON.stringify(canary), score: 1, lastUpdated: 100 },
              { kind: 'transform', sourceTool: 'list', path: ['id'], transform: 'affix', prefix: canary, score: 1, lastUpdated: 100 },
            ] },
          ], contexts: [],
        },
        {
          server: 's', prevTool: 'a', nextTool: 'b', count: 2, lastUpdated: 100,
          templates: [{ name: 'access_token', underivable: false, derived: 2, missed: 0,
            sources: [{ kind: 'arg', key: 'id', score: 2, lastUpdated: 100 }] }],
        },
      ],
      openers: [
        { server: 's', tool: 'read', argsRepr: JSON.stringify({ id: 'ok', password: canary }), count: 2, lastUpdated: 100 },
      ],
    };
    const clean = sanitizeLearnerState(raw, { guard, now: 100, cutoff: 0 });
    const bytes = JSON.stringify(clean.value);
    expect(bytes).not.toContain(canary);
    expect(bytes).not.toContain('[REDACTED]');
    expect(clean.removedSensitive).toBeGreaterThanOrEqual(4);
    const transition = clean.value.transitions[0]!;
    expect(transition.templates[0]!.sources).toEqual([
      expect.objectContaining({ kind: 'parsed', sourceTool: 'list', path: ['rows', '0', 'id'] }),
    ]);
    expect(clean.value.transitions).toHaveLength(1);
    expect(clean.value.openers).toEqual([]);
  });

  it('preserves ordinary identifiers and does not classify entropy alone', () => {
    const values = ['550e8400-e29b-41d4-a716-446655440000', '01JABCDEFGHIJKLMNOPQRSTUVWXYZ', 'normal-id-123'];
    const guard = createSecretGuard();
    for (const value of values) expect(guard.isSensitive(value, 'recordId')).toBe(false);
    expect(guard.isSensitive('opaque-value', 'tokenId')).toBe(false);
    expect(guard.isSensitive('opaque-value', 'secretName')).toBe(false);
    expect(guard.isSensitive('Bearer abcdefghijklmnopqrstuvwxyz', 'value')).toBe(true);
    expect(guard.isSensitive('aaa.bbbbbbbbbbbbbbbb.cccccccccccccccc', 'value')).toBe(true);
  });

  it('collects configured credential values but ignores ordinary settings', () => {
    const config = {
      mode: 'strict' as const, maxPredictionsPerTrigger: 3, log: 'off' as const,
      servers: { s: { command: 'server', env: { API_TOKEN: 'secret-one', FORMAT: 'json' }, headers: {
        Authorization: 'Bearer two-token', 'X-Api-Version': '2026-01-01',
      } } },
    };
    const found = collectRuntimeSecrets(config, { env: {}, oauthPath: null });
    expect(found).toEqual(expect.arrayContaining(['secret-one', 'Bearer two-token', 'two-token']));
    expect(found).not.toContain('json');
    expect(found).not.toContain('2026-01-01');
  });

  it('removes known secrets from real learner context keys and nested object keys', () => {
    const canary = 'opaque-canary-0123456789';
    const learner = new TransitionLearner({ now: () => 100 });
    learner.observe({ server: 'sample', tool: 'scan', args: {}, parsed: { [canary]: { id: 'ordinary' } }, timestamp: 1, result: { content: [] }, latencyMs: 1 });
    learner.observe({ server: 'sample', tool: 'read', args: { id: 'ordinary' }, parsed: {}, timestamp: 2, result: { content: [] }, latencyMs: 1 });
    const cleaned = sanitizeLearnerState(learner.exportState(), {
      now: 100, cutoff: 0, guard: createSecretGuard([canary]),
    });
    expect(JSON.stringify(cleaned.value)).not.toContain(canary);

    const nested = sanitizeLearnerState({ transitions: [], openers: [{
      server: 'sample', tool: 'read', argsRepr: JSON.stringify({ nested: { [canary]: 'ordinary' } }), count: 2, lastUpdated: 100,
    }] }, { now: 100, cutoff: 0, guard: createSecretGuard([canary]) });
    expect(nested.value.openers).toEqual([]);
  });

  it('drops transformed fragments of a known credential', () => {
    const canary = 'prefixcanary-MIDDLE-suffixcanary';
    const cleaned = sanitizeLearnerState({ transitions: [{
      server: 'sample', prevTool: 'scan', nextTool: 'read', count: 3, lastUpdated: 100,
      templates: [{ name: 'value', underivable: false, derived: 3, missed: 0, sources: [{
        kind: 'transform', sourceTool: 'scan', path: ['value'], transform: 'affix',
        prefix: 'prefixcanary-', suffix: '-suffixcanary', score: 3, lastUpdated: 100,
      }] }],
    }] }, { now: 100, cutoff: 0, guard: createSecretGuard([canary]) });
    expect(cleaned.value.transitions).toEqual([]);
    expect(JSON.stringify(cleaned.value)).not.toContain('prefixcanary');
  });

  it('does not promote a constant after discarding a malformed historical source', () => {
    const cleaned = sanitizeLearnerState({ transitions: [{
      server: 'sample', prevTool: 'scan', nextTool: 'read', count: 10, lastUpdated: 100,
      templates: [{ name: 'id', underivable: false, derived: 10, missed: 0, sources: [
        { kind: 'const', repr: JSON.stringify('id1'), score: 1, lastUpdated: 100 },
        { kind: 'parsed', sourceTool: '', path: ['id'], score: 9, lastUpdated: 100 },
      ] }],
    }] }, { now: 100, cutoff: 0 });
    expect(cleaned.value.transitions).toEqual([]);

    const restored = new TransitionLearner({ now: () => 100 });
    restored.importState(cleaned.value);
    expect(restored.predict({
      server: 'sample', tool: 'scan', args: {}, parsed: { id: 'id999' }, timestamp: 101,
      result: { content: [] }, latencyMs: 1,
    })).toEqual([]);
  });
});
