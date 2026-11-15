/**
 * The `/speculate` report: what it tells the person beyond the counters.
 */
import { describe, expect, it } from 'vitest';
import { formatReport } from '../src/report.js';
import { CLAIM_BYPASSED, Speculator } from '../src/speculator.js';

describe('formatReport', () => {
  it('says speculation is running by saying nothing about it being off', () => {
    const spec = new Speculator();
    expect(formatReport(spec.stats(), null, {})).not.toMatch(/off for this session/i);
  });

  it('says so, and why, when speculation stopped itself', () => {
    const report = formatReport({ ...new Speculator().stats(), halted: CLAIM_BYPASSED }, null, {});
    expect(report).toMatch(/off for this session/i);
    expect(report).toMatch(/PreToolUse/);
  });
});
