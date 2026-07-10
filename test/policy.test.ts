import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SafetyPolicy } from '../src/policy.js';

/** Build a minimal SDK Tool, optionally with annotations. */
function tool(name: string, annotations?: Tool['annotations']): Tool {
  const t: Tool = { name, inputSchema: { type: 'object' } };
  if (annotations !== undefined) t.annotations = annotations;
  return t;
}

const GH_TOOLS: Tool[] = [
  tool('get_issue', { readOnlyHint: true }),
  tool('list_pull_requests', { readOnlyHint: true }),
  tool('search_code', { readOnlyHint: true }),
  tool('mark_read', { readOnlyHint: true }), // annotated read, but denylisted below
  tool('create_issue', { readOnlyHint: false }),
  tool('merge_pr'), // no annotations at all
  tool('get_me', { title: 'whoami' }), // annotations present, readOnlyHint absent
];

const GH_CONFIG = {
  github: {
    allowlist: ['get_issue', 'list_pull_requests', 'legacy_read'],
    denylist: ['mark_read'],
  },
};

function makePolicy(mode: 'strict' | 'annotated' | 'off'): SafetyPolicy {
  const p = new SafetyPolicy(mode, GH_CONFIG);
  p.updateTools('github', GH_TOOLS);
  return p;
}

describe('SafetyPolicy.eligibility — mode matrix', () => {
  describe('strict mode (annotation AND allowlist)', () => {
    const p = makePolicy('strict');

    it('allows annotated + allowlisted tools', () => {
      expect(p.eligibility('github', 'get_issue')).toEqual({
        eligible: true,
        reason: 'allowlisted',
      });
      expect(p.eligibility('github', 'list_pull_requests')).toEqual({
        eligible: true,
        reason: 'allowlisted',
      });
    });

    it('denies annotated tools missing from the allowlist', () => {
      expect(p.eligibility('github', 'search_code')).toEqual({
        eligible: false,
        reason: 'not-allowlisted',
      });
    });

    it('denies allowlisted tools missing the annotation (untrusted-hint conjunction)', () => {
      // 'legacy_read' is allowlisted but the server never advertised it as
      // read-only; annotation check comes first.
      const p2 = new SafetyPolicy('strict', GH_CONFIG);
      p2.updateTools('github', [...GH_TOOLS, tool('legacy_read')]);
      expect(p2.eligibility('github', 'legacy_read')).toEqual({
        eligible: false,
        reason: 'not-annotated',
      });
    });
  });

  describe('annotated mode (annotation alone suffices)', () => {
    const p = makePolicy('annotated');

    it('allows annotated tools regardless of allowlist', () => {
      expect(p.eligibility('github', 'search_code')).toEqual({
        eligible: true,
        reason: 'annotated',
      });
      expect(p.eligibility('github', 'get_issue')).toEqual({
        eligible: true,
        reason: 'annotated',
      });
    });

    it('denies readOnlyHint: false', () => {
      expect(p.eligibility('github', 'create_issue')).toEqual({
        eligible: false,
        reason: 'not-annotated',
      });
    });

    it('denies tools with no annotations object', () => {
      expect(p.eligibility('github', 'merge_pr')).toEqual({
        eligible: false,
        reason: 'not-annotated',
      });
    });

    it('denies annotations present but readOnlyHint absent', () => {
      expect(p.eligibility('github', 'get_me')).toEqual({
        eligible: false,
        reason: 'not-annotated',
      });
    });
  });

  describe('off mode', () => {
    const p = makePolicy('off');

    it('blocks everything, even annotated + allowlisted tools', () => {
      expect(p.eligibility('github', 'get_issue')).toEqual({
        eligible: false,
        reason: 'mode-off',
      });
      expect(p.eligibility('github', 'search_code')).toEqual({
        eligible: false,
        reason: 'mode-off',
      });
      expect(p.eligibility('github', 'nonexistent')).toEqual({
        eligible: false,
        reason: 'mode-off',
      });
    });
  });
});

describe('SafetyPolicy.eligibility — default-deny', () => {
  it('denies tools never seen in updateTools', () => {
    for (const mode of ['strict', 'annotated'] as const) {
      expect(makePolicy(mode).eligibility('github', 'never_advertised')).toEqual({
        eligible: false,
        reason: 'unknown-tool',
      });
    }
  });

  it('denies tools on servers never seen in updateTools', () => {
    const p = new SafetyPolicy('annotated', {});
    expect(p.eligibility('ghost-server', 'get_issue')).toEqual({
      eligible: false,
      reason: 'unknown-tool',
    });
  });

  it('denies allowlisted tools on a server with no tool list yet (strict)', () => {
    const p = new SafetyPolicy('strict', GH_CONFIG);
    expect(p.eligibility('github', 'get_issue')).toEqual({
      eligible: false,
      reason: 'unknown-tool',
    });
  });
});

describe('SafetyPolicy — denylist', () => {
  it('denylisted tool is ineligible in every mode, despite annotation + allowlist', () => {
    const cfg = {
      github: { allowlist: ['mark_read'], denylist: ['mark_read'] },
    };
    for (const mode of ['strict', 'annotated'] as const) {
      const p = new SafetyPolicy(mode, cfg);
      p.updateTools('github', GH_TOOLS);
      expect(p.eligibility('github', 'mark_read')).toEqual({
        eligible: false,
        reason: 'denylisted',
      });
    }
  });

  it('denylisted + suspended tool is ineligible (whatever the reason ordering)', () => {
    const p = makePolicy('annotated');
    p.suspend('github', 'mark_read', 'auth');
    expect(p.eligibility('github', 'mark_read').eligible).toBe(false);
  });
});

describe('SafetyPolicy — updateTools replacement semantics', () => {
  it('a tool removed from the list becomes unknown', () => {
    const p = makePolicy('annotated');
    expect(p.eligibility('github', 'search_code').eligible).toBe(true);

    p.updateTools('github', [tool('get_issue', { readOnlyHint: true })]);
    expect(p.eligibility('github', 'search_code')).toEqual({
      eligible: false,
      reason: 'unknown-tool',
    });
    expect(p.eligibility('github', 'get_issue').eligible).toBe(true);
  });

  it('an annotation change on re-list takes effect', () => {
    const p = makePolicy('annotated');
    expect(p.eligibility('github', 'search_code').eligible).toBe(true);

    p.updateTools('github', [tool('search_code', { readOnlyHint: false })]);
    expect(p.eligibility('github', 'search_code')).toEqual({
      eligible: false,
      reason: 'not-annotated',
    });
  });

  it('updateTools for one server does not affect another', () => {
    const p = new SafetyPolicy('annotated', {});
    p.updateTools('a', [tool('read', { readOnlyHint: true })]);
    p.updateTools('b', [tool('other', { readOnlyHint: true })]);
    expect(p.eligibility('a', 'read').eligible).toBe(true);
    expect(p.eligibility('b', 'read')).toEqual({
      eligible: false,
      reason: 'unknown-tool',
    });
  });
});

describe('SafetyPolicy — suspension (auth-error breaker)', () => {
  it('suspend blocks an otherwise-eligible tool with suspended:<reason>', () => {
    const p = makePolicy('annotated');
    expect(p.eligibility('github', 'get_issue').eligible).toBe(true);

    p.suspend('github', 'get_issue', 'auth');
    expect(p.isSuspended('github', 'get_issue')).toBe(true);
    expect(p.eligibility('github', 'get_issue')).toEqual({
      eligible: false,
      reason: 'suspended:auth',
    });
  });

  it('resetSuspension restores eligibility', () => {
    const p = makePolicy('strict');
    p.suspend('github', 'get_issue', 'auth');
    expect(p.eligibility('github', 'get_issue').eligible).toBe(false);

    p.resetSuspension('github', 'get_issue');
    expect(p.isSuspended('github', 'get_issue')).toBe(false);
    expect(p.eligibility('github', 'get_issue')).toEqual({
      eligible: true,
      reason: 'allowlisted',
    });
  });

  it('suspension survives updateTools (tools/list_changed does not reset the breaker)', () => {
    const p = makePolicy('annotated');
    p.suspend('github', 'get_issue', 'elicitation');
    p.updateTools('github', GH_TOOLS);
    expect(p.isSuspended('github', 'get_issue')).toBe(true);
    expect(p.eligibility('github', 'get_issue')).toEqual({
      eligible: false,
      reason: 'suspended:elicitation',
    });
  });

  it('suspension is per (server, tool)', () => {
    const p = new SafetyPolicy('annotated', {});
    p.updateTools('a', [tool('read', { readOnlyHint: true })]);
    p.updateTools('b', [tool('read', { readOnlyHint: true })]);
    p.suspend('a', 'read', 'auth');
    expect(p.eligibility('a', 'read').eligible).toBe(false);
    expect(p.eligibility('b', 'read').eligible).toBe(true);
    expect(p.isSuspended('b', 'read')).toBe(false);
  });

  it('resetSuspension on a never-suspended tool is a no-op', () => {
    const p = makePolicy('annotated');
    expect(() => p.resetSuspension('github', 'get_issue')).not.toThrow();
    expect(p.eligibility('github', 'get_issue').eligible).toBe(true);
  });
});

describe('SafetyPolicy.isAffirmativelyReadOnly — union semantics (§6.2)', () => {
  const p = makePolicy('strict');

  it('annotated-only (not allowlisted) is read-only', () => {
    // search_code is NOT eligible in strict mode, but it is still a read for
    // invalidation purposes.
    expect(p.eligibility('github', 'search_code').eligible).toBe(false);
    expect(p.isAffirmativelyReadOnly('github', 'search_code')).toBe(true);
  });

  it('allowlisted-only (advertised without annotation) is read-only', () => {
    const p2 = new SafetyPolicy('strict', GH_CONFIG);
    p2.updateTools('github', [...GH_TOOLS, tool('legacy_read')]);
    expect(p2.isAffirmativelyReadOnly('github', 'legacy_read')).toBe(true);
  });

  it('unknown tools are writes', () => {
    expect(p.isAffirmativelyReadOnly('github', 'never_advertised')).toBe(false);
    expect(p.isAffirmativelyReadOnly('no-such-server', 'get_issue')).toBe(false);
  });

  it('readOnlyHint: false / unannotated known tools are writes', () => {
    expect(p.isAffirmativelyReadOnly('github', 'create_issue')).toBe(false);
    expect(p.isAffirmativelyReadOnly('github', 'merge_pr')).toBe(false);
  });

  it('denylisted-but-annotated is still a read (denylisted reads are reads)', () => {
    expect(p.eligibility('github', 'mark_read').eligible).toBe(false);
    expect(p.isAffirmativelyReadOnly('github', 'mark_read')).toBe(true);
  });

  it('suspension does not turn a read into a write', () => {
    const p2 = makePolicy('annotated');
    p2.suspend('github', 'search_code', 'auth');
    expect(p2.isAffirmativelyReadOnly('github', 'search_code')).toBe(true);
  });
});
