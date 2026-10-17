/**
 * Tool knowledge (DESIGN.md §4): affirmative, host-learned eligibility,
 * argument key shapes, and the sanitize/merge rules for persisted facts.
 */
import { describe, expect, it } from 'vitest';
import {
  ToolKnowledge,
  argShape,
  mergeToolFacts,
  sanitizeToolFacts,
  type ToolFact,
  type ToolFacts,
} from '../src/tools.js';
import { createSecretGuard } from '../src/privacy.js';

const read = { readOnly: true, servable: true, args: {} };

describe('argShape', () => {
  it('is the sorted key list, independent of values and insertion order', () => {
    expect(argShape({ b: 1, a: 'secret-value', c: null })).toBe('a,b,c');
    expect(argShape({})).toBe('');
  });
});

describe('ToolKnowledge eligibility', () => {
  it('treats an unknown tool as ineligible', () => {
    const k = new ToolKnowledge(() => 0);
    expect(k.eligibility('s', 't')).toEqual({ eligible: false, reason: 'unknown' });
    expect(k.isReadOnly('s', 't')).toBe(false);
  });

  it('requires the host to have reported the tool read-only', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', { ...read, readOnly: false });
    expect(k.eligibility('s', 't')).toEqual({ eligible: false, reason: 'not-read-only' });
    expect(k.isReadOnly('s', 't')).toBe(false);
  });

  it('requires a servable (content block) result', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', { ...read, servable: false });
    expect(k.eligibility('s', 't')).toEqual({ eligible: false, reason: 'not-servable' });
    expect(k.isReadOnly('s', 't')).toBe(true);
  });

  it('is eligible once a read-only servable call was seen', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', read);
    expect(k.eligibility('s', 't')).toEqual({ eligible: true, reason: 'read-only' });
  });

  it('a later non-read-only report revokes eligibility', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', read);
    k.record('s', 't', { ...read, readOnly: false });
    expect(k.eligibility('s', 't').reason).toBe('not-read-only');
  });

  it('suspension blocks with its reason and can be reset', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', read);
    k.suspend('s', 't', 'auth');
    expect(k.isSuspended('s', 't')).toBe(true);
    expect(k.eligibility('s', 't')).toEqual({ eligible: false, reason: 'suspended:auth' });
    expect(k.eligibility('s', 'other')).toMatchObject({ reason: 'unknown' });
    k.resetSuspension('s', 't');
    expect(k.eligibility('s', 't').eligible).toBe(true);
  });

  it('never speculates a tool that settings hooks watch', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 'watched', read);
    k.record('s', 'free', read);
    k.setHooked((server, tool) => server === 's' && tool === 'watched');
    expect(k.eligibility('s', 'watched')).toEqual({ eligible: false, reason: 'tool-hooks' });
    expect(k.eligibility('s', 'free').eligible).toBe(true);
  });

  it('bumps revision on record and import', () => {
    const k = new ToolKnowledge(() => 0);
    const r0 = k.revision;
    k.record('s', 't', read);
    expect(k.revision).toBeGreaterThan(r0);
    const r1 = k.revision;
    k.importState({});
    expect(k.revision).toBeGreaterThan(r1);
  });
});

describe('ToolKnowledge shapes', () => {
  it('records sorted key sets, most recent first, deduplicated, capped at 8', () => {
    let t = 0;
    const k = new ToolKnowledge(() => t);
    k.record('s', 't', { ...read, args: { b: 1, a: 2 } });
    expect(k.fact('s', 't')?.shapes).toEqual(['a,b']);
    expect(k.hasShape('s', 't', ['b', 'a'])).toBe(true);
    expect(k.hasShape('s', 't', ['a'])).toBe(false);

    k.record('s', 't', { ...read, args: { c: 1 } });
    k.record('s', 't', { ...read, args: { a: 0, b: 0 } }); // seen again: moves to the front
    expect(k.fact('s', 't')?.shapes).toEqual(['a,b', 'c']);

    for (let i = 0; i < 10; i++) {
      t = i + 1;
      k.record('s', 't', { ...read, args: { [`k${i}`]: i } });
    }
    const shapes = k.fact('s', 't')!.shapes;
    expect(shapes).toHaveLength(8);
    expect(shapes[0]).toBe('k9');
    expect(shapes).not.toContain('a,b');
    expect(k.fact('s', 't')?.lastSeen).toBe(10);
  });

  it('never stores argument values', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', { ...read, args: { path: 'value-canary-123' } });
    expect(JSON.stringify(k.exportState())).not.toContain('value-canary-123');
  });
});

describe('ToolKnowledge export/import', () => {
  it('round-trips through JSON', () => {
    const a = new ToolKnowledge(() => 42);
    a.record('s', 'read', { readOnly: true, servable: true, args: { id: 1 } });
    a.record('s', 'write', { readOnly: false, servable: true, args: { id: 1, body: 2 } });
    a.record('other', 'x', { readOnly: true, servable: false, args: {} });
    const exported = a.exportState();
    expect(exported).toEqual({
      s: {
        read: { readOnly: true, servable: true, shapes: ['id'], lastSeen: 42 },
        write: { readOnly: false, servable: true, shapes: ['body,id'], lastSeen: 42 },
      },
      other: { x: { readOnly: true, servable: false, shapes: [''], lastSeen: 42 } },
    });

    const b = new ToolKnowledge(() => 0);
    b.importState(JSON.parse(JSON.stringify(exported)));
    expect(b.exportState()).toEqual(exported);
    expect(b.eligibility('s', 'read').eligible).toBe(true);
    expect(b.servers().sort()).toEqual(['other', 's']);
    expect(b.tools('s').sort()).toEqual(['read', 'write']);
  });

  it('exports a copy that later records do not mutate', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 't', { ...read, args: { a: 1 } });
    const snapshot = k.exportState();
    k.record('s', 't', { ...read, args: { b: 1 } });
    expect(snapshot['s']!['t']!.shapes).toEqual(['a']);
  });

  it('import replaces prior facts and skips malformed entries without throwing', () => {
    const k = new ToolKnowledge(() => 0);
    k.record('s', 'old', read);
    k.importState({
      s: {
        good: { readOnly: true, servable: true, shapes: ['a', 7], lastSeen: 1 },
        noBool: { readOnly: 'yes', servable: true, shapes: [], lastSeen: 1 },
        badStamp: { readOnly: true, servable: true, shapes: [], lastSeen: -1 },
        noShapes: { readOnly: true, servable: true, lastSeen: 1 },
      },
      '': { t: { readOnly: true, servable: true, shapes: [], lastSeen: 1 } },
      notRecord: 'x',
    });
    expect(k.exportState()).toEqual({ s: { good: { readOnly: true, servable: true, shapes: ['a'], lastSeen: 1 } } });
    for (const junk of [null, 42, 'x', [], { s: [] }]) expect(() => k.importState(junk)).not.toThrow();
  });
});

describe('sanitizeToolFacts', () => {
  const fact = (lastSeen: number, shapes: string[] = []): ToolFact => ({ readOnly: true, servable: true, shapes, lastSeen });

  it('drops facts last seen before the cutoff', () => {
    const out = sanitizeToolFacts({ s: { old: fact(10), fresh: fact(100) } }, 50, createSecretGuard());
    expect(out.value).toEqual({ s: { fresh: fact(100) } });
    expect(out.removedSensitive).toBe(0);
  });

  it('removes credential-shaped servers, tools, and shapes', () => {
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz';
    const out = sanitizeToolFacts({
      [bearer]: { a: fact(100), b: fact(100) },
      s: {
        [bearer]: fact(100),
        ok: fact(100, ['id', `${bearer}`, 'access_token=abcdefgh']),
      },
    }, 0, createSecretGuard());
    expect(out.value).toEqual({ s: { ok: fact(100, ['id']) } });
    expect(out.removedSensitive).toBe(2 + 1 + 2);
    expect(JSON.stringify(out.value)).not.toContain('abcdefgh');
  });

  it('returns an empty value for malformed input', () => {
    expect(sanitizeToolFacts('junk', 0, createSecretGuard())).toEqual({ value: {}, removedSensitive: 0, removedExpired: 0 });
    expect(sanitizeToolFacts(undefined, 0, createSecretGuard()).value).toEqual({});
  });
});

describe('mergeToolFacts', () => {
  it('keeps the newest verdict per tool and unions shapes newest first', () => {
    const a: ToolFacts = { s: {
      t: { readOnly: true, servable: true, shapes: ['a', 'shared'], lastSeen: 100 },
      onlyA: { readOnly: true, servable: true, shapes: [], lastSeen: 1 },
    } };
    const b: ToolFacts = {
      s: { t: { readOnly: false, servable: false, shapes: ['b', 'shared'], lastSeen: 200 } },
      other: { u: { readOnly: true, servable: true, shapes: ['x'], lastSeen: 5 } },
    };
    const expected = {
      s: {
        t: { readOnly: false, servable: false, shapes: ['b', 'shared', 'a'], lastSeen: 200 },
        onlyA: { readOnly: true, servable: true, shapes: [], lastSeen: 1 },
      },
      other: { u: { readOnly: true, servable: true, shapes: ['x'], lastSeen: 5 } },
    };
    expect(mergeToolFacts(a, b)).toEqual(expected);
    expect(mergeToolFacts(b, a)).toEqual(expected); // order-independent winner
  });

  it('caps unioned shapes at 8 and tolerates missing sides', () => {
    const shapes = (prefix: string) => Array.from({ length: 6 }, (_, i) => `${prefix}${i}`);
    const merged = mergeToolFacts(
      { s: { t: { readOnly: true, servable: true, shapes: shapes('old'), lastSeen: 1 } } },
      { s: { t: { readOnly: true, servable: true, shapes: shapes('new'), lastSeen: 2 } } },
    );
    expect(merged['s']!['t']!.shapes).toEqual([...shapes('new'), 'old0', 'old1']);
    expect(mergeToolFacts(undefined, undefined)).toEqual({});
    const only = { s: { t: { readOnly: true, servable: true, shapes: ['a'], lastSeen: 1 } } };
    expect(mergeToolFacts(only, undefined)).toEqual(only);
  });

  it('does not alias input shape arrays', () => {
    const input: ToolFacts = { s: { t: { readOnly: true, servable: true, shapes: ['a'], lastSeen: 1 } } };
    const merged = mergeToolFacts(input, undefined);
    merged['s']!['t']!.shapes.push('mutated');
    expect(input['s']!['t']!.shapes).toEqual(['a']);
  });
});
