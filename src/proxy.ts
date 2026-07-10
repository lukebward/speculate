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
import { SpeculationExecutor } from './executor.js';
import { builtinProfiles, profileCanonicalizer } from './profiles/index.js';
import { canonicalKey } from './keys.js';
import { Upstream } from './upstream.js';
import type { ServerProfile, SpeculateConfig } from './types.js';

const STATS_TOOL = 'speculate__stats';
/** Names the proxy itself serves; upstream tools may never claim them. */
const BUILTIN_TOOLS = new Set([STATS_TOOL]);
/** Generous ceiling for forwarded real calls; progress resets the clock. */
const REAL_CALL_TIMEOUT_MS = 600_000;

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

  constructor(config: SpeculateConfig, opts: { now?: () => number } = {}) {
    this.config = config;
    this.now = opts.now ?? Date.now;
    const now = this.now;

    // Per-server profile resolution (config profile name -> builtin profile).
    for (const [name, sc] of Object.entries(config.servers)) {
      if (sc.profile) {
        const profile = builtinProfiles[sc.profile];
        if (!profile) throw new Error(`unknown profile '${sc.profile}' for server '${name}'`);
        this.profiles[name] = profile;
      }
    }

    this.metrics = new Metrics({ mode: config.mode, log: config.log, now });
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
    this.predictor = new Predictor({
      profiles: this.profiles,
      maxPerTrigger: config.maxPredictionsPerTrigger,
      metrics: this.metrics,
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
      { name: 'speculate', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    this.registerHandlers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.connectUpstreams();

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

    this.sweeper = setInterval(() => this.cache.sweep(), 5_000);
    this.sweeper.unref();
    this.server.oninitialized = () => {
      this.initialized = true;
    };
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
          up.setToolsChangedHandler(() => this.handleUpstreamToolsChanged(up));
          up.setDisconnectHandler(() => this.handleUpstreamDisconnect(up));
        } catch (err) {
          process.stderr.write(
            `[speculate] upstream '${up.name}' failed to connect: ${(err as Error).message}\n`,
          );
        }
      }),
    );
    this.rebuildRoutes();
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.upstreams.values()].map((u) => u.close()));
    await this.server.close();
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
        while (routes.has(exposed) || BUILTIN_TOOLS.has(exposed)) {
          exposed = `${name}__${exposed}`;
          if (exposed.length > 512) break; // pathological upstream names
        }
        routes.set(exposed, { server: name, tool });
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
        'Speculate proxy statistics: hit rate, wasted speculative calls, estimated time saved, per-rule effectiveness.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    });
    return out;
  }

  private handleUpstreamToolsChanged(up: Upstream): void {
    // §3.4: flush that server's entries and re-run eligibility on new tools.
    this.policy.updateTools(up.name, up.tools);
    this.cache.invalidateServer(up.name);
    this.rebuildRoutes();
    this.notifyToolListChanged();
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
        return {
          content: [
            { type: 'text', text: JSON.stringify(this.metrics.statsSnapshot(), null, 2) },
          ],
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
    const finalResult = result;
    if (!finalResult.isError) {
      setImmediate(() => {
        try {
          const predictions = this.predictor.observe({
            server,
            tool,
            args,
            result: finalResult,
            latencyMs,
            timestamp: this.now(),
          });
          if (this.config.mode !== 'off' && predictions.length > 0) {
            this.executor.submit(predictions);
          }
        } catch (err) {
          process.stderr.write(`[speculate] prediction error: ${(err as Error).message}\n`);
        }
      });
    }

    return finalResult;
  }
}
