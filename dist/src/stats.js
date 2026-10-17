import { compactUsageRecords, readUsageReport } from './usage.js';
/** Summarizes recorded evidence, not whether a proxy is currently running. */
export function summarizeLearning(totals) {
    const opportunities = totals.predictionOpportunities;
    const offered = totals.predictionOffered;
    const matched = totals.predictionHitsAt3;
    const usefulPrefetches = totals.hits + totals.joins;
    const estimatedNetSavedMs = totals.estimatedSavedMs - totals.estimatedAddedWaitMs;
    return {
        recordedReadOutcomes: usefulPrefetches + totals.misses,
        opportunities,
        offered,
        coverage: opportunities > 0 ? offered / opportunities : null,
        matched,
        withoutCandidate: Math.max(0, opportunities - offered),
        unmatched: Math.max(0, offered - matched),
        usefulPrefetches,
        estimatedNetSavedMs,
        benefit: estimatedNetSavedMs < 0 ? 'negative-estimate'
            : usefulPrefetches > 0 ? (estimatedNetSavedMs > 0 ? 'positive-estimate' : 'neutral-estimate')
                : opportunities === 0 ? 'no-prediction-data' : 'no-useful-prefetches',
    };
}
const BENEFIT_LABEL = {
    'no-prediction-data': 'no prediction-quality observations recorded',
    'no-useful-prefetches': 'no useful prefetches recorded',
    'positive-estimate': 'positive tool-wait estimate',
    'negative-estimate': 'estimated added wait exceeds estimated saved wait',
    'neutral-estimate': 'useful prefetches recorded; no positive net estimate',
};
export function parseStatsArgs(argv) {
    const out = { json: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json')
            out.json = true;
        else if (arg === '--by-server')
            out.byServer = true;
        else if (arg === '--by-tool')
            out.byTool = true;
        else if (arg === '--compact')
            out.compact = true;
        else if (arg === '--since' || arg === '--workspace') {
            const value = argv[++i];
            if (value === undefined || value.startsWith('--')) {
                return { error: `${arg} requires a value` };
            }
            if (arg === '--since')
                out.since = value;
            else
                out.workspace = value;
        }
        else
            return { error: `unknown stats argument '${arg}'` };
    }
    return out;
}
function sinceTimestamp(raw, now) {
    if (raw === undefined)
        return undefined;
    const duration = /^(\d+)(m|h|d|w)$/.exec(raw);
    if (duration) {
        const amount = Number(duration[1]);
        const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2]];
        return now - amount * unit;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed)
        ? parsed
        : { error: `--since must be a date or duration such as 24h, 7d, or 2026-08-01` };
}
function formatDuration(milliseconds) {
    if (milliseconds < 1000)
        return `${Math.round(milliseconds)}ms`;
    if (milliseconds < 60_000)
        return `${Math.round(milliseconds / 1000)}s`;
    if (milliseconds < 3_600_000) {
        const seconds = Math.round(milliseconds / 1000);
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }
    const minutes = Math.round(milliseconds / 60_000);
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function formatSignedDuration(milliseconds) {
    return milliseconds < 0 ? `-${formatDuration(-milliseconds)}` : formatDuration(milliseconds);
}
function formatPercentage(value) {
    return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}
function escapeControls(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => character === '\n'
        ? '\\n'
        : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function formatUsageReport(report, options = {}) {
    if (report.totals.sessions === 0) {
        const lines = [
            'No Speculate usage recorded yet.',
            'Collection starts after installing this version.',
        ];
        if (report.ignoredRecords > 0)
            lines.push(`Ignored records: ${report.ignoredRecords}`);
        return `${lines.join('\n')}\n`;
    }
    const heading = report.since === null
        ? 'Speculate stats (all time)'
        : `Speculate stats (since ${report.since.slice(0, 10)})`;
    const used = report.totals.hits + report.totals.joins;
    const learning = summarizeLearning(report.totals);
    const wastePerHit = report.totals.wastePerHit === null
        ? '—'
        : report.totals.wastePerHit.toFixed(2);
    const lines = [
        heading,
        `Estimated time saved: ${formatDuration(report.totals.estimatedSavedMs)}`,
        `Potential stdio wait added: ${formatDuration(report.totals.estimatedAddedWaitMs)}`,
        `Conservative net estimate: ${formatSignedDuration(report.totals.estimatedSavedMs - report.totals.estimatedAddedWaitMs)}`,
        `Prefetch hits: ${used} (${report.totals.hits} ready, ${report.totals.joins} joined)`,
        `Hit rate: ${formatPercentage(report.totals.hitRate)}`,
        `Speculative calls: ${report.totals.speculativeCalls}`,
        `Wasted calls: ${report.totals.wasted} (${wastePerHit} per hit)`,
        `Predictor recall: @1 ${formatPercentage(report.totals.predictionRecallAt1)}, @3 ${formatPercentage(report.totals.predictionRecallAt3)}`,
        `Prediction precision when offered: ${formatPercentage(report.totals.predictionPrecisionAt3)}`,
        `Prediction coverage: ${learning.offered}/${learning.opportunities} opportunities (${formatPercentage(learning.coverage)})`,
        `Without a ranked candidate: ${learning.withoutCandidate}; offered but unmatched: ${learning.unmatched}`,
        `Recorded benefit: ${BENEFIT_LABEL[learning.benefit]}`,
        `Argument near misses: ${report.totals.nearMisses} (${report.totals.nearMissDistanceOne} one-key away)`,
        `Sessions: ${report.totals.sessions}`,
        `MCP: ${formatDuration(report.bySource.mcp.estimatedSavedMs)} saved`,
        // Fresh 0.11 installs never write `cli` records (the tier was removed);
        // only show the line when a pre-0.11 install left some behind.
        ...(report.bySource.cli.sessions > 0
            ? [`CLI: ${formatDuration(report.bySource.cli.estimatedSavedMs)} saved`]
            : []),
        ...report.workspaces.map((workspace) => `${escapeControls(workspace.workspace)}: ${formatDuration(workspace.estimatedSavedMs)} saved`),
        ...(options.byServer
            ? report.servers.map((server) => `server ${escapeControls(server.server)}: ${formatDuration(server.estimatedSavedMs)} saved, ${formatPercentage(server.hitRate)} hit rate`)
            : []),
        ...(options.byTool
            ? report.tools.map((tool) => `tool ${escapeControls(tool.server)}/${escapeControls(tool.tool)}: ${formatDuration(tool.estimatedSavedMs)} saved, ${formatPercentage(tool.hitRate)} hit rate`)
            : []),
        `Ignored records: ${report.ignoredRecords}`,
        `Last recorded activity: ${report.updatedAt ?? 'unknown'}`,
        "Activation: speculate status; retained learning: speculate memory",
    ];
    return `${lines.join('\n')}\n`;
}
export function runStats(args, options = {}) {
    const now = (options.now ?? Date.now)();
    const since = sinceTimestamp(args.since, now);
    if (typeof since === 'object') {
        (options.write ?? ((text) => process.stdout.write(text)))(`${since.error}\n`);
        return 2;
    }
    if (args.compact) {
        (options.compact ?? compactUsageRecords)(options.directory, now - 30 * 24 * 60 * 60_000);
    }
    const report = (options.read ?? readUsageReport)(options.directory, {
        sinceMs: since,
        workspace: args.workspace,
    });
    const output = args.json
        ? `${JSON.stringify({ ...report, learning: summarizeLearning(report.totals) }, null, 2)}\n`
        : formatUsageReport(report, args);
    (options.write ?? ((text) => process.stdout.write(text)))(output);
    return 0;
}
