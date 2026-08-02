import { readUsageReport, type UsageReport } from './usage.js';

export interface StatsArgs {
  json: boolean;
}

export function parseStatsArgs(argv: string[]): StatsArgs | { error: string } {
  if (argv.length === 0) return { json: false };
  if (argv.length === 1 && argv[0] === '--json') return { json: true };
  return { error: `unknown stats argument '${argv[0]}'` };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  if (milliseconds < 3_600_000) {
    const seconds = Math.round(milliseconds / 1000);
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  const minutes = Math.round(milliseconds / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatPercentage(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
    character === '\n'
      ? '\\n'
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatUsageReport(report: UsageReport): string {
  if (report.totals.sessions === 0) {
    const lines = [
      'No Speculate usage recorded yet.',
      'Collection starts after installing this version.',
    ];
    if (report.ignoredRecords > 0) lines.push(`Ignored records: ${report.ignoredRecords}`);
    return `${lines.join('\n')}\n`;
  }

  const heading = report.since === null
    ? 'Speculate stats (all time)'
    : `Speculate stats (all time since ${report.since.slice(0, 10)})`;
  const used = report.totals.hits + report.totals.joins;
  const wastePerHit = report.totals.wastePerHit === null
    ? '—'
    : report.totals.wastePerHit.toFixed(2);
  const lines = [
    heading,
    `Estimated time saved: ${formatDuration(report.totals.estimatedSavedMs)}`,
    `Prefetch hits: ${used} (${report.totals.hits} ready, ${report.totals.joins} joined)`,
    `Hit rate: ${formatPercentage(report.totals.hitRate)}`,
    `Speculative calls: ${report.totals.speculativeCalls}`,
    `Wasted calls: ${report.totals.wasted} (${wastePerHit} per hit)`,
    `Sessions: ${report.totals.sessions}`,
    `MCP: ${formatDuration(report.bySource.mcp.estimatedSavedMs)} saved`,
    // Fresh 0.11 installs never write `cli` records (the tier was removed);
    // only show the line when a pre-0.11 install left some behind.
    ...(report.bySource.cli.sessions > 0
      ? [`CLI: ${formatDuration(report.bySource.cli.estimatedSavedMs)} saved`]
      : []),
    ...report.workspaces.map(
      (workspace) =>
        `${escapeControls(workspace.workspace)}: ${formatDuration(workspace.estimatedSavedMs)} saved`,
    ),
    `Ignored records: ${report.ignoredRecords}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function runStats(
  args: StatsArgs,
  options: {
    directory?: string;
    read?: (directory?: string) => UsageReport;
    write?: (text: string) => void;
  } = {},
): number {
  const report = (options.read ?? readUsageReport)(options.directory);
  const output = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatUsageReport(report);
  (options.write ?? ((text) => process.stdout.write(text)))(output);
  return 0;
}
