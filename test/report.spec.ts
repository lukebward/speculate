/**
 * The `/speculate` report: what it tells the person beyond the counters.
 */
import { describe, expect, it } from 'vitest';
import { formatReport } from '../src/report.js';
import { Speculator } from '../src/speculator.js';

describe('formatReport', () => {
  const stats = () => new Speculator().stats();

  it('says how many MCP tools the hooks name', () => {
    expect(formatReport(stats(), null, {}, { named: 12 })).toContain('Watching 12 MCP tools by name.');
  });

  it('says so while every tool call is watched, and why', () => {
    const unsaved = formatReport(stats(), null, {}, { all: 'unsaved' });
    expect(unsaved).toContain('Watching every tool call until the list of MCP tools is saved');
    const refused = formatReport(stats(), null, {}, { all: 'refused' });
    expect(refused).toContain('your settings did not keep the list of MCP tools');
  });

  it('says nothing about watching when it is not told', () => {
    expect(formatReport(stats(), null, {})).not.toMatch(/Watching/);
  });
});
