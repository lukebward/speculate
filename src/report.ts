/**
 * The `/speculate` report: is speculation paying for itself here?
 *
 * Counts only: no arguments, keys, or results. Tool and server names come
 * from the host's own configuration and are escaped before display.
 */
import type { UsageCounters } from './metrics.js';
import type { ToolFacts } from './tools.js';
import type { StatsReport } from './types.js';

export function formatReport(
  session: StatsReport & { cache: { ready: number; inFlight: number } },
  totals: unknown,
  tools: ToolFacts,
): string {
  const lifetime = usage(totals);
  const known = Object.entries(tools).flatMap(([server, byTool]) =>
    Object.entries(byTool).map(([tool, fact]) => ({ server, tool, fact })),
  );
  const reads = known.filter(({ fact }) => fact.readOnly && fact.servable);

  const lines = [
    'Speculate',
    '',
    'This session',
    `  Served from prefetch: ${session.hits + session.joins} (${session.hits} ready, ${session.joins} in flight)`,
    `  Real MCP calls: ${session.realCalls}`,
    `  Prefetches started: ${session.speculativeCalls}, wasted: ${session.wasted}`,
    `  Estimated time saved: ${duration(session.estimatedSavedMs)} (net of waits behind prefetches: ${signed(session.netEstimatedSavedMs)})`,
    `  Next-call recall: ${percent(session.predictionQuality.recallAt1)} at 1, ${percent(session.predictionQuality.recallAt3)} at 3`,
  ];
  if (lifetime) {
    const served = lifetime.hits + lifetime.joins;
    lines.push(
      '',
      'All sessions',
      `  Served from prefetch: ${served}`,
      `  Prefetches started: ${lifetime.speculativeCalls}, wasted: ${lifetime.wasted}${served > 0 ? ` (${(lifetime.wasted / served).toFixed(2)} per served call)` : ''}`,
      `  Estimated time saved: ${duration(lifetime.estimatedSavedMs)} (net: ${signed(lifetime.estimatedSavedMs - lifetime.estimatedAddedWaitMs)})`,
    );
  }
  lines.push(
    '',
    `Known MCP tools: ${known.length}, prefetchable reads: ${reads.length}`,
  );
  const suppressed = Object.entries(session.suppressed).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (suppressed.length > 0) {
    lines.push(`  Most common reasons a prediction was not started: ${suppressed.map(([reason, n]) => `${escape(reason)} (${n})`).join(', ')}`);
  }
  if (known.length === 0) {
    lines.push('', 'Nothing learned yet. Speculate learns from the MCP calls Claude Code makes, and only prefetches tools that ran read-only and that your permission settings already allow without asking.');
  }
  return lines.join('\n');
}

function usage(raw: unknown): UsageCounters | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const n = (key: string): number => {
    const v = value[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return {
    hits: n('hits'),
    joins: n('joins'),
    misses: n('misses'),
    speculativeCalls: n('speculativeCalls'),
    wasted: n('wasted'),
    estimatedSavedMs: n('estimatedSavedMs'),
    estimatedAddedWaitMs: n('estimatedAddedWaitMs'),
    predictionOpportunities: n('predictionOpportunities'),
    predictionOffered: n('predictionOffered'),
    predictionHitsAt1: n('predictionHitsAt1'),
    predictionHitsAt3: n('predictionHitsAt3'),
    nearMisses: n('nearMisses'),
    nearMissDistanceOne: n('nearMissDistanceOne'),
  };
}

function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function signed(ms: number): string {
  return ms < 0 ? `-${duration(-ms)}` : duration(ms);
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function escape(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}
