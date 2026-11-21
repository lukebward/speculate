/**
 * What the live benchmark measures, as pure functions over recorded data.
 *
 * `bench/live.ts` runs real Claude Code sessions and hands their
 * `--output-format stream-json` lines to `measureSession`. Nothing here
 * starts a process, reads a clock, or touches the network, so the arithmetic
 * behind every published number is covered by `test/bench-measure.spec.ts`.
 *
 * Tool wait is taken from the host's own event timestamps: the `assistant`
 * event that carries a `tool_use` block, and the `user` event that carries
 * its `tool_result`. That interval is what the model waited, whoever answered
 * the call, and it includes everything the mod adds to a call it does not
 * answer. It is independent of the mod's own "estimated time saved".
 */

/** One stdout line of a session, and when the runner received it. */
export interface StreamLine {
  at: number;
  line: string;
}

export interface CallSample {
  /** Tool name as the model called it (`mcp__server__tool`, or a built-in). */
  tool: string;
  mcp: boolean;
  /** The call's arguments as JSON, for auditing what the model chose. */
  args: string;
  /** Milliseconds from the session's first event to the call. */
  startMs: number;
  waitMs: number;
  isError: boolean;
}

export interface SessionMeasure {
  calls: CallSample[];
  mcpCalls: number;
  mcpErrors: number;
  /** Sum of the MCP calls' waits. Parallel calls count once each. */
  toolWaitMs: number;
  /** Wall-clock time with at least one MCP call outstanding. */
  toolWallMs: number;
  /** The host's own totals for the session; null when it never reported. */
  durationMs: number | null;
  apiMs: number | null;
  turns: number | null;
  costUsd: number | null;
  /** The model the host says it ran, which an alias such as `haiku` hides. */
  servedModel: string | null;
  /** The session ended with a successful result. */
  ok: boolean;
}

/** The mod's cumulative counters this benchmark reads (src/metrics.ts). */
export const USAGE_KEYS = [
  'hits',
  'joins',
  'misses',
  'speculativeCalls',
  'wasted',
  'estimatedSavedMs',
  'estimatedAddedWaitMs',
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];
export type Usage = Record<UsageKey, number>;

export type Arm = 'off' | 'on';

export interface SessionRow extends SessionMeasure {
  scenario: string;
  workload: string;
  model: string;
  /** 1-based. The `on` arm's memory carries from one pair to the next. */
  pair: number;
  arm: Arm;
  /** Which of the pair's two sessions ran first (1) or second (2). */
  order: 1 | 2;
  /** What the mod counted during this session; null for the `off` arm. */
  mod: Usage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Total length covered by a set of intervals, overlaps counted once. */
export function unionLength(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .map(([start, end]) => [start, end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const interval of sorted) {
    if (current === null) {
      current = interval;
    } else if (interval[0] <= current[1]) {
      current[1] = Math.max(current[1], interval[1]);
    } else {
      total += current[1] - current[0];
      current = interval;
    }
  }
  return current === null ? total : total + (current[1] - current[0]);
}

/**
 * Reads one session's event stream. Lines that are not JSON, and events this
 * does not know, are skipped: the stream carries a good deal else.
 */
export function measureSession(lines: readonly StreamLine[]): SessionMeasure {
  const open = new Map<string, { tool: string; at: number; args: string }>();
  const calls: CallSample[] = [];
  const spans: Array<[number, number]> = [];
  let first: number | null = null;
  let durationMs: number | null = null;
  let apiMs: number | null = null;
  let turns: number | null = null;
  let costUsd: number | null = null;
  let servedModel: string | null = null;
  let ok = false;

  for (const { at, line } of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const stamped = typeof event['timestamp'] === 'string' ? Date.parse(event['timestamp']) : NaN;
    const ts = Number.isFinite(stamped) ? stamped : at;
    first ??= ts;

    if (event['type'] === 'system' && event['subtype'] === 'init' && typeof event['model'] === 'string') {
      servedModel = event['model'];
      continue;
    }
    if (event['type'] === 'result') {
      durationMs = finite(event['duration_ms']);
      apiMs = finite(event['duration_api_ms']);
      turns = finite(event['num_turns']);
      costUsd = finite(event['total_cost_usd']);
      ok = event['is_error'] !== true && event['subtype'] === 'success';
      continue;
    }
    if (event['type'] !== 'assistant' && event['type'] !== 'user') continue;
    // A subagent's calls belong to its own turn, not to the session's.
    if (typeof event['parent_tool_use_id'] === 'string') continue;
    const message = event['message'];
    const content = isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (event['type'] === 'assistant' && block['type'] === 'tool_use') {
        if (typeof block['id'] !== 'string' || typeof block['name'] !== 'string') continue;
        open.set(block['id'], { tool: block['name'], at: ts, args: JSON.stringify(block['input'] ?? {}) });
      } else if (event['type'] === 'user' && block['type'] === 'tool_result') {
        const id = block['tool_use_id'];
        const started = typeof id === 'string' ? open.get(id) : undefined;
        if (typeof id !== 'string' || started === undefined) continue;
        open.delete(id);
        const mcp = started.tool.startsWith('mcp__');
        const waitMs = Math.max(0, ts - started.at);
        calls.push({
          tool: started.tool,
          mcp,
          args: started.args,
          startMs: started.at - first,
          waitMs,
          isError: block['is_error'] === true,
        });
        if (mcp) spans.push([started.at, ts]);
      }
    }
  }

  const mcp = calls.filter(call => call.mcp);
  return {
    calls,
    mcpCalls: mcp.length,
    mcpErrors: mcp.filter(call => call.isError).length,
    toolWaitMs: mcp.reduce((sum, call) => sum + call.waitMs, 0),
    toolWallMs: unionLength(spans),
    durationMs,
    apiMs,
    turns,
    costUsd,
    servedModel,
    ok,
  };
}

/** The counters out of whatever the plugin store held; absent ones are zero. */
export function readUsage(raw: unknown): Usage {
  const source = isRecord(raw) ? raw : {};
  const usage = {} as Usage;
  for (const key of USAGE_KEYS) usage[key] = Math.max(0, finite(source[key]) ?? 0);
  return usage;
}

/** What one session added to the cumulative counters. */
export function usageDelta(before: Usage, after: Usage): Usage {
  const delta = {} as Usage;
  for (const key of USAGE_KEYS) delta[key] = after[key] - before[key];
  return delta;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface ArmSummary {
  sessions: number;
  /** MCP calls that returned a result. */
  calls: number;
  /** MCP calls that returned an error; counted apart, never a wait sample. */
  errors: number;
  /** All waits pooled: total wait over total calls. */
  meanCallWaitMs: number | null;
  medianCallWaitMs: number | null;
  medianSessionToolWaitMs: number | null;
  medianSessionDurationMs: number | null;
}

export interface PhaseSummary {
  /** Pairs in this phase with both sessions usable. */
  pairs: number;
  /** Pairs left out: a session failed, or got no result from any MCP call. */
  excludedPairs: number;
  off: ArmSummary;
  on: ArmSummary;
  /** 1 - on/off of the pooled per-call wait; null when either arm is empty. */
  callWaitReduction: number | null;
  /** 1 - on/off of the median session duration. */
  durationReduction: number | null;
  /** Pairs whose `on` session waited less on tools than its `off` session. */
  pairsWithLessToolWait: number;
  /** Calls the mod answered: ready results plus in-flight joins. */
  served: number;
  hits: number;
  joins: number;
  /** Prefetches the mod started. */
  prefetches: number;
  /** Prefetches nothing used: started minus served. Extra upstream reads. */
  unused: number;
  /** The mod's own estimate, for comparison with the measured waits. */
  estimatedSavedMs: number;
}

export interface Summary {
  scenario: string;
  workload: string;
  model: string;
  warmupPairs: number;
  cold: PhaseSummary;
  warm: PhaseSummary;
}

/**
 * An MCP call that came back with a result. A call that errored is not a wait
 * sample: it is usually a fast refusal (the model's own bad argument, or a
 * server's quota message), and a few of them in one arm would pass for speed.
 */
const answered = (row: SessionRow): CallSample[] => row.calls.filter(call => call.mcp && !call.isError);

function usable(row: SessionRow | undefined): row is SessionRow {
  return row !== undefined && row.ok && answered(row).length > 0;
}

function summarizeArm(rows: readonly SessionRow[]): ArmSummary {
  const waits = rows.flatMap(row => answered(row).map(call => call.waitMs));
  return {
    sessions: rows.length,
    calls: waits.length,
    errors: rows.reduce((sum, row) => sum + row.mcpErrors, 0),
    meanCallWaitMs: mean(waits),
    medianCallWaitMs: median(waits),
    medianSessionToolWaitMs: median(rows.map(row => row.toolWaitMs)),
    medianSessionDurationMs: median(rows.flatMap(row => (row.durationMs === null ? [] : [row.durationMs]))),
  };
}

function reduction(off: number | null, on: number | null): number | null {
  return off === null || on === null || off <= 0 ? null : 1 - on / off;
}

function summarizePhase(rows: readonly SessionRow[], pairs: readonly number[]): PhaseSummary {
  const off: SessionRow[] = [];
  const on: SessionRow[] = [];
  let excludedPairs = 0;
  let pairsWithLessToolWait = 0;
  for (const pair of pairs) {
    const offRow = rows.find(row => row.pair === pair && row.arm === 'off');
    const onRow = rows.find(row => row.pair === pair && row.arm === 'on');
    if (!usable(offRow) || !usable(onRow)) {
      excludedPairs++;
      continue;
    }
    off.push(offRow);
    on.push(onRow);
    if (onRow.toolWaitMs < offRow.toolWaitMs) pairsWithLessToolWait++;
  }
  const offSummary = summarizeArm(off);
  const onSummary = summarizeArm(on);
  const total = (key: UsageKey): number => on.reduce((sum, row) => sum + (row.mod?.[key] ?? 0), 0);
  const hits = total('hits');
  const joins = total('joins');
  const prefetches = total('speculativeCalls');
  return {
    pairs: off.length,
    excludedPairs,
    off: offSummary,
    on: onSummary,
    callWaitReduction: reduction(offSummary.meanCallWaitMs, onSummary.meanCallWaitMs),
    durationReduction: reduction(offSummary.medianSessionDurationMs, onSummary.medianSessionDurationMs),
    pairsWithLessToolWait,
    served: hits + joins,
    hits,
    joins,
    prefetches,
    unused: prefetches - hits - joins,
    estimatedSavedMs: total('estimatedSavedMs'),
  };
}

/** Every scenario, workload and model in a set of sessions, each summarized. */
export function summarizeAll(rows: readonly SessionRow[], warmupPairs: number): Summary[] {
  const groups = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.scenario, row.workload, row.model]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map(group => summarize(group, warmupPairs));
}

/**
 * One scenario and workload, split at `warmupPairs`: the pairs up to it are
 * the mod's learning sessions and are reported apart, never dropped.
 */
export function summarize(rows: readonly SessionRow[], warmupPairs: number): Summary {
  const head = rows[0];
  const pairs = [...new Set(rows.map(row => row.pair))].sort((a, b) => a - b);
  return {
    scenario: head?.scenario ?? '',
    workload: head?.workload ?? '',
    model: head?.model ?? '',
    warmupPairs,
    cold: summarizePhase(rows, pairs.filter(pair => pair <= warmupPairs)),
    warm: summarizePhase(rows, pairs.filter(pair => pair > warmupPairs)),
  };
}

const ms = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value)} ms`);

export type Phase = 'cold' | 'warm';

/** A reduction as a signed change: 25% less wait reads "-25%". */
function change(reduction: number | null): string {
  if (reduction === null) return 'n/a';
  const percent = Math.abs(reduction * 100).toFixed(0);
  return percent === '0' ? '0%' : `${reduction > 0 ? '-' : '+'}${percent}%`;
}

/** One phase of each summary as a Markdown table of calls and what served them, for the docs. */
export function markdownTable(summaries: readonly Summary[], phase: Phase = 'warm'): string {
  const lines = [
    '| Server | Workload | Calls off / on | Errors off / on | Served | Prefetches | Unused | Mean wait per call, off | Mean wait per call, on | Change |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const summary of summaries) {
    const p = summary[phase];
    lines.push(
      `| ${summary.scenario} | ${summary.workload} | ${p.off.calls} / ${p.on.calls} | ${p.off.errors} / ${p.on.errors} ` +
        `| ${p.served} (${p.hits} ready, ${p.joins} joined) | ${p.prefetches} | ${p.unused} ` +
        `| ${ms(p.off.meanCallWaitMs)} | ${ms(p.on.meanCallWaitMs)} | ${change(p.callWaitReduction)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * The same phase per session, as medians: what the tools cost a session, and
 * the session itself. One slow call moves a median far less than a mean.
 */
export function markdownSessionTable(summaries: readonly Summary[], phase: Phase = 'warm'): string {
  const lines = [
    '| Server | Workload | Pairs | Tool wait per session, off | Tool wait per session, on | Change | Pairs with less wait | Session time, off | Session time, on | Change |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const summary of summaries) {
    const p = summary[phase];
    lines.push(
      `| ${summary.scenario} | ${summary.workload} | ${p.pairs}${p.excludedPairs > 0 ? ` (${p.excludedPairs} excluded)` : ''} ` +
        `| ${ms(p.off.medianSessionToolWaitMs)} | ${ms(p.on.medianSessionToolWaitMs)} ` +
        `| ${change(reduction(p.off.medianSessionToolWaitMs, p.on.medianSessionToolWaitMs))} ` +
        `| ${p.pairsWithLessToolWait} of ${p.pairs} ` +
        `| ${ms(p.off.medianSessionDurationMs)} | ${ms(p.on.medianSessionDurationMs)} | ${change(p.durationReduction)} |`,
    );
  }
  return lines.join('\n');
}
