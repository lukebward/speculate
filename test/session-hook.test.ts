import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBridge, connectSessionBridgeOwner } from '../src/sessionBridge.js';
import { CompletionLedger } from '../src/runAgent.js';
import type { Candidate, LocalRouteDescriptor, SessionContext } from '../src/observerTypes.js';
import type { ProxySessionEvent } from '../src/proxy.js';

const HOOK = fileURLToPath(new URL('../plugin/hooks/session-observer.mjs', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runHook(socketPath: string, payload: unknown, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: {
      ...process.env,
      SPECULATE_OBSERVER_SOCKET: socketPath,
      SPECULATE_OBSERVER_CAPABILITY: 'hook-capability',
      SPECULATE_OBSERVER_LAUNCH_ID: 'launch',
      SPECULATE_OBSERVER_CLIENT: 'claude',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(payload));
  return new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

describe('standalone session observer hook', () => {
  it.skipIf(process.platform === 'win32')('sends one bounded authenticated event with no output or decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'speculate-session-hook-'));
    directories.push(root);
    const socketPath = join(root, 'hook.sock');
    let received = '';
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { received += chunk; });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const result = await runHook(socketPath, { hook_event_name: 'UserPromptSubmit', session_id: 'session', prompt: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(result).toEqual({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(JSON.parse(received.trim())).toEqual({
      type: 'hook',
      capability: 'hook-capability',
      launchId: 'launch',
      hostClient: 'claude',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'session', prompt: 'hello' },
    });
  });

  it('abandons an unavailable bridge quickly without stdout or stderr', async () => {
    const started = Date.now();
    const result = await runHook(join(tmpdir(), `missing-${process.pid}-${Date.now()}.sock`), { event: 'start' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toEqual({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  });

  it('drops oversized and malformed input without output', async () => {
    const socketPath = join(tmpdir(), `missing-${process.pid}-${Date.now()}.sock`);
    const oversized = await runHook(socketPath, { text: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(oversized).toEqual({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  });
});

const context: SessionContext = {
  launchId: 'launch', conversationId: 'thread', agent: 'claude', cwd: '/work',
};
const localRoute: LocalRouteDescriptor = {
  exposedTool: 'read', upstreamServer: 'upstream', upstreamTool: 'read', inputSchema: { type: 'object' },
};

function candidate(routeId: string, generation: number, candidateId = 'candidate'): Candidate {
  return {
    version: 1, launchId: 'launch', conversationId: 'thread', candidateId,
    routeId, generation, sourceEventId: `source-${candidateId}`, source: 'intent',
    args: { path: '/work/a' }, confidence: 0.9, createdAt: 100,
  };
}

describe('session bridge authority roles', () => {
  it('keeps candidate delivery pending until exact async authorization succeeds', async () => {
    let decide!: (value: { decision: 'allowed'; permissionContext: string }) => void;
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      authorizeCandidate: async () => await new Promise((resolve) => { decide = resolve; }),
    });
    const received: unknown[] = [];
    const owner = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'files', onCandidates: (values) => received.push(values),
    });
    const [route] = await owner.register([localRoute]);
    expect(bridge.submit(candidate(route!.routeId, route!.generation))).toBe(true);
    expect(received).toEqual([]);
    decide({ decision: 'allowed', permissionContext: 'policy-digest' });
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(received).toEqual([[{ candidate: expect.objectContaining({ candidateId: 'candidate' }), permissionContext: 'policy-digest' }]]);
    expect(owner.currentPermissionContext('thread')).toBe('policy-digest');
    await owner.close(); await bridge.close();
  });

  it('drops denied and stale pending authorizations', async () => {
    const decisions: Array<(value: { decision: 'allowed' | 'denied'; permissionContext: string | null }) => void> = [];
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      authorizeCandidate: async () => await new Promise((resolve) => decisions.push(resolve)),
    });
    const received: unknown[] = [];
    const owner = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'files', onCandidates: (values) => received.push(values),
    });
    const [route] = await owner.register([localRoute]);
    expect(bridge.submit(candidate(route!.routeId, route!.generation, 'denied'))).toBe(true);
    decisions.shift()!({ decision: 'denied', permissionContext: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(bridge.submit(candidate(route!.routeId, route!.generation, 'stale'))).toBe(true);
    await owner.invalidate(undefined, 'changed');
    decisions.shift()!({ decision: 'allowed', permissionContext: 'old-policy' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([]);
    await owner.close(); await bridge.close();
  });

  it('drops authorization when the conversation cwd changes while native policy is pending', async () => {
    let decide!: (value: { decision: 'allowed'; permissionContext: string }) => void;
    const bridge = await SessionBridge.start(context, {
      now: () => 100,
      authorizeCandidate: async () => await new Promise((resolve) => { decide = resolve; }),
    });
    const received: unknown[] = [];
    const owner = await connectSessionBridgeOwner(bridge.coordinates, {
      hostClient: 'claude', hostServerAlias: 'files', onCandidates: (values) => received.push(values),
    });
    const [route] = await owner.register([localRoute]);
    expect(bridge.submit(candidate(route!.routeId, route!.generation))).toBe(true);
    expect(bridge.registerConversation({ ...context, cwd: '/other' })).toBe(true);
    decide({ decision: 'allowed', permissionContext: 'old-cwd-policy' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([]);
    await owner.close(); await bridge.close();
  });

  it('accepts hook events through only the observation capability and never creates an owner', async () => {
    const seen: unknown[] = [];
    const bridge = await SessionBridge.start(context, { onHook: (client, payload, observedAt) => seen.push({ client, payload, observedAt }) });
    const send = (capability: string) => new Promise<void>((resolve) => {
      const socket = createConnection(bridge.hookCoordinates.socketPath, () => {
        socket.end(`${JSON.stringify({
          type: 'hook', capability, launchId: 'launch', hostClient: 'claude', payload: { event: 'prompt' },
        })}\n`, resolve);
      });
      socket.on('error', () => resolve());
    });
    await send(bridge.hookCoordinates.capability);
    await send(bridge.coordinates.capability);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ client: 'claude', payload: { event: 'prompt' } });
    expect(bridge.listRoutes()).toEqual([]);
    await bridge.close();
  });
});

function completion(overrides: Partial<ProxySessionEvent> = {}): ProxySessionEvent {
  return {
    kind: 'tool-complete', launchId: 'launch', hostClient: 'claude', hostServerAlias: 'files',
    conversationId: null, eventId: 'complete', routeId: 'route', generation: 1,
    exposedTool: 'read', upstreamServer: 'upstream', upstreamTool: 'read',
    args: { path: '/work/a' }, result: { content: [] }, latencyMs: 20, startedAt: 120, completedAt: 140,
    ...overrides,
  };
}

describe('completion correlation', () => {
  it('correlates an exact marker and consumes it once', async () => {
    const ledger = new CompletionLedger();
    ledger.recordToolCall({
      source: 'model', phase: 'selected', context, routeId: 'route', generation: 1,
      callId: 'call', args: { path: '/work/a' }, observedAt: 110,
    });
    await expect(ledger.correlate(completion())).resolves.toMatchObject({ conversationId: 'thread' });
    await expect(ledger.correlate(completion({ eventId: 'second' }))).resolves.toBeNull();
  });

  it('uses one uniquely containing verified execution window across overlapping contexts', async () => {
    const ledger = new CompletionLedger();
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'parent', observedAt: 100 });
    ledger.recordWindow({ phase: 'opened', source: 'model', context: { ...context, conversationId: 'child' }, windowId: 'child', observedAt: 130 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'parent', observedAt: 150 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context: { ...context, conversationId: 'child' }, windowId: 'child', observedAt: 170 });
    await expect(ledger.correlate(completion())).resolves.toMatchObject({ conversationId: 'thread' });
  });

  it('keeps one opaque window eligible for multiple wrapper-authoritative calls', async () => {
    const ledger = new CompletionLedger();
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'exec', observedAt: 100 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'exec', observedAt: 200 });
    await expect(ledger.correlate(completion())).resolves.toMatchObject({ conversationId: 'thread' });
    await expect(ledger.correlate(completion({ eventId: 'later', startedAt: 160, completedAt: 180 }))).resolves.toMatchObject({ conversationId: 'thread' });
  });

  it('retains a previously used competing window for later ambiguity checks', async () => {
    const ledger = new CompletionLedger();
    const other = { ...context, conversationId: 'other' };
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'wide', observedAt: 100 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'wide', observedAt: 220 });
    await expect(ledger.correlate(completion({ startedAt: 120, completedAt: 125 }))).resolves.toMatchObject({ conversationId: 'thread' });
    ledger.recordWindow({ phase: 'opened', source: 'model', context: other, windowId: 'overlap', observedAt: 150 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context: other, windowId: 'overlap', observedAt: 210 });
    await expect(ledger.correlate(completion({ eventId: 'ambiguous', startedAt: 160, completedAt: 180 }))).resolves.toBeNull();
  });

  it('abstains when an open possible window remains after boundary grace', async () => {
    const ledger = new CompletionLedger({ boundaryGraceMs: 5 });
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'closed', observedAt: 100 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'closed', observedAt: 170 });
    ledger.recordWindow({ phase: 'opened', source: 'model', context: { ...context, conversationId: 'unknown' }, windowId: 'open', observedAt: 90 });
    await expect(ledger.correlate(completion())).resolves.toBeNull();
  });

  it.each(['ambiguous', 'tracking-loss'] as const)('abstains on %s execution context', async (kind) => {
    const ledger = new CompletionLedger();
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'one', observedAt: 100 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'one', observedAt: 160 });
    if (kind === 'ambiguous') {
      ledger.recordWindow({ phase: 'opened', source: 'model', context: { ...context, conversationId: 'other' }, windowId: 'two', observedAt: 90 });
      ledger.recordWindow({ phase: 'closed', source: 'model', context: { ...context, conversationId: 'other' }, windowId: 'two', observedAt: 170 });
    } else ledger.markTrackingLoss(105);
    await expect(ledger.correlate(completion())).resolves.toBeNull();
  });

  it('keeps correlation disabled after bounded-state eviction could hide a competing context', async () => {
    const ledger = new CompletionLedger();
    for (let index = 0; index < 1_025; index++) {
      const itemContext = { ...context, conversationId: `thread-${index}` };
      ledger.recordWindow({ phase: 'opened', source: 'model', context: itemContext, windowId: `window-${index}`, observedAt: index * 10 });
      ledger.recordWindow({ phase: 'closed', source: 'model', context: itemContext, windowId: `window-${index}`, observedAt: index * 10 + 1 });
    }
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'target', observedAt: 10_300 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'target', observedAt: 10_400 });
    await expect(ledger.correlate(completion({ startedAt: 10_320, completedAt: 10_340 }))).resolves.toBeNull();
  });

  it('does not regain certainty when an evicted open context ages beyond retention', async () => {
    const ledger = new CompletionLedger();
    ledger.recordWindow({ phase: 'opened', source: 'model', context: { ...context, conversationId: 'lost' }, windowId: 'long', observedAt: 0 });
    ledger.recordWindow({ phase: 'opened', source: 'model', context, windowId: 'target', observedAt: 200_000 });
    ledger.recordWindow({ phase: 'closed', source: 'model', context, windowId: 'target', observedAt: 200_100 });
    await expect(ledger.correlate(completion({ startedAt: 200_020, completedAt: 200_080 }))).resolves.toBeNull();
  });

  it('reports bounded-state correlation loss once for launch diagnostics', async () => {
    const onTrackingLoss = vi.fn();
    const ledger = new CompletionLedger({ onTrackingLoss });
    for (let index = 0; index < 1_025; index++) {
      ledger.recordToolCall({
        source: 'model', phase: 'selected', context, routeId: 'route', generation: 1,
        callId: `call-${index}`, args: { index }, observedAt: 1,
      });
    }
    expect(onTrackingLoss).toHaveBeenCalledTimes(1);
    await expect(ledger.correlate(completion())).resolves.toBeNull();
  });
});
