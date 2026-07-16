/**
 * Speculate proxy core: router + wiring (DESIGN.md §3).
 *
 * MVP transport shape (§10): stdio on the client side; stdio or
 * streamable-HTTP upstreams. Resources/prompts pass through in
 * single-upstream deployments; multi-upstream aggregation is tools-only.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { SpeculationCache } from './cache.js';
import { SafetyPolicy } from './policy.js';
import { BudgetManager } from './budget.js';
import { Metrics } from './metrics.js';
import { Predictor } from './predictor.js';
import { TransitionLearner } from './learner.js';
import { SpeculationExecutor } from './executor.js';
import { builtinProfiles, detectProfile, profileCanonicalizer } from './profiles/index.js';
import { compileConfigRules } from './configRules.js';
import { morphologicalPairs } from './priming.js';
import { StateStore } from './persistence.js';
import { VERSION } from './version.js';
import { canonicalKey } from './keys.js';
import { Upstream, friendlySpawnError } from './upstream.js';
import type { Rule, ServerProfile, SpeculateConfig } from './types.js';
import type { UsageRecorder } from './usage.js';

const STATS_TOOL = 'speculate__stats';
/** Names the proxy itself serves; upstream tools may never claim them. */
const BUILTIN_TOOLS = new Set([STATS_TOOL]);
/** Generous ceiling for forwarded real calls; progress resets the clock. */
const REAL_CALL_TIMEOUT_MS = 600_000;
/** How many of a session's leading reads are recorded as openers (§13.15). */
const OPENER_RECORD_LIMIT = 3;

interface Route {
  server: string;
  tool: Tool;
}

export class SpeculateProxy {
  readonly upstreams = new Map<string, Upstream>();
  readonly metrics: Metrics;
  readonly cache: SpeculationCache;
  readonly policy: SafetyPolicy;
  readonly budget: BudgetManager;
  readonly predictor: Predictor;
  readonly executor: SpeculationExecutor;

  private readonly server: Server;
  private readonly config: SpeculateConfig;
  private readonly profiles: Record<string, ServerProfile> = {};
  private readonly now: () => number;
  private routes = new Map<string, Route>();
  private sweeper: NodeJS.Timeout | null = null;
  private initialized = false;
  private closing = false;
  private readonly learner: TransitionLearner;
  private readonly noProfile = new Set<string>();
  private readonly store: StateStore | null;
  private readonly usageRecorder: UsageRecorder | null;
  private saveTimer: NodeJS.Timeout | null = null;
  private savedStamp = '';
  /** Remaining opener-recording slots per server this session (§13.15). */
  private readonly openerSlots = new Map<string, number>();

  constructor(
    config: SpeculateConfig,
    opts: {
      now?: () => number;
      statePath?: string | null;
      usageRecorder?: UsageRecorder | null;
    } = {},
  ) {
    this.config = config;
    this.now = opts.now ?? Date.now;
    this.usageRecorder = opts.usageRecorder ?? null;
    const now = this.now;

    // Per-server profile resolution (config profile name -> builtin profile).
    // 'none' explicitly opts a server out of profiles and fingerprinting.
    for (const [name, sc] of Object.entries(config.servers)) {
      if (sc.profile === 'none') {
        this.noProfile.add(name);
      } else if (sc.profile) {
        const profile = builtinProfiles[sc.profile];
        if (!profile) throw new Error(`unknown profile '${sc.profile}' for server '${name}'`);
        this.profiles[name] = profile;
      }
    }

    this.metrics = new Metrics({
      mode: config.mode,
      log: config.log,
      now,
      onUsage: (counters) => this.usageRecorder?.update(counters),
    });
    this.cache = new SpeculationCache({
      now,
      onEvent: (ev) =>
        this.metrics.record({
          type: ev.type,
          server: ev.meta.server,
          tool: ev.meta.tool,
          ruleId: ev.meta.ruleId,
          reason: ev.error,
        }),
    });
    this.policy = new SafetyPolicy(
      config.mode,
      Object.fromEntries(
        Object.entries(config.servers).map(([name, sc]) => [
          name,
          {
            allowlist: [
              ...(this.profiles[name]?.readOnlyAllowlist ?? []),
              ...(sc.allowTools ?? []),
            ],
            denylist: sc.denyTools ?? [],
          },
        ]),
      ),
    );
    this.budget = new BudgetManager(
      Object.fromEntries(
        Object.entries(config.servers).map(([name, sc]) => [
          name,
          {
            transport: (sc.url ? 'http' : 'stdio') as 'http' | 'stdio',
            maxPerMinute: sc.speculation?.maxPerMinute,
            maxConcurrent: sc.speculation?.maxConcurrent,
          },
        ]),
      ),
      { now },
    );
    // Declarative config rules: any server gets speculation straight from
    // the config file, no vetted profile required.
    const extraRules: Record<string, Rule[]> = {};
    for (const [name, sc] of Object.entries(config.servers)) {
      if (sc.rules?.length) extraRules[name] = compileConfigRules(name, sc.rules);
    }

    // §13.6 persistence: learned transitions + rule feedback survive
    // restarts. Tool results never touch disk (§6.4). Every load failure is
    // a cold start, never an error.
    this.learner = new TransitionLearner({ now });
    this.store = opts.statePath ? new StateStore(opts.statePath, now) : null;
    if (this.store) {
      const state = this.store.load();
      if (state) {
        this.learner.importState(state.learner);
        this.metrics.importRuleFeedback(state.ruleFeedback);
      }
      this.savedStamp = this.dirtyStamp();
    }

    this.predictor = new Predictor({
      profiles: this.profiles,
      maxPerTrigger: config.maxPredictionsPerTrigger,
      metrics: this.metrics,
      extraRules,
      // §5.3 Tier 2 (server-agnostic): learns tool-call transitions from the
      // session itself, so unprofiled servers gain speculation over time.
      learner: this.learner,
    });
    this.executor = new SpeculationExecutor({
      upstreams: this.upstreams,
      cache: this.cache,
      policy: this.policy,
      budget: this.budget,
      metrics: this.metrics,
      profiles: this.profiles,
      config,
      now,
    });

    for (const [name, sc] of Object.entries(config.servers)) {
      this.upstreams.set(name, new Upstream(name, sc));
    }

    // Constructor declares tools; resources/prompts are registered in start()
    // once the sole upstream's actual capabilities are known.
    this.server = new Server(
      { name: 'speculate', version: VERSION },
      { capabilities: { tools: { listChanged: true } } },
    );
    this.registerHandlers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.connectUpstreams();

    // §13.15 session-start priming: the biggest idle window is the one
    // before the first request — fire persisted opening reads now, through
    // the normal policy/budget/dedupe pipeline like any other prediction.
    if (this.config.mode !== 'off') {
      for (const [name, up] of this.upstreams) {
        if (!up.connected) continue;
        try {
          const openers = this.predictor.sessionStart(name);
          if (openers.length > 0) this.executor.submit(openers);
        } catch (err) {
          process.stderr.write(
            `[speculate] session-start priming error: ${(err as Error).message}\n`,
          );
        }
      }
    }

    // §10: resources/prompts pass through only in single-upstream mode, and
    // only when the upstream actually advertises them. Capability and handler
    // registration happen together, post-connect, because the SDK requires
    // the capability to exist before a handler for it may be registered.
    if (this.isSingleUpstream()) {
      const caps = this.soleUpstream()?.capabilities();
      if (caps?.resources) {
        this.server.registerCapabilities({ resources: {} });
        this.server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
          this.passthrough((up) => up.listResources(req.params), 'resources/list'),
        );
        this.server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
          this.passthrough((up) => up.readResource(req.params), 'resources/read'),
        );
        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
          this.passthrough(
            (up) => up.listResourceTemplates(req.params),
            'resources/templates/list',
          ),
        );
      }
      if (caps?.prompts) {
        this.server.registerCapabilities({ prompts: {} });
        this.server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
          this.passthrough((up) => up.listPrompts(req.params), 'prompts/list'),
        );
        this.server.setRequestHandler(GetPromptRequestSchema, async (req) =>
          this.passthrough(
            (up) =>
              up.getPrompt(req.params as { name: string; arguments?: Record<string, string> }),
            'prompts/get',
          ),
        );
      }
    }

    // Sweeps can expire entries (waste events → feedback changes), so they
    // also nudge the dirty-gated save.
    this.sweeper = setInterval(() => {
      this.cache.sweep();
      this.scheduleSave();
    }, 5_000);
    this.sweeper.unref();
    this.server.oninitialized = () => {
      this.initialized = true;
    };
    // A host that dies or just closes the pipes (no signal) must not leave
    // an orphaned proxy + upstream process tree behind — and the final
    // state flush must still run. The SDK's stdio transport fires onclose
    // only from its own close(), NOT on stdin EOF (verified against SDK
    // 1.29), so watch stdin directly; keep onclose for protocol-level
    // closes.
    const exitOnHostGone = (): void => {
      if (this.closing) return;
      process.stderr.write('[speculate] host closed the connection — shutting down\n');
      // Transports/upstreams may hold the event loop, so a hard exit is
      // needed — but only after stdio write callbacks confirm every
      // buffered byte reached the OS (exact, unlike a flush timeout).
      void this.close().finally(() => {
        let pending = 2;
        const done = (): void => {
          if (--pending === 0) process.exit(0);
        };
        process.stdout.write('', done);
        process.stderr.write('', done);
      });
    };
    this.server.onclose = exitOnHostGone;
    process.stdin.once('end', exitOnHostGone);
    process.stdin.once('close', exitOnHostGone);
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /** Connect all upstreams; a failed upstream contributes no tools (§3.4). */
  private async connectUpstreams(): Promise<void> {
    await Promise.all(
      [...this.upstreams.values()].map(async (up) => {
        try {
          await up.connect();
          this.policy.updateTools(up.name, up.tools);
          this.fingerprintProfile(up);
          this.primeLearner(up);
          up.setToolsChangedHandler(() => this.handleUpstreamToolsChanged(up));
          up.setDisconnectHandler(() => this.handleUpstreamDisconnect(up));
        } catch (err) {
          process.stderr.write(
            `[speculate] upstream '${up.name}' failed to connect: ${friendlySpawnError(err, up)}\n`,
          );
        }
      }),
    );
    this.rebuildRoutes();
  }

  /** True when at least one upstream is serving. */
  anyUpstreamConnected(): boolean {
    return [...this.upstreams.values()].some((u) => u.connected);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveState(); // best-effort final flush
    try {
      await Promise.all([...this.upstreams.values()].map((u) => u.close()));
      await this.server.close();
    } finally {
      this.usageRecorder?.close();
    }
  }

  /** Learner + feedback state fingerprint for the dirty gate (§13.6). */
  private dirtyStamp(): string {
    return `${this.learner.revision}:${this.metrics.feedbackRevision}`;
  }

  /** Debounced dirty-flag save: fires ~1s after the FIRST unsaved change. */
  private scheduleSave(): void {
    if (!this.store || this.saveTimer || this.dirtyStamp() === this.savedStamp) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveState();
    }, 1_000);
    this.saveTimer.unref();
  }

  private saveState(): void {
    if (!this.store) return;
    const stamp = this.dirtyStamp();
    if (stamp === this.savedStamp) return;
    if (
      this.store.save({
        learner: this.learner.exportState(),
        ruleFeedback: this.metrics.exportRuleFeedback(),
      })
    ) {
      this.savedStamp = stamp;
    }
  }

  // -------------------------------------------------------------------------
  // Routing / naming (§3.4)
  // -------------------------------------------------------------------------

  private rebuildRoutes(): void {
    const routes = new Map<string, Route>();
    // Config order is claim order: first server keeps the bare name. Builtin
    // proxy tool names are reserved — upstream tools that collide with them
    // are prefixed like any other collision, never shadowed silently.
    for (const name of Object.keys(this.config.servers)) {
      const up = this.upstreams.get(name);
      if (!up?.connected) continue;
      for (const tool of up.tools) {
        let exposed = tool.name;
        let renamable = true;
        while (routes.has(exposed) || BUILTIN_TOOLS.has(exposed)) {
          if (exposed.length > 512) {
            renamable = false; // pathological name; never overwrite a route
            break;
          }
          exposed = `${name}__${exposed}`;
        }
        if (renamable) routes.set(exposed, { server: name, tool });
      }
    }
    this.routes = routes;
  }

  private exposedTools(): Tool[] {
    const out: Tool[] = [];
    for (const [exposed, route] of this.routes) {
      out.push(exposed === route.tool.name ? route.tool : { ...route.tool, name: exposed });
    }
    out.push({
      name: STATS_TOOL,
      description:
        'Speculate proxy statistics: hit rate, wasted speculative calls, estimated time saved, suppression reasons, cache occupancy, per-rule effectiveness.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['strict', 'annotated', 'off'] },
          uptimeMs: { type: 'number' },
          realCalls: { type: 'number', description: 'tools/calls forwarded upstream' },
          speculativeCalls: { type: 'number' },
          hits: { type: 'number' },
          joins: { type: 'number', description: 'real calls that joined an in-flight prefetch' },
          misses: { type: 'number' },
          expired: { type: 'number' },
          invalidated: { type: 'number' },
          wasted: { type: 'number' },
          parserMisses: { type: 'number' },
          stdioDelays: { type: 'number' },
          suppressed: { type: 'object', additionalProperties: { type: 'number' } },
          estimatedSavedMs: { type: 'number' },
          wastePerHit: { type: ['number', 'null'] },
          perServer: { type: 'object' },
          perRule: { type: 'array' },
          cache: {
            type: 'object',
            properties: { ready: { type: 'number' }, inFlight: { type: 'number' } },
          },
          persistence: { type: 'object' },
        },
        required: ['mode', 'hits', 'joins', 'misses', 'estimatedSavedMs'],
      },
      annotations: { readOnlyHint: true },
    });
    return out;
  }

  private handleUpstreamToolsChanged(up: Upstream): void {
    // §3.4: flush that server's entries and re-run eligibility on new tools.
    this.policy.updateTools(up.name, up.tools);
    this.cache.invalidateServer(up.name);
    this.fingerprintProfile(up);
    this.primeLearner(up);
    this.rebuildRoutes();
    this.notifyToolListChanged();
  }

  /**
   * §13.11 dynamic profile detection: when no profile is configured, match
   * the LIVE tool list against builtin profiles' allowlists — a server is
   * recognized by what it serves, not by how it was launched (dockerized
   * or renamed github-mcp-server still fingerprints). Applying a profile
   * only ever adds vetted read-only knowledge: allowlist entries, rules,
   * TTLs, canonicalizers, primes.
   */
  private fingerprintProfile(up: Upstream): void {
    if (this.profiles[up.name] || this.noProfile.has(up.name)) return;
    const match = detectProfile(up.tools.map((t) => t.name));
    if (!match) return;
    if (this.config.mode === 'strict') {
      // Strict means EXPLICIT operator consent: recognition is only a hint,
      // never an allowlist. (Auto-applying here would let a server earn
      // strict-mode speculation by naming its tools like a known profile.)
      process.stderr.write(
        `[speculate] ${up.name}: looks like '${match.profile.name}' (${Math.round(match.score * 100)}% tool match) — add "profile": "${match.profile.name}" to enable its rules in strict mode\n`,
      );
      this.noProfile.add(up.name); // don't repeat the hint on tools_changed
      return;
    }
    // Annotated/off: apply rules, TTLs, canonicalizers, and primes. NOT the
    // allowlist — eligibility stays annotation-based, and a name-colliding
    // unannotated write must keep triggering §6.2 mutation invalidation.
    this.profiles[up.name] = match.profile; // shared record: executor/router see it
    this.predictor.setProfile(up.name, match.profile);
    process.stderr.write(
      `[speculate] ${up.name}: recognized as '${match.profile.name}' (${Math.round(match.score * 100)}% tool match) — profile applied\n`,
    );
  }

  /**
   * §13.9 pre-loaded priors: profile-curated pairs plus lister→getter
   * tool-name morphology, primed only toward speculation-ELIGIBLE targets
   * so a prior can never point at a write.
   */
  private primeLearner(up: Upstream): void {
    const names = up.tools.map((t) => t.name);
    const present = new Set(names);
    const eligibleTarget = (tool: string): boolean =>
      this.policy.eligibility(up.name, tool).eligible;
    for (const [prev, next] of this.profiles[up.name]?.primes ?? []) {
      if (present.has(prev) && present.has(next) && eligibleTarget(next)) {
        this.learner.prime(up.name, prev, next);
      }
    }
    for (const [prev, next] of morphologicalPairs(names)) {
      if (eligibleTarget(next)) this.learner.prime(up.name, prev, next);
    }
  }

  private handleUpstreamDisconnect(up: Upstream): void {
    // §6.4 restart flush: entries fetched over the dead connection are gone;
    // a restarted process may carry a different identity/config.
    process.stderr.write(`[speculate] upstream '${up.name}' disconnected\n`);
    this.cache.invalidateServer(up.name);
    this.policy.updateTools(up.name, []);
    this.rebuildRoutes();
    this.notifyToolListChanged();
  }

  private notifyToolListChanged(): void {
    if (!this.initialized) return;
    // Fire-and-forget: a mid-teardown client transport must not turn a
    // routine notification into an unhandled rejection.
    void Promise.resolve()
      .then(() => this.server.sendToolListChanged())
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Request handlers
  // -------------------------------------------------------------------------

  private isSingleUpstream(): boolean {
    return Object.keys(this.config.servers).length === 1;
  }

  private soleUpstream(): Upstream | undefined {
    return this.upstreams.values().next().value;
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.exposedTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      if (name === STATS_TOOL) {
        const payload = {
          ...this.metrics.statsSnapshot(),
          cache: this.cache.size(),
          persistence: this.store ? { path: this.store.path } : { enabled: false },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      }
      const route = this.routes.get(name);
      if (!route) {
        throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const progressToken = req.params._meta?.progressToken;
      return this.handleToolCall(route, args, {
        onprogress:
          progressToken === undefined
            ? undefined
            : (progress) =>
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, ...progress },
                  })
                  .catch(() => {}),
      });
    });

    // Resources/prompts pass-through handlers are registered in start(),
    // mirroring the sole upstream's actual capabilities (§10).
  }

  private async passthrough<T>(fn: (up: Upstream) => Promise<T>, method: string): Promise<T> {
    if (!this.isSingleUpstream()) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `${method}: resource/prompt aggregation across multiple upstreams is not supported in this version`,
      );
    }
    const up = this.soleUpstream();
    if (!up?.connected) {
      throw new McpError(ErrorCode.InternalError, 'upstream not connected');
    }
    this.budget.realStarted(up.name);
    try {
      return await fn(up);
    } finally {
      this.budget.realFinished(up.name);
      this.executor.drainServer(up.name);
    }
  }

  // -------------------------------------------------------------------------
  // The read path (§3.1 router)
  // -------------------------------------------------------------------------

  private async handleToolCall(
    route: Route,
    args: Record<string, unknown>,
    opts: { onprogress?: (p: { progress: number; total?: number; message?: string }) => void },
  ): Promise<CallToolResult> {
    const { server } = route;
    const tool = route.tool.name;
    const upstream = this.upstreams.get(server);
    if (!upstream?.connected) {
      throw new McpError(ErrorCode.InternalError, `upstream '${server}' is not connected`);
    }
    const isReadOnly = this.policy.isAffirmativelyReadOnly(server, tool);

    // §6.2 conservative invalidation: unknown/mutating tools invalidate on
    // issue and again on settle (success OR failure — a timed-out write may
    // still have applied upstream; see finally below).
    if (!isReadOnly) this.cache.invalidateServer(server);

    // stdio contention visibility (§3.1/§9): a real call arriving while a
    // speculative call is in flight on a serial transport may queue.
    if (upstream.transport === 'stdio' && this.budget.specInFlight(server) > 0) {
      this.metrics.record({ type: 'stdio_delay', server, tool });
    }

    let result: CallToolResult | null = null;
    let latencyMs = 0;

    if (isReadOnly) {
      const profile = this.profiles[server];
      let key: string;
      try {
        key = canonicalKey(server, tool, args, profileCanonicalizer(profile, tool));
      } catch {
        // A broken canonicalizer must never fail a real call (§3.3): fall
        // back to the raw-args key (worst case: a cache miss).
        key = canonicalKey(server, tool, args);
      }
      const found = this.cache.lookup(key);
      if (found.outcome === 'hit') {
        result = found.result;
        latencyMs = found.meta.upstreamLatencyMs ?? 0;
        this.metrics.record({
          type: 'hit',
          server,
          tool,
          ruleId: found.meta.ruleId,
          savedMs: found.meta.upstreamLatencyMs ?? 0,
        });
      } else if (found.outcome === 'joined') {
        const tJoin = this.now();
        try {
          result = await found.promise;
          const saved = Math.max(0, tJoin - found.meta.issuedAt);
          latencyMs = this.now() - tJoin;
          this.metrics.record({
            type: 'joined',
            server,
            tool,
            ruleId: found.meta.ruleId,
            savedMs: saved,
          });
        } catch (err) {
          // Speculative call failed — fall through to a real call (never
          // surface a speculative failure for a call the agent actually
          // made). The joined entry emits no cache event, so report the
          // waste here or the §5.6 feedback loop never learns.
          this.metrics.record({
            type: 'spec_error',
            server,
            tool,
            ruleId: found.meta.ruleId,
            reason: `join-failed: ${(err as Error)?.message?.slice(0, 200) ?? 'unknown'}`,
          });
          result = null;
        }
      } else {
        this.metrics.record({
          type: 'miss',
          server,
          tool,
          nearMissDistance: found.nearMissDistance,
        });
      }
    }

    if (result === null) {
      const t0 = this.now();
      this.budget.realStarted(server);
      try {
        result = await upstream.callTool(tool, args, {
          onprogress: opts.onprogress,
          timeoutMs: REAL_CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        });
      } finally {
        this.budget.realFinished(server);
        // Order matters (§6.2): a mutation settles (even by throwing — the
        // write may still have applied) → flush + doom BEFORE draining, so
        // queued speculation can't fire into a pre-flush window or be
        // issued-then-instantly-doomed.
        if (!isReadOnly) this.cache.invalidateServer(server);
        this.executor.drainServer(server);
      }
      latencyMs = this.now() - t0;
      this.metrics.record({ type: 'real_call', server, tool, latencyMs });
      if (!result.isError && this.policy.isSuspended(server, tool)) {
        // §4: a successful real call resets the auth breaker.
        this.policy.resetSuspension(server, tool);
      }
    }

    // §5.5: prediction runs off the critical path, on every served call.
    // In 'off' mode the ENTIRE pipeline is skipped — no prediction, no
    // learning, no state persistence. Off means off (§13.7): a disabled
    // proxy must not accumulate learned argument data on disk.
    const finalResult = result;
    if (!finalResult.isError && this.config.mode !== 'off') {
      setImmediate(() => {
        try {
          // §13.15: the session's first few read asks per server become
          // opener candidates for the NEXT session's start-time prefetch.
          if (isReadOnly) {
            const slots = this.openerSlots.get(server) ?? OPENER_RECORD_LIMIT;
            if (slots > 0) {
              this.openerSlots.set(server, slots - 1);
              this.learner.recordOpener(server, tool, args);
            }
          }
          const predictions = this.predictor.observe({
            server,
            tool,
            args,
            result: finalResult,
            latencyMs,
            timestamp: this.now(),
          });
          if (predictions.length > 0) {
            this.executor.submit(predictions);
          }
          this.scheduleSave(); // §13.6: persist newly learned transitions
        } catch (err) {
          process.stderr.write(`[speculate] prediction error: ${(err as Error).message}\n`);
        }
      });
    }

    return finalResult;
  }
}
