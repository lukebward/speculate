/** Paired, persistent, full-proxy benchmark for repeated local workflows. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { percentile } from './comparison.js';
import { REPEATED_WORKFLOW_IDS, generateRepeatedWorkflow, } from './repeatedWorkflows.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_SERVER = join(ROOT, 'bench', 'repeatedFixtureServer.ts');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ALL_ARMS = ['off', 'stable', 'candidate'];
export function orderedArms(arms, seed, session) {
    if (arms.length === 0)
        return [];
    const offset = (seed + session) % arms.length;
    return [...arms.slice(offset), ...arms.slice(0, offset)];
}
export function armStatePath(root, arm, workflow, seed) {
    return join(root, arm, workflow, String(seed), 'state.json');
}
export function finalizeAccounting(input) {
    if (input.requestedCalls !== input.hits + input.joins + input.misses) {
        throw new Error('requestedCalls must equal hits + joins + misses');
    }
    const outstandingAtSnapshot = input.ready + input.inFlight;
    if (input.speculativeCalls !== input.hits + input.joins + input.wasted + outstandingAtSnapshot) {
        throw new Error('speculative calls do not have exactly one terminal or outstanding outcome');
    }
    return {
        terminalWasted: input.wasted,
        outstandingAtSnapshot,
        shutdownWaste: input.wasted + outstandingAtSnapshot,
    };
}
export function validatePairedOutputs(records) {
    const off = new Map();
    for (const record of records) {
        if (record.arm === 'off')
            off.set(pairKey(record), record);
    }
    for (const record of records) {
        if (record.arm === 'off')
            continue;
        const control = off.get(pairKey(record));
        if (!control)
            throw new Error(`missing off pair for ${pairKey(record)}`);
        if (control.outputDigest !== record.outputDigest) {
            throw new Error(`output digest differs for ${pairKey(record)}`);
        }
        if (control.requestedCalls !== record.requestedCalls) {
            throw new Error(`requested call count differs for ${pairKey(record)}`);
        }
    }
}
export function mergeArtifactRecords(left, right) {
    const result = [];
    const keys = new Set();
    for (const record of [...left, ...right]) {
        const key = `${pairKey(record)}:${record.arm}`;
        if (keys.has(key))
            throw new Error(`duplicate repeated benchmark record: ${key}`);
        keys.add(key);
        result.push(record);
    }
    return result;
}
function pairKey(record) {
    return `${record.workflow}@${record.workflowVersion}:${record.seed}:${record.session}`;
}
export function compareEnabledArms(records) {
    const stable = new Map(records.filter((record) => record.arm === 'stable').map((record) => [pairKey(record), record]));
    const pairs = records
        .filter((record) => record.arm === 'candidate')
        .flatMap((candidate) => {
        const control = stable.get(pairKey(candidate));
        return control ? [{ stable: control, candidate }] : [];
    });
    if (pairs.length === 0)
        return null;
    const total = (arm, field) => pairs.reduce((sum, pair) => sum + Number(pair[arm][field]), 0);
    const requestedCalls = total('stable', 'requestedCalls');
    const opportunitiesStable = total('stable', 'predictorOpportunities');
    const opportunitiesCandidate = total('candidate', 'predictorOpportunities');
    const usefulStable = total('stable', 'hits') + total('stable', 'joins');
    const usefulCandidate = total('candidate', 'hits') + total('candidate', 'joins');
    const rate = (numerator, denominator) => denominator === 0 ? 0 : numerator / denominator;
    const wasteStable = rate(total('stable', 'shutdownWaste'), usefulStable);
    const wasteCandidate = rate(total('candidate', 'shutdownWaste'), usefulCandidate);
    return {
        pairedRecords: pairs.length,
        requestedCalls,
        measuredWaitDeltaMsPer100: requestedCalls === 0
            ? 0
            : (100 * (total('stable', 'toolWaitMs') - total('candidate', 'toolWaitMs'))) /
                requestedCalls,
        hitRateDelta: rate(usefulCandidate, total('candidate', 'requestedCalls')) -
            rate(usefulStable, requestedCalls),
        recallAt3Delta: rate(total('candidate', 'predictorHitsAt3'), opportunitiesCandidate) -
            rate(total('stable', 'predictorHitsAt3'), opportunitiesStable),
        wastePerUsefulDelta: usefulStable === 0 || usefulCandidate === 0 ? null : wasteCandidate - wasteStable,
    };
}
function nonNegativeInteger(raw, name) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
}
export function parseRepeatedCliArgs(argv) {
    const value = (name) => {
        const index = argv.indexOf(`--${name}`);
        if (index === -1)
            return undefined;
        const found = argv[index + 1];
        if (found === undefined || found.startsWith('--'))
            throw new Error(`--${name} needs a value`);
        return found;
    };
    const seeds = (value('seeds') ?? '1,2,3')
        .split(',')
        .filter(Boolean)
        .map((item) => nonNegativeInteger(item, 'seed'));
    if (seeds.length === 0 || new Set(seeds).size !== seeds.length) {
        throw new Error('seeds must be a non-empty list without duplicates');
    }
    const arms = (value('arms') ?? (value('baseline') ? ALL_ARMS.join(',') : 'off,candidate'))
        .split(',')
        .filter(Boolean);
    if (arms.length === 0 ||
        new Set(arms).size !== arms.length ||
        arms.some((arm) => !ALL_ARMS.includes(arm))) {
        throw new Error('arms must be a non-empty subset of off,stable,candidate without duplicates');
    }
    const known = new Set(['baseline', 'candidate', 'seeds', 'train', 'holdout', 'latency', 'arms', 'json']);
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index] ?? '';
        if (!flag.startsWith('--') || !known.has(flag.slice(2)))
            throw new Error(`unknown option: ${flag}`);
    }
    return {
        baselineRoot: value('baseline') ?? ROOT,
        candidateRoot: value('candidate') ?? ROOT,
        seeds,
        trainSessions: nonNegativeInteger(value('train') ?? '4', 'train'),
        holdoutSessions: nonNegativeInteger(value('holdout') ?? '4', 'holdout'),
        latencyMs: nonNegativeInteger(value('latency') ?? '120', 'latency'),
        arms,
        jsonPath: value('json') ?? resolve(ROOT, 'repeated-benchmark.json'),
    };
}
function targetFor(arm, options) {
    return resolve(arm === 'candidate' ? options.candidateRoot : options.baselineRoot);
}
export function digestToolResults(results) {
    return createHash('sha256').update(JSON.stringify(results)).digest('hex');
}
function fileSize(path) {
    try {
        return statSync(path).size;
    }
    catch {
        return 0;
    }
}
async function runSession(options, stateRoot, fixture, arm) {
    const targetRoot = targetFor(arm, options);
    const targetCli = join(targetRoot, 'dist', 'src', 'cli.js');
    if (!existsSync(targetCli))
        throw new Error(`target CLI does not exist: ${targetCli}`);
    const statePath = armStatePath(stateRoot, arm, fixture.id, fixture.seed);
    mkdirSync(dirname(statePath), { recursive: true });
    const sessionRoot = mkdtempSync(join(tmpdir(), 'speculate-repeated-session-'));
    const configPath = join(sessionRoot, 'config.json');
    const logPath = join(sessionRoot, 'upstream.jsonl');
    writeFileSync(configPath, JSON.stringify({
        mode: arm === 'off' ? 'off' : 'annotated',
        log: 'off',
        maxPredictionsPerTrigger: 3,
        persistence: { enabled: arm !== 'off', path: statePath },
        servers: {
            fixture: {
                command: process.execPath,
                args: [TSX_CLI, FIXTURE_SERVER],
                env: {
                    SPECULATE_REPEAT_WORKFLOW: fixture.id,
                    SPECULATE_REPEAT_SEED: String(fixture.seed),
                    SPECULATE_REPEAT_SESSION: String(fixture.session),
                    SPECULATE_REPEAT_TRAIN: String(options.trainSessions),
                    SPECULATE_REPEAT_LATENCY: String(options.latencyMs),
                    SPECULATE_REPEAT_CALL_LOG: logPath,
                },
            },
        },
    }));
    const startedWall = performance.now();
    const startedCpu = process.cpuUsage();
    const startedRss = process.memoryUsage().rss;
    const client = new Client({ name: `repeated-${arm}-${fixture.id}-${fixture.seed}-${fixture.session}`, version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [targetCli, '--config', configPath],
        cwd: targetRoot,
        env: {
            ...process.env,
            SPECULATE_USAGE_OFF: '1',
            XDG_STATE_HOME: join(sessionRoot, 'xdg'),
        },
        stderr: 'ignore',
    });
    const waits = [];
    const outputs = [];
    let stats;
    try {
        await client.connect(transport);
        for (const current of fixture.steps) {
            const started = performance.now();
            const response = (await client.callTool({
                name: current.tool,
                arguments: current.args,
            }));
            waits.push(performance.now() - started);
            if (response.isError)
                throw new Error(`${fixture.id}/${current.tool} returned isError`);
            outputs.push(response);
            if (current.thinkMs > 0)
                await new Promise((done) => setTimeout(done, current.thinkMs));
        }
        // This wait is outside tool-wait measurement. It lets the final speculative
        // batch settle so ready and in-flight entries can be accounted separately.
        await new Promise((done) => setTimeout(done, options.latencyMs + 20));
        stats = payload((await client.callTool({ name: 'speculate__stats', arguments: {} })));
    }
    finally {
        await client.close().catch(() => { });
    }
    if (!stats)
        throw new Error('proxy produced no stats snapshot');
    const cpu = process.cpuUsage(startedCpu);
    const accounting = finalizeAccounting({
        requestedCalls: fixture.steps.length,
        hits: stats.hits,
        joins: stats.joins,
        misses: stats.misses,
        speculativeCalls: stats.speculativeCalls,
        wasted: stats.wasted,
        ready: stats.cache?.ready ?? 0,
        inFlight: stats.cache?.inFlight ?? 0,
    });
    const upstreamCalls = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).length
        : 0;
    const toolWaitMs = waits.reduce((sum, item) => sum + item, 0);
    const record = {
        schemaVersion: 1,
        workflow: fixture.id,
        workflowVersion: fixture.version,
        arm,
        seed: fixture.seed,
        session: fixture.session,
        phase: fixture.phase,
        requestedCalls: fixture.steps.length,
        eligibleCalls: fixture.steps.length,
        hits: stats.hits,
        joins: stats.joins,
        misses: stats.misses,
        speculativeCalls: stats.speculativeCalls,
        ...accounting,
        predictorOpportunities: stats.predictionQuality?.opportunities ?? 0,
        predictorHitsAt1: stats.predictionQuality?.hitsAt1 ?? 0,
        predictorHitsAt3: stats.predictionQuality?.hitsAt3 ?? 0,
        predictorOffered: stats.predictionQuality?.offered ?? 0,
        toolWaitMs,
        toolWaitSamplesMs: waits,
        estimatedSavedMs: stats.estimatedSavedMs,
        estimatedAddedWaitMs: stats.estimatedAddedWaitMs ?? 0,
        upstreamCalls,
        outputDigest: digestToolResults(outputs),
        wallTimeMs: performance.now() - startedWall,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        rssDeltaBytes: process.memoryUsage().rss - startedRss,
        stateBytes: fileSize(statePath),
        suppressed: stats.suppressed ?? {},
        nearMisses: stats.nearMisses?.sameTool ?? 0,
    };
    rmSync(sessionRoot, { recursive: true, force: true });
    return record;
}
function payload(result) {
    const text = result.content.find((block) => block.type === 'text');
    if (!text || text.type !== 'text')
        throw new Error('expected a JSON text result');
    return JSON.parse(text.text);
}
export async function runRepeatedBenchmark(options) {
    if (options.trainSessions + options.holdoutSessions < 1) {
        throw new Error('train + holdout sessions must be at least one');
    }
    const workflows = options.workflows ?? [...REPEATED_WORKFLOW_IDS];
    const ownedState = options.stateRoot === undefined;
    const stateRoot = options.stateRoot ?? mkdtempSync(join(tmpdir(), 'speculate-repeated-state-'));
    mkdirSync(stateRoot, { recursive: true });
    const records = [];
    const executionOrder = [];
    try {
        const totalSessions = options.trainSessions + options.holdoutSessions;
        for (const seed of options.seeds) {
            for (let session = 0; session < totalSessions; session++) {
                for (const workflow of workflows) {
                    const fixture = generateRepeatedWorkflow(workflow, seed, session, options.trainSessions);
                    const arms = orderedArms(options.arms, seed, session);
                    executionOrder.push({ seed, session, workflow, arms });
                    for (const arm of arms) {
                        const record = await runSession(options, stateRoot, fixture, arm);
                        records.push(record);
                        options.onProgress?.(`${arm} ${workflow} seed=${seed} session=${session} ${fixture.phase} ` +
                            `hits=${record.hits + record.joins}/${record.requestedCalls} ` +
                            `wait=${record.toolWaitMs.toFixed(1)}ms waste=${record.shutdownWaste}`);
                    }
                }
            }
        }
        if (options.arms.includes('off'))
            validatePairedOutputs(records);
        return artifactFor(options, workflows, records, executionOrder);
    }
    finally {
        if (ownedState)
            rmSync(stateRoot, { recursive: true, force: true });
    }
}
function summarize(records, arm) {
    const selected = records.filter((record) => record.arm === arm);
    const requestedCalls = selected.reduce((sum, record) => sum + record.requestedCalls, 0);
    const hits = selected.reduce((sum, record) => sum + record.hits, 0);
    const joins = selected.reduce((sum, record) => sum + record.joins, 0);
    const misses = selected.reduce((sum, record) => sum + record.misses, 0);
    const useful = hits + joins;
    const opportunities = selected.reduce((sum, record) => sum + record.predictorOpportunities, 0);
    const offered = selected.reduce((sum, record) => sum + record.predictorOffered, 0);
    const waits = selected.flatMap((record) => record.toolWaitSamplesMs);
    const totalWait = waits.reduce((sum, value) => sum + value, 0);
    return {
        arm,
        records: selected.length,
        requestedCalls,
        hits,
        joins,
        misses,
        hitRate: requestedCalls === 0 ? 0 : useful / requestedCalls,
        speculativeCalls: selected.reduce((sum, record) => sum + record.speculativeCalls, 0),
        shutdownWaste: selected.reduce((sum, record) => sum + record.shutdownWaste, 0),
        wastePerUseful: useful === 0
            ? null
            : selected.reduce((sum, record) => sum + record.shutdownWaste, 0) / useful,
        recallAt1: opportunities === 0
            ? null
            : selected.reduce((sum, record) => sum + record.predictorHitsAt1, 0) / opportunities,
        recallAt3: opportunities === 0
            ? null
            : selected.reduce((sum, record) => sum + record.predictorHitsAt3, 0) / opportunities,
        predictionCoverage: opportunities === 0 ? null : offered / opportunities,
        toolWaitMs: totalWait,
        meanToolWaitMs: waits.length === 0 ? 0 : totalWait / waits.length,
        p50ToolWaitMs: percentile(waits, 0.5),
        p95ToolWaitMs: percentile(waits, 0.95),
        estimatedSavedMs: selected.reduce((sum, record) => sum + record.estimatedSavedMs, 0),
        estimatedAddedWaitMs: selected.reduce((sum, record) => sum + record.estimatedAddedWaitMs, 0),
        upstreamCalls: selected.reduce((sum, record) => sum + record.upstreamCalls, 0),
        wallTimeMs: selected.reduce((sum, record) => sum + record.wallTimeMs, 0),
        cpuUserMicros: selected.reduce((sum, record) => sum + record.cpuUserMicros, 0),
        cpuSystemMicros: selected.reduce((sum, record) => sum + record.cpuSystemMicros, 0),
        peakStateBytes: selected.reduce((max, record) => Math.max(max, record.stateBytes), 0),
    };
}
function comparisons(records) {
    const off = new Map(records.filter((record) => record.arm === 'off').map((record) => [pairKey(record), record]));
    const result = [];
    for (const arm of ['stable', 'candidate']) {
        const selected = records.filter((record) => record.arm === arm);
        let calls = 0;
        let saved = 0;
        let pairs = 0;
        for (const record of selected) {
            const control = off.get(pairKey(record));
            if (!control)
                continue;
            calls += record.requestedCalls;
            saved += control.toolWaitMs - record.toolWaitMs;
            pairs++;
        }
        if (pairs > 0) {
            result.push({
                arm,
                versus: 'off',
                pairedRecords: pairs,
                measuredWaitDeltaMsPer100: calls === 0 ? 0 : (100 * saved) / calls,
            });
        }
    }
    return result;
}
function artifactFor(options, workflows, records, executionOrder) {
    const holdoutRecords = records.filter((record) => record.phase === 'holdout');
    const coldRecords = records.filter((record) => record.session === 0);
    const armsRun = [...new Set(records.map((record) => record.arm))];
    return {
        schemaVersion: 1,
        benchmark: 'repeated-workflows',
        createdAt: new Date().toISOString(),
        baselineRoot: resolve(options.baselineRoot),
        candidateRoot: resolve(options.candidateRoot),
        node: process.execPath,
        latency: { kind: 'synthetic-injected', milliseconds: options.latencyMs },
        seeds: [...options.seeds],
        trainSessions: options.trainSessions,
        holdoutSessions: options.holdoutSessions,
        workflows,
        armsRun,
        executionOrder,
        records,
        holdout: armsRun.map((arm) => summarize(holdoutRecords, arm)),
        cold: armsRun.map((arm) => summarize(coldRecords, arm)),
        comparisons: comparisons(holdoutRecords),
        candidateVsStable: compareEnabledArms(holdoutRecords),
        resourceMeasurementScope: 'driver-process-only',
    };
}
function compatible(a, options) {
    return (a.schemaVersion === 1 &&
        a.benchmark === 'repeated-workflows' &&
        a.baselineRoot === resolve(options.baselineRoot) &&
        a.candidateRoot === resolve(options.candidateRoot) &&
        a.latency.milliseconds === options.latencyMs &&
        JSON.stringify(a.seeds) === JSON.stringify(options.seeds) &&
        a.trainSessions === options.trainSessions &&
        a.holdoutSessions === options.holdoutSessions &&
        JSON.stringify(a.workflows) === JSON.stringify(REPEATED_WORKFLOW_IDS));
}
async function main() {
    const options = parseRepeatedCliArgs(process.argv.slice(2));
    const progressPath = `${resolve(options.jsonPath)}.progress.log`;
    mkdirSync(dirname(progressPath), { recursive: true });
    writeFileSync(progressPath, '');
    const fresh = await runRepeatedBenchmark({
        ...options,
        onProgress: (line) => {
            const stamped = `${new Date().toISOString()} ${line}`;
            appendProgress(progressPath, stamped);
            process.stderr.write(`${stamped}\n`);
        },
    });
    let records = fresh.records;
    let executionOrder = fresh.executionOrder;
    if (existsSync(options.jsonPath)) {
        const existing = JSON.parse(readFileSync(options.jsonPath, 'utf8'));
        if (!compatible(existing, options))
            throw new Error('existing JSON artifact is incompatible');
        records = mergeArtifactRecords(existing.records, records);
        executionOrder = [...existing.executionOrder, ...fresh.executionOrder];
    }
    if (records.some((record) => record.arm === 'off'))
        validatePairedOutputs(records);
    const artifact = artifactFor(options, [...REPEATED_WORKFLOW_IDS], records, executionOrder);
    mkdirSync(dirname(resolve(options.jsonPath)), { recursive: true });
    writeFileSync(options.jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`REPEATED_E2E ${JSON.stringify(artifact)}\n`);
}
function appendProgress(path, line) {
    writeFileSync(path, `${line}\n`, { flag: 'a' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.stack ?? String(error)}\n`);
        process.exitCode = 1;
    });
}
