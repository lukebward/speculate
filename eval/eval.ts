/**
 * Prediction-quality evaluation (DESIGN.md §5.3, §10 item 8).
 *
 * Replays the synthetic corpus through the real, server-agnostic
 * TransitionLearner and prints recall@1/3/5 and waste per hit per archetype.
 * Unlike `npm run bench` — which measures what prefetching is worth ONCE the
 * predictions are right — this measures whether the predictions are right at
 * all, with no profile, no rules, and no server.
 *
 * Usage: npm run eval [-- --seed 1] [-- --detail]
 *
 * `--detail` adds the per-transition breakdown: which (prevTool → nextTool)
 * pairs the model gets and which it does not. That is what tells a later
 * change whether it moved the number for the reason it thinks it did.
 *
 * Output is deliberately plain ASCII: the table gets pasted verbatim into
 * task reports as the baseline every later change is diffed against.
 */
import { WARMUP_SESSIONS, SESSIONS_PER_ARCHETYPE } from './corpus.js';
import { MAX_K, PRODUCTION_K, runEvalDetailed, toReport } from './replay.js';
import type { RecallReport } from './replay.js';

const COLUMNS: Array<{ head: string; width: number }> = [
  { head: 'archetype', width: 20 },
  { head: 'pairs', width: 7 },
  { head: 'recall@1', width: 10 },
  { head: 'recall@3', width: 10 },
  { head: 'recall@5', width: 10 },
  { head: 'waste/hit', width: 11 },
];

function row(report: RecallReport): string {
  const cells = [
    report.archetype.padEnd(COLUMNS[0]!.width),
    String(report.pairs).padStart(COLUMNS[1]!.width),
    report.recallAt1.toFixed(3).padStart(COLUMNS[2]!.width),
    report.recallAt3.toFixed(3).padStart(COLUMNS[3]!.width),
    report.recallAt5.toFixed(3).padStart(COLUMNS[4]!.width),
    fmtWaste(report.wastePerHit).padStart(COLUMNS[5]!.width),
  ];
  return cells.join('');
}

function fmtWaste(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : 'inf';
}

function main(): void {
  const seedArg = process.argv.indexOf('--seed');
  const requested = seedArg !== -1 ? Number(process.argv[seedArg + 1]) : 1;
  const seed = Number.isFinite(requested) ? Math.trunc(requested) : 1;

  const run = runEvalDetailed(seed);
  const width = COLUMNS.reduce((a, c) => a + c.width, 0);

  console.log();
  console.log('  Speculate prediction eval - offline recall@K, generic TransitionLearner');
  console.log(
    `  seed ${seed} | ${SESSIONS_PER_ARCHETYPE} sessions/archetype ` +
      `(${WARMUP_SESSIONS} warm-up: learned, not scored) | ` +
      `hit = tool AND args match under the canonical cache key`,
  );
  console.log();
  console.log('  ' + COLUMNS.map((c, i) => (i === 0 ? c.head.padEnd(c.width) : c.head.padStart(c.width))).join(''));
  console.log('  ' + '-'.repeat(width));
  for (const report of run.reports) console.log('  ' + row(report));
  console.log('  ' + '-'.repeat(width));
  console.log('  ' + row(toReport('overall', run.overall)));
  console.log();

  if (process.argv.includes('--detail')) {
    for (const result of run.byArchetype) {
      console.log(`  ${result.report.archetype}   (transition, pairs, recall@1/@3/@5)`);
      for (const t of result.byTransition) {
        console.log(
          `    ${t.transition.padEnd(42)}${String(t.pairs).padStart(6)}` +
            `${(t.hitsAt1 / t.pairs).toFixed(3).padStart(9)}` +
            `${(t.hitsAt3 / t.pairs).toFixed(3).padStart(9)}` +
            `${(t.hitsAt5 / t.pairs).toFixed(3).padStart(9)}`,
        );
      }
      console.log();
    }
  }
  console.log(
    `  BASELINE recall@3 ${run.overall.pairs > 0 ? (run.overall.hitsAt3 / run.overall.pairs).toFixed(4) : '0.0000'}` +
      ` seed=${seed} pairs=${run.overall.pairs} waste/hit=${fmtWaste(toReport('overall', run.overall).wastePerHit)}`,
  );
  console.log();
  console.log(
    `  recall@3 is the headline: ${PRODUCTION_K} is the shipped per-trigger cap (DESIGN.md 5.6).`,
  );
  console.log(
    `  recall@5 is measurable only because the eval raises the learner's cap to ${MAX_K}.`,
  );
  console.log(
    `  waste/hit counts predictions issued at the shipped cap that no real call claimed.`,
  );
  console.log();
}

main();
