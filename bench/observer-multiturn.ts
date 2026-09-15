import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startLlmProxy, type LlmProxy } from '../src/llmProxy.js';
import type { Observation } from '../src/observerTypes.js';
import type { ObserverLifecycleEvent } from '../src/types.js';
import { OBSERVER_ARMS, startRuntime, type RuntimeHandle } from './observer.js';
import {
  OBSERVER_WORKFLOWS,
  type MaterializedToolStep,
  type ObserverWorkflow,
} from './observer-workflows.js';
import {
  MULTITURN_PARAMETERS,
  materializeMultiturnWorkflow,
  type MultiturnArm,
  type MultiturnClient,
  type MultiturnStep,
  type MultiturnWorkflow,
  type MultiturnWorkflowId,
} from './observer-multiturn-workflows.js';

type Source = 'intent' | 'transition' | 'stream';

interface SourceCounts {
  issued: number;
  hits: number;
  joins: number;
  waste: number;
}

export interface MultiturnOrderEntry {
  client: MultiturnClient;
  arm: MultiturnArm;
  workflow: MultiturnWorkflowId;
  repetition: number;
  orderIndex: number;
}

export interface MultiturnRecord {
  client: MultiturnClient;
  arm: MultiturnArm;
  workflow: MultiturnWorkflowId;
  repetition: number;
  taskWallMs: number;
  toolWaitMs: number;
  modelWaitMs: number;
  providerRequests: number;
  demandedCalls: number;
  physicalCalls: number;
  hits: number;
  joins: number;
  misses: number;
  issued: number;
  settledWaste: number;
  perSource: Partial<Record<Source, SourceCounts>>;
  providerDigest?: string;
  resultDigest: string;
  failures: string[];
}

interface ProviderPlan {
  body: Buffer;
  delayMs: number;
}

interface ProviderHandle {
  baseUrl: string;
  enqueue(plan: ProviderPlan): void;
  requestDigests(): string[];
  close(): Promise<void>;
}

interface TurnHistory {
  step: MultiturnStep;
  result: Record<string, unknown>;
}

const clients: readonly MultiturnClient[] = ['claude', 'codex'];
const workflows: readonly MultiturnWorkflowId[] = ['derivable-cross-server', 'unpredictable-cold'];
export const MULTITURN_ARM_DEFINITIONS = OBSERVER_ARMS;
const arms = Object.keys(MULTITURN_ARM_DEFINITIONS) as MultiturnArm[];

export function createMultiturnOrder(repetitions: number, seed: number): MultiturnOrderEntry[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be a positive integer');
  const random = mulberry32(seed);
  const blocks = clients.flatMap((client) => workflows.flatMap((workflow) =>
    Array.from({ length: repetitions }, (_, repetition) => ({ client, workflow, repetition }))));
  shuffle(blocks, random);
  const entries: Omit<MultiturnOrderEntry, 'orderIndex'>[] = [];
  for (const block of blocks) {
    const blockArms = [...arms];
    shuffle(blockArms, random);
    entries.push(...blockArms.map((arm) => ({ ...block, arm })));
  }
  return entries.map((entry, orderIndex) => ({ ...entry, orderIndex }));
}

export async function runObserverMultiturn() {
  const order = createMultiturnOrder(MULTITURN_PARAMETERS.repetitions, MULTITURN_PARAMETERS.orderSeed);
  const records: MultiturnRecord[] = [];
  for (const entry of order) records.push(await runMultiturnRecord(entry));
  reconcilePairs(records);
  return {
    schemaVersion: 1,
    benchmark: 'observer-multiturn-opportunity',
    evidenceScope: 'synthetic-opportunity-diagnostic',
    releaseQualification: false,
    nativeClientEvidence: false,
    sourceCommit: process.env.SPECULATE_BENCH_SOURCE_COMMIT ?? 'uncommitted',
    parameters: MULTITURN_PARAMETERS,
    armDefinitions: MULTITURN_ARM_DEFINITIONS,
    baselineScope: 'Arm B runs the production session wrapper, predictor, admission, executor, cache, permission gate, and MCP client. The warm opportunity crosses server owners, outside ordinary per-server transition learning.',
    order,
    records,
    summary: summarizeMultiturnRecords(records),
    comparisons: compareMultiturnRecords(records),
    limitations: [
      'Synthetic fixed latency is an opportunity diagnostic, not release or native-client performance evidence.',
      'The hook input is normalized by the production client adapter without invoking a native client hook process.',
      'Model reasoning latency benefits intent and prior-result transitions; completed-stream candidates receive only dispatchLagMs.',
      'The retained 1,000-record observer artifact and its fixed gates are unchanged.',
    ],
  };
}

export function summarizeMultiturnRecords(records: readonly MultiturnRecord[]) {
  return clients.flatMap((client) => arms.flatMap((arm) => {
    const selected = records.filter((record) => record.client === client && record.arm === arm);
    if (selected.length === 0) return [];
    return [{
      client,
      arm,
      records: selected.length,
      taskWallMedianMs: median(selected.map((record) => record.taskWallMs)),
      toolWaitMedianMs: median(selected.map((record) => record.toolWaitMs)),
      issued: sum(selected, (record) => record.issued),
      hits: sum(selected, (record) => record.hits),
      joins: sum(selected, (record) => record.joins),
      settledWaste: sum(selected, (record) => record.settledWaste),
      perSource: aggregateSources(selected),
      failures: sum(selected, (record) => record.failures.length),
    }];
  }));
}

export function compareMultiturnRecords(records: readonly MultiturnRecord[]) {
  const definitions = [['B', 'A'], ['C', 'B'], ['D', 'C'], ['E', 'D']] as const;
  return clients.flatMap((client) => definitions.flatMap(([candidateArm, controlArm]) => {
    const controls = new Map(records.filter((record) => record.client === client && record.arm === controlArm)
      .map((record) => [pairKey(record), record]));
    const pairs = records.filter((record) => record.client === client && record.arm === candidateArm).flatMap((candidate) => {
      const control = controls.get(pairKey(candidate));
      return control ? [{ control, candidate }] : [];
    });
    if (pairs.length === 0) return [];
    return [{
      client,
      comparison: `${candidateArm}-${controlArm}`,
      pairedRecords: pairs.length,
      taskWallMedianImprovement: median(pairs.map(({ control, candidate }) => relativeImprovement(control.taskWallMs, candidate.taskWallMs))),
      toolWaitMedianImprovement: median(pairs.map(({ control, candidate }) => relativeImprovement(control.toolWaitMs, candidate.toolWaitMs))),
    }];
  }));
}

export async function runMultiturnRecord(entry: MultiturnOrderEntry): Promise<MultiturnRecord> {
  const stateRoot = mkdtempSync(join(tmpdir(), `speculate-multiturn-${entry.client}-`));
  const arm = OBSERVER_ARMS[entry.arm];
  const runtimeWorkflow = harnessWorkflow(entry.workflow);
  const captures: Array<{
    episode: number;
    index: number;
    step: MaterializedToolStep;
    parsed: Record<string, unknown>;
    latencyMs: number;
  }> = [];
  let runtime: RuntimeHandle | null = null;
  let provider: ProviderHandle | null = null;
  let relay: LlmProxy | null = null;
  try {
    if (entry.workflow === 'derivable-cross-server' && entry.arm !== 'A') {
      const trainer = await startRuntime(entry.client, arm, runtimeWorkflow,
        MULTITURN_PARAMETERS.trainingToolLatencyMs, stateRoot, undefined, toolsByAlias(entry.workflow));
      trainer.setSignals({ intent: false, transition: false, stream: false });
      try {
        for (let episode = 0; episode < MULTITURN_PARAMETERS.trainingEpisodes; episode++) {
          const workflow = materializeMultiturnWorkflow(entry.workflow, 'training',
            hashNumber(MULTITURN_PARAMETERS.experimentSeed, entry.client, entry.repetition, episode), entry.repetition);
          const episodeCaptures = await derivedSteps(workflow, async (step) => {
            const outcome = await trainer.call(asToolStep(step));
            return { parsed: parseFixtureResult(outcome.result), latencyMs: outcome.elapsedMs };
          });
          captures.push(...episodeCaptures.map(({ step, parsed, latencyMs }, index) =>
            ({ episode, index, step: asToolStep(step), parsed, latencyMs })));
        }
      } finally {
        await trainer.close();
      }
    }

    runtime = await startRuntime(entry.client, arm, runtimeWorkflow, MULTITURN_PARAMETERS.toolLatencyMs,
      stateRoot, undefined, toolsByAlias(entry.workflow));
    runtime.setSignals(arm.signals);
    if (runtime.bridge && captures.length > 0) {
      runtime.setSignals({ intent: false, transition: false, stream: false });
      for (const capture of captures) {
        const route = await runtime.route(capture.step);
        if (!route) throw new Error('training route was not registered');
        runtime.bridge.publishObservation({
          kind: 'tool-complete',
          context: runtime.context,
          eventId: `training-${capture.episode}-${capture.index}`,
          observedAt: clockNow(),
          routeId: route.routeId,
          args: capture.step.args,
          parsed: capture.parsed,
          latencyMs: capture.latencyMs,
          ordered: true,
        });
        await delay(1);
      }
      runtime.setSignals(arm.signals);
    }

    provider = await startProvider();
    if (arm.requestObserver && runtime.adapter && runtime.bridge) {
      const activeRuntime = runtime;
      relay = await startLlmProxy({
        upstreamBaseUrl: provider.baseUrl,
        adapter: runtime.adapter,
        onObservation: (observation) => publishObserved(activeRuntime, observation),
      });
    }

    const workflow = materializeMultiturnWorkflow(entry.workflow, 'holdout',
      hashNumber(MULTITURN_PARAMETERS.experimentSeed, entry.workflow, entry.repetition), entry.repetition);
    if (runtime.bridge) {
      for (const step of workflow.steps) {
        if (!await runtime.route(asToolStep(step))) throw new Error('holdout route was not registered');
      }
    }
    const taskStart = performance.now();
    if (arm.hooks) publishHook(runtime, workflow.prompt);

    let previous: Record<string, unknown> | null = null;
    let toolWaitMs = 0;
    let modelWaitMs = 0;
    const resultDigests: string[] = [];
    const resultHistory: TurnHistory[] = [];
    const failures: string[] = [];
    for (let index = 0; index < workflow.steps.length; index++) {
      const declared = workflow.steps[index]!;
      const step = index === 0 || entry.workflow === 'unpredictable-cold' ? declared : deriveFromResult(declared, previous);
      if (stable(step.args) !== stable(declared.args)) failures.push(`derived-args-mismatch:${index}`);
      const modelStart = performance.now();
      await exchangeModel(provider, relay?.baseUrl ?? provider.baseUrl, runtime, step, workflow.prompt, resultHistory);
      modelWaitMs += performance.now() - modelStart;
      await delay(MULTITURN_PARAMETERS.dispatchLagMs);
      const outcome = await runtime.call(asToolStep(step));
      toolWaitMs += outcome.elapsedMs;
      const parsed = parseFixtureResult(outcome.result);
      validateProvenance(step, parsed, index, failures);
      previous = parsed;
      resultHistory.push({ step, result: parsed });
      resultDigests.push(digest(parsed));
    }
    const taskWallMs = performance.now() - taskStart;
    await waitForRuntime(runtime);
    const stats = await runtime.stats();
    const calls = runtime.calls();
    const perSource = lifecycleSources(runtime.lifecycle);
    const providerDigests = provider.requestDigests();
    if (providerDigests.length !== workflow.steps.length) failures.push('provider-request-count');
    return {
      client: entry.client,
      arm: entry.arm,
      workflow: entry.workflow,
      repetition: entry.repetition,
      taskWallMs,
      toolWaitMs,
      modelWaitMs,
      providerRequests: providerDigests.length,
      demandedCalls: workflow.steps.length,
      physicalCalls: calls.length,
      hits: stats?.hits ?? 0,
      joins: stats?.joins ?? 0,
      misses: stats?.misses ?? workflow.steps.length,
      issued: stats?.speculativeCalls ?? 0,
      settledWaste: (stats?.expired ?? 0) + (stats?.invalidated ?? 0) + (stats?.abandoned ?? 0) +
        (stats?.specErrors ?? 0) + (stats ? stats.cache.ready + stats.cache.inFlight : 0),
      perSource,
      providerDigest: digest(providerDigests),
      resultDigest: digest(resultDigests),
      failures,
    };
  } finally {
    await relay?.close().catch(() => {});
    await provider?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

function harnessWorkflow(id: MultiturnWorkflowId): ObserverWorkflow {
  const base = OBSERVER_WORKFLOWS.find((workflow) => workflow.id ===
    (id === 'derivable-cross-server' ? 'dependency-navigation' : 'unpredictable-lookups'))!;
  const tools = id === 'derivable-cross-server'
    ? [['workspace', 'list_directory'], ['registry', 'get_package'], ['ci', 'list_checks']] as const
    : [['nonce-a', 'lookup_alpha'], ['nonce-b', 'lookup_beta']] as const;
  return {
    ...base,
    steps: tools.map(([alias, tool], index) => ({ kind: 'tool' as const, alias, tool, argsRef: `turn-${index}`, thinkMs: 0 })),
    expected: { requestedCalls: tools.length, mutationCalls: 0, permissionDecisions: tools.map(() => 'allowed' as const) },
  };
}

function toolsByAlias(id: MultiturnWorkflowId): Readonly<Record<string, readonly string[]>> {
  return id === 'derivable-cross-server'
    ? { workspace: ['list_directory'], registry: ['get_package'], ci: ['list_checks'] }
    : { 'nonce-a': ['lookup_alpha'], 'nonce-b': ['lookup_beta'] };
}

async function derivedSteps(
  workflow: MultiturnWorkflow,
  call: (step: MultiturnStep) => Promise<{ parsed: Record<string, unknown>; latencyMs: number }>,
): Promise<Array<{ step: MultiturnStep; parsed: Record<string, unknown>; latencyMs: number }>> {
  const captured: Array<{ step: MultiturnStep; parsed: Record<string, unknown>; latencyMs: number }> = [];
  let previous: Record<string, unknown> | null = null;
  for (let index = 0; index < workflow.steps.length; index++) {
    const declared = workflow.steps[index]!;
    const step = index === 0 ? declared : deriveFromResult(declared, previous);
    const { parsed, latencyMs } = await call(step);
    captured.push({ step, parsed, latencyMs });
    previous = parsed;
  }
  return captured;
}

function deriveFromResult(step: MultiturnStep, previous: Record<string, unknown> | null): MultiturnStep {
  const value = previous?.path ?? previous?.key;
  return { ...step, args: { key: String(value) } };
}

function asToolStep(step: MultiturnStep): MaterializedToolStep {
  return { kind: 'tool', alias: step.alias, tool: step.tool, args: step.args, thinkMs: 0 };
}

function publishHook(runtime: RuntimeHandle, prompt: string): void {
  if (!runtime.bridge || !runtime.adapter) return;
  const payload = runtime.context.agent === 'claude'
    ? { hook_event_name: 'UserPromptSubmit', session_id: runtime.context.conversationId, cwd: runtime.context.cwd, prompt }
    : { type: 'user-prompt-submit', thread_id: runtime.context.conversationId, cwd: runtime.context.cwd, prompt };
  for (const observation of runtime.adapter.normalizeHook(payload, clockNow())) publishObserved(runtime, observation);
}

function publishObserved(runtime: RuntimeHandle, observation: Observation): void {
  runtime.observations.push(observation);
  runtime.bridge?.publishObservation(observation);
}

async function exchangeModel(
  provider: ProviderHandle,
  target: string,
  runtime: RuntimeHandle,
  step: MultiturnStep,
  prompt: string,
  history: readonly TurnHistory[],
): Promise<void> {
  const name = `mcp__${step.alias}__${step.tool}`;
  const schema = fixtureSchema(step.tool);
  const client = runtime.context.agent;
  const request = client === 'claude'
    ? {
        messages: [
          { role: 'user', content: prompt },
          ...history.flatMap((turn, index) => {
            const callId = `history-${index}`;
            return [
              { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: modelToolName(turn.step), input: turn.step.args }] },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: stable(turn.result) }] },
            ];
          }),
        ],
        tools: [{ name, input_schema: schema }],
      }
    : {
        input: [
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
          ...history.flatMap((turn, index) => {
            const callId = `history-${index}`;
            return [
              { type: 'function_call', call_id: callId, name: modelToolName(turn.step), arguments: stable(turn.step.args) },
              { type: 'function_call_output', call_id: callId, output: stable(turn.result) },
            ];
          }),
        ],
        tools: [{ type: 'function', name, parameters: schema }],
      };
  const response = client === 'claude' ? claudeResponse(name, step) : codexResponse(name, step);
  const responseBody = Buffer.from(response);
  provider.enqueue({ body: responseBody, delayMs: MULTITURN_PARAMETERS.modelLatencyMs });
  const result = await fetch(`${target}${client === 'claude' ? '/v1/messages' : '/v1/responses'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(client === 'claude'
        ? { 'x-claude-code-session-id': runtime.context.conversationId }
        : { 'thread-id': runtime.context.conversationId }),
    },
    body: JSON.stringify(request),
  });
  if (!result.ok) throw new Error(`fixture provider returned ${result.status}`);
  const received = Buffer.from(await result.arrayBuffer());
  if (!received.equals(responseBody)) throw new Error('fixture response payload changed in transit');
}

function modelToolName(step: MultiturnStep): string {
  return `mcp__${step.alias}__${step.tool}`;
}

function claudeResponse(name: string, step: MultiturnStep): string {
  return `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${step.tool}`, name, input: {} } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.args) } })}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`;
}

function codexResponse(name: string, step: MultiturnStep): string {
  return `data: ${JSON.stringify({ type: 'response.output_item.added', item: { id: `item-${step.tool}`, type: 'function_call', call_id: `call-${step.tool}`, name, arguments: '' } })}\n\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: `item-${step.tool}`, delta: JSON.stringify(step.args) })}\n\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { id: `item-${step.tool}`, type: 'function_call', call_id: `call-${step.tool}`, name } })}\n\n`;
}

function parseFixtureResult(result: CallToolResult): Record<string, unknown> {
  const block = result.content.find((item) => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('fixture result did not contain text');
  const parsed = JSON.parse(block.text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('fixture result was not an object');
  return parsed as Record<string, unknown>;
}

function validateProvenance(step: MultiturnStep, parsed: Record<string, unknown>, index: number, failures: string[]): void {
  const argument = step.tool === 'list_directory' ? 'path' : 'key';
  if (parsed.alias !== step.alias || parsed.tool !== step.tool || parsed[argument] !== step.args[argument]) {
    failures.push(`result-provenance:${index}`);
  }
}

function lifecycleSources(events: readonly ObserverLifecycleEvent[]): Partial<Record<Source, SourceCounts>> {
  const result: Partial<Record<Source, SourceCounts>> = {};
  for (const source of ['intent', 'transition', 'stream'] as const) {
    const selected = events.filter((event) => event.observerAttribution.source === source);
    if (selected.length === 0) continue;
    const issuedIds = new Set(selected.filter((event) => event.type === 'speculated').flatMap((event) => event.issueId ? [event.issueId] : []));
    const terminalIds = new Set(selected.filter((event) =>
      ['hit', 'joined', 'expired', 'invalidated', 'abandoned', 'spec_error'].includes(event.type))
      .flatMap((event) => event.issueId ? [event.issueId] : []));
    const outstanding = [...issuedIds].filter((issueId) => !terminalIds.has(issueId)).length;
    result[source] = {
      issued: selected.filter((event) => event.type === 'speculated').length,
      hits: selected.filter((event) => event.type === 'hit').length,
      joins: selected.filter((event) => event.type === 'joined').length,
      waste: selected.filter((event) => ['expired', 'invalidated', 'abandoned', 'spec_error'].includes(event.type)).length + outstanding,
    };
  }
  return result;
}

async function waitForRuntime(runtime: RuntimeHandle): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const stats = await runtime.stats();
    if (!stats || stats.cache.inFlight === 0) return;
    await delay(5);
  }
  throw new Error('timed out waiting for speculative calls');
}

async function startProvider(): Promise<ProviderHandle> {
  const plans: ProviderPlan[] = [];
  const digests: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    digests.push(digest(Buffer.concat(chunks)));
    const plan = plans.shift();
    if (!plan) {
      response.writeHead(500).end();
      return;
    }
    await delay(plan.delayMs);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.end(plan.body);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture provider failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    enqueue: (plan) => plans.push(plan),
    requestDigests: () => [...digests],
    close: async () => {
      const closed = new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function reconcilePairs(records: MultiturnRecord[]): void {
  const controls = new Map(records.filter((record) => record.arm === 'A').map((record) => [pairKey(record), record]));
  for (const record of records) {
    const control = controls.get(pairKey(record));
    if (!control) {
      record.failures.push('missing-control');
      continue;
    }
    if (record.resultDigest !== control.resultDigest) record.failures.push('result-digest-mismatch');
    if (record.providerDigest !== control.providerDigest) record.failures.push('provider-digest-mismatch');
  }
}

function aggregateSources(records: readonly MultiturnRecord[]): Record<Source, SourceCounts> {
  return Object.fromEntries((['intent', 'transition', 'stream'] as const).map((source) => [source, {
    issued: sum(records, (record) => record.perSource[source]?.issued ?? 0),
    hits: sum(records, (record) => record.perSource[source]?.hits ?? 0),
    joins: sum(records, (record) => record.perSource[source]?.joins ?? 0),
    waste: sum(records, (record) => record.perSource[source]?.waste ?? 0),
  }])) as Record<Source, SourceCounts>;
}

function fixtureSchema(tool: string): Record<string, unknown> {
  const property = tool === 'list_directory' ? 'path' : 'key';
  return {
    type: 'object',
    properties: { [property]: { type: 'string' } },
    required: [property],
    $schema: 'http://json-schema.org/draft-07/schema#',
  };
}

function pairKey(record: Pick<MultiturnRecord, 'client' | 'workflow' | 'repetition'>): string {
  return `${record.client}\0${record.workflow}\0${record.repetition}`;
}

function relativeImprovement(control: number, candidate: number): number {
  return control === 0 ? 0 : (control - candidate) / control;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function clockNow(): number {
  return performance.timeOrigin + performance.now();
}

function digest(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(stable(value));
  return createHash('sha256').update(bytes).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hashNumber(...values: Array<string | number>): number {
  return createHash('sha256').update(values.join('\0')).digest().readUInt32BE(0);
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function sum<T>(values: readonly T[], project: (value: T) => number): number {
  return values.reduce((total, value) => total + project(value), 0);
}

async function main(): Promise<void> {
  const outputAt = process.argv.indexOf('--output');
  const output = outputAt >= 0 ? process.argv[outputAt + 1] : undefined;
  const artifact = await runObserverMultiturn();
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (output) writeFileSync(resolve(output), json);
  else process.stdout.write(json);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
