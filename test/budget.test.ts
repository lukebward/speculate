import { describe, expect, it } from 'vitest';
import { BudgetManager } from '../src/budget.js';

/** Fake clock helper. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

describe('BudgetManager — unknown server', () => {
  it('denies servers not in the config', () => {
    const bm = new BudgetManager({ gh: { transport: 'http' } });
    expect(bm.tryAcquire('nope')).toEqual({ ok: false, reason: 'unknown-server' });
    expect(bm.specInFlight('nope')).toBe(0);
    expect(bm.realInFlight('nope')).toBe(0);
    // Bookkeeping on unknown servers is a safe no-op.
    expect(() => {
      bm.realStarted('nope');
      bm.realFinished('nope');
      bm.release('nope');
    }).not.toThrow();
  });
});

describe('BudgetManager — http concurrency', () => {
  it('defaults to 2 concurrent speculative calls; release frees a slot', () => {
    const c = clock();
    const bm = new BudgetManager({ gh: { transport: 'http' } }, { now: c.now });

    expect(bm.tryAcquire('gh')).toEqual({ ok: true });
    expect(bm.tryAcquire('gh')).toEqual({ ok: true });
    expect(bm.specInFlight('gh')).toBe(2);

    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'concurrency' });
    expect(bm.specInFlight('gh')).toBe(2); // denial consumed nothing

    bm.release('gh');
    expect(bm.specInFlight('gh')).toBe(1);
    expect(bm.tryAcquire('gh')).toEqual({ ok: true });
  });

  it('honors configured maxConcurrent for http', () => {
    const bm = new BudgetManager({ gh: { transport: 'http', maxConcurrent: 1 } });
    expect(bm.tryAcquire('gh').ok).toBe(true);
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'concurrency' });
  });

  it('real traffic does not consume http speculative slots', () => {
    const bm = new BudgetManager({ gh: { transport: 'http' } });
    bm.realStarted('gh');
    bm.realStarted('gh');
    expect(bm.realInFlight('gh')).toBe(2);
    expect(bm.tryAcquire('gh').ok).toBe(true);
    expect(bm.tryAcquire('gh').ok).toBe(true);
    bm.realFinished('gh');
    expect(bm.realInFlight('gh')).toBe(1);
  });

  it('reports concurrency before per-minute when both are exhausted', () => {
    const bm = new BudgetManager({
      gh: { transport: 'http', maxConcurrent: 2, maxPerMinute: 2 },
    });
    expect(bm.tryAcquire('gh').ok).toBe(true);
    expect(bm.tryAcquire('gh').ok).toBe(true);
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'concurrency' });
  });
});

describe('BudgetManager — per-minute sliding window', () => {
  it('denies the 31st issuance within 60s (default budget) and recovers after the window slides', () => {
    const c = clock(1_000_000);
    const bm = new BudgetManager({ gh: { transport: 'http' } }, { now: c.now });

    for (let i = 0; i < 30; i++) {
      expect(bm.tryAcquire('gh')).toEqual({ ok: true });
      bm.release('gh'); // free the slot; the per-minute token stays spent
      c.advance(1); // 30 issuances in 30 ms
    }
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'per-minute' });

    // Still inside the window 30 s later.
    c.set(1_000_000 + 30_000);
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'per-minute' });

    // Once the first issuances are >60 s old, tokens come back.
    c.set(1_000_000 + 60_001);
    expect(bm.tryAcquire('gh')).toEqual({ ok: true });
  });

  it('window slides per issuance timestamp, not in fixed buckets', () => {
    const c = clock(0);
    const bm = new BudgetManager(
      { gh: { transport: 'http', maxPerMinute: 3, maxConcurrent: 10 } },
      { now: c.now },
    );

    // Two issuances at t=0, one at t=30s -> full.
    expect(bm.tryAcquire('gh').ok).toBe(true);
    expect(bm.tryAcquire('gh').ok).toBe(true);
    bm.release('gh');
    bm.release('gh');
    c.set(30_000);
    expect(bm.tryAcquire('gh').ok).toBe(true);
    bm.release('gh');
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'per-minute' });

    // At t=61s the two t=0 issuances have expired, the t=30s one has not.
    c.set(61_000);
    expect(bm.tryAcquire('gh').ok).toBe(true);
    bm.release('gh');
    expect(bm.tryAcquire('gh').ok).toBe(true);
    bm.release('gh');
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'per-minute' });

    // At t=91s the t=30s issuance is out of the window too.
    c.set(91_000);
    expect(bm.tryAcquire('gh').ok).toBe(true);
  });

  it('denied acquires do not spend per-minute tokens', () => {
    const c = clock(0);
    const bm = new BudgetManager(
      { gh: { transport: 'http', maxPerMinute: 3, maxConcurrent: 1 } },
      { now: c.now },
    );
    expect(bm.tryAcquire('gh').ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'concurrency' });
    }
    bm.release('gh');
    expect(bm.tryAcquire('gh').ok).toBe(true);
    bm.release('gh');
    expect(bm.tryAcquire('gh').ok).toBe(true); // 3rd token still available
    bm.release('gh');
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'per-minute' });
  });

  it('per-minute budget applies to stdio too', () => {
    const c = clock(0);
    const bm = new BudgetManager(
      { fs: { transport: 'stdio', maxPerMinute: 1 } },
      { now: c.now },
    );
    expect(bm.tryAcquire('fs').ok).toBe(true);
    bm.release('fs');
    // Idle again, but the minute token is spent.
    expect(bm.tryAcquire('fs')).toEqual({ ok: false, reason: 'per-minute' });
    c.set(60_001);
    expect(bm.tryAcquire('fs').ok).toBe(true);
  });
});

describe('BudgetManager — stdio idle-only rule', () => {
  it('allows a speculative call only when the server is fully idle', () => {
    const bm = new BudgetManager({ fs: { transport: 'stdio' } });
    expect(bm.tryAcquire('fs')).toEqual({ ok: true });
    expect(bm.specInFlight('fs')).toBe(1);
  });

  it('denies while a real call is in flight (stdio-busy)', () => {
    const bm = new BudgetManager({ fs: { transport: 'stdio' } });
    bm.realStarted('fs');
    expect(bm.tryAcquire('fs')).toEqual({ ok: false, reason: 'stdio-busy' });

    bm.realFinished('fs');
    expect(bm.tryAcquire('fs')).toEqual({ ok: true });
  });

  it('denies while another speculative call is in flight', () => {
    const bm = new BudgetManager({ fs: { transport: 'stdio' } });
    expect(bm.tryAcquire('fs')).toEqual({ ok: true });
    expect(bm.tryAcquire('fs')).toEqual({ ok: false, reason: 'stdio-busy' });

    bm.release('fs');
    expect(bm.tryAcquire('fs')).toEqual({ ok: true });
  });

  it('ignores configured maxConcurrent: stdio is always effectively 1', () => {
    const bm = new BudgetManager({
      fs: { transport: 'stdio', maxConcurrent: 5 },
    });
    expect(bm.tryAcquire('fs')).toEqual({ ok: true });
    expect(bm.tryAcquire('fs')).toEqual({ ok: false, reason: 'stdio-busy' });
    expect(bm.specInFlight('fs')).toBe(1);
  });

  it('denies while both real and speculative traffic are pending', () => {
    const bm = new BudgetManager({ fs: { transport: 'stdio' } });
    expect(bm.tryAcquire('fs').ok).toBe(true);
    bm.realStarted('fs');
    expect(bm.tryAcquire('fs')).toEqual({ ok: false, reason: 'stdio-busy' });
    bm.release('fs');
    // Real call still in flight.
    expect(bm.tryAcquire('fs')).toEqual({ ok: false, reason: 'stdio-busy' });
    bm.realFinished('fs');
    expect(bm.tryAcquire('fs').ok).toBe(true);
  });
});

describe('BudgetManager — server independence', () => {
  it('budgets are tracked per server', () => {
    const bm = new BudgetManager({
      gh: { transport: 'http', maxConcurrent: 1 },
      fs: { transport: 'stdio' },
    });
    expect(bm.tryAcquire('gh').ok).toBe(true);
    expect(bm.tryAcquire('gh')).toEqual({ ok: false, reason: 'concurrency' });
    // gh saturation does not affect fs.
    expect(bm.tryAcquire('fs').ok).toBe(true);
    expect(bm.specInFlight('gh')).toBe(1);
    expect(bm.specInFlight('fs')).toBe(1);
    // Real traffic on gh does not make fs stdio-busy.
    bm.realStarted('gh');
    bm.release('fs');
    expect(bm.tryAcquire('fs').ok).toBe(true);
  });
});
