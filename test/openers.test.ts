/**
 * Session-opener tracking in the learner (§13.15): recording, thresholds,
 * eviction, prediction shape, and (de)serialization hardening.
 */
import { describe, expect, it } from 'vitest';
import { TransitionLearner } from '../src/learner.js';

const ARGS = { owner: 'acme', repo: 'api' };

function learnerAt(now = () => 1_000) {
  return new TransitionLearner({ now });
}

describe('learner openers', () => {
  it('predicts an opener only after minObservations identical sightings', () => {
    const l = learnerAt();
    l.recordOpener('gh', 'get_issue', ARGS);
    expect(l.openerPredictions('gh')).toHaveLength(0);
    l.recordOpener('gh', 'get_issue', ARGS);
    const preds = l.openerPredictions('gh');
    expect(preds).toHaveLength(1);
    expect(preds[0]).toMatchObject({
      server: 'gh',
      tool: 'get_issue',
      args: ARGS,
      ruleId: 'opener:gh:get_issue',
    });
    expect(preds[0]!.confidence).toBeGreaterThan(0);
    expect(preds[0]!.confidence).toBeLessThanOrEqual(0.5);
  });

  it('an opener with varying args never reaches the threshold', () => {
    const l = learnerAt();
    l.recordOpener('gh', 'get_issue', { n: 1 });
    l.recordOpener('gh', 'get_issue', { n: 2 });
    l.recordOpener('gh', 'get_issue', { n: 3 });
    expect(l.openerPredictions('gh')).toHaveLength(0);
  });

  it('returned args are fresh copies, not aliases of stored state', () => {
    const l = learnerAt();
    l.recordOpener('gh', 'get_issue', ARGS);
    l.recordOpener('gh', 'get_issue', ARGS);
    const first = l.openerPredictions('gh')[0]!;
    (first.args as Record<string, unknown>)['owner'] = 'tampered';
    expect(l.openerPredictions('gh')[0]!.args).toEqual(ARGS);
  });

  it('openers are per-server and ranked by count', () => {
    const l = learnerAt();
    for (let i = 0; i < 3; i++) l.recordOpener('gh', 'list_issues', {});
    for (let i = 0; i < 2; i++) l.recordOpener('gh', 'get_issue', ARGS);
    l.recordOpener('other', 'list_issues', {});
    const preds = l.openerPredictions('gh');
    expect(preds.map((p) => p.tool)).toEqual(['list_issues', 'get_issue']);
    expect(l.openerPredictions('other')).toHaveLength(0); // count 1 < threshold
  });

  it('evicts the weakest opener beyond the per-server cap', () => {
    const l = learnerAt();
    for (let i = 0; i < 3; i++) l.recordOpener('gh', 'strong', {});
    for (let n = 0; n < 8; n++) l.recordOpener('gh', `weak_${n}`, {});
    // Cap is 8: adding the 9th key must evict a count-1 entry, never 'strong'.
    for (let i = 0; i < 2; i++) l.recordOpener('gh', 'strong', {}); // still tracked
    expect(l.openerPredictions('gh').some((p) => p.tool === 'strong')).toBe(true);
  });

  it('skips unrepresentable and oversized args (fail closed)', () => {
    const l = learnerAt();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    l.recordOpener('gh', 'get_issue', cyclic);
    l.recordOpener('gh', 'get_issue', cyclic);
    l.recordOpener('gh', 'big', { blob: 'x'.repeat(5_000) });
    l.recordOpener('gh', 'big', { blob: 'x'.repeat(5_000) });
    l.recordOpener('gh', 'bad tool', {});
    expect(l.openerPredictions('gh')).toHaveLength(0);
  });

  it('openers survive an export/import round trip', () => {
    const first = learnerAt();
    first.recordOpener('gh', 'get_issue', ARGS);
    first.recordOpener('gh', 'get_issue', ARGS);
    const state = JSON.parse(JSON.stringify(first.exportState())) as unknown;

    const second = learnerAt();
    second.importState(state);
    const preds = second.openerPredictions('gh');
    expect(preds).toHaveLength(1);
    expect(preds[0]!.args).toEqual(ARGS);
  });

  it('export omits the openers key when none are tracked', () => {
    expect('openers' in learnerAt().exportState()).toBe(false);
  });

  it('import skips malformed openers without poisoning the rest', () => {
    const l = learnerAt();
    l.importState({
      transitions: [],
      openers: [
        null,
        { server: 'gh', tool: 'ok', argsRepr: '{"a":1}', count: 5 },
        { server: 'gh', tool: 'no count', argsRepr: '{}' },
        { server: 'gh', tool: 'bad repr', argsRepr: '[1,2]', count: 3 }, // not an object
        { server: 'gh', tool: 'nan', argsRepr: '{}', count: NaN },
        { server: 'sp ace', tool: 'x', argsRepr: '{}', count: 2 },
        { server: 'gh', tool: 'unparseable', argsRepr: '{oops', count: 2 },
      ],
    });
    const preds = l.openerPredictions('gh');
    expect(preds).toHaveLength(1);
    expect(preds[0]!.tool).toBe('ok');
    expect(preds[0]!.args).toEqual({ a: 1 });
  });

  it('recording an opener bumps the dirty revision', () => {
    const l = learnerAt();
    const before = l.revision;
    l.recordOpener('gh', 'get_issue', ARGS);
    expect(l.revision).toBeGreaterThan(before);
  });
});
