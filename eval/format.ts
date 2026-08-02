/**
 * Rendering for the evaluation report — pure functions, no I/O, no argv.
 *
 * Separate from eval.ts because the `BASELINE` line is the artifact every
 * later task diffs against: it needs a test, and a module that prints on
 * import cannot have one.
 */
import { ARCHETYPE_TIMING, FLOOR_ARCHETYPES } from './corpus.js';
import { CALL_LATENCY_MS, toAgeReport } from './replay.js';
import type {
  AgeTotals,
  ArchetypeResult,
  EvalRun,
  RecallReport,
  ReplayTotals,
} from './replay.js';

interface Column {
  head: string;
  width: number;
}

const COLUMNS: readonly Column[] = [
  { head: 'archetype', width: 22 },
  { head: 'pairs', width: 7 },
  { head: 'recall@1', width: 10 },
  { head: 'recall@3', width: 10 },
  { head: 'recall@5', width: 10 },
  { head: 'waste/hit', width: 11 },
];
/** Appended only when a comparison run is supplied. */
const DELTA_COLUMN: Column = { head: 'd recall@3', width: 12 };

const TABLE_WIDTH = COLUMNS.reduce((a, c) => a + c.width, 0);
/** Wide enough for the longest `prevTool->nextTool` in the corpus. */
const TRANSITION_WIDTH = 34;

export function fmtWaste(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : 'inf';
}

function recallAt3(t: ReplayTotals): number {
  return t.pairs > 0 ? t.hitsAt3 / t.pairs : 0;
}

function head(extra?: Column): string {
  const cols = extra ? [...COLUMNS, extra] : COLUMNS;
  return cols.map((c, i) => (i === 0 ? c.head.padEnd(c.width) : c.head.padStart(c.width))).join('');
}

function rule(extra?: Column): string {
  return '-'.repeat(TABLE_WIDTH + (extra ? extra.width : 0));
}

/** One table row. `delta` is the change in recall@3 against a comparison run. */
export function row(report: RecallReport, delta?: number): string {
  const cells = [
    report.archetype.padEnd(COLUMNS[0]!.width),
    String(report.pairs).padStart(COLUMNS[1]!.width),
    report.recallAt1.toFixed(3).padStart(COLUMNS[2]!.width),
    report.recallAt3.toFixed(3).padStart(COLUMNS[3]!.width),
    report.recallAt5.toFixed(3).padStart(COLUMNS[4]!.width),
    fmtWaste(report.wastePerHit).padStart(COLUMNS[5]!.width),
  ];
  if (delta !== undefined) {
    const sign = delta > 0 ? '+' : delta < 0 ? '' : ' ';
    cells.push(`${sign}${delta.toFixed(3)}`.padStart(DELTA_COLUMN.width));
  }
  return cells.join('');
}

/**
 * The line later tasks diff against. Shape is asserted by test/eval.test.ts:
 * `BASELINE recall@3 X.XXXX seeds=N[,N…] pairs=N waste/hit=X.XX`.
 *
 * The headline pools the WORKFLOW archetypes only. The floor rides along in
 * the tail of the line so it is never silently dropped, but pooling it in
 * would let a change that merely fires harder on noise move the headline.
 */
export function baselineLine(run: EvalRun): string {
  const w = run.workflow;
  const f = run.floor;
  return (
    `BASELINE recall@3 ${recallAt3(w).toFixed(4)} seeds=${run.seeds.join(',')}` +
    ` pairs=${w.pairs} waste/hit=${fmtWaste(toReportLike(w).wastePerHit)}` +
    ` (workflow) | floor recall@3 ${recallAt3(f).toFixed(4)}` +
    ` pairs=${f.pairs} waste/hit=${fmtWaste(toReportLike(f).wastePerHit)}`
  );
}

function toReportLike(t: ReplayTotals): RecallReport {
  return {
    archetype: '',
    pairs: t.pairs,
    recallAt1: t.pairs > 0 ? t.hitsAt1 / t.pairs : 0,
    recallAt3: recallAt3(t),
    recallAt5: t.pairs > 0 ? t.hitsAt5 / t.pairs : 0,
    wastePerHit:
      t.hitsAt3 > 0 ? t.wasted / t.hitsAt3 : t.wasted > 0 ? Number.POSITIVE_INFINITY : 0,
  };
}

export interface TableOptions {
  /** Per-archetype recall@3 from an earlier run, keyed by archetype name. */
  compare?: Map<string, number>;
}

/** The main table: workflow rows, the pooled headline, then the floor. */
export function table(run: EvalRun, opts: TableOptions = {}): string[] {
  const cmp = opts.compare;
  const extra = cmp ? DELTA_COLUMN : undefined;
  const delta = (r: RecallReport): number | undefined => {
    const before = cmp?.get(r.archetype);
    return before === undefined ? undefined : r.recallAt3 - before;
  };

  const lines: string[] = [head(extra), rule(extra)];
  const floors: ArchetypeResult[] = [];
  for (const result of run.byArchetype) {
    if (FLOOR_ARCHETYPES.has(result.report.archetype)) {
      floors.push(result);
      continue;
    }
    lines.push(row(result.report, delta(result.report)));
  }
  lines.push(rule(extra));
  const headline = { ...toReportLike(run.workflow), archetype: 'WORKFLOW (headline)' };
  lines.push(row(headline, delta(headline)));
  lines.push('');
  for (const result of floors) {
    const r = { ...result.report, archetype: `${result.report.archetype} (floor)` };
    lines.push(row(r, delta(result.report)));
  }
  return lines;
}

const AGE_COLUMNS: readonly Column[] = [
  { head: 'class', width: 22 },
  { head: 'hits', width: 7 },
  { head: 'median', width: 10 },
  { head: 'p95', width: 10 },
  { head: 'max', width: 10 },
  { head: 'last TTL 1/4', width: 14 },
  { head: 'mean lead', width: 11 },
  { head: 'unclaimed', width: 11 },
];

function ageRow(label: string, totals: AgeTotals): string {
  const a = toAgeReport(totals);
  const ms = (v: number | null): string => (v === null ? '-' : `${v}ms`);
  const cells = [
    label.padEnd(AGE_COLUMNS[0]!.width),
    String(a.hits).padStart(AGE_COLUMNS[1]!.width),
    ms(a.p50Ms).padStart(AGE_COLUMNS[2]!.width),
    ms(a.p95Ms).padStart(AGE_COLUMNS[3]!.width),
    ms(a.maxMs).padStart(AGE_COLUMNS[4]!.width),
    (a.lastQuarterShare === null ? '-' : a.lastQuarterShare.toFixed(3)).padStart(
      AGE_COLUMNS[5]!.width,
    ),
    (a.meanLead === null ? '-' : a.meanLead.toFixed(3)).padStart(AGE_COLUMNS[6]!.width),
    String(a.unconsumed).padStart(AGE_COLUMNS[7]!.width),
  ];
  return cells.join('');
}

/**
 * Freshness of what the simulated buffer served (§6.2). Recall says whether
 * the right call was predicted; this says how OLD the answer was when it was
 * handed over — the number that better prediction can only push upward, and
 * which no other line in this report would show moving.
 */
export function ageTable(run: EvalRun): string[] {
  const width = AGE_COLUMNS.reduce((a, c) => a + c.width, 0);
  const factor =
    run.standingTtlFactor === 1
      ? 'standing bets on the same TTL'
      : `standing bets at x${run.standingTtlFactor}`;
  // The quarter boundary a hit would have to reach to be "near expiry" at all,
  // expressed in the units this corpus actually varies: calls apart.
  const leadToEdge = (0.75 * run.ttlMs + CALL_LATENCY_MS) / run.callSpacingMs;
  return [
    `age at consumption (${run.ttlMs} ms TTL, single-use buffer, ${factor})`,
    AGE_COLUMNS.map((c, i) =>
      i === 0 ? c.head.padEnd(c.width) : c.head.padStart(c.width),
    ).join(''),
    '-'.repeat(width),
    ageRow('all', run.age.all),
    ageRow('next-call', run.age.next),
    ageRow('standing (memorized)', run.age.standing),
    '',
    ageRow('adversarial (floor)', run.floorAge.all),
    '',
    // Said plainly, because three columns of the same number read as three
    // independent measurements and are not.
    `calls are ${run.callSpacingMs} ms apart, so age = lead x ${run.callSpacingMs} - ${CALL_LATENCY_MS} ms exactly:`,
    'median/p95/max carry nothing beyond mean lead, which is the live statistic here.',
    `"last TTL 1/4" cannot be non-zero below a lead of ${leadToEdge.toFixed(1)} at this spacing.`,
  ];
}

/**
 * Footnotes for archetypes that do not replay on the standard schedule, so
 * the header's "N sessions/archetype, first M warm-up" is never quietly false.
 */
export function notes(run: EvalRun): string[] {
  const out: string[] = [];
  for (const result of run.byArchetype) {
    const timing = ARCHETYPE_TIMING.get(result.report.archetype);
    if (!timing) continue;
    const bits = [
      `${result.sessions} sessions/seed`,
      `first ${result.warmupSessions} warm-up`,
    ];
    if (timing.idleGap) {
      const days = Math.round(timing.idleGap.ms / 86_400_000);
      bits.push(`${days}-day idle gap before session ${timing.idleGap.beforeSession}`);
    }
    out.push(`${result.report.archetype}: ${bits.join(', ')}`);
  }
  return out;
}

/** Per-transition breakdown: which (prevTool → nextTool) pairs move. */
export function detail(run: EvalRun): string[] {
  const lines: string[] = [];
  for (const result of run.byArchetype) {
    lines.push(`${result.report.archetype}   (transition, pairs, recall@1/@3/@5)`);
    for (const t of result.byTransition) {
      lines.push(
        `  ${t.transition.padEnd(TRANSITION_WIDTH)}` +
          `${(t.hitsAt1 / t.pairs).toFixed(3).padStart(COLUMNS[2]!.width)}` +
          `${(t.hitsAt3 / t.pairs).toFixed(3).padStart(COLUMNS[3]!.width)}` +
          `${(t.hitsAt5 / t.pairs).toFixed(3).padStart(COLUMNS[4]!.width)}` +
          `${String(t.pairs).padStart(COLUMNS[5]!.width)} pairs`,
      );
    }
    lines.push('');
  }
  return lines;
}
