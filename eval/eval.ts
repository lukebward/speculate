/**
 * Prediction-quality evaluation (DESIGN.md §5.3, §10 item 8).
 *
 * Replays the synthetic corpus through the real, server-agnostic
 * TransitionLearner and prints recall@1/3/5 and waste per hit per archetype.
 * Unlike `npm run bench` — which measures what prefetching is worth ONCE the
 * predictions are right — this measures whether the predictions are right at
 * all, with no profile, no rules, and no server.
 *
 *   npm run eval                           pooled over the default seeds
 *   npm run eval -- --seeds 1,2,3,4        pool over other seeds
 *   npm run eval -- --detail               per-transition breakdown
 *   npm run eval -- --json before.json     machine-readable snapshot
 *   npm run eval -- --compare before.json  add a per-archetype delta column
 *
 * `--json` takes a path rather than writing to stdout: `npm run` prints its
 * own banner there, so a redirect would produce a file that is not JSON.
 *
 * The compare flow is the point: a claim that a model change helped must be
 * ATTRIBUTED to archetypes, not pooled into one number. A change that only
 * makes the learner fire harder on noise moves the floor row, and the
 * headline (workflow archetypes only) will not move with it.
 *
 * Output is deliberately plain ASCII: the table gets pasted verbatim into
 * task reports as the baseline every later change is diffed against.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SESSIONS_PER_ARCHETYPE, WARMUP_SESSIONS } from './corpus.js';
import { baselineLine, detail, table } from './format.js';
import { DEFAULT_SEEDS, MAX_K, PRODUCTION_K, runEvalDetailed } from './replay.js';
import type { EvalRun } from './replay.js';

/** Indents a report line, leaving blank separators genuinely blank. */
function indent(line: string): string {
  return line === '' ? '' : `  ${line}`;
}

/** `--flag value` lookup; undefined when the flag is absent. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function seeds(): number[] {
  const raw = flag('--seeds') ?? flag('--seed');
  if (raw === undefined) return [...DEFAULT_SEEDS];
  const parsed = raw
    .split(',')
    .map((s) => Math.trunc(Number(s.trim())))
    .filter((n) => Number.isFinite(n));
  return parsed.length > 0 ? parsed : [...DEFAULT_SEEDS];
}

/** Per-archetype recall@3 from a `--json` snapshot, for the delta column. */
function comparison(): Map<string, number> | undefined {
  const path = flag('--compare');
  if (path === undefined) return undefined;
  // A snapshot written by an editor or a PowerShell redirect may carry a BOM.
  const prior = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as EvalRun;
  const map = new Map<string, number>();
  for (const report of prior.reports) map.set(report.archetype, report.recallAt3);
  if (prior.workflow.pairs > 0) {
    map.set('WORKFLOW (headline)', prior.workflow.hitsAt3 / prior.workflow.pairs);
  }
  return map;
}

function main(): void {
  const run = runEvalDetailed(seeds());

  const jsonPath = flag('--json');
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    console.log(`wrote ${jsonPath}`);
    return;
  }

  console.log();
  console.log('  Speculate prediction eval - offline recall@K, generic TransitionLearner');
  console.log(
    `  seeds ${run.seeds.join(',')} | ${SESSIONS_PER_ARCHETYPE} sessions/archetype/seed ` +
      `(${WARMUP_SESSIONS} warm-up: learned, not scored) | ` +
      `hit = tool AND args match under the canonical cache key`,
  );
  console.log();
  for (const line of table(run, { compare: comparison() })) console.log(indent(line));
  console.log();
  if (process.argv.includes('--detail')) {
    for (const line of detail(run)) console.log(indent(line));
  }
  console.log('  ' + baselineLine(run));
  console.log();
  console.log('  headline = workflow archetypes only; the floor sits beside it, never in it.');
  console.log(
    `  recall@3 is the headline band: ${PRODUCTION_K} is the shipped per-trigger cap (DESIGN.md 5.6).`,
  );
  console.log(
    `  recall@5 is measurable only because the eval raises the learner's cap to ${MAX_K}.`,
  );
  console.log('  waste/hit bills every prediction issued at the shipped cap, including the');
  console.log("  batch fired after each session's last call, which nothing can ever claim.");
  console.log();
}

main();
