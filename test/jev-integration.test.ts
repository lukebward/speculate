import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBridge, connectSessionBridgeOwner } from '../src/sessionBridge.js';
import { SemanticRankingService } from '../src/semanticService.js';
import { SpeculateProxy } from '../src/proxy.js';
import { parseConfig } from '../src/config.js';
import type { AgentKind } from '../src/observerTypes.js';
import type { SemanticRankingMode } from '../src/semanticTypes.js';
import type { Upstream } from '../src/upstream.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(agent: AgentKind, mode: SemanticRankingMode, failProvider = false, providerGate?: Promise<void>) {
  const context = { launchId: `launch-${agent}`, conversationId: `conversation-${agent}`, agent, cwd: '/workspace' };
  const config = parseConfig({
    mode: 'strict', maxPredictionsPerTrigger: 1, log: 'off', persistence: { enabled: false },
    semanticRanking: { mode, timeoutMs: 500 },
    servers: {
      files: {
        url: 'https://example.invalid/mcp', allowTools: ['trigger', 'read'],
        speculation: { minExpectedSavedMs: 0, maxPerMinute: 30, maxConcurrent: 2 },
        rules: [{ trigger: 'trigger', predict: [
          { tool: 'read', args: { path: 'README.md' }, confidence: 0.95 },
          { tool: 'read', args: { path: 'src/auth.ts' }, confidence: 0.5 },
        ] }],
      },
    },
  });
  const payloads: Array<Record<string, any>> = [];
  const service = new SemanticRankingService({
    config: config.semanticRanking!, apiKey: 'test-key-never-persisted',
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      payloads.push(payload);
      if (providerGate) await providerGate;
      if (failProvider) return new Response('upstream private error text', { status: 503 });
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.keys(payload.questions).map((key, index) => [key, {
          type: 'noul', noul: payload.state.candidates[`c${index}`].args.path === 'src/auth.ts' ? 0.99 : 0.01,
        }])),
        usage: { input_tokens: 100, output_tokens: 8 },
      }));
    },
  });
  const correlate = vi.fn(async () => ({ conversationId: context.conversationId, cwd: context.cwd }));
  const bridge = await SessionBridge.start(context, { semanticConfig: config.semanticRanking, semanticService: service, correlateCompletion: correlate });
  cleanup.push(() => bridge.close());
  const runtime = await connectSessionBridgeOwner(bridge.coordinates, {
    hostClient: agent, hostServerAlias: 'files', onCandidates: () => {},
  });
  cleanup.push(() => runtime.close());
  const judging = vi.spyOn(runtime, 'judgeCandidates');
  const proxy = new SpeculateProxy(config, {
    session: {
      launchId: context.launchId, hostClient: agent, hostServerAlias: 'files', runtime,
      permissionContext: () => 'permission', permissionGate: { check: () => 'allowed' },
    },
  });
  const tools = ['trigger', 'read'].map((name) => ({
    name, description: name === 'read' ? 'Read the exact file contents.' : 'Read change metadata.',
    inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  }));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  proxy.upstreams.set('files', {
    connected: true, transport: 'http', tools,
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    close: async () => {},
  } as unknown as Upstream);
  cleanup.push(() => proxy.close());
  proxy.policy.updateTools('files', tools);
  (proxy as any).rebuildRoutes();
  await vi.waitFor(() => expect(bridge.listRoutes()).toHaveLength(2));
  const promptObserved = new Promise<void>((resolve) => {
    const unsubscribe = bridge.subscribe((observation) => {
      if (observation.eventId === 'prompt') { unsubscribe(); resolve(); }
    });
  });
  bridge.publishObservation({
    kind: 'prompt', context, eventId: 'prompt', observedAt: Date.now(),
    text: 'Explain why authentication started failing after the latest change.',
  });
  await promptObserved;
  await (proxy as any).handleToolCall({ server: 'files', exposed: 'trigger', tool: tools[0] }, {}, {});
  return { proxy, bridge, payloads, calls, correlate, service, runtime, judging, context, tools };
}

describe.each(['claude', 'codex'] as const)('Jev full pipeline: %s', (agent) => {
  it.each(['off', 'shadow', 'rank'] as const)('compares concrete execution in %s mode', async (mode) => {
    const h = await fixture(agent, mode);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1]).toEqual({ name: 'read', args: { path: mode === 'rank' ? 'src/auth.ts' : 'README.md' } });
    if (mode === 'off') expect(h.payloads).toHaveLength(0);
    else {
      await vi.waitFor(() => expect(h.payloads).toHaveLength(1));
      expect(Object.keys(h.payloads[0]!.questions)).toHaveLength(2);
      expect(h.payloads[0]!.state.task).toContain('authentication');
      expect(h.payloads[0]!.state.candidates.c0.description).toBe('Read the exact file contents.');
      expect(JSON.stringify(h.payloads)).not.toContain('test-key-never-persisted');
      expect(h.correlate).toHaveBeenCalledTimes(1);
    }
  });

  it('uses the current baseline after provider failure without altering real results', async () => {
    const h = await fixture(agent, 'rank', true);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.payloads).toHaveLength(1);
    expect(h.calls[1]).toEqual({ name: 'read', args: { path: 'README.md' } });
  });

  it('does not revive an old baseline when a new prompt cancels active judging', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await fixture(agent, 'rank', false, gate);
    await vi.waitFor(() => expect(h.payloads).toHaveLength(1));
    const changed = new Promise<void>((resolve) => {
      const unsubscribe = h.bridge.subscribe((event) => {
        if (event.eventId === 'new-task') { unsubscribe(); resolve(); }
      });
    });
    h.bridge.publishObservation({
      kind: 'prompt', context: h.context, eventId: 'new-task', observedAt: Date.now(),
      text: 'Stop investigating authentication; inspect the build configuration instead.',
    });
    await changed;
    release();
    await h.judging.mock.results[0]!.value;
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.calls).toEqual([{ name: 'trigger', args: {} }]);
  });

  it('labels real demand that arrives before a shadow provider response', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await fixture(agent, 'shadow', false, gate);
    await vi.waitFor(() => expect(h.payloads).toHaveLength(1));
    await (h.proxy as any).handleToolCall(
      { server: 'files', exposed: 'read', tool: h.tools[1] }, { path: 'src/auth.ts' }, {},
    );
    await vi.waitFor(() => expect(h.correlate).toHaveBeenCalledTimes(2));
    release();
    await h.judging.mock.results[0]!.value;
    await vi.waitFor(() => expect(h.service.report().evaluation.positives).toBe(1));
  });

});
