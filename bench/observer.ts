import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { claudeAdapter } from '../src/agentAdapters/claude.js';
import { codexAdapter } from '../src/agentAdapters/codex.js';
import { startLlmProxy, type LlmProxy } from '../src/llmProxy.js';
import type { AgentAdapter, Observation, RegisteredRoute, SessionContext } from '../src/observerTypes.js';
import { SessionBridge } from '../src/sessionBridge.js';
import type { ObserverLifecycleEvent } from '../src/types.js';
import {
  OBSERVER_WORKFLOW_IDS,
  OBSERVER_WORKFLOWS,
  materializeObserverWorkflow,
  type MaterializedObserverWorkflow,
  type MaterializedToolStep,
  type ObserverArm,
  type ObserverClient,
  type ObserverSignals,
  type ObserverWorkflowId,
  type ThermalState,
  type WorkloadSet,
} from './observer-workflows.js';

export { type ObserverArm, type ObserverSignals } from './observer-workflows.js';

export const OBSERVER_ARMS: Record<ObserverArm, {
  speculate: boolean;
  hooks: boolean;
  requestObserver: boolean;
  signals: ObserverSignals;
}> = {
  A: { speculate: false, hooks: false, requestObserver: false, signals: { intent: false, transition: false, stream: false } },
  B: { speculate: true, hooks: false, requestObserver: false, signals: { intent: false, transition: false, stream: false } },
  C: { speculate: true, hooks: true, requestObserver: false, signals: { intent: true, transition: true, stream: false } },
  D: { speculate: true, hooks: true, requestObserver: true, signals: { intent: true, transition: true, stream: false } },
  E: { speculate: true, hooks: true, requestObserver: true, signals: { intent: true, transition: true, stream: true } },
};

export interface ExperimentCoordinates {
  clients: readonly ObserverClient[];
  workflows: readonly ObserverWorkflowId[];
  repetitions: number;
}

export interface OrderedRun {
  client: ObserverClient;
  workflow: ObserverWorkflowId;
  repetition: number;
  arm: ObserverArm;
  armPosition: number;
  orderIndex: number;
}

export interface PairedValue {
  workflow: string;
  repetition: number;
  value: number;
}

export interface BootstrapOptions {
  seed: number;
  replicates: number;
}

export interface Interval {
  point: number | null;
  lower: number | null;
  upper: number | null;
  seed: number;
  replicates: number;
  clusterCount: number;
  pairCount: number;
}

export interface SettlementInput {
  hits: number;
  joins: number;
  expired: number;
  invalidated: number;
  abandoned: number;
  specErrors: number;
  outstandingAtSnapshot: number;
  queuedSuppressed: number;
}

export interface SettledAccounting extends SettlementInput {
  issued: number;
  wastedAtSnapshot: number;
  settledAbandoned: number;
  settledWaste: number;
  settledWasteRate: number | null;
}

export interface SourceOutcome {
  emitted: number;
  admitted: number;
  issued: number;
  hits: number;
  joins: number;
  dedupSuppressions: number;
  terminalWaste: number;
  positiveLeadShare: number | null;
  medianLeadMs: number | null;
}

export interface ObserverRunRecord {
  schemaVersion: 1;
  phase: 'holdout';
  sourceCommit: string;
  client: ObserverClient;
  clientVersion: string;
  adapterFixtureVersion: string;
  transport: 'messages-json' | 'messages-sse' | 'responses-sse' | 'responses-websocket';
  model: string;
  effort: string | null;
  arm: ObserverArm;
  signals: ObserverSignals;
  observationPaths: readonly ('hook' | 'request' | 'stream')[];
  thermalState: ThermalState;
  workloadSet: WorkloadSet;
  workflow: ObserverWorkflowId;
  workflowVersion: 1;
  repetition: number;
  trainingSeed: number | null;
  holdoutSeed: number;
  orderIndex: number;
  runtimePath: 'bare-mcp' | 'session-wrapper';
  timings: {
    taskWallMs: number;
    toolWaitMs: number;
    toolWaitSamplesMs: number[];
    modelTtfbMs: number[];
    candidateToDispatchMs: number[];
    demandLeadMs: number[];
    streamDetectionLagMs: number[];
  };
  cache: {
    requestedCalls: number;
    hits: number;
    joins: number;
    misses: number;
    issued: number;
    expired: number;
    invalidated: number;
    abandoned: number;
    specErrors: number;
    outstandingAtSnapshot: number;
    settledWaste: number;
    suppressed: Record<string, number>;
    perSource: Partial<Record<'intent' | 'transition' | 'stream', SourceOutcome>>;
  };
  provider: {
    modelRequests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    usageSource: 'fixture-reported' | 'provider-reported' | 'unavailable';
    requestsObserved: number;
    streamCallsObserved: number;
    requestDigests: string[];
  };
  correctness: {
    outputDigest: string;
    expectedDigest: string;
    providerPayloadIdentical: boolean;
    toolResultDigestsIdenticalToA: boolean;
    unexpectedWrites: number;
    consentBypasses: number;
    wrongSessionResults: number;
    failures: string[];
  };
}

export interface ObserverBenchmarkOptions {
  clients?: readonly ObserverClient[];
  arms?: readonly ObserverArm[];
  workflows?: readonly ObserverWorkflowId[];
  repetitions?: number;
  latencyMs?: number;
  trainingEpisodes?: number;
  experimentSeed?: number;
  orderSeed?: number;
  bootstrapReplicates?: number;
  relayPairs?: number;
  relayWarmups?: number;
  verifyLauncher?: boolean;
  outputPath?: string;
  checkpointPath?: string;
  onProgress?: (line: string) => void;
}

export interface ObserverArtifact {
  schemaVersion: 1;
  benchmark: 'observer';
  evidenceScope: 'measured-deterministic-replay';
  fixtureLatency: { kind: 'synthetic-injected'; milliseconds: number };
  training: { timed: false; fixtureLatencyMs: 0; independentlySeeded: true };
  seeds: { experiment: number; order: number };
  armDefinitions: typeof OBSERVER_ARMS;
  executionOrder: OrderedRun[];
  records: ObserverRunRecord[];
  comparisons: ObserverComparison[];
  relay: ObserverRelayResult[];
  launcher: Record<ObserverClient, boolean>;
  summary: ReturnType<typeof summarizeObserverArtifact>;
  decisions: ObserverDecision[];
}

export interface ObserverRelayResult {
    client: ObserverClient;
    warmups: number;
    pairs: number;
    p50AddedTtfbMs: number | null;
    p95AddedTtfbMs: number | null;
    p95AddedTtfbInterval: Interval;
    payloadsIdentical: boolean;
    releaseEvidence: boolean;
}

export type ObserverSubject = 'hook-stage' | 'request-observation' | 'stream';
export type ObserverGateStatus = 'pass' | 'fail' | 'unverified';
export type ObserverGateName = 'correctness' | 'consent' | 'isolation' | 'extra-predictor-model-calls'
  | 'local-relay-p95' | 'median-improvement-vs-b' | 'mixed-p95-regression' | 'settled-waste'
  | 'incremental-benefit' | 'native-matched-task';

export interface ObserverGate {
  gate: ObserverGateName;
  status: ObserverGateStatus;
  reason: string;
}

export interface ObserverDecision {
  client: ObserverClient;
  subject: ObserverSubject;
  gateStatus: ObserverGateStatus;
  decision: 'enable' | 'retain-experimental' | 'remove' | 'unverified';
  reason: string;
  gates: ObserverGate[];
}

export interface ObserverComparison {
  client: ObserverClient;
  comparison: 'B-A' | 'C-A' | 'D-A' | 'E-A' | 'C-B' | 'D-C' | 'E-D' | 'D-B' | 'E-B';
  pairedRecords: number;
  toolHeavyTaskImprovement: Interval;
  toolHeavyToolWaitImprovement: Interval;
  mixedP95Regression: number | null;
  mixedP95RegressionInterval: Interval;
  correctnessFailures: number;
  extraPredictorModelCalls: number;
}

interface RuntimeStats {
  realCalls: number;
  speculativeCalls: number;
  hits: number;
  joins: number;
  misses: number;
  expired: number;
  invalidated: number;
  abandoned: number;
  suppressed: Record<string, number>;
  specErrors: number;
  cache: { ready: number; inFlight: number };
}

export interface FixtureCall {
  alias: string;
  tool: string;
  argsDigest: string;
  resultDigest: string;
  startedAt: number;
  completedAt: number;
}

interface RuntimeHandle {
  context: SessionContext;
  bridge: SessionBridge | null;
  adapter: AgentAdapter | null;
  observations: Observation[];
  lifecycle: ObserverLifecycleEvent[];
  setSignals(signals: ObserverSignals): void;
  call(step: MaterializedToolStep): Promise<{ result: CallToolResult; elapsedMs: number }>;
  route(step: MaterializedToolStep): Promise<RegisteredRoute | null>;
  stats(): Promise<RuntimeStats | null>;
  calls(): FixtureCall[];
  close(): Promise<void>;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = join(root, 'src', 'cli.ts');
const fixtureServer = join(root, 'bench', 'observer-fixture-server.ts');
const hookScript = join(root, 'plugin', 'hooks', 'session-observer.mjs');
const allTools = [...new Set(OBSERVER_WORKFLOWS.flatMap((workflow) => workflow.steps.flatMap((step) =>
  step.kind === 'tool' ? [step.tool] : step.kind === 'parallel' ? step.steps.map((item) => item.tool) : [],
)))];
const readTools = allTools.filter((tool) => tool !== 'write_file');

export function lifecycleTiming(input: {
  candidateCreatedAt: number;
  specDispatchAt: number;
  realDemandAt?: number;
  argsCompleteChunkAt?: number;
  streamObservedAt?: number;
}): { candidateToDispatchMs: number; demandLeadMs: number | null; streamDetectionLagMs: number | null } {
  return {
    candidateToDispatchMs: input.specDispatchAt - input.candidateCreatedAt,
    demandLeadMs: input.realDemandAt === undefined ? null : input.realDemandAt - input.specDispatchAt,
    streamDetectionLagMs: input.argsCompleteChunkAt === undefined || input.streamObservedAt === undefined
      ? null
      : input.streamObservedAt - input.argsCompleteChunkAt,
  };
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('percentile fraction must be finite and between 0 and 1');
  if (values.some((value) => !Number.isFinite(value))) throw new Error('percentile values must be finite');
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * fraction)]!;
}

export function bootstrapPairedMedian(pairs: readonly PairedValue[], options: BootstrapOptions): Interval {
  if (!Number.isSafeInteger(options.replicates) || options.replicates <= 0) throw new Error('bootstrap replicates must be positive');
  const byWorkflow = new Map<string, PairedValue[]>();
  for (const pair of pairs) {
    if (!Number.isFinite(pair.value)) throw new Error('paired values must be finite');
    const values = byWorkflow.get(pair.workflow) ?? [];
    values.push(pair);
    byWorkflow.set(pair.workflow, values);
  }
  const clusters = [...byWorkflow].sort(([left], [right]) => left.localeCompare(right));
  if (clusters.length === 0) {
    return { point: null, lower: null, upper: null, seed: options.seed, replicates: options.replicates, clusterCount: 0, pairCount: 0 };
  }
  const random = randomFor(options.seed);
  const samples: number[] = [];
  for (let replicate = 0; replicate < options.replicates; replicate++) {
    const values: number[] = [];
    for (let index = 0; index < clusters.length; index++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]![1];
      values.push(...cluster.map((pair) => pair.value));
    }
    samples.push(percentile(values, 0.5)!);
  }
  return {
    point: percentile(pairs.map((pair) => pair.value), 0.5),
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
    seed: options.seed,
    replicates: options.replicates,
    clusterCount: clusters.length,
    pairCount: pairs.length,
  };
}

export function settleAccounting(input: SettlementInput): SettledAccounting {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  const issued = input.hits + input.joins + input.expired + input.invalidated + input.abandoned + input.specErrors + input.outstandingAtSnapshot;
  const wastedAtSnapshot = input.expired + input.invalidated + input.abandoned + input.specErrors;
  const settledAbandoned = input.abandoned + input.outstandingAtSnapshot;
  const settledWaste = input.expired + input.invalidated + settledAbandoned + input.specErrors;
  return { ...input, issued, wastedAtSnapshot, settledAbandoned, settledWaste, settledWasteRate: issued === 0 ? null : settledWaste / issued };
}

export function randomizedBlocks(input: ExperimentCoordinates, seed: number): OrderedRun[] {
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions <= 0) throw new Error('repetitions must be positive');
  const arms = Object.keys(OBSERVER_ARMS) as ObserverArm[];
  const blocks = input.clients.flatMap((client) => input.workflows.flatMap((workflow) =>
    Array.from({ length: input.repetitions }, (_, repetition) => ({ client, workflow, repetition })),
  ));
  shuffle(blocks, randomFor(seed));
  let orderIndex = 0;
  return blocks.flatMap((block) => arms.map((arm, armIndex) => ({
    ...block,
    arm,
    armPosition: (armIndex + block.repetition) % arms.length,
  })).sort((left, right) => left.armPosition - right.armPosition).map((run) => ({ ...run, orderIndex: orderIndex++ })));
}

export function validatePair(records: readonly ObserverRunRecord[]): void {
  const control = records.find((record) => record.arm === 'A');
  if (!control) throw new Error('pair is missing arm A');
  for (const record of records) {
    if (record.client !== control.client || record.workflow !== control.workflow || record.repetition !== control.repetition ||
      record.holdoutSeed !== control.holdoutSeed || record.thermalState !== control.thermalState) throw new Error('pair coordinates differ');
    if (record.correctness.outputDigest !== control.correctness.outputDigest || record.correctness.expectedDigest !== control.correctness.expectedDigest) {
      throw new Error('output digest mismatch');
    }
    if (!record.correctness.providerPayloadIdentical) throw new Error('provider payload mismatch');
    if (record.cache.requestedCalls !== control.cache.requestedCalls) throw new Error('requested call count mismatch');
    if (record.correctness.wrongSessionResults > 0) throw new Error('wrong-session result');
    if (record.correctness.unexpectedWrites > 0) throw new Error('unexpected write');
    if (record.correctness.consentBypasses > 0) throw new Error('consent bypass');
    if (record.provider.modelRequests !== control.provider.modelRequests) throw new Error('extra predictor model call');
    if (stable(record.provider.requestDigests) !== stable(control.provider.requestDigests)) throw new Error('provider request digest mismatch');
  }
}

const rawKeys = new Set(['rawprompt', 'prompt', 'args', 'arguments', 'result', 'results', 'headers', 'credential', 'credentials', 'authorization']);

export function validateArtifact(artifact: Pick<ObserverArtifact, 'schemaVersion' | 'benchmark' | 'records'> | Record<string, unknown>): void {
  if (artifact.schemaVersion !== 1 || artifact.benchmark !== 'observer' || !Array.isArray(artifact.records)) throw new Error('invalid observer artifact');
  scanRawFields(artifact);
  for (const record of artifact.records as ObserverRunRecord[]) {
    if (!record.client || !record.clientVersion || !record.model || record.effort === undefined || !record.transport ||
      !record.thermalState || !record.signals || !Number.isSafeInteger(record.orderIndex)) throw new Error('record is missing required tags including model');
  }
}

export function summarizeObserverArtifact(records: readonly ObserverRunRecord[]) {
  const groups = new Map<string, ObserverRunRecord[]>();
  for (const record of records) {
    const key = `${record.client}:${record.arm}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
    const [client, arm] = key.split(':') as [ObserverClient, ObserverArm];
    const issued = values.reduce((sum, record) => sum + record.cache.issued, 0);
    const waste = values.reduce((sum, record) => sum + record.cache.settledWaste, 0);
    return {
      client,
      arm,
      records: values.length,
      taskWallP50Ms: percentile(values.map((record) => record.timings.taskWallMs), 0.5),
      taskWallP95Ms: percentile(values.map((record) => record.timings.taskWallMs), 0.95),
      toolWaitP50Ms: percentile(values.map((record) => record.timings.toolWaitMs), 0.5),
      toolWaitP95Ms: percentile(values.map((record) => record.timings.toolWaitMs), 0.95),
      settledWasteRate: issued === 0 ? null : waste / issued,
      correctnessFailures: values.reduce((sum, record) => sum + record.correctness.failures.length, 0),
    };
  });
}

export function evaluateObserverGates(input: {
  completeMatrix: boolean;
  clients: readonly ObserverClient[];
  records: readonly ObserverRunRecord[];
  comparisons: readonly ObserverComparison[];
  relay: readonly ObserverRelayResult[];
}): ObserverDecision[] {
  const subjects: Array<{ subject: ObserverSubject; arm: ObserverArm; benefit: ObserverComparison['comparison']; increment: ObserverComparison['comparison'] }> = [
    { subject: 'hook-stage', arm: 'C', benefit: 'C-B', increment: 'C-B' },
    { subject: 'request-observation', arm: 'D', benefit: 'D-B', increment: 'D-C' },
    { subject: 'stream', arm: 'E', benefit: 'E-B', increment: 'E-D' },
  ];
  return input.clients.flatMap((client) => subjects.map(({ subject, arm, benefit, increment }) => {
    const records = input.records.filter((record) => record.client === client && record.arm === arm);
    const benefitComparison = input.comparisons.find((item) => item.client === client && item.comparison === benefit);
    const incrementComparison = input.comparisons.find((item) => item.client === client && item.comparison === increment);
    const relay = input.relay.find((item) => item.client === client);
    const measured = (gate: ObserverGateName, pass: boolean, reason: string): ObserverGate => input.completeMatrix
      ? { gate, status: pass ? 'pass' : 'fail', reason }
      : { gate, status: 'unverified', reason: 'Requires the complete 20-workflow, five-repetition matrix.' };
    const missing = (gate: ObserverGateName, reason: string): ObserverGate => ({ gate, status: 'unverified', reason });
    const correctnessFailures = records.reduce((sum, record) => sum + record.correctness.failures.length + record.correctness.unexpectedWrites, 0);
    const consentBypasses = records.reduce((sum, record) => sum + record.correctness.consentBypasses, 0);
    const isolationFailures = records.reduce((sum, record) => sum + record.correctness.wrongSessionResults, 0);
    const issued = records.reduce((sum, record) => sum + record.cache.issued, 0);
    const waste = records.reduce((sum, record) => sum + record.cache.settledWaste, 0);
    const wasteRate = issued === 0 ? null : waste / issued;
    const improvement = benefitComparison?.toolHeavyTaskImprovement;
    const incrementalImprovement = incrementComparison?.toolHeavyTaskImprovement;
    const gates: ObserverGate[] = [
      records.length === 0
        ? missing('correctness', `No ${arm} records exist for ${client}.`)
        : measured('correctness', correctnessFailures === 0, `Observed ${correctnessFailures} correctness or unexpected-write failures.`),
      records.length === 0
        ? missing('consent', `No ${arm} records exist for ${client}.`)
        : measured('consent', consentBypasses === 0, `Observed ${consentBypasses} consent bypasses.`),
      records.length === 0
        ? missing('isolation', `No ${arm} records exist for ${client}.`)
        : measured('isolation', isolationFailures === 0, `Observed ${isolationFailures} session-isolation failures.`),
      benefitComparison
        ? measured('extra-predictor-model-calls', benefitComparison.extraPredictorModelCalls === 0,
            `Observed ${benefitComparison.extraPredictorModelCalls} extra model calls in ${benefit}.`)
        : missing('extra-predictor-model-calls', `Comparison ${benefit} is missing for ${client}.`),
      subject === 'hook-stage'
        ? { gate: 'local-relay-p95', status: 'pass', reason: 'Hook-stage observation does not use the local model relay.' }
        : !relay || !relay.releaseEvidence || relay.p95AddedTtfbMs === null
        ? missing('local-relay-p95', `A release-sized local relay sample is missing for ${client}.`)
        : measured('local-relay-p95', relay.payloadsIdentical && relay.p95AddedTtfbMs <= 5,
            `Observed p95 added TTFB ${relay.p95AddedTtfbMs} ms; limit is 5 ms; payload identity is ${relay.payloadsIdentical}.`),
      !improvement || improvement.point === null || improvement.lower === null
        ? missing('median-improvement-vs-b', `Task-wall improvement comparison ${benefit} is incomplete for ${client}.`)
        : measured('median-improvement-vs-b', improvement.point >= 0.1 && improvement.lower > 0,
            `Observed ${benefit} median task-wall improvement ${improvement.point}; 95% lower bound ${improvement.lower}; minimum is 0.1 with the interval excluding zero.`),
      !benefitComparison || benefitComparison.mixedP95Regression === null
        ? missing('mixed-p95-regression', `Mixed-task comparison ${benefit} is incomplete for ${client}.`)
        : measured('mixed-p95-regression', benefitComparison.mixedP95Regression <= 0.05,
            `Observed ${benefit} mixed-task p95 regression ${benefitComparison.mixedP95Regression}; limit is 0.05.`),
      wasteRate === null
        ? missing('settled-waste', `No speculative issues were measured for ${client} arm ${arm}.`)
        : measured('settled-waste', wasteRate <= 0.2, `Observed settled waste rate ${wasteRate}; limit is 0.2.`),
      !incrementalImprovement || incrementalImprovement.point === null || incrementalImprovement.lower === null
        ? missing('incremental-benefit', `Increment comparison ${increment} is incomplete for ${client}.`)
        : measured('incremental-benefit', incrementalImprovement.point > 0 && incrementalImprovement.lower > 0,
            `Observed ${increment} median task-wall improvement ${incrementalImprovement.point}; 95% lower bound ${incrementalImprovement.lower}; both must be positive.`),
      missing('native-matched-task', `Deterministic replay does not verify native matched-task benefit for ${client}.`),
    ];
    const gateStatus: ObserverGateStatus = gates.some((gate) => gate.status === 'fail') ? 'fail'
      : gates.some((gate) => gate.status === 'unverified') ? 'unverified' : 'pass';
    const decision: ObserverDecision['decision'] = !input.completeMatrix ? 'unverified'
      : gateStatus === 'fail' ? 'remove' : gateStatus === 'unverified' ? 'retain-experimental' : 'enable';
    const unresolved = gates.filter((gate) => gate.status !== 'pass').map((gate) => `${gate.gate}:${gate.status}`);
    return {
      client,
      subject,
      gateStatus,
      decision,
      reason: unresolved.length === 0 ? 'All fixed release gates passed.' : `Unresolved gates: ${unresolved.join(', ')}.`,
      gates,
    };
  }));
}

export async function runObserverBenchmark(options: ObserverBenchmarkOptions = {}): Promise<ObserverArtifact> {
  const clients = [...(options.clients ?? ['claude', 'codex'])];
  const arms = [...(options.arms ?? ['A', 'B', 'C', 'D', 'E'])];
  const workflows = [...(options.workflows ?? OBSERVER_WORKFLOW_IDS)];
  const repetitions = options.repetitions ?? 5;
  const latencyMs = options.latencyMs ?? 400;
  const trainingEpisodes = options.trainingEpisodes;
  const experimentSeed = options.experimentSeed ?? 0x51ec7;
  const orderSeed = options.orderSeed ?? 0x0b5e7;
  const bootstrapReplicates = options.bootstrapReplicates ?? 10_000;
  const completeOrder = randomizedBlocks({ clients, workflows, repetitions }, orderSeed);
  const executionOrder = completeOrder.filter((run) => arms.includes(run.arm));
  const records: ObserverRunRecord[] = [];
  const startedAt = monotonicNow();
  const checkpointPath = options.checkpointPath ?? (options.outputPath ? `${resolve(options.outputPath)}.partial` : undefined);
  for (let index = 0; index < executionOrder.length; index++) {
    const run = executionOrder[index]!;
    records.push(await runRecord(run, {
      latencyMs,
      trainingEpisodes,
      experimentSeed,
    }));
    const elapsedMs = Math.round(monotonicNow() - startedAt);
    options.onProgress?.(`completed ${index + 1}/${executionOrder.length} client=${run.client} arm=${run.arm} workflow=${run.workflow} elapsedMs=${elapsedMs}`);
    const next = executionOrder[index + 1];
    if (checkpointPath && (!next || blockKey(next) !== blockKey(run))) {
      writeCheckpoint(checkpointPath, 'running', records, executionOrder.length, elapsedMs, run);
    }
  }
  reconcileControls(records);
  for (const group of pairedGroups(records).values()) validatePair(group);
  const relayPairs = options.relayPairs ?? (executionOrder.length === 1_000 ? 200 : 4);
  const relayWarmups = options.relayWarmups ?? (executionOrder.length === 1_000 ? 20 : 1);
  const relay = await Promise.all(clients.map((client) => measureRelay(client, relayPairs, relayWarmups, bootstrapReplicates)));
  const launcher: Record<ObserverClient, boolean> = { claude: false, codex: false };
  if (options.verifyLauncher !== false) {
    for (const client of clients) launcher[client] = await verifyLauncherPath(client);
  }
  const fullMatrix = clients.length === 2 && arms.length === 5 && workflows.length === 20 && repetitions === 5;
  const comparisons = compareObserverRecords(records, bootstrapReplicates, experimentSeed);
  const decisions = evaluateObserverGates({ completeMatrix: fullMatrix, clients, records, comparisons, relay });
  const artifact: ObserverArtifact = {
    schemaVersion: 1,
    benchmark: 'observer',
    evidenceScope: 'measured-deterministic-replay',
    fixtureLatency: { kind: 'synthetic-injected', milliseconds: latencyMs },
    training: { timed: false, fixtureLatencyMs: 0, independentlySeeded: true },
    seeds: { experiment: experimentSeed, order: orderSeed },
    armDefinitions: OBSERVER_ARMS,
    executionOrder,
    records,
    comparisons,
    relay,
    launcher,
    summary: summarizeObserverArtifact(records),
    decisions,
  };
  validateArtifact(artifact);
  if (options.outputPath) writeJsonAtomic(resolve(options.outputPath), artifact);
  if (checkpointPath) {
    const last = executionOrder.at(-1);
    if (last) writeCheckpoint(checkpointPath, 'complete', records, executionOrder.length, Math.round(monotonicNow() - startedAt), last);
  }
  return artifact;
}

export function compareObserverRecords(
  records: readonly ObserverRunRecord[],
  replicates: number,
  seed: number,
): ObserverComparison[] {
  const definitions = [
    ['B', 'A'], ['C', 'A'], ['D', 'A'], ['E', 'A'],
    ['C', 'B'], ['D', 'C'], ['E', 'D'], ['D', 'B'], ['E', 'B'],
  ] as const;
  const comparisons: ObserverComparison[] = [];
  for (const client of ['claude', 'codex'] as const) {
    for (const [candidateArm, controlArm] of definitions) {
      const control = new Map(records.filter((record) => record.client === client && record.arm === controlArm)
        .map((record) => [recordPairKey(record), record]));
      const pairs = records.filter((record) => record.client === client && record.arm === candidateArm).flatMap((candidate) => {
        const baseline = control.get(recordPairKey(candidate));
        return baseline ? [{ baseline, candidate }] : [];
      });
      if (pairs.length === 0) continue;
      const taskValues = pairs.filter(({ candidate }) => candidate.workloadSet === 'tool-heavy').map(({ baseline, candidate }) => ({
        workflow: candidate.workflow,
        repetition: candidate.repetition,
        value: baseline.timings.taskWallMs === 0 ? 0 : (baseline.timings.taskWallMs - candidate.timings.taskWallMs) / baseline.timings.taskWallMs,
      }));
      const waitValues = pairs.filter(({ candidate }) => candidate.workloadSet === 'tool-heavy').map(({ baseline, candidate }) => ({
        workflow: candidate.workflow,
        repetition: candidate.repetition,
        value: baseline.timings.toolWaitMs === 0 ? 0 : (baseline.timings.toolWaitMs - candidate.timings.toolWaitMs) / baseline.timings.toolWaitMs,
      }));
      const mixed = pairs.filter(({ candidate }) => candidate.workloadSet === 'mixed');
      const candidateP95 = percentile(mixed.map(({ candidate }) => candidate.timings.taskWallMs), 0.95);
      const controlP95 = percentile(mixed.map(({ baseline }) => baseline.timings.taskWallMs), 0.95);
      const mixedInterval = bootstrapMixedRegression(mixed, {
        seed: hashSeed(seed, client, candidateArm, controlArm, 'mixed'),
        replicates,
      });
      comparisons.push({
        client,
        comparison: `${candidateArm}-${controlArm}` as ObserverComparison['comparison'],
        pairedRecords: pairs.length,
        toolHeavyTaskImprovement: bootstrapPairedMedian(taskValues, { seed: hashSeed(seed, client, candidateArm, controlArm, 'task'), replicates }),
        toolHeavyToolWaitImprovement: bootstrapPairedMedian(waitValues, { seed: hashSeed(seed, client, candidateArm, controlArm, 'wait'), replicates }),
        mixedP95Regression: candidateP95 === null || controlP95 === null || controlP95 === 0 ? null : candidateP95 / controlP95 - 1,
        mixedP95RegressionInterval: mixedInterval,
        correctnessFailures: pairs.reduce((total, pair) => total + pair.candidate.correctness.failures.length, 0),
        extraPredictorModelCalls: pairs.reduce((total, pair) => total + Math.max(0, pair.candidate.provider.modelRequests - pair.baseline.provider.modelRequests), 0),
      });
    }
  }
  return comparisons;
}

async function runRecord(
  run: OrderedRun,
  options: { latencyMs: number; trainingEpisodes?: number; experimentSeed: number },
): Promise<ObserverRunRecord> {
  const arm = OBSERVER_ARMS[run.arm];
  const workflow = OBSERVER_WORKFLOWS.find((item) => item.id === run.workflow)!;
  const holdoutSeed = hashSeed(options.experimentSeed, 'holdout', run.workflow, run.repetition);
  const trainingSeed = workflow.thermalState === 'warm'
    ? hashSeed(options.experimentSeed, 'train', run.client, run.repetition, run.workflow)
    : null;
  const recordRoot = mkdtempSync(join(tmpdir(), `speculate-observer-record-${run.client}-`));
  const stateRoot = join(recordRoot, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const episodes = options.trainingEpisodes ?? workflow.trainingEpisodes;
  const trainingCaptures: Array<{
    episode: number;
    index: number;
    step: MaterializedToolStep;
    parsed: unknown;
    latencyMs: number;
  }> = [];
  if (trainingSeed !== null && episodes > 0) {
    const trainer = await startRuntime(run.client, arm, workflow, 0, stateRoot);
    trainer.setSignals({ intent: false, transition: false, stream: false });
    try {
      for (let episode = 0; episode < episodes; episode++) {
        const training = materializeObserverWorkflow(run.workflow, trainingSeed + episode, run.repetition, 'training');
        for (let index = 0; index < training.steps.length; index++) {
          const step = training.steps[index]!;
          const outcome = await trainer.call(step);
          trainingCaptures.push({ episode, index, step, parsed: callPayload(outcome.result), latencyMs: outcome.elapsedMs });
        }
      }
    } finally {
      await trainer.close();
    }
  }
  const runtime = await startRuntime(run.client, arm, workflow, options.latencyMs, stateRoot);
  const modelTtfbMs: number[] = [];
  const toolWaitSamplesMs: number[] = [];
  const resultDigests: string[] = [];
  const demandedResults: Array<{ step: MaterializedToolStep; parsed: unknown }> = [];
  let providerPayloadIdentical = true;
  let providerRequestDigests: string[] = [];
  let modelRequests = 0;
  let argsCompleteChunkAt: number | undefined;
  let requestsObserved = 0;
  let requestedCalls = 0;
  try {
    if (trainingSeed !== null && episodes > 0 && runtime.bridge) {
      runtime.setSignals({ intent: false, transition: false, stream: false });
      await replayCapturedTraining(runtime, trainingCaptures);
      runtime.setSignals(arm.signals);
    }
    const materialized = materializeObserverWorkflow(run.workflow, holdoutSeed, run.repetition, 'holdout');
    const taskStart = monotonicNow();
    if (arm.hooks) {
      await publishHook(runtime, run.client, materialized);
      await delay(10);
    }
    if (materialized.steps[0]) {
      const exchange = await exchangeModel(runtime, run.client, arm, materialized.steps[0], materialized.id);
      modelTtfbMs.push(exchange.ttfbMs);
      providerPayloadIdentical = exchange.identical;
      argsCompleteChunkAt = exchange.argsCompleteChunkAt;
      requestsObserved = exchange.requestsObserved;
      providerRequestDigests = exchange.requestDigests;
      modelRequests = exchange.modelRequests;
    }
    const permissionBlocked = workflow.id === 'permission-denied' || workflow.id === 'approval-required';
    if (!permissionBlocked) {
      for (const step of materialized.steps) {
        await delay(step.thinkMs);
        const outcome = await runtime.call(step);
        requestedCalls++;
        toolWaitSamplesMs.push(outcome.elapsedMs);
        const parsed = callPayload(outcome.result);
        demandedResults.push({ step, parsed });
        resultDigests.push(digest(parsed));
      }
    } else {
      await delay(materialized.steps[0]?.thinkMs ?? 0);
    }
    const taskEnd = monotonicNow();
    await waitForIdle(runtime);
    const stats = await runtime.stats();
    const outstandingAtSnapshot = stats ? stats.cache.ready + stats.cache.inFlight : 0;
    const specErrors = stats?.specErrors ?? 0;
    const queuedSuppressed = stats ? (stats.suppressed['session-end'] ?? 0) + (stats.suppressed['queue-expired'] ?? 0) : 0;
    const settled = settleAccounting({
      hits: stats?.hits ?? 0,
      joins: stats?.joins ?? 0,
      expired: stats?.expired ?? 0,
      invalidated: stats?.invalidated ?? 0,
      abandoned: stats?.abandoned ?? 0,
      specErrors,
      outstandingAtSnapshot,
      queuedSuppressed,
    });
    const streamObservedAt = runtime.observations.find((observation) => observation.kind === 'stream-call')?.observedAt;
    const source = sourceOutcomes(runtime.lifecycle, runtime.observations);
    const fixtureCalls = runtime.calls();
    const provenanceFailures = demandedResults.filter(({ step, parsed }) => !validateToolResultProvenance(step, parsed, fixtureCalls)).length;
    const lifecycleTimings = runtime.lifecycle.filter((event) => event.type === 'speculated' && event.specDispatchAt !== undefined).map((event) =>
      lifecycleTiming({
        candidateCreatedAt: event.observerAttribution.candidateCreatedAt,
        specDispatchAt: event.specDispatchAt!,
        ...(runtime.lifecycle.find((terminal) => terminal.issueId === event.issueId && terminal.realDemandAt !== undefined)?.realDemandAt === undefined
          ? {}
          : { realDemandAt: runtime.lifecycle.find((terminal) => terminal.issueId === event.issueId && terminal.realDemandAt !== undefined)!.realDemandAt }),
        ...(streamObservedAt === undefined || argsCompleteChunkAt === undefined ? {} : { argsCompleteChunkAt, streamObservedAt }),
      }),
    );
    const outputDigest = digest(resultDigests);
    return {
      schemaVersion: 1,
      phase: 'holdout',
      sourceCommit: sourceCommit(),
      client: run.client,
      clientVersion: run.client === 'claude' ? 'fixture-claude-2.1.268' : 'fixture-codex-0.154.0',
      adapterFixtureVersion: '1',
      transport: run.client === 'claude' ? 'messages-sse' : 'responses-sse',
      model: 'deterministic-fixture-model',
      effort: null,
      arm: run.arm,
      signals: { ...arm.signals },
      observationPaths: [
        ...(arm.hooks ? ['hook' as const] : []),
        ...(arm.requestObserver ? ['request' as const] : []),
        ...(arm.signals.stream ? ['stream' as const] : []),
      ],
      thermalState: workflow.thermalState,
      workloadSet: workflow.set,
      workflow: workflow.id,
      workflowVersion: 1,
      repetition: run.repetition,
      trainingSeed,
      holdoutSeed,
      orderIndex: run.orderIndex,
      runtimePath: run.arm === 'A' ? 'bare-mcp' : 'session-wrapper',
      timings: {
        taskWallMs: taskEnd - taskStart,
        toolWaitMs: toolWaitSamplesMs.reduce((sum, value) => sum + value, 0),
        toolWaitSamplesMs,
        modelTtfbMs,
        candidateToDispatchMs: lifecycleTimings.map((item) => item.candidateToDispatchMs),
        demandLeadMs: lifecycleTimings.flatMap((item) => item.demandLeadMs === null ? [] : [item.demandLeadMs]),
        streamDetectionLagMs: lifecycleTimings.flatMap((item) => item.streamDetectionLagMs === null ? [] : [item.streamDetectionLagMs]),
      },
      cache: {
        requestedCalls,
        hits: stats?.hits ?? 0,
        joins: stats?.joins ?? 0,
        misses: stats?.misses ?? requestedCalls,
        issued: stats?.speculativeCalls ?? 0,
        expired: stats?.expired ?? 0,
        invalidated: stats?.invalidated ?? 0,
        abandoned: stats?.abandoned ?? 0,
        specErrors,
        outstandingAtSnapshot,
        settledWaste: settled.settledWaste,
        suppressed: stats?.suppressed ?? {},
        perSource: source,
      },
      provider: {
        modelRequests,
        inputTokens: null,
        outputTokens: null,
        usageSource: 'unavailable',
        requestsObserved,
        streamCallsObserved: runtime.observations.filter((observation) => observation.kind === 'stream-call').length,
        requestDigests: providerRequestDigests,
      },
      correctness: {
        outputDigest,
        expectedDigest: outputDigest,
        providerPayloadIdentical,
        toolResultDigestsIdenticalToA: true,
        unexpectedWrites: Math.max(0, fixtureCalls.filter((call) => call.tool === 'write_file').length - workflow.expected.mutationCalls),
        consentBypasses: permissionBlocked && fixtureCalls.length > 0 ? fixtureCalls.length : 0,
        wrongSessionResults: provenanceFailures,
        failures: [
          ...(providerPayloadIdentical ? [] : ['provider-payload-mismatch']),
          ...(provenanceFailures === 0 ? [] : [`tool-result-provenance:${provenanceFailures}`]),
        ],
      },
    };
  } finally {
    await runtime.close();
    rmSync(recordRoot, { recursive: true, force: true });
  }
}

async function startRuntime(
  clientKind: ObserverClient,
  arm: typeof OBSERVER_ARMS[ObserverArm],
  workflow: (typeof OBSERVER_WORKFLOWS)[number],
  latencyMs: number,
  stateRoot: string,
): Promise<RuntimeHandle> {
  const directory = mkdtempSync(join(stateRoot, `run-${clientKind}-`));
  const context: SessionContext = {
    launchId: randomUUID(),
    conversationId: `conversation-${randomUUID()}`,
    agent: clientKind,
    cwd: directory,
  };
  const lifecycle: ObserverLifecycleEvent[] = [];
  const observations: Observation[] = [];
  let adapter: AgentAdapter | null = null;
  let activeSignals = { ...arm.signals };
  const bridge = arm.speculate ? await SessionBridge.start(context, {
    correlateCompletion: async () => ({ conversationId: context.conversationId, cwd: context.cwd }),
    authorizeCandidate: async ({ candidate }) => {
      if (!activeSignals[candidate.source]) return { decision: 'denied', permissionContext: null };
      const decision = workflow.id === 'permission-denied' ? 'denied'
        : workflow.id === 'approval-required' ? 'approval-required'
          : 'allowed';
      return { decision, permissionContext: decision === 'allowed' ? `permission-${clientKind}` : null };
    },
    startupPolicy: async () => ({ enabled: true, allowTools: readTools, denyTools: ['write_file'] }),
    onHook: (hostClient, payload, observedAt) => {
      if (!adapter || hostClient !== clientKind) return;
      for (const observation of adapter.normalizeHook(payload, observedAt)) {
        observations.push(observation);
        if (observation.kind !== 'prompt' || activeSignals.intent) bridge?.publishObservation(observation);
      }
    },
    onLifecycle: (event) => { lifecycle.push(event); },
  }) : null;
  if (bridge) {
    const environment = {
      contextForConversation: (conversationId: string, cwd?: string) => {
        if (conversationId !== context.conversationId) return null;
        return { ...context, cwd: cwd ? resolve(cwd) : context.cwd };
      },
      routes: () => bridge.listRoutes(),
      now: monotonicNow,
    };
    adapter = clientKind === 'claude' ? claudeAdapter(environment) : codexAdapter(environment);
  }
  const aliases = [...new Set(workflow.steps.flatMap((step) => step.kind === 'tool' ? [step.alias]
    : step.kind === 'parallel' ? step.steps.map((item) => item.alias) : []))];
  const clients = new Map<string, Client>();
  const logs = new Map<string, string>();
  try {
    for (const alias of aliases) {
      const log = join(directory, `${alias}.jsonl`);
      logs.set(alias, log);
      const fixtureArgs = [tsxCli, fixtureServer];
      const fixtureEnv = {
        SPECULATE_OBSERVER_FIXTURE_ALIAS: alias,
        SPECULATE_OBSERVER_FIXTURE_LATENCY_MS: String(latencyMs),
        SPECULATE_OBSERVER_FIXTURE_CALL_LOG: log,
        SPECULATE_OBSERVER_FIXTURE_TOOLS: JSON.stringify(allTools),
      };
      const transport = arm.speculate
        ? new StdioClientTransport({
            command: process.execPath,
            args: [tsxCli, cli, 'wrap', '--mode', 'strict', '--allow', readTools.join(','), '--host-client', clientKind,
              '--host-server', alias, '--cwd', directory, '--', process.execPath, ...fixtureArgs],
            cwd: root,
            env: {
              ...process.env,
              XDG_STATE_HOME: stateRoot,
              ...fixtureEnv,
              SPECULATE_SESSION_SOCKET: bridge!.coordinates.socketPath,
              SPECULATE_SESSION_CAPABILITY: bridge!.coordinates.capability,
              SPECULATE_SESSION_LAUNCH_ID: bridge!.coordinates.launchId,
            } as Record<string, string>,
            stderr: 'pipe',
          })
        : new StdioClientTransport({
            command: process.execPath,
            args: fixtureArgs,
            cwd: directory,
            env: { ...process.env, ...fixtureEnv } as Record<string, string>,
            stderr: 'pipe',
          });
      const client = new Client({ name: `observer-${clientKind}-${alias}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      clients.set(alias, client);
    }
  } catch (error) {
    await Promise.allSettled([...clients.values()].map((client) => client.close()));
    await bridge?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    context,
    bridge,
    adapter,
    observations,
    lifecycle,
    setSignals(signals) { activeSignals = { ...signals }; },
    async call(step) {
      const client = clients.get(step.alias);
      if (!client) throw new Error(`missing fixture alias ${step.alias}`);
      const started = monotonicNow();
      const result = await client.callTool({ name: step.tool, arguments: step.args }) as CallToolResult;
      return { result, elapsedMs: monotonicNow() - started };
    },
    async route(step) {
      if (!bridge) return null;
      return waitFor(() => bridge.listRoutes().find((route) => route.hostServerAlias === step.alias && route.exposedTool === step.tool) ?? null,
        (route): route is RegisteredRoute => route !== null);
    },
    async stats() {
      if (!arm.speculate) return null;
      const snapshots = await Promise.all([...clients.values()].map(async (client) => {
        const result = await client.callTool({ name: 'speculate__stats', arguments: {} }) as CallToolResult;
        return callPayload(result) as RuntimeStats & { perServer?: Record<string, { specErrors: number }> };
      }));
      if (snapshots.length === 0) return null;
      return aggregateStats(snapshots);
    },
    calls: () => [...logs.values()].flatMap(readFixtureCalls).sort((left, right) => left.startedAt - right.startedAt),
    async close() {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
      await bridge?.close().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function publishHook(runtime: RuntimeHandle, client: ObserverClient, workflow: MaterializedObserverWorkflow): Promise<void> {
  if (!runtime.bridge) return;
  const payload = client === 'claude'
    ? { hook_event_name: 'UserPromptSubmit', session_id: runtime.context.conversationId, cwd: runtime.context.cwd,
        prompt: hookPrompt(workflow) }
    : { type: 'user-prompt-submit', thread_id: runtime.context.conversationId, cwd: runtime.context.cwd,
        prompt: hookPrompt(workflow) };
  await runProcess(process.execPath, [hookScript], {
    ...process.env,
    SPECULATE_OBSERVER_SOCKET: runtime.bridge.hookCoordinates.socketPath,
    SPECULATE_OBSERVER_CAPABILITY: runtime.bridge.hookCoordinates.capability,
    SPECULATE_OBSERVER_LAUNCH_ID: runtime.bridge.hookCoordinates.launchId,
    SPECULATE_OBSERVER_CLIENT: client,
  }, JSON.stringify(payload));
  await delay(2);
}

async function replayCapturedTraining(
  runtime: RuntimeHandle,
  captures: readonly {
    episode: number;
    index: number;
    step: MaterializedToolStep;
    parsed: unknown;
    latencyMs: number;
  }[],
): Promise<void> {
  if (!runtime.bridge) return;
  for (const capture of captures) {
    const step = capture.step;
    const route = await runtime.route(step);
    if (!route) continue;
    runtime.bridge.publishObservation({
      context: runtime.context,
      eventId: `training-${capture.episode}-${capture.index}`,
      observedAt: monotonicNow(),
      kind: 'tool-complete',
      routeId: route.routeId,
      args: step.args,
      parsed: capture.parsed as never,
      latencyMs: capture.latencyMs,
      ordered: true,
    });
    await delay(1);
  }
}

async function exchangeModel(
  runtime: RuntimeHandle,
  client: ObserverClient,
  arm: typeof OBSERVER_ARMS[ObserverArm],
  step: MaterializedToolStep,
  workflow: ObserverWorkflowId,
): Promise<{
  ttfbMs: number;
  identical: boolean;
  argsCompleteChunkAt: number;
  requestsObserved: number;
  modelRequests: number;
  requestDigests: string[];
}> {
  await runtime.route(step);
  const modelName = `mcp__${step.alias}__${step.tool}`;
  const inputSchema = fixtureInputSchema(step.tool);
  const requestBody = Buffer.from(JSON.stringify(client === 'claude'
    ? { messages: [{ role: 'user', content: modelPrompt(step) }], tools: [{ name: modelName, input_schema: inputSchema }] }
    : { input: modelPrompt(step), tools: [{ type: 'function', name: modelName, parameters: inputSchema }] }));
  const responseBody = client === 'claude'
    ? Buffer.from(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-call', name: modelName, input: {} } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.args) } })}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`)
    : Buffer.from(`data: ${JSON.stringify({ type: 'response.output_item.added', item: { id: 'fixture-item', type: 'function_call', call_id: 'fixture-call', name: modelName, arguments: '' } })}\n\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fixture-item', delta: JSON.stringify(step.args) })}\n\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { id: 'fixture-item', type: 'function_call', call_id: 'fixture-call', name: modelName } })}\n\n`);
  const cancelled = workflow === 'cancelled-mixed-task';
  const responseChunks = cancelled
    ? client === 'claude'
      ? [
          Buffer.from(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-call', name: modelName, input: {} } })}\n\n`),
          Buffer.from(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"key":"partial' } })}\n\n`),
        ]
      : [
          Buffer.from(`data: ${JSON.stringify({ type: 'response.output_item.added', item: { id: 'fixture-item', type: 'function_call', call_id: 'fixture-call', name: modelName, arguments: '' } })}\n\n`),
          Buffer.from(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fixture-item', delta: '{"key":"partial' })}\n\n`),
        ]
    : [responseBody];
  const provider = await startProvider(requestBody, responseChunks, 1, cancelled ? 20 : 0);
  let relay: LlmProxy | null = null;
  try {
    let target = provider.baseUrl;
    if (arm.requestObserver && runtime.adapter && runtime.bridge) {
      relay = await startLlmProxy({
        upstreamBaseUrl: provider.baseUrl,
        adapter: runtime.adapter,
        onObservation: (observation) => {
          runtime.observations.push(observation);
          if (observation.kind === 'stream-call' && !arm.signals.stream) return;
          if (observation.kind === 'prompt' && !arm.signals.intent) return;
          runtime.bridge!.publishObservation(observation);
        },
      });
      target = relay.baseUrl;
    }
    const exchange = await postStream(`${target}${client === 'claude' ? '/v1/messages' : '/v1/responses'}`, requestBody, {
      'content-type': 'application/json',
      ...(client === 'claude'
        ? { 'x-claude-code-session-id': runtime.context.conversationId }
        : { 'thread-id': runtime.context.conversationId }),
    }, cancelled);
    await delay(2);
    return {
      ttfbMs: exchange.firstByteAt - exchange.startedAt,
      identical: provider.requestCount === 1 && provider.requestBodies.every((body) => body.equals(requestBody)) &&
        exchange.body.equals(cancelled ? responseChunks[0]! : responseBody),
      argsCompleteChunkAt: provider.responseAt,
      requestsObserved: relay?.debugObservationState().totalRequests ?? 0,
      modelRequests: provider.requestCount,
      requestDigests: provider.requestDigests,
    };
  } finally {
    await relay?.close();
    await provider.close();
  }
}

async function measureRelay(
  client: ObserverClient,
  pairs: number,
  warmups: number,
  bootstrapReplicates: number,
): Promise<ObserverArtifact['relay'][number]> {
  const requestBody = Buffer.from(client === 'claude' ? '{"messages":[]}' : '{"input":[]}');
  const responseBody = Buffer.from('data: {"type":"fixture.completed"}\n\n');
  const provider = await startProvider(requestBody, responseBody, pairs * 2 + warmups * 2);
  const context: SessionContext = { launchId: 'relay', conversationId: 'relay', agent: client, cwd: root };
  const adapter = client === 'claude'
    ? claudeAdapter({ contextForConversation: () => context, routes: () => [] })
    : codexAdapter({ contextForConversation: () => context, routes: () => [] });
  const relay = await startLlmProxy({ upstreamBaseUrl: provider.baseUrl, adapter });
  const added: number[] = [];
  let identical = true;
  try {
    for (let index = 0; index < warmups + pairs; index++) {
      const directFirst = index % 2 === 0;
      const exchange = (baseUrl: string) => postStream(`${baseUrl}/v1/${client === 'claude' ? 'messages' : 'responses'}`, requestBody, { 'content-type': 'application/json' });
      const first = await exchange(directFirst ? provider.baseUrl : relay.baseUrl);
      const second = await exchange(directFirst ? relay.baseUrl : provider.baseUrl);
      const direct = directFirst ? first : second;
      const relayed = directFirst ? second : first;
      identical &&= direct.body.equals(responseBody) && relayed.body.equals(responseBody);
      if (index >= warmups) {
        const directTtfb = direct.firstByteAt - direct.startedAt;
        const relayTtfb = relayed.firstByteAt - relayed.startedAt;
        added.push(relayTtfb - directTtfb);
      }
    }
  } finally {
    await relay.close();
    await provider.close();
  }
  return {
    client,
    warmups,
    pairs,
    p50AddedTtfbMs: percentile(added, 0.5),
    p95AddedTtfbMs: percentile(added, 0.95),
    p95AddedTtfbInterval: bootstrapValues(added, 0.95, {
      seed: hashSeed(0x7e1a, client, pairs, warmups),
      replicates: bootstrapReplicates,
    }),
    payloadsIdentical: identical,
    releaseEvidence: pairs >= 200 && warmups >= 20,
  };
}

function bootstrapMixedRegression(
  pairs: readonly { baseline: ObserverRunRecord; candidate: ObserverRunRecord }[],
  options: BootstrapOptions,
): Interval {
  const byWorkflow = new Map<string, Array<{ baseline: ObserverRunRecord; candidate: ObserverRunRecord }>>();
  for (const pair of pairs) {
    const cluster = byWorkflow.get(pair.candidate.workflow) ?? [];
    cluster.push(pair);
    byWorkflow.set(pair.candidate.workflow, cluster);
  }
  const clusters = [...byWorkflow].sort(([left], [right]) => left.localeCompare(right));
  const statistic = (sample: readonly { baseline: ObserverRunRecord; candidate: ObserverRunRecord }[]) => {
    const baseline = percentile(sample.map((pair) => pair.baseline.timings.taskWallMs), 0.95);
    const candidate = percentile(sample.map((pair) => pair.candidate.timings.taskWallMs), 0.95);
    return baseline === null || candidate === null || baseline === 0 ? null : candidate / baseline - 1;
  };
  if (clusters.length === 0) {
    return { point: null, lower: null, upper: null, seed: options.seed, replicates: options.replicates, clusterCount: 0, pairCount: 0 };
  }
  const random = randomFor(options.seed);
  const samples: number[] = [];
  for (let replicate = 0; replicate < options.replicates; replicate++) {
    const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]![1]).flat();
    const value = statistic(sample);
    if (value !== null) samples.push(value);
  }
  return {
    point: statistic(pairs),
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
    seed: options.seed,
    replicates: options.replicates,
    clusterCount: clusters.length,
    pairCount: pairs.length,
  };
}

function bootstrapValues(values: readonly number[], fraction: number, options: BootstrapOptions): Interval {
  if (values.length === 0) {
    return { point: null, lower: null, upper: null, seed: options.seed, replicates: options.replicates, clusterCount: 0, pairCount: 0 };
  }
  const random = randomFor(options.seed);
  const samples = Array.from({ length: options.replicates }, () => percentile(
    Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!),
    fraction,
  )!);
  return {
    point: percentile(values, fraction),
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
    seed: options.seed,
    replicates: options.replicates,
    clusterCount: values.length,
    pairCount: values.length,
  };
}

async function verifyLauncherPath(client: ObserverClient): Promise<boolean> {
  const directory = mkdtempSync(join(tmpdir(), `speculate-launcher-${client}-`));
  const fake = join(directory, `fake-${client}.mjs`);
  const report = join(directory, 'report.json');
  const script = client === 'claude'
    ? `#!/usr/bin/env node\nif (process.argv.includes('--version')) process.stdout.write('2.1.268\\n');\n`
    : `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.154.0\\n'); process.exit(0); }
if (process.argv.includes('app-server')) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = message.method === 'initialize' ? { codexHome: ${JSON.stringify(directory)} }
      : message.method === 'config/read' ? { config: {}, layers: [], origins: {} } : {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  });
}
`;
  writeFileSync(fake, script, { mode: 0o700 });
  chmodSync(fake, 0o700);
  try {
    const result = await runProcess(process.execPath, [tsxCli, cli, 'run', client, '--observe', 'off', '--json-report', report, '--', ...(client === 'codex' ? ['exec'] : [])], {
      ...process.env,
      HOME: directory,
      ...(client === 'claude' ? { SPECULATE_CLAUDE_BIN: fake } : { SPECULATE_CODEX_BIN: fake }),
    });
    if (result !== 0 || !existsSync(report)) return false;
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as { client?: string; exit?: { code?: number } };
    return parsed.client === client && parsed.exit?.code === 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sourceOutcomes(
  lifecycle: readonly ObserverLifecycleEvent[],
  observations: readonly Observation[],
): Partial<Record<'intent' | 'transition' | 'stream', SourceOutcome>> {
  const result: Partial<Record<'intent' | 'transition' | 'stream', SourceOutcome>> = {};
  for (const source of ['intent', 'transition', 'stream'] as const) {
    const events = lifecycle.filter((event) => event.observerAttribution.source === source);
    const emitted = observations.filter((observation) => source === 'stream' ? observation.kind === 'stream-call'
      : source === 'intent' ? observation.kind === 'prompt' : observation.kind === 'tool-complete').length;
    if (events.length === 0 && emitted === 0) continue;
    const leads = events.flatMap((event) => event.realDemandAt === undefined || event.specDispatchAt === undefined
      ? [] : [event.realDemandAt - event.specDispatchAt]);
    const issued = events.filter((event) => event.type === 'speculated');
    const terminalIssueIds = new Set(events.filter((event) => ['hit', 'joined', 'expired', 'invalidated', 'abandoned', 'spec_error'].includes(event.type))
      .flatMap((event) => event.issueId ? [event.issueId] : []));
    const outstanding = issued.filter((event) => event.issueId && !terminalIssueIds.has(event.issueId)).length;
    const terminalWaste = events.filter((event) => ['expired', 'invalidated', 'abandoned', 'spec_error'].includes(event.type)).length + outstanding;
    result[source] = {
      emitted,
      admitted: events.filter((event) => event.type === 'speculated' || event.type === 'suppressed').length,
      issued: issued.length,
      hits: events.filter((event) => event.type === 'hit').length,
      joins: events.filter((event) => event.type === 'joined').length,
      dedupSuppressions: events.filter((event) => event.type === 'suppressed' && event.suppression === 'dedup').length,
      terminalWaste,
      positiveLeadShare: leads.length === 0 ? null : leads.filter((lead) => lead > 0).length / leads.length,
      medianLeadMs: percentile(leads, 0.5),
    };
  }
  return result;
}

function aggregateStats(snapshots: Array<RuntimeStats & { perServer?: Record<string, { specErrors: number }> }>): RuntimeStats {
  const sum = (field: 'realCalls' | 'speculativeCalls' | 'hits' | 'joins' | 'misses' | 'expired' | 'invalidated' | 'abandoned') =>
    snapshots.reduce((total, snapshot) => total + snapshot[field], 0);
  const suppressed: Record<string, number> = {};
  for (const snapshot of snapshots) {
    for (const [reason, count] of Object.entries(snapshot.suppressed)) suppressed[reason] = (suppressed[reason] ?? 0) + count;
  }
  return {
    realCalls: sum('realCalls'),
    speculativeCalls: sum('speculativeCalls'),
    hits: sum('hits'),
    joins: sum('joins'),
    misses: sum('misses'),
    expired: sum('expired'),
    invalidated: sum('invalidated'),
    abandoned: sum('abandoned'),
    suppressed,
    specErrors: snapshots.reduce((total, snapshot) => total + Object.values(snapshot.perServer ?? {})
      .reduce((serverTotal, server) => serverTotal + server.specErrors, 0), 0),
    cache: {
      ready: snapshots.reduce((total, snapshot) => total + snapshot.cache.ready, 0),
      inFlight: snapshots.reduce((total, snapshot) => total + snapshot.cache.inFlight, 0),
    },
  };
}

function reconcileControls(records: ObserverRunRecord[]): void {
  for (const group of pairedGroups(records).values()) {
    const control = group.find((record) => record.arm === 'A');
    if (!control) continue;
    for (const record of group) {
      record.correctness.expectedDigest = control.correctness.outputDigest;
      record.correctness.toolResultDigestsIdenticalToA = record.correctness.outputDigest === control.correctness.outputDigest;
      if (!record.correctness.toolResultDigestsIdenticalToA) record.correctness.failures.push('tool-result-digest-mismatch');
    }
  }
}

function pairedGroups(records: readonly ObserverRunRecord[]): Map<string, ObserverRunRecord[]> {
  const groups = new Map<string, ObserverRunRecord[]>();
  for (const record of records) {
    const key = `${record.client}\0${record.workflow}\0${record.repetition}\0${record.holdoutSeed}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return groups;
}

function recordPairKey(record: ObserverRunRecord): string {
  return `${record.workflow}\0${record.repetition}\0${record.holdoutSeed}\0${record.thermalState}`;
}

function blockKey(run: OrderedRun): string {
  return `${run.client}\0${run.workflow}\0${run.repetition}`;
}

function writeCheckpoint(
  path: string,
  status: 'running' | 'complete',
  records: readonly ObserverRunRecord[],
  total: number,
  elapsedMs: number,
  last: OrderedRun,
): void {
  const checkpoint = {
    schemaVersion: 1,
    benchmark: 'observer-checkpoint',
    status,
    completed: records.length,
    total,
    elapsedMs,
    last: { client: last.client, arm: last.arm, workflow: last.workflow },
    records,
  };
  scanRawFields(checkpoint);
  writeJsonAtomic(path, checkpoint);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const target = resolve(path);
  mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
}

function scanRawFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) scanRawFields(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (rawKeys.has(key.toLowerCase())) throw new Error(`raw session field is forbidden: ${key}`);
    scanRawFields(item);
  }
}

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
}

function hashSeed(...parts: Array<string | number>): number {
  return createHash('sha256').update(parts.join('\0')).digest().readUInt32BE(0);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function sourceCommit(): string {
  return process.env.SPECULATE_BENCH_SOURCE_COMMIT ?? 'staging-uncommitted';
}

function hookPrompt(workflow: MaterializedObserverWorkflow): string {
  const first = workflow.steps[0];
  return first?.tool === 'list_directory' && typeof first.args.path === 'string'
    ? `List ${first.args.path}`
    : 'Complete the deterministic fixture workflow.';
}

function modelPrompt(step: MaterializedToolStep): string {
  return step.tool === 'list_directory' && typeof step.args.path === 'string'
    ? `List ${step.args.path}`
    : 'Inspect the selected registered tool.';
}

function fixtureInputSchema(tool: string): Record<string, unknown> {
  const property = tool === 'list_directory' ? 'path' : 'key';
  return {
    type: 'object',
    properties: { [property]: { type: 'string' } },
    required: [property],
    $schema: 'http://json-schema.org/draft-07/schema#',
  };
}

export function validateToolResultProvenance(
  step: MaterializedToolStep,
  parsed: unknown,
  calls: readonly FixtureCall[],
): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const payload = parsed as Record<string, unknown>;
  if (payload.alias !== step.alias || payload.tool !== step.tool || payload.ok !== true || !Number.isSafeInteger(payload.revision)) return false;
  const returnedArgs: Record<string, unknown> = {};
  for (const key of Object.keys(step.args)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return false;
    returnedArgs[key] = payload[key];
  }
  const argsDigest = digest(step.args);
  if (digest(returnedArgs) !== argsDigest) return false;
  const resultDigest = digest(parsed);
  return calls.some((call) => call.alias === step.alias && call.tool === step.tool &&
    call.argsDigest === argsDigest && call.resultDigest === resultDigest);
}

function callPayload(result: CallToolResult): unknown {
  const block = result.content.find((item) => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('fixture tool result did not contain text');
  return JSON.parse(block.text) as unknown;
}

function readFixtureCalls(path: string): FixtureCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FixtureCall);
}

function monotonicNow(): number {
  return performance.timeOrigin + performance.now();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitFor<T>(read: () => T, accepts: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = monotonicNow() + timeoutMs;
  let value = read();
  while (!accepts(value) && monotonicNow() < deadline) {
    await delay(5);
    value = read();
  }
  if (!accepts(value)) throw new Error('timed out waiting for observer state');
  return value;
}

async function waitForIdle(runtime: RuntimeHandle): Promise<void> {
  if (!runtime.bridge) return;
  const deadline = monotonicNow() + 5_000;
  while (monotonicNow() < deadline) {
    const stats = await runtime.stats();
    if (!stats || stats.cache.inFlight === 0) return;
    await delay(5);
  }
  throw new Error('timed out waiting for speculative calls to settle');
}

async function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited on ${signal}`));
      else if ((code ?? 0) !== 0 && stderr) resolvePromise(code ?? 1);
      else resolvePromise(code ?? 0);
    });
    child.stdin?.end(input);
  });
}

async function startProvider(
  expectedRequest: Buffer,
  responseBody: Buffer | readonly Buffer[],
  requestLimit = 1,
  chunkDelayMs = 0,
): Promise<{
  baseUrl: string;
  requestBodies: readonly Buffer[];
  requestCount: number;
  requestDigests: string[];
  responseAt: number;
  close(): Promise<void>;
}> {
  const requestBodies: Buffer[] = [];
  let responseAt = 0;
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    await new Promise<void>((resolvePromise) => request.on('end', resolvePromise));
    const requestBody = Buffer.concat(chunks);
    requestBodies.push(requestBody);
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    responseAt = monotonicNow();
    const responseChunks = Buffer.isBuffer(responseBody) ? [responseBody] : responseBody;
    for (let index = 0; index < responseChunks.length; index++) {
      if (response.destroyed) break;
      response.write(responseChunks[index]);
      if (chunkDelayMs > 0 && index < responseChunks.length - 1) await delay(chunkDelayMs);
    }
    if (!response.destroyed) response.end();
    if (requests > requestLimit || !requestBody.equals(expectedRequest)) response.destroy();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture provider failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requestBodies() { return requestBodies; },
    get requestCount() { return requests; },
    get requestDigests() { return requestBodies.map((body) => createHash('sha256').update(body).digest('hex')); },
    get responseAt() { return responseAt; },
    close: () => closeServer(server),
  };
}

async function postStream(url: string, body: Buffer, headers: Record<string, string>, abortAfterFirstChunk = false): Promise<{
  startedAt: number;
  firstByteAt: number;
  body: Buffer;
}> {
  const startedAt = monotonicNow();
  return await new Promise((resolvePromise, reject) => {
    const request = httpRequest(url, { method: 'POST', headers: { ...headers, 'content-length': String(body.byteLength) } });
    let cancelled = false;
    request.once('error', (error) => { if (!cancelled) reject(error); });
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      let firstByteAt = startedAt;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolvePromise({ startedAt, firstByteAt, body: Buffer.concat(chunks) });
      };
      response.on('data', (chunk: Buffer) => {
        if (chunks.length === 0) firstByteAt = monotonicNow();
        chunks.push(Buffer.from(chunk));
        if (abortAfterFirstChunk && chunks.length === 1) {
          cancelled = true;
          response.destroy();
          request.destroy();
        }
      });
      response.once('end', finish);
      response.once('close', finish);
      response.once('error', (error) => { if (cancelled) finish(); else reject(error); });
    });
    request.end(body);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
}

function parseCli(argv: string[]): ObserverBenchmarkOptions {
  const options: ObserverBenchmarkOptions = {
    outputPath: resolve('observer-results.json'),
    onProgress: (line) => process.stderr.write(`${line}\n`),
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--smoke') {
      options.workflows = ['early-stream-call'];
      options.repetitions = 1;
      options.latencyMs = 5;
      options.trainingEpisodes = 0;
      options.bootstrapReplicates = 64;
      options.relayPairs = 4;
      options.relayWarmups = 1;
    } else if (argument === '--latency') options.latencyMs = Number(argv[++index]);
    else if (argument === '--output') options.outputPath = argv[++index];
    else throw new Error(`unknown observer benchmark argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runObserverBenchmark(parseCli(process.argv.slice(2))).then((artifact) => {
    process.stdout.write(`${JSON.stringify({
      records: artifact.records.length,
      evidenceScope: artifact.evidenceScope,
      fixtureLatency: artifact.fixtureLatency,
      summary: artifact.summary,
      decisions: artifact.decisions,
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
