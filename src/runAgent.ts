import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import type { AgentAdapter, LaunchPlan, ObserverMode, SessionContext } from './observerTypes.js';
import type { ExecutionWindowEvent, ToolCallMarker } from './observerTypes.js';
import { SessionBridge, type CandidateAuthorizationInput, type CandidateAuthorizationResult, type CompletionCorrelation } from './sessionBridge.js';
import type { ProxySessionEvent } from './proxy.js';
import { claudeAdapter, buildLaunchPlan as buildClaudeLaunchPlan, claudeObserverHookCommand } from './agentAdapters/claude.js';
import { codexAdapter, buildLaunchPlan as buildCodexLaunchPlan, codexProxyOverrideIsVerifiable } from './agentAdapters/codex.js';
import {
  codexInvocation,
  extractCodexConfigInvocation,
  startCodexClient,
  type CodexAccountMode,
  type CodexClient,
  type CodexConfigRead,
} from './codexClient.js';
import { projectCodexPolicy, type CodexPolicyProjection } from './codexPolicy.js';
import { projectClaudeMcpPolicy, verifyClaudeMcpPreauthorization } from './claudePermission.js';
import { selfCommand } from './hostConfig.js';
import { startLlmProxy, type LlmProxy } from './llmProxy.js';
import { win32ShimInvocation } from './manage.js';
import { ObservationBudget } from './observationBudget.js';
import type { ObserverLifecycleEvent } from './types.js';

export interface RunAgentArgs {
  agent: 'claude' | 'codex';
  observe: ObserverMode;
  clientArgs: string[];
  jsonReport: string | null;
}

export interface SessionMeasurements {
  sources: Record<string, { issued: number; used: number; wasted: number; suppressed: number }>;
  transport: { requests: number; failures: number; localOverheadMs?: number };
}

export interface PreparedAgentRun {
  plan: LaunchPlan;
  mode: ObserverMode;
  transport: 'messages' | 'responses';
  clientVersion?: string | null;
  registeredRoutes(): number;
  disabledCapabilities(): string[];
  measurements(): SessionMeasurements;
  close(): Promise<void>;
}

interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

interface WindowRecord {
  context: ExecutionWindowEvent['context'];
  windowId: string;
  openedAt: number;
  closedAt: number | null;
  actorId?: string;
  turnId?: string;
  retainedBytes: number;
}

const CORRELATION_RETENTION_MS = 120_000;
const MAX_CORRELATION_RECORDS = 1_024;
const MAX_CORRELATION_BYTES = 8 * 1024 * 1024;
const WINDOW_CLOSE_GRACE_MS = 250;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class CompletionLedger {
  private readonly markers: Array<ToolCallMarker & { consumed: boolean; retainedBytes: number }> = [];
  private readonly windows = new Map<string, WindowRecord>();
  private readonly losses: number[] = [];
  private retainedBytes = 0;
  private trackingLost = false;

  constructor(private readonly options: { boundaryGraceMs?: number; onTrackingLoss?: () => void } = {}) {}

  recordToolCall(marker: ToolCallMarker): void {
    const duplicate = this.markers.some((item) =>
      item.context.agent === marker.context.agent &&
      item.context.conversationId === marker.context.conversationId &&
      item.callId === marker.callId && item.phase === marker.phase,
    );
    if (!duplicate) {
      const markerCopy = structuredClone(marker);
      const copy = { ...markerCopy, consumed: false, retainedBytes: serializedBytes(markerCopy) };
      this.markers.push(copy);
      this.retainedBytes += copy.retainedBytes;
    }
    this.prune(marker.observedAt);
  }

  recordWindow(event: ExecutionWindowEvent): void {
    const key = `${event.context.agent}\0${event.context.conversationId}\0${event.windowId}`;
    if (event.phase === 'opened') {
      if (!this.windows.has(key)) {
        const base = {
          context: structuredClone(event.context), windowId: event.windowId,
          openedAt: event.observedAt, closedAt: null,
          ...(event.actorId ? { actorId: event.actorId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
        };
        const record: WindowRecord = { ...base, retainedBytes: serializedBytes(base) };
        this.windows.set(key, record);
        this.retainedBytes += record.retainedBytes;
      }
    } else {
      const window = this.windows.get(key);
      if (!window || event.observedAt < window.openedAt) this.markTrackingLoss(event.observedAt);
      else window.closedAt = event.observedAt;
    }
    this.prune(event.observedAt);
  }

  markTrackingLoss(observedAt: number): void {
    this.setTrackingLost();
    if (Number.isFinite(observedAt) && observedAt >= 0) this.losses.push(observedAt);
    this.prune(observedAt);
  }

  async correlate(event: Readonly<ProxySessionEvent>): Promise<CompletionCorrelation | null> {
    this.prune(event.completedAt);
    if (this.trackingLost) return null;
    if (this.losses.some((loss) => loss >= event.startedAt - CORRELATION_RETENTION_MS && loss <= event.completedAt)) return null;
    const key = stable(event.args);
    const exact = this.markers.filter((marker) => !marker.consumed && marker.routeId === event.routeId &&
      marker.generation === event.generation && stable(marker.args) === key &&
      marker.observedAt <= event.completedAt && marker.observedAt >= event.startedAt - 1_000);
    const logical = new Map<string, typeof exact>();
    for (const marker of exact) {
      const id = `${marker.context.agent}\0${marker.context.conversationId}\0${marker.context.cwd}\0${marker.actorId ?? ''}\0${marker.turnId ?? ''}\0${marker.callId}`;
      const group = logical.get(id) ?? [];
      group.push(marker);
      logical.set(id, group);
    }
    if (logical.size === 1) {
      const group = logical.values().next().value!;
      for (const marker of group) marker.consumed = true;
      return { conversationId: group[0]!.context.conversationId, cwd: group[0]!.context.cwd };
    }
    if (logical.size > 1) return null;
    if ([...this.windows.values()].some((window) => window.openedAt <= event.startedAt && window.closedAt === null)) {
      await this.waitForBoundary();
    }
    this.prune(event.completedAt + WINDOW_CLOSE_GRACE_MS);
    if ([...this.windows.values()].some((window) => window.openedAt <= event.startedAt && window.closedAt === null)) return null;
    const containing = [...this.windows.values()].filter((window) =>
      window.closedAt !== null && window.openedAt <= event.startedAt &&
      event.completedAt <= window.closedAt! && !this.losses.some((loss) => loss >= window.openedAt && loss <= window.closedAt!),
    );
    if (containing.length !== 1) return null;
    return { conversationId: containing[0]!.context.conversationId, cwd: containing[0]!.context.cwd };
  }

  private waitForBoundary(): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, this.options.boundaryGraceMs ?? WINDOW_CLOSE_GRACE_MS));
  }

  private prune(now: number): void {
    const cutoff = now - CORRELATION_RETENTION_MS;
    let coverageLost = false;
    while (this.markers.length > 0 && (this.markers[0]!.observedAt < cutoff ||
      this.markers.length > MAX_CORRELATION_RECORDS || this.retainedBytes > MAX_CORRELATION_BYTES)) {
      const marker = this.markers.shift()!;
      if (marker.observedAt >= cutoff && !marker.consumed) coverageLost = true;
      this.retainedBytes -= marker.retainedBytes;
    }
    for (const [key, window] of this.windows) {
      if ((window.closedAt ?? window.openedAt) < cutoff || this.windows.size > MAX_CORRELATION_RECORDS ||
        this.retainedBytes > MAX_CORRELATION_BYTES) {
        this.windows.delete(key);
        if (window.closedAt === null || (window.closedAt ?? window.openedAt) >= cutoff) coverageLost = true;
        this.retainedBytes -= window.retainedBytes;
      }
    }
    if (coverageLost) {
      this.setTrackingLost();
      this.losses.push(now);
    }
    while (this.losses.length > 0 && (this.losses[0]! < cutoff || this.losses.length > MAX_CORRELATION_RECORDS)) this.losses.shift();
  }

  private setTrackingLost(): void {
    if (this.trackingLost) return;
    this.trackingLost = true;
    try { this.options.onTrackingLoss?.(); } catch {}
  }
}

function serializedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return MAX_CORRELATION_BYTES; }
}

export interface RunAgentDependencies {
  prepare?: (args: RunAgentArgs) => Promise<PreparedAgentRun>;
  spawn?: typeof spawn;
  signalSource?: SignalSource;
  log?: (line: string) => void;
}

export function nativeClientInvocation(
  agent: RunAgentArgs['agent'],
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; windowsVerbatimArguments?: true } {
  if (agent === 'codex') return codexInvocation(command, args, platform);
  if (/\.[cm]?js$/i.test(command)) return { file: process.execPath, args: [command, ...args] };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return { ...win32ShimInvocation(command, args), windowsVerbatimArguments: true };
  }
  return { file: command, args };
}

export function parseRunArgs(argv: string[]): RunAgentArgs | { error: string } {
  const agent = argv[0];
  if (agent !== 'claude' && agent !== 'codex') return { error: 'expected claude or codex' };
  let observe: ObserverMode = 'proxy';
  let jsonReport: string | null = null;
  let index = 1;
  for (; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      index++;
      break;
    }
    if (arg === '--observe') {
      const value = argv[++index];
      if (value !== 'off' && value !== 'hooks' && value !== 'proxy') {
        return { error: '--observe must be off, hooks, or proxy' };
      }
      observe = value;
      continue;
    }
    if (arg === '--json-report') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) return { error: '--json-report requires a path' };
      jsonReport = value;
      continue;
    }
    return { error: `unknown run argument '${arg}'` };
  }
  return { agent, observe, clientArgs: argv.slice(index), jsonReport };
}

export async function runAgent(args: RunAgentArgs, dependencies: RunAgentDependencies = {}): Promise<number> {
  const prepare = dependencies.prepare ?? prepareAgentRun;
  const prepared = await prepare(args);
  const launch = dependencies.spawn ?? spawn;
  const signals = dependencies.signalSource ?? process;
  const log = dependencies.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let child: ChildProcess | null = null;
  let exitCode = 127;
  let exitSignal: NodeJS.Signals | null = null;
  let measurements: SessionMeasurements = { sources: {}, transport: { requests: 0, failures: 0 } };
  let registeredRoutes = 0;
  let disabledCapabilities: string[] = [];
  const forwardInt = () => child?.kill('SIGINT');
  const forwardTerm = () => child?.kill('SIGTERM');
  signals.on('SIGINT', forwardInt);
  signals.on('SIGTERM', forwardTerm);
  try {
    log(`[speculate] launching ${args.agent} (observer: ${prepared.mode}, transport: ${prepared.transport})`);
    if (args.observe === 'proxy' && prepared.mode === 'hooks') {
      const reason = prepared.disabledCapabilities().find((value) => value.startsWith('model-observation:'));
      log(reason
        ? `[speculate] model observation unavailable; using hooks (${reason})`
        : '[speculate] model observation unavailable; using hooks');
    }
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      try {
        const invocation = nativeClientInvocation(args.agent, prepared.plan.command, prepared.plan.args);
        child = launch(invocation.file, invocation.args, {
          cwd: process.cwd(),
          env: prepared.plan.env,
          stdio: 'inherit',
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch {
        resolveExit({ code: 127, signal: null });
        return;
      }
      child.once('error', () => resolveExit({ code: 127, signal: null }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    exitSignal = outcome.signal;
    exitCode = outcome.signal ? 128 + (osConstants.signals[outcome.signal] ?? 1) : (outcome.code ?? 0);
  } finally {
    signals.off('SIGINT', forwardInt);
    signals.off('SIGTERM', forwardTerm);
    measurements = prepared.measurements();
    registeredRoutes = prepared.registeredRoutes();
    disabledCapabilities = prepared.disabledCapabilities();
    await prepared.close();
  }
  if (args.jsonReport) {
    const report = {
      schemaVersion: 1,
      client: args.agent,
      clientVersion: prepared.clientVersion ?? null,
      requestedMode: args.observe,
      activeMode: prepared.mode,
      transport: prepared.transport,
      registeredRoutes,
      measurements,
      disabledCapabilities,
      exit: { code: exitCode, signal: exitSignal },
    };
    writeReport(args.jsonReport, report);
  }
  const used = Object.values(measurements.sources).reduce((sum, source) => sum + source.used, 0);
  const wasted = Object.values(measurements.sources).reduce((sum, source) => sum + source.wasted, 0);
  log(`[speculate] observer summary: ${used} used, ${wasted} wasted, ${registeredRoutes} route(s)`);
  return exitCode;
}

function writeReport(path: string, report: unknown): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
}

export async function prepareAgentRun(_args: RunAgentArgs): Promise<PreparedAgentRun> {
  return prepareNativeAgentRun(_args);
}

export class SessionMeasurementCollector {
  private readonly sourceCounters = new Map<string, { issued: number; used: number; wasted: number; suppressed: number }>();
  private readonly activeIssues = new Map<string, string>();

  record(event: ObserverLifecycleEvent): void {
    const source = event.observerAttribution.source;
    const counters = this.sourceCounters.get(source) ?? { issued: 0, used: 0, wasted: 0, suppressed: 0 };
    this.sourceCounters.set(source, counters);
    if (event.type === 'suppressed') {
      counters.suppressed++;
      return;
    }
    const issueKey = event.issueId
      ? `${event.observerAttribution.client}\0${event.observerAttribution.routeId}\0${event.observerAttribution.generation}\0${event.issueId}`
      : null;
    if (event.type === 'speculated' && issueKey) {
      if (!this.activeIssues.has(issueKey)) {
        counters.issued++;
        this.activeIssues.set(issueKey, source);
        while (this.activeIssues.size > 4_096) this.activeIssues.delete(this.activeIssues.keys().next().value!);
      }
      return;
    }
    if (!issueKey) return;
    const issueSource = this.activeIssues.get(issueKey);
    if (!issueSource) return;
    const issueCounters = this.sourceCounters.get(issueSource)!;
    if (event.type === 'hit' || event.type === 'joined') issueCounters.used++;
    else if (event.type === 'expired' || event.type === 'invalidated' || event.type === 'abandoned' || event.type === 'spec_error') {
      issueCounters.wasted++;
    } else return;
    this.activeIssues.delete(issueKey);
  }

  snapshot(transport: SessionMeasurements['transport']): SessionMeasurements {
    return { sources: Object.fromEntries(this.sourceCounters), transport: { ...transport } };
  }
}

class CodexNativeAuthority {
  upstreamBaseUrl: string | null = null;
  private constructor(
    private readonly client: CodexClient,
    private readonly effectiveCwd: string,
    private readonly globalArgs: readonly string[],
    private readonly accountMode: CodexAccountMode,
  ) {}

  static async start(
    launchCwd: string,
    effectiveCwd: string,
    env: NodeJS.ProcessEnv,
    bin: string | undefined,
    globalArgs: readonly string[],
  ): Promise<CodexNativeAuthority> {
    const client = await startCodexClient({ bin, cwd: launchCwd, env, globalArgs });
    let accountMode: CodexAccountMode = 'unverified';
    try { accountMode = await client.readAccountMode(); } catch {}
    return new CodexNativeAuthority(client, effectiveCwd, globalArgs, accountMode);
  }

  async read(): Promise<CodexConfigRead> {
    const native = await this.client.readConfig(this.effectiveCwd);
    this.upstreamBaseUrl = codexUpstream(native.config, this.accountMode);
    return native;
  }

  close(): Promise<void> { return this.client.close(); }

  async startupPolicy(alias: string): Promise<CodexPolicyProjection | null> {
    try { return projectCodexPolicy((await this.read()).config, alias); } catch { return null; }
  }

  async authorize(input: Readonly<CandidateAuthorizationInput>): Promise<CandidateAuthorizationResult> {
    try {
      const native = await this.read();
      const projection = projectCodexPolicy(native.config, input.route.hostServerAlias);
      const allowed = projection.enabled && !projection.denyTools.includes(input.route.exposedTool) &&
        (projection.allowTools === null || projection.allowTools.includes(input.route.exposedTool));
      if (!allowed) return { decision: 'denied', permissionContext: null };
      return {
        decision: 'allowed',
        permissionContext: createHash('sha256').update(stable({
          cwd: this.effectiveCwd,
          globalArgs: this.globalArgs,
          config: native.config,
          origins: native.origins,
          alias: input.route.hostServerAlias,
          tool: input.route.exposedTool,
        })).digest('base64url'),
      };
    } catch {
      return { decision: 'unverifiable', permissionContext: null };
    }
  }
}

function codexUpstream(config: Record<string, unknown>, accountMode: CodexAccountMode): string | null {
  const provider = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
  if (provider !== 'openai') {
    const providers = config.model_providers;
    const selected = providers && typeof providers === 'object' && !Array.isArray(providers)
      ? (providers as Record<string, unknown>)[provider]
      : null;
    return selected && typeof selected === 'object' && !Array.isArray(selected) &&
      typeof (selected as Record<string, unknown>).base_url === 'string'
      ? (selected as Record<string, unknown>).base_url as string
      : null;
  }
  if (typeof config.openai_base_url === 'string') return config.openai_base_url;
  if (accountMode === 'chatgpt') return 'https://chatgpt.com/backend-api/codex';
  if (accountMode === 'apiKey') return 'https://api.openai.com/v1';
  return null;
}

async function prepareNativeAgentRun(args: RunAgentArgs): Promise<PreparedAgentRun> {
  const cwd = process.cwd();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPECULATE_SESSION_') || key.startsWith('SPECULATE_OBSERVER_')) delete env[key];
  }
  const launchId = randomUUID();
  const initialContext: SessionContext = { launchId, conversationId: `launch:${launchId}`, agent: args.agent, cwd };
  const disabled = new Set<string>();
  const ledger = new CompletionLedger({ onTrackingLoss: () => disabled.add('completion-correlation:tracking-lost') });
  const measurements = new SessionMeasurementCollector();
  const codexInvocation = args.agent === 'codex' ? extractCodexConfigInvocation(args.clientArgs) : null;
  const nativeCwd = codexInvocation?.cwd ? resolve(cwd, codexInvocation.cwd) : cwd;
  let authority: CodexNativeAuthority | null = null;
  let nativeConfig: CodexConfigRead | null = null;
  if (args.agent === 'codex') {
    if (codexInvocation?.verifiable) {
      authority = await CodexNativeAuthority.start(cwd, nativeCwd, env, env.SPECULATE_CODEX_BIN, codexInvocation.globalArgs);
      try { nativeConfig = await authority.read(); }
      catch (error) { await authority.close(); throw error; }
    } else {
      disabled.add('permission-authorization:unsupported-config-arguments');
      nativeConfig = { config: {}, layers: [], origins: {} };
    }
  }
  let adapter: AgentAdapter | null = null;
  let bridge: SessionBridge;
  try {
    bridge = await SessionBridge.start(initialContext, {
    correlateCompletion: (event) => ledger.correlate(event),
    authorizeCandidate: async (input) => {
      if (args.agent === 'claude') {
        const result = verifyClaudeMcpPreauthorization({
          cwd: input.context.cwd,
          home: env.HOME || homedir(),
          env,
          clientArgs: args.clientArgs,
          observerCommand: claudeObserverHookCommand(),
        }, { alias: input.route.hostServerAlias, tool: input.route.exposedTool });
        if (result.decision !== 'allowed' && result.reason) disabled.add(`permission-authorization:${result.reason}`);
        return result;
      }
      if (!authority) return { decision: 'unverifiable', permissionContext: null };
      return authority.authorize(input);
    },
    startupPolicy: args.agent === 'codex' && authority
      ? async (_client, alias) => authority!.startupPolicy(alias)
      : args.agent === 'claude'
        ? async (_client, alias) => projectClaudeMcpPolicy({
            cwd,
            home: env.HOME || homedir(),
            env,
            clientArgs: args.clientArgs,
            observerCommand: claudeObserverHookCommand(),
          }, alias)
        : undefined,
    onHook: (client, payload, observedAt) => {
      if (!adapter || client !== args.agent) return;
      disabled.delete('hook-observation:trust-unverified');
      for (const observation of adapter.normalizeHook(payload, observedAt)) bridge.publishObservation(observation);
    },
    onLifecycle: (event) => measurements.record(event),
    });
  } catch (error) {
    await authority?.close();
    throw error;
  }
  const contextForConversation = (conversationId: string, observedCwd?: string): SessionContext | null => {
    const existing = bridge.conversationContext(conversationId);
    const next = { launchId, conversationId, agent: args.agent, cwd: observedCwd ? resolve(observedCwd) : existing?.cwd ?? nativeCwd };
    return bridge.registerConversation(next) ? bridge.conversationContext(conversationId) : null;
  };
  const onTrackingLoss = (observedAt: number) => {
    ledger.markTrackingLoss(observedAt);
    bridge.publishObservation({
      kind: 'invalidate', context: initialContext, eventId: `tracking-loss:${randomUUID()}`,
      observedAt, routeIds: [], reason: 'observer-tracking-gap',
    });
  };
  const analysisBudget = new ObservationBudget(undefined, onTrackingLoss);
  const environment = {
    contextForConversation,
    routes: () => bridge.listRoutes(),
    now: Date.now,
    onToolCallMarker: (marker: ToolCallMarker) => ledger.recordToolCall(marker),
    onExecutionWindow: (event: ExecutionWindowEvent) => ledger.recordWindow(event),
    onTrackingLoss,
    analysisBudget,
  };
  adapter = args.agent === 'claude' ? claudeAdapter(environment) : codexAdapter(environment);
  let relay: LlmProxy | null = null;
  let plan: LaunchPlan | null = null;
  let mode = args.observe;
  if (mode === 'off') {
    disabled.add('hook-observation:off');
    disabled.add('model-observation:off');
  } else if (mode === 'hooks') {
    disabled.add('model-observation:not-requested');
  } else if (args.agent === 'claude' && ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .some((key) => env[key] === '1' || env[key] === 'true')) {
    mode = 'hooks';
    disabled.add('model-observation:unsupported-provider');
  } else if (args.agent === 'codex' && mode === 'proxy' && !authority?.upstreamBaseUrl) {
    mode = 'hooks';
    disabled.add('model-observation:unverified-account-route');
  } else if (args.agent === 'codex' && mode === 'proxy' &&
    !codexProxyOverrideIsVerifiable(nativeConfig!.config, codexInvocation?.globalArgs ?? [], args.clientArgs)) {
    mode = 'hooks';
    disabled.add('model-observation:config-override-precedence');
  }
  if (args.agent === 'codex' && mode !== 'off') disabled.add('hook-observation:trust-unverified');
  if (args.agent === 'codex' && mode === 'proxy') disabled.add('stream-call-observation:opaque-native-exec');
  const buildPlan = (relayBaseUrl: string | null): Promise<LaunchPlan> => args.agent === 'claude'
    ? buildClaudeLaunchPlan({ cwd, home: env.HOME || homedir(), env, clientArgs: args.clientArgs, observe: mode,
      relayBaseUrl, session: bridge.coordinates, hook: bridge.hookCoordinates, self: selfCommand() })
    : buildCodexLaunchPlan({ cwd: nativeCwd, env, clientArgs: args.clientArgs, observe: mode,
      relayBaseUrl, session: bridge.coordinates, hook: bridge.hookCoordinates, self: selfCommand(), nativeConfig: nativeConfig!,
      nativeUpstreamBaseUrl: authority?.upstreamBaseUrl, nativeGlobalArgs: codexInvocation?.globalArgs });
  try {
    if (mode === 'proxy') {
      const probePlan = await buildPlan(null);
      try {
        relay = await startLlmProxy({
          upstreamBaseUrl: probePlan.upstreamBaseUrl,
          adapter,
          analysisBudget,
          onObservation: (observation) => { bridge.publishObservation(observation); },
          onObservationLoss: (observedAt) => environment.onTrackingLoss(observedAt),
        });
      } catch {
        mode = 'hooks';
        disabled.add('model-observation:relay-preflight-failed');
      } finally {
        await probePlan.cleanup();
      }
    }
    plan = await buildPlan(relay?.baseUrl ?? null);
    for (const reason of plan.disabledCapabilities ?? []) disabled.add(reason);
  } catch (error) {
    await relay?.close();
    try { adapter?.close?.(); } catch {}
    await bridge.close();
    await authority?.close();
    throw error;
  }
  const finalPlan = plan;
  const version = nativeVersion(finalPlan.command);
  let closed = false;
  return {
    plan: finalPlan,
    mode,
    transport: finalPlan.transport,
    clientVersion: version,
    registeredRoutes: () => bridge.listRoutes().length,
    disabledCapabilities: () => [...disabled].sort(),
    measurements: () => {
      const state = relay?.debugObservationState();
      return measurements.snapshot({ requests: state?.totalRequests ?? 0, failures: state?.failures ?? 0 });
    },
    async close() {
      if (closed) return;
      closed = true;
      await finalPlan.cleanup();
      await relay?.close();
      try { adapter?.close?.(); } catch {}
      await bridge.close();
      await authority?.close();
    },
  };
}

function nativeVersion(command: string): string | null {
  try {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024 });
    const match = `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/\b\d+\.\d+(?:\.\d+)?\b/);
    return match?.[0] ?? null;
  } catch { return null; }
}
