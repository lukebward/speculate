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
import { builtinProfiles } from './profiles/index.js';
import { canonicalKey } from './keys.js';
import { Upstream } from './upstream.js';
import type { ServerProfile, SpeculateConfig } from './types.js';

const STATS_TOOL = 'speculate__stats';

interface Route {
  server: string;
  tool: string;
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
  private routes = new Map<string, Route>();
  private sweeper: NodeJS.Timeout | null = null;
  private clientSupportsToolListChanged = false;

  constructor(config: SpeculateConfig, opts: { now?: () => number } = {}) {
    this.config = config;
    const now = opts.now ?? Date.now;

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

    this.server = new Server(
      { name: 'speculate', version: '0.1.0' },
      { capabilities: this.buildCapabilities() },
    );
    this.registerHandlers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.connectUpstreams();
    this.sweeper = setInterval(() => this.cache.sweep(), 5_000);
    this.sweeper.unref();
    const transport = new StdioServerTransport();
    this.server.oninitialized = () => {
      const caps = this.server.getClientCapabilities();
      this.clientSupportsToolListChanged = true; // list_changed is a plain notification; safe to send
      void caps;
    };
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
    // Config order is claim order: first server keeps the bare name.
    for (const name of Object.keys(this.config.servers)) {
      const up = this.upstreams.get(name);
      if (!up?.connected) continue;
      for (const tool of up.tools) {
        const exposed = routes.has(tool.name) ? `${name}__${tool.name}` : tool.name;
        routes.set(exposed, { server: name, tool: tool.name });
      }
    }
    this.routes = routes;
  }

  private exposedTools(): Tool[] {
    const out: Tool[] = [];
    for (const [exposed, route] of this.routes) {
      const up = this.upstreams.get(route.server);
      const tool = up?.tools.find((t) => t.name === route.tool);
      if (!tool) continue;
      out.push(exposed === tool.name ? tool : { ...tool, name: exposed });
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
    if (this.clientSupportsToolListChanged) {
      this.server.sendToolListChanged();
    }
  }

  // -------------------------------------------------------------------------
  // Request handlers
  // -------------------------------------------------------------------------

  private buildCapabilities(): Record<string, object> {
    // Tools always; resources/prompts only in single-upstream deployments
    // (URI/name routing across upstreams is out of MVP scope — §10).
    const caps: Record<string, object> = { tools: { listChanged: true } };
    if (this.isSingleUpstream()) {
      caps.resources = {};
      caps.prompts = {};
    }
    return caps;
  }

  private isSingleUpstream(): boolean {
    return Object.keys(this.config.servers).length === 1;
  }

  private soleUpstream(): Upstream {
    const first = this.upstreams.values().next().value;
    if (!first) throw new McpError(ErrorCode.InternalError, 'no upstream configured');
    return first;
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

    // Resources / prompts / templates: single-upstream pass-through (§10).
    this.server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
      this.passthroughUpstream('resources/list').listResources(req.params),
    );
    this.server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      this.passthroughUpstream('resources/read').readResource(req.params),
    );
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
      this.passthroughUpstream('resources/templates/list').listResourceTemplates(req.params),
    );
    this.server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
      this.passthroughUpstream('prompts/list').listPrompts(req.params),
    );
    this.server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      this.passthroughUpstream('prompts/get').getPrompt(
        req.params as { name: string; arguments?: Record<string, string> },
      ),
    );
  }

  private passthroughUpstream(method: string): Upstream {
    if (!this.isSingleUpstream()) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `${method}: resource/prompt aggregation across multiple upstreams is not supported in this version`,
      );
    }
    return this.soleUpstream();
  }

  // -------------------------------------------------------------------------
  // The read path (§3.1 router)
  // -------------------------------------------------------------------------

  private async handleToolCall(
    route: Route,
    args: Record<string, unknown>,
    opts: { onprogress?: (p: { progress: number; total?: number; message?: string }) => void },
  ): Promise<CallToolResult> {
    const { server, tool } = route;
    const upstream = this.upstreams.get(server);
    if (!upstream?.connected) {
      throw new McpError(ErrorCode.InternalError, `upstream '${server}' is not connected`);
    }
    const now = Date.now;
    const isReadOnly = this.policy.isAffirmativelyReadOnly(server, tool);

    // §6.2 conservative invalidation: unknown/mutating tools invalidate on
    // issue AND on completion.
    if (!isReadOnly) this.cache.invalidateServer(server);

    // stdio contention visibility (§3.1/§9): a real call arriving while a
    // speculative call is in flight on a serial transport may queue.
    if (upstream.transport === 'stdio' && this.budget.specInFlight(server) > 0) {
      this.metrics.record({ type: 'stdio_delay', server, tool });
    }

    let result: CallToolResult | null = null;
    let servedFromSpeculation = false;
    let latencyMs = 0;

    if (isReadOnly) {
      const profile = this.profiles[server];
      const key = canonicalKey(server, tool, args, profile?.canonicalizers[tool]);
      const found = this.cache.lookup(key);
      if (found.outcome === 'hit') {
        result = found.result;
        servedFromSpeculation = true;
        latencyMs = found.meta.upstreamLatencyMs ?? 0;
        this.metrics.record({
          type: 'hit',
          server,
          tool,
          ruleId: found.meta.ruleId,
          savedMs: found.meta.upstreamLatencyMs ?? 0,
        });
      } else if (found.outcome === 'joined') {
        const tJoin = now();
        try {
          result = await found.promise;
          servedFromSpeculation = true;
          const saved = Math.max(0, tJoin - found.meta.issuedAt);
          latencyMs = now() - tJoin;
          this.metrics.record({
            type: 'joined',
            server,
            tool,
            ruleId: found.meta.ruleId,
            savedMs: saved,
          });
        } catch {
          // Speculative call failed — fall through to a real call. Never
          // surface a speculative failure for a call the agent actually made.
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
      const t0 = now();
      this.budget.realStarted(server);
      try {
        result = await upstream.callTool(tool, args, { onprogress: opts.onprogress });
      } finally {
        this.budget.realFinished(server);
        // A freed serial upstream may unblock queued speculation (§3.1).
        this.executor.drainServer(server);
      }
      latencyMs = now() - t0;
      this.metrics.record({ type: 'real_call', server, tool, latencyMs });
      if (!result.isError && this.policy.isSuspended(server, tool)) {
        // §4: a successful real call resets the auth breaker.
        this.policy.resetSuspension(server, tool);
      }
    } else {
      this.metrics.record({ type: 'real_call', server, tool, latencyMs, reason: 'served-from-speculation' });
    }

    if (!isReadOnly) this.cache.invalidateServer(server);

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
            timestamp: now(),
          });
          if (this.config.mode !== 'off' && predictions.length > 0) {
            this.executor.submit(predictions);
          }
        } catch (err) {
          process.stderr.write(`[speculate] prediction error: ${(err as Error).message}\n`);
        }
      });
    }

    void servedFromSpeculation;
    return finalResult;
  }
}
