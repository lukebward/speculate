/**
 * Recorded sessions, and their replay through the mod's own core.
 *
 * A live run (`bench/live.ts --keep`) leaves each session's event stream on
 * disk. `extractTrace` turns one into the calls the model made: their
 * arguments, results, how long each took, and how long the model took before
 * each. `replayTraces` then runs those calls through a real `Speculator` on a
 * virtual clock, driving it the way `hooks/register.ts` does: memory carried
 * from one session to the next, a prefetch answered with what the server
 * answered the recorded call, and every call served or run as the core
 * decides.
 *
 * It costs nothing and takes milliseconds, so a change to prediction can be
 * tried against what a model really did before it is measured live. It is
 * not a measurement: the model's calls are fixed to the recording, where a
 * real model might have asked differently once a call came back sooner, and
 * the host's own costs are not in it.
 */
import { mcpToolName, parseMcpToolName, Speculator, type RealOutcome, type SpeculationIo } from '../src/speculator.js';
import { recordOf, type RecordForm } from '../src/tools.js';
import type { SpeculateOptions, ToolResult } from '../src/types.js';
import type { StreamLine } from './measure.js';

export interface TraceCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** The result as the model read it. */
  text: string;
  /** How the host recorded it: one text, or content blocks. */
  form: RecordForm;
  isError: boolean;
  /** Milliseconds from the session's first event to the call. */
  startMs: number;
  latencyMs: number;
}

export interface Trace {
  /** Where it came from, for the report. */
  label: string;
  calls: TraceCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The text of a tool result block's content, and the form it was kept in. */
function resultText(content: unknown): { text: string; form: RecordForm } {
  if (typeof content === 'string') return { text: content, form: 'text' };
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .map(block => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n');
  return { text, form: 'blocks' };
}

/** The MCP calls of one recorded session, in the order the model made them. */
export function extractTrace(lines: readonly StreamLine[], label: string): Trace {
  const open = new Map<string, { name: string; args: Record<string, unknown>; at: number }>();
  const calls: TraceCall[] = [];
  let first: number | null = null;
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
    // A stream read back from a file has no arrival times: the session starts
    // at its first event that says when it happened.
    if (first === null && (Number.isFinite(stamped) || at > 0)) first = ts;
    if (first === null) continue;
    if ((event['type'] !== 'assistant' && event['type'] !== 'user') || typeof event['parent_tool_use_id'] === 'string') continue;
    const message = event['message'];
    const content = isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (event['type'] === 'assistant' && block['type'] === 'tool_use') {
        if (typeof block['id'] !== 'string' || typeof block['name'] !== 'string') continue;
        open.set(block['id'], { name: block['name'], args: isRecord(block['input']) ? block['input'] : {}, at: ts });
      } else if (event['type'] === 'user' && block['type'] === 'tool_result') {
        const id = block['tool_use_id'];
        const started = typeof id === 'string' ? open.get(id) : undefined;
        if (typeof id !== 'string' || started === undefined) continue;
        open.delete(id);
        const name = parseMcpToolName(started.name);
        if (!name) continue;
        calls.push({
          ...name,
          args: started.args,
          ...resultText(block['content']),
          isError: block['is_error'] === true,
          startMs: started.at - first,
          latencyMs: Math.max(0, ts - started.at),
        });
      }
    }
  }
  calls.sort((a, b) => a.startMs - b.startMs);
  return { label, calls };
}

export interface ReplayedCall {
  tool: string;
  served: boolean;
  isError: boolean;
}

export interface ReplayedSession {
  label: string;
  calls: ReplayedCall[];
  /** Prefetches the core started during this session. */
  prefetched: Array<{ tool: string; args: Record<string, unknown> }>;
}

export interface ReplayReport {
  sessions: ReplayedSession[];
  calls: number;
  served: number;
  prefetches: number;
  /** Predictions the core did not start, by its own reason, over the whole replay. */
  notStarted: Record<string, number>;
  recallAt1: number | null;
  recallAt3: number | null;
}

export interface ReplayOptions {
  /** Sessions at the start whose calls are replayed but left out of the totals. */
  warmup?: number;
  /** Milliseconds a served call takes: the host's own time for it. */
  servedMs?: number;
  /** Options for the core, as `new Speculator(options)` takes them. */
  speculator?: Partial<SpeculateOptions>;
  /** Called with each new core before it is used: a place to vary it. */
  configure?: (speculator: Speculator) => void;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

const asResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

/**
 * Replays recorded sessions in order through one core whose memory carries
 * from each session to the next, as the mod's store does.
 */
export async function replayTraces(traces: readonly Trace[], options: ReplayOptions = {}): Promise<ReplayReport> {
  const warmup = options.warmup ?? 0;
  const servedMs = options.servedMs ?? 25;

  // --- a virtual clock: nothing here waits on real time ----------------------
  let t = 1_800_000_000_000;
  const timers: Array<{ at: number; fire: () => void }> = [];
  const now = (): number => t;
  const sleep = (ms: number): Promise<void> => new Promise(resolve => timers.push({ at: t + Math.max(0, ms), fire: resolve }));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  const run = async (main: Promise<void>): Promise<void> => {
    let done = false;
    void main.finally(() => {
      done = true;
    });
    for (;;) {
      await settle();
      if (done) break;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) throw new Error('replay stalled: nothing is scheduled and the session has not ended');
      t = Math.max(t, next.at);
      next.fire();
    }
    await main;
  };

  // What the server answered each recorded call, for a prefetch of the same call.
  const answers = new Map<string, TraceCall>();
  const typical = new Map<string, number[]>();
  for (const trace of traces) {
    for (const call of trace.calls) {
      if (call.isError) continue;
      answers.set(stable([call.server, call.tool, call.args]), call);
      const key = `${call.server}\0${call.tool}`;
      typical.set(key, [...(typical.get(key) ?? []), call.latencyMs]);
    }
  }
  const usual = (server: string, tool: string): number => {
    const seen = [...(typical.get(`${server}\0${tool}`) ?? [300])].sort((a, b) => a - b);
    return seen[seen.length >> 1]!;
  };

  let prefetched: ReplayedSession['prefetched'] = [];
  const io: SpeculationIo = {
    call: async (server, tool, args) => {
      prefetched.push({ tool, args });
      const recorded = answers.get(stable([server, tool, args]));
      await sleep(recorded?.latencyMs ?? usual(server, tool));
      return asResult(recorded?.text ?? '');
    },
    authorize: async () => true,
    sleep,
  };

  const make = (memory?: unknown): Speculator => {
    const speculator = new Speculator(options.speculator ?? {}, { now });
    options.configure?.(speculator);
    if (memory !== undefined) speculator.importMemory(memory as never);
    return speculator;
  };

  const report: ReplayReport = {
    sessions: [],
    calls: 0,
    served: 0,
    prefetches: 0,
    notStarted: {},
    recallAt1: null,
    recallAt3: null,
  };
  let opportunities = 0;
  let hitsAt1 = 0;
  let hitsAt3 = 0;
  let speculator = make();

  for (const [index, trace] of traces.entries()) {
    prefetched = [];
    const session: ReplayedSession = { label: trace.label, calls: [], prefetched };
    const counted = index >= warmup;

    const one = async (call: TraceCall): Promise<void> => {
      const claim = await speculator.serve(call.server, call.tool, call.args, io, sleep(8_500), 8_500);
      const answer = claim ? recordOf(claim.result, speculator.tools.form(call.server, call.tool)) : null;
      const started = speculator.beginReal(call.server);
      if (claim && answer !== null) {
        await sleep(servedMs);
        claim.commit();
        speculator.observeServed(call.server, call.tool, call.args, claim, io);
        session.calls.push({ tool: call.tool, served: true, isError: false });
        return;
      }
      claim?.discard('record-form');
      await sleep(call.latencyMs);
      const outcome: RealOutcome = {
        result: asResult(call.text),
        isReadOnly: true,
        servable: !call.isError,
        form: call.form,
        isError: call.isError,
        latencyMs: call.latencyMs,
      };
      speculator.observe(call.server, call.tool, call.args, outcome, io, started);
      session.calls.push({ tool: call.tool, served: false, isError: call.isError });
    };

    const main = (async (): Promise<void> => {
      const servers = [...new Set(trace.calls.map(call => call.server))];
      const tools = [...new Set(trace.calls.map(call => mcpToolName(call.server, call.tool)))];
      void servers;
      speculator.sessionStart(tools, io);
      // Calls the model issued together (one began before another ended) run together.
      let previousEnd = 0;
      let step: TraceCall[] = [];
      const steps: TraceCall[][] = [];
      let stepEnd = 0;
      for (const call of trace.calls) {
        if (step.length > 0 && call.startMs >= stepEnd) {
          steps.push(step);
          step = [];
        }
        step.push(call);
        stepEnd = Math.max(stepEnd, call.startMs + call.latencyMs);
      }
      if (step.length > 0) steps.push(step);
      for (const group of steps) {
        const first = group[0]!;
        // The model's own time before this step, as recorded.
        await sleep(Math.max(0, first.startMs - previousEnd));
        await Promise.all(group.map(async call => {
          await sleep(call.startMs - first.startMs);
          await one(call);
        }));
        previousEnd = Math.max(...group.map(call => call.startMs + call.latencyMs));
      }
      // The model writes its answer; whatever was prefetched for a next call goes unused.
      await sleep(2_000);
    })();
    await run(main);

    const stats = speculator.stats();
    if (counted) {
      report.sessions.push(session);
      report.calls += session.calls.length;
      report.served += session.calls.filter(call => call.served).length;
      report.prefetches += prefetched.length;
      for (const [reason, count] of Object.entries(stats.suppressed)) {
        report.notStarted[reason] = (report.notStarted[reason] ?? 0) + count;
      }
      const usage = speculator.usageDelta();
      opportunities += usage.predictionOpportunities;
      hitsAt1 += usage.predictionHitsAt1;
      hitsAt3 += usage.predictionHitsAt3;
    }
    speculator.close();
    speculator = make(speculator.exportMemory());
    // The next session is another day's.
    t += 60_000;
  }

  report.recallAt1 = opportunities > 0 ? hitsAt1 / opportunities : null;
  report.recallAt3 = opportunities > 0 ? hitsAt3 / opportunities : null;
  return report;
}
