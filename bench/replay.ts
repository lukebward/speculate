/**
 * Replays the sessions a live run kept through the mod's core, offline.
 *
 *   SPECULATE_BENCH_LIVE=1 npm run bench:live -- --scenario mslearn --workload varied --keep
 *   npm run bench:replay -- --dir /tmp/speculate-live-XXXX --workload varied
 *
 * `--keep` leaves each session's event stream in the run's temporary
 * directory. This reads the streams of one workload and arm (default: the
 * `off` arm, the model's calls with no mod in the way), in pair order, and
 * reports what the core would have served had those been its sessions.
 * See bench/trace.ts for what that is and is not evidence of.
 *
 * Options:
 *   --dir DIR        the kept directory (required)
 *   --workload KEY   which workload's sessions (default varied)
 *   --arm off|on     which arm's sessions (default off)
 *   --warmup N       leading sessions replayed but not counted (default 2)
 *   --verbose        print the arguments of every prefetch
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTrace, replayTraces, type ReplayReport, type Trace } from './trace.js';

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

/** The kept streams of one workload and arm, in pair order. */
export function loadTraces(dir: string, workload: string, arm: string): Trace[] {
  const pattern = new RegExp(`^${workload}-(\\d+)-${arm}\\.jsonl$`);
  return readdirSync(dir)
    .map(name => ({ name, match: pattern.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map(({ name }) =>
      extractTrace(
        readFileSync(join(dir, name), 'utf8').split('\n').map(line => ({ at: 0, line })),
        name.replace(/\.jsonl$/, ''),
      ),
    )
    .filter(trace => trace.calls.length > 0);
}

const percent = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : 'n/a');
const share = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`);

export function printReport(report: ReplayReport, verbose = false): void {
  for (const session of report.sessions) {
    const marks = session.calls.map(call => `${call.tool}${call.served ? '+' : call.isError ? '!' : '-'}`).join(' ');
    const prefetched = session.prefetched.map(call => call.tool).join(' ') || 'none';
    console.log(`  ${session.label.padEnd(16)} ${marks}  | prefetched: ${prefetched}`);
    if (verbose) for (const call of session.prefetched) console.log(`      prefetched ${call.tool} ${JSON.stringify(call.args)}`);
  }
  console.log(`  (+ served from a prefetch, - ran for real, ! errored)`);
  console.log(
    `  hit rate ${percent(report.served, report.calls)} (${report.served} of ${report.calls} calls); ` +
      `${report.prefetches} prefetches, ${percent(report.served, report.prefetches)} used, ` +
      `${report.prefetches - report.served} unused; recall ${share(report.recallAt1)} at 1, ${share(report.recallAt3)} at 3`,
  );
  const reasons = Object.entries(report.notStarted).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) console.log(`  predictions not started: ${reasons.map(([reason, n]) => `${reason} ${n}`).join(', ')}`);
}

const dir = flag('dir');
if (dir !== undefined) {
  const workload = flag('workload') ?? 'varied';
  const arm = flag('arm') ?? 'off';
  const warmup = Math.max(0, Number(flag('warmup') ?? 2) || 0);
  const traces = loadTraces(dir, workload, arm);
  if (traces.length === 0) {
    console.log(`no kept sessions for workload '${workload}', arm '${arm}' in ${dir}`);
  } else {
    console.log(`\n${traces.length} recorded sessions (${workload}, ${arm} arm), the first ${Math.min(warmup, traces.length)} not counted`);
    replayTraces(traces, { warmup }).then(report => printReport(report, process.argv.includes('--verbose')), (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
  }
} else if (process.argv[1]?.endsWith('replay.ts')) {
  console.log('usage: npm run bench:replay -- --dir <directory kept by bench:live --keep> [--workload varied] [--arm off] [--warmup 2]');
}
