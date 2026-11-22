/**
 * The Speculator read path (DESIGN.md §3.1) against a fake SpeculationIo and
 * an injected clock: serve/claim accounting, learning from real and served
 * calls, invalidation, prompt intent, session start, and the helpers the mod
 * hooks use.
 */
import { describe, expect, it } from 'vitest';
import {
  addUsage,
  CLAIM_BYPASSED,
  mcpToolName,
  parseMcpToolName,
  Speculator,
  unservedReason,
  type RealOutcome,
  type SpeculationIo,
} from '../src/speculator.js';
import { canonicalKey } from '../src/keys.js';
import type { SpeculateOptions, ToolResult } from '../src/types.js';
import type { UsageCounters } from '../src/metrics.js';

const S = 'github';
const LIST = 'list_issues';
const GET = 'get_issue';
const ARGS = { repo: 'acme/api' };

const text = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

interface IssuedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  resolve: (result?: ToolResult) => void;
  reject: (err: unknown) => void;
}

interface FakeIo extends SpeculationIo {
  calls: IssuedCall[];
  allow: boolean;
  /** When true, speculative calls resolve immediately with `results[tool]`. */
  auto: boolean;
  results: Record<string, ToolResult>;
}

function fakeIo(): FakeIo {
  const io: FakeIo = {
    calls: [],
    allow: true,
    auto: true,
    results: {},
    call(server, tool, args) {
      return new Promise<ToolResult>((resolve, reject) => {
        const fallback = io.results[tool] ?? text({ tool, args });
        io.calls.push({ server, tool, args, resolve: (r = fallback) => resolve(r), reject });
        if (io.auto) resolve(fallback);
      });
    },
    async authorize() {
      return io.allow;
    },
  };
  return io;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

function harness(options: Partial<SpeculateOptions> = {}) {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const spec = new Speculator(options, { now });
  const io = fakeIo();

  const outcome = (result: ToolResult, over: Partial<RealOutcome> = {}): RealOutcome => ({
    result,
    isReadOnly: true,
    servable: true,
    isError: false,
    latencyMs: 400,
    ...over,
  });

  /** One real call through the host as the tool.call hook drives it. */
  async function real(
    tool: string,
    args: Record<string, unknown> = ARGS,
    over: Partial<RealOutcome> = {},
    server = S,
  ) {
    const claim = await spec.serve(server, tool, args, io);
    const started = spec.beginReal(server);
    if (claim) {
      claim.commit();
      spec.observeServed(server, tool, args, claim, io);
    } else {
      advance(400);
      spec.observe(server, tool, args, outcome(text({ tool, ...args }), over), io, started);
    }
    advance(100);
    await settle();
    return claim;
  }

  /** Teaches LIST -> GET twice, then triggers a LIST that should prefetch GET. */
  async function warm() {
    await real(LIST);
    await real(GET);
    await real(LIST);
    await real(GET);
    io.calls.length = 0;
    await real(LIST);
  }

  return { spec, io, advance, real, warm, outcome, now };
}

const stats = (spec: Speculator) => spec.stats();

// --- serve -------------------------------------------------------------------

describe('serve', () => {
  it('never serves an unknown tool, and invalidates the server', async () => {
    const h = harness();
    await h.warm();
    expect(h.spec.cache.size().ready).toBe(1);

    const claim = await h.spec.serve(S, 'never_seen', {}, h.io);
    expect(claim).toBeNull();
    expect(h.spec.cache.size().ready).toBe(0);
    expect(stats(h.spec).invalidated).toBe(1);
  });

  it('learns from real read-only calls and prefetches the predicted next read', async () => {
    const h = harness();
    await h.warm();
    expect(h.io.calls.map((c) => [c.server, c.tool, c.args])).toEqual([[S, GET, ARGS]]);
    expect(h.spec.cache.has(canonicalKey(S, GET, ARGS))).toBe(true);
    expect(stats(h.spec).speculativeCalls).toBe(1);
  });

  /** Teaches LIST -> GET, then runs LIST and GET as parallel calls. */
  async function parallelPair(h: ReturnType<typeof harness>, getSettlesFirst: boolean) {
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    await h.real(GET);
    h.io.calls.length = 0;
    expect(await h.spec.serve(S, LIST, ARGS, h.io)).toBeNull();
    const listStarted = h.spec.beginReal(S);
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
    const getStarted = h.spec.beginReal(S);
    h.advance(400);
    const done = (tool: string, started: { mayWaitBehindSpeculation: boolean }) =>
      h.spec.observe(S, tool, ARGS, h.outcome(text({ tool, ...ARGS })), h.io, started);
    if (getSettlesFirst) done(GET, getStarted);
    done(LIST, listStarted);
    await settle();
    return () => done(GET, getStarted);
  }

  it('never prefetches a call the agent is already making in parallel', async () => {
    const h = harness();
    const finishGet = await parallelPair(h, false);
    expect(h.io.calls.filter((c) => c.tool === GET)).toEqual([]);
    finishGet();
    await settle();
    expect(stats(h.spec).speculativeCalls).toBe(0);
  });

  it('never prefetches a call the agent made while the trigger ran', async () => {
    const h = harness();
    await parallelPair(h, true);
    expect(h.io.calls.filter((c) => c.tool === GET)).toEqual([]);
    expect(stats(h.spec).speculativeCalls).toBe(0);
  });

  it('still prefetches a repeat of a call that finished before the trigger', async () => {
    const h = harness();
    await h.warm(); // GET ran, then LIST started: GET again is a new read
    expect(h.io.calls.map((c) => c.tool)).toEqual([GET]);
  });

  it('still prefetches a repeat read when its trigger started in the same clock tick it finished', async () => {
    const h = harness();
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    // The second GET settles and the next LIST starts with no time between.
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
    const getStarted = h.spec.beginReal(S);
    h.advance(400);
    h.spec.observe(S, GET, ARGS, h.outcome(text({ tool: GET, ...ARGS })), h.io, getStarted);
    await settle();
    h.io.calls.length = 0;
    await h.real(LIST);
    expect(h.io.calls.map((c) => c.tool)).toEqual([GET]);
  });

  it('never prefetches a repeat of the very call that triggered the prediction', async () => {
    const h = harness();
    // LIST -> LIST, as a poll does: the agent holds the answer it just got,
    // and asks again only to see something newer than a prefetch made now.
    await h.real(LIST);
    await h.real(LIST);
    await h.real(LIST);
    await h.real(LIST);
    expect(h.io.calls).toEqual([]);
    expect(stats(h.spec).suppressed['already-called']).toBeGreaterThan(0);
  });

  it('serves a hit for a real call with the same args, and commit records it', async () => {
    const h = harness();
    await h.warm();
    const claim = await h.spec.serve(S, GET, { ...ARGS }, h.io);
    expect(claim).not.toBeNull();
    expect(claim!.source).toBe('hit');
    expect(claim!.result).toEqual(text({ tool: GET, args: ARGS }));
    expect(stats(h.spec).hits).toBe(0); // nothing counted before commit
    claim!.commit();
    expect(stats(h.spec).hits).toBe(1);
    expect(stats(h.spec).wasted).toBe(0);
  });

  it('misses a real call with different args', async () => {
    const h = harness();
    await h.warm();
    const misses = stats(h.spec).misses;
    expect(await h.spec.serve(S, GET, { repo: 'other' }, h.io)).toBeNull();
    expect(stats(h.spec).misses).toBe(misses + 1);
  });

  it('joins an in-flight prefetch, and commit records the join', async () => {
    const h = harness();
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    await h.real(GET);
    h.io.calls.length = 0;
    h.io.auto = false;
    await h.real(LIST);
    expect(h.io.calls.map((c) => c.tool)).toEqual([GET]);

    const pending = h.spec.serve(S, GET, ARGS, h.io);
    await settle();
    h.advance(50);
    h.io.calls[0]!.resolve();
    const claim = await pending;
    expect(claim?.source).toBe('joined');
    expect(claim!.result).toEqual(text({ tool: GET, args: ARGS }));
    claim!.commit();
    expect(stats(h.spec).joins).toBe(1);
  });

  it('a join that reaches its deadline falls through to the real call', async () => {
    const h = harness();
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    await h.real(GET);
    h.io.auto = false;
    await h.real(LIST);

    const claim = await h.spec.serve(S, GET, ARGS, h.io, Promise.resolve());
    expect(claim).toBeNull();
    expect(stats(h.spec).perServer[S]!.specErrors).toBe(1);
  });

  /** GET really takes 20 s; a LIST has just started a prefetch of it. */
  async function slowPrefetchInFlight() {
    const h = harness();
    await h.real(LIST);
    await h.real(GET, ARGS, { latencyMs: 20_000 });
    await h.real(LIST);
    await h.real(GET, ARGS, { latencyMs: 20_000 });
    h.io.auto = false;
    h.io.calls.length = 0;
    await h.real(LIST);
    expect(h.io.calls.map((c) => c.tool)).toEqual([GET]);
    return h;
  }

  it('does not join a prefetch that cannot land within the wait the caller can afford', async () => {
    const h = await slowPrefetchInFlight();
    h.advance(3_000); // about 17 s of the 20 s still to go; the caller can wait 8.5 s

    const outcome = await Promise.race([
      h.spec.serve(S, GET, ARGS, h.io, new Promise(() => {}), 8_500),
      settle().then(() => 'still waiting'),
    ]);
    expect(outcome).toBeNull();
    expect(stats(h.spec).wasted).toBe(1);
    expect(stats(h.spec).joins).toBe(0);
  });

  it('joins a slow prefetch that is far enough along to land in time', async () => {
    const h = await slowPrefetchInFlight();
    h.advance(15_000); // about 5 s to go, inside the 8.5 s the caller can wait

    const pending = h.spec.serve(S, GET, ARGS, h.io, new Promise(() => {}), 8_500);
    await settle();
    h.io.calls[0]!.resolve();
    const claim = await pending;
    expect(claim?.source).toBe('joined');
  });

  it('discard records waste rather than a hit', async () => {
    const h = harness();
    await h.warm();
    const claim = await h.spec.serve(S, GET, ARGS, h.io);
    claim!.discard('tool-hooks');
    const s = stats(h.spec);
    expect(s.hits).toBe(0);
    expect(s.invalidated).toBe(1);
    expect(s.wasted).toBe(1);
  });

  it('returns null and counts waste when the host no longer allows the call', async () => {
    const h = harness();
    await h.warm();
    h.io.allow = false;
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
    const s = stats(h.spec);
    expect(s.wasted).toBe(1);
    expect(s.hits).toBe(0);
    // The entry was consumed: a second lookup misses.
    h.io.allow = true;
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
  });

  it('a denied join is counted as waste exactly once', async () => {
    const h = harness();
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    await h.real(GET);
    h.io.auto = false;
    h.io.calls.length = 0;
    await h.real(LIST);
    h.io.allow = false;
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
    h.io.calls[0]!.resolve();
    await settle();
    expect(stats(h.spec).wasted).toBe(1);
  });
});

// --- observe -------------------------------------------------------------------

describe('observe', () => {
  it('a non-read-only outcome invalidates the server cache and records the verdict', async () => {
    const h = harness();
    await h.warm();
    expect(h.spec.cache.size().ready).toBe(1);
    h.spec.observe(S, GET, ARGS, h.outcome(text({}), { isReadOnly: false }), h.io);
    expect(h.spec.cache.size().ready).toBe(0);
    expect(h.spec.tools.eligibility(S, GET)).toEqual({ eligible: false, reason: 'not-read-only' });
  });

  it('a mutation on another server leaves this cache alone', async () => {
    const h = harness();
    await h.warm();
    h.spec.observe('linear', 'create_issue', {}, h.outcome(text({}), { isReadOnly: false }), h.io);
    expect(h.spec.cache.size().ready).toBe(1);
  });

  it('a write outside MCP discards what was prefetched from every server', async () => {
    const h = harness();
    for (const server of [S, 'linear']) {
      await h.real(LIST, ARGS, {}, server);
      await h.real(GET, ARGS, {}, server);
      await h.real(LIST, ARGS, {}, server);
      await h.real(GET, ARGS, {}, server);
    }
    await h.real(LIST, ARGS, {}, S);
    await h.real(LIST, ARGS, {}, 'linear');
    expect(h.spec.cache.size().ready).toBe(2);

    h.spec.externalWrite();
    expect(h.spec.cache.size()).toEqual({ ready: 0, inFlight: 0 });
    expect(stats(h.spec).invalidated).toBe(2);
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
    expect(await h.spec.serve('linear', GET, ARGS, h.io)).toBeNull();
  });

  it('a write outside MCP cancels a prefetch still waiting on its permission check', async () => {
    const h = harness();
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    await h.real(GET);
    h.io.calls.length = 0;
    let answer: (allowed: boolean) => void = () => {};
    h.io.authorize = () => new Promise<boolean>((resolve) => (answer = resolve));
    await h.real(LIST); // predicts GET, which now waits on the permission check

    h.spec.externalWrite();
    answer(true);
    await settle();
    expect(h.io.calls).toEqual([]);
    expect(stats(h.spec).suppressed['cache-invalidation']).toBe(1);
  });

  it('an error without isReadOnly keeps the verdict but still invalidates', async () => {
    const h = harness();
    await h.warm();
    const before = h.spec.tools.fact(S, GET)!;
    h.spec.observe(
      S,
      GET,
      ARGS,
      h.outcome({ isError: true, content: [{ type: 'text', text: 'denied by hook' }] }, {
        isError: true,
        isReadOnly: false,
        servable: false,
      }),
      h.io,
    );
    const after = h.spec.tools.fact(S, GET)!;
    expect(after.readOnly).toBe(true);
    expect(after.servable).toBe(before.servable);
    expect(h.spec.tools.eligibility(S, GET).eligible).toBe(true);
    expect(h.spec.cache.size().ready).toBe(0);
  });

  it('an error without isReadOnly on an unknown tool records nothing', () => {
    const h = harness();
    h.spec.observe(S, 'mystery', {}, h.outcome(text({}), { isError: true, isReadOnly: false }), h.io);
    expect(h.spec.tools.fact(S, 'mystery')).toBeUndefined();
  });

  it('a read-only error keeps the servable bit a successful call showed', () => {
    const h = harness();
    h.spec.observe(S, GET, ARGS, h.outcome(text({})), h.io);
    h.spec.observe(S, GET, ARGS, h.outcome(text({}), { isError: true, servable: false }), h.io);
    expect(h.spec.tools.fact(S, GET)).toMatchObject({ readOnly: true, servable: true });
  });

  it('a successful real call lifts a suspension', () => {
    const h = harness();
    h.spec.observe(S, GET, ARGS, h.outcome(text({})), h.io);
    h.spec.tools.suspend(S, GET, 'auth');
    h.spec.observe(S, GET, ARGS, h.outcome(text({})), h.io);
    expect(h.spec.tools.isSuspended(S, GET)).toBe(false);
  });

  it('a refused call (no outcome) learns nothing and only drains', () => {
    const h = harness();
    const started = h.spec.beginReal(S);
    h.spec.observe(S, GET, ARGS, null, h.io, started);
    expect(h.spec.tools.fact(S, GET)).toBeUndefined();
    expect(stats(h.spec).realCalls).toBe(0);
    expect(h.spec.budget.realInFlight(S)).toBe(0);
  });

  it('charges a stdio delay when the real call may have waited behind speculation', () => {
    const h = harness();
    h.spec.observe(S, GET, ARGS, h.outcome(text({}), { latencyMs: 250 }), h.io, { mayWaitBehindSpeculation: true });
    expect(stats(h.spec).stdioDelays).toBe(1);
    expect(stats(h.spec).estimatedAddedWaitMs).toBe(250);
  });

  it('observeServed keeps a chain predicting past a served step', async () => {
    const h = harness();
    // Teach LIST -> GET -> LIST twice so a served GET predicts LIST.
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST);
    await h.real(GET);
    await h.real(LIST); // prefetches GET
    h.io.calls.length = 0;

    const claim = await h.real(GET); // served
    expect(claim?.source).toBe('hit');
    expect(h.io.calls.map((c) => c.tool)).toEqual([LIST]);
    expect(h.spec.cache.has(canonicalKey(S, LIST, ARGS))).toBe(true);
  });
});

// --- prompt --------------------------------------------------------------------

describe('prompt', () => {
  const PR = 'review https://github.com/acme/api/pull/7';
  const PR_ARGS = { owner: 'acme', repo: 'api', pull_number: 7 };

  it('admits an intent only for a known eligible tool with a matching arg shape', async () => {
    const h = harness();
    expect(h.spec.prompt(PR, '/w', h.io)).toBe(0); // tool unknown

    h.spec.observe(S, 'get_pull_request', { owner: 'x', repo: 'y' }, h.outcome(text({})), h.io);
    expect(h.spec.prompt(PR, '/w', h.io)).toBe(0); // shape mismatch

    h.spec.observe(S, 'get_pull_request', { owner: 'x', repo: 'y', pull_number: 1 }, h.outcome(text({})), h.io);
    await settle();
    h.io.calls.length = 0;
    expect(h.spec.prompt(PR, '/w', h.io)).toBe(1);
    await settle();
    expect(h.io.calls.map((c) => [c.server, c.tool, c.args])).toEqual([[S, 'get_pull_request', PR_ARGS]]);
  });

  it('refuses a mapping onto a tool recorded as not read-only', () => {
    const h = harness();
    h.spec.observe(S, 'get_pull_request', PR_ARGS, h.outcome(text({}), { isReadOnly: false }), h.io);
    expect(h.spec.prompt(PR, '/w', h.io)).toBe(0);
  });

  it('refuses an intent that is ambiguous across two servers', () => {
    const h = harness();
    h.spec.observe('fs1', 'list_directory', { path: '/a' }, h.outcome(text({})), h.io);
    h.spec.observe('fs2', 'list_directory', { path: '/b' }, h.outcome(text({})), h.io);
    expect(h.spec.prompt('list the workspace', '/w', h.io)).toBe(0);
  });

  it('maps a workspace listing onto the one server that knows it', async () => {
    const h = harness();
    h.spec.observe('fs1', 'list_directory', { path: '/a' }, h.outcome(text({})), h.io);
    await settle();
    h.io.calls.length = 0;
    expect(h.spec.prompt('list the workspace', '/w', h.io)).toBe(1);
    await settle();
    expect(h.io.calls.map((c) => [c.server, c.args])).toEqual([['fs1', { path: '/w' }]]);
  });

  it('ignores prompts with no mapping', () => {
    const h = harness();
    h.spec.observe(S, 'get_pull_request', PR_ARGS, h.outcome(text({})), h.io);
    expect(h.spec.prompt('what is a pull request?', '/w', h.io)).toBe(0);
  });
});

// --- sessionStart ----------------------------------------------------------------

describe('sessionStart', () => {
  /** A speculator whose memory holds GET as a learned opener for S. */
  function withOpener() {
    const first = harness();
    first.spec.observe(S, GET, ARGS, first.outcome(text({})), first.io);
    const memory = first.spec.exportMemory();
    // The learner needs two sessions' sightings to trust an opener.
    const second = harness();
    second.spec.importMemory({ ...memory } as never);
    second.spec.observe(S, GET, ARGS, second.outcome(text({})), second.io);
    const third = harness();
    third.spec.importMemory({ ...second.spec.exportMemory() } as never);
    return third;
  }

  it('fires learned openers once per server', async () => {
    const h = withOpener();
    const names = [mcpToolName(S, GET), mcpToolName(S, LIST), 'Read', 'mcp__bad'];
    expect(h.spec.sessionStart(names, h.io)).toBe(1);
    await settle();
    expect(h.io.calls.map((c) => [c.server, c.tool, c.args])).toEqual([[S, GET, ARGS]]);

    expect(h.spec.sessionStart(names, h.io)).toBe(0);
    await settle();
    expect(h.io.calls).toHaveLength(1);
  });

  it('close() ends the session, so the next one fires its openers again', async () => {
    const h = withOpener();
    const names = [mcpToolName(S, GET)];
    expect(h.spec.sessionStart(names, h.io)).toBe(1);
    await settle();
    h.spec.close();
    expect(h.spec.sessionStart(names, h.io)).toBe(1);
  });

  it('a later server is still started once it appears', () => {
    const h = withOpener();
    expect(h.spec.sessionStart([mcpToolName('linear', 'list_teams')], h.io)).toBe(0);
    expect(h.spec.sessionStart([mcpToolName('linear', 'list_teams'), mcpToolName(S, GET)], h.io)).toBe(1);
  });
});

// --- mode off ----------------------------------------------------------------------

describe("mode 'off'", () => {
  it('serves nothing, learns nothing, prefetches nothing', async () => {
    const h = harness({ mode: 'off' });
    expect(h.spec.enabled).toBe(false);
    for (let i = 0; i < 3; i++) {
      await h.real(LIST);
      await h.real(GET);
    }
    expect(h.io.calls).toHaveLength(0);
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
    h.spec.observe(S, 'get_pull_request', { owner: 'a', repo: 'b', pull_number: 1 }, h.outcome(text({})), h.io);
    expect(h.spec.prompt('review https://github.com/a/b/pull/1', '/w', h.io)).toBe(0);
    expect(h.spec.sessionStart([mcpToolName(S, GET)], h.io)).toBe(0);
    expect(stats(h.spec).speculativeCalls).toBe(0);
    expect(stats(h.spec).misses).toBe(0);
  });
});

// --- a host that never lets a claim answer ------------------------------------------

describe('a host that runs claimed calls without asking the mod', () => {
  /**
   * One call by the agent on a host that runs it for real whether or not a
   * prefetched result was claimed for it. Returns whether one was.
   */
  async function ranAnyway(h: ReturnType<typeof harness>, tool: string, reason: string) {
    const claim = await h.spec.serve(S, tool, ARGS, h.io);
    const started = h.spec.beginReal(S);
    claim?.discard(reason);
    h.advance(400);
    h.spec.observe(S, tool, ARGS, h.outcome(text({ tool, ...ARGS })), h.io, started);
    h.advance(100);
    await settle();
    return claim !== null;
  }

  it('stops speculating once two claims in a row ran without its PreToolUse hook being asked', async () => {
    const h = harness();
    await h.warm(); // GET is prefetched; each call below prefetches the other
    expect(await ranAnyway(h, GET, CLAIM_BYPASSED)).toBe(true);
    expect(h.spec.enabled).toBe(true); // one alone could be another plugin's doing
    expect(stats(h.spec).halted).toBeNull();

    expect(await ranAnyway(h, LIST, CLAIM_BYPASSED)).toBe(true);
    expect(h.spec.enabled).toBe(false);
    expect(stats(h.spec).halted).toBe(CLAIM_BYPASSED);
    // Off means off: nothing left standing, nothing new started, nothing served.
    expect(h.spec.cache.size()).toEqual({ ready: 0, inFlight: 0 });
    const prefetches = h.io.calls.length;
    await h.real(GET);
    await h.real(LIST);
    expect(h.io.calls).toHaveLength(prefetches);
    expect(await h.spec.serve(S, GET, ARGS, h.io)).toBeNull();
  });

  it('keeps speculating when a served call comes between two such claims', async () => {
    const h = harness();
    await h.warm();
    expect(await ranAnyway(h, GET, CLAIM_BYPASSED)).toBe(true);
    expect(await h.real(LIST)).not.toBeNull(); // claimed and answered: the host does ask
    expect(await ranAnyway(h, GET, CLAIM_BYPASSED)).toBe(true);
    expect(h.spec.enabled).toBe(true);
  });

  it('keeps speculating when the PreToolUse hooks it was asked about turned the claims down', async () => {
    const h = harness();
    await h.warm();
    expect(await ranAnyway(h, GET, 'tool-hooks')).toBe(true);
    expect(await ranAnyway(h, LIST, 'tool-hooks')).toBe(true);
    expect(await ranAnyway(h, GET, 'tool-hooks')).toBe(true);
    expect(h.spec.enabled).toBe(true);
  });
});

describe('unservedReason', () => {
  const ran = { result: [], text: 'ok' };
  it.each([
    ['its hook was asked and the hooks beneath decided otherwise', true, ran, 'tool-hooks'],
    ['its hook was never asked and the tool ran', false, ran, CLAIM_BYPASSED],
    ['its hook was never asked because a hook above refused the call', false, { result: [], text: 'no', isError: true }, 'tool-hooks'],
    ['its hook was never asked because the call was denied', false, { deny: 'no' }, 'tool-hooks'],
  ] as Array<[string, boolean, Record<string, unknown>, string]>)('%s', (_what, asked, outcome, expected) => {
    expect(unservedReason(asked, outcome)).toBe(expected);
  });
});

// --- lifecycle --------------------------------------------------------------------

describe('lifecycle and reporting', () => {
  it('close abandons unclaimed entries so the funnel reconciles', async () => {
    const h = harness();
    await h.warm();
    h.spec.close();
    expect(stats(h.spec).abandoned).toBe(1);
    expect(h.spec.cache.size()).toEqual({ ready: 0, inFlight: 0 });
  });

  it('usageDelta reports each increment exactly once', async () => {
    const h = harness();
    await h.warm();
    const first = h.spec.usageDelta();
    expect(first.speculativeCalls).toBe(1);
    expect(h.spec.usageDelta().speculativeCalls).toBe(0);
    (await h.spec.serve(S, GET, ARGS, h.io))!.commit();
    const third = h.spec.usageDelta();
    expect(third.hits).toBe(1);
    expect(third.speculativeCalls).toBe(0);
  });

  it('memory round-trips tool facts and changes the revision', () => {
    const h = harness();
    const rev = h.spec.revision;
    h.spec.observe(S, GET, ARGS, h.outcome(text({})), h.io);
    expect(h.spec.revision).not.toBe(rev);
    const other = harness();
    other.spec.importMemory(h.spec.exportMemory() as never);
    expect(other.spec.tools.eligibility(S, GET).eligible).toBe(true);
    other.spec.importMemory(null);
    expect(other.spec.tools.eligibility(S, GET).eligible).toBe(true);
  });
});

// --- helpers ----------------------------------------------------------------------

describe('parseMcpToolName', () => {
  it.each([
    ['mcp__github__get_issue', { server: 'github', tool: 'get_issue' }],
    ['mcp__my_server__get__thing', { server: 'my_server', tool: 'get__thing' }],
    ['mcp__s__t', { server: 's', tool: 't' }],
    ['mcp__claude_ai_Slack__slack_read_thread', { server: 'claude_ai_Slack', tool: 'slack_read_thread' }],
  ])('parses %s', (name, expected) => {
    expect(parseMcpToolName(name)).toEqual(expected);
  });

  it.each(['Read', 'mcp__github', 'mcp__github__', 'mcp____tool', 'xmcp__a__b', 'mcp_a__b', ''])(
    'rejects %j',
    (name) => {
      expect(parseMcpToolName(name)).toBeNull();
    },
  );

  it('round-trips mcpToolName', () => {
    expect(parseMcpToolName(mcpToolName('github', 'get_issue'))).toEqual({ server: 'github', tool: 'get_issue' });
  });
});

describe('addUsage', () => {
  const delta: UsageCounters = {
    hits: 1,
    joins: 2,
    misses: 3,
    speculativeCalls: 4,
    wasted: 5,
    estimatedSavedMs: 6,
    estimatedAddedWaitMs: 7,
    predictionOpportunities: 8,
    predictionOffered: 9,
    predictionHitsAt1: 10,
    predictionHitsAt3: 11,
    nearMisses: 12,
    nearMissDistanceOne: 13,
  };

  it('adds into well-formed totals', () => {
    const doubled = addUsage(delta, delta);
    for (const key of Object.keys(delta) as Array<keyof UsageCounters>) expect(doubled[key]).toBe(delta[key] * 2);
  });

  it.each([null, undefined, 'x', 42, [1, 2]])('starts over from malformed totals (%j)', (stored) => {
    expect(addUsage(stored, delta)).toEqual(delta);
  });

  it('ignores individual malformed counters', () => {
    const out = addUsage({ hits: -1, joins: 'many', misses: Infinity, speculativeCalls: NaN, wasted: 10 }, delta);
    expect(out.hits).toBe(1);
    expect(out.joins).toBe(2);
    expect(out.misses).toBe(3);
    expect(out.speculativeCalls).toBe(4);
    expect(out.wasted).toBe(15);
  });

  it('does not mutate the delta', () => {
    const copy = { ...delta };
    addUsage(delta, delta);
    expect(delta).toEqual(copy);
  });
});

describe('calls the agent runs together', () => {
  const once = (h: ReturnType<typeof harness>, tool: string, started: ReturnType<Speculator['beginReal']>) =>
    h.spec.observe(S, tool, ARGS, h.outcome(text({ tool, ...ARGS })), h.io, started);

  it('are remembered per server, and the next session may prefetch that many at once', async () => {
    const h = harness();
    expect(h.spec.tools.concurrency(S)).toBe(1);
    // Two reads in flight at the same time: the server runs calls together.
    const first = h.spec.beginReal(S);
    const second = h.spec.beginReal(S);
    h.advance(400);
    once(h, LIST, first);
    once(h, GET, second);
    await settle();
    expect(h.spec.tools.concurrency(S)).toBe(2);

    const next = harness();
    next.spec.importMemory(h.spec.exportMemory() as never);
    expect(next.spec.budget.tryAcquire(S)).toEqual({ ok: true });
    expect(next.spec.budget.tryAcquire(S)).toEqual({ ok: true });
    expect(next.spec.budget.tryAcquire(S)).toEqual({ ok: false, reason: 'concurrency' });
  });

  it('one after another leave the server serial', async () => {
    const h = harness();
    once(h, LIST, h.spec.beginReal(S));
    once(h, GET, h.spec.beginReal(S));
    await settle();
    expect(h.spec.tools.concurrency(S)).toBe(1);
    expect(h.spec.budget.tryAcquire(S)).toEqual({ ok: true });
    expect(h.spec.budget.tryAcquire(S)).toEqual({ ok: false, reason: 'stdio-busy' });
  });

  it('a call a prefetch is answering is not a call on the server', async () => {
    const h = harness();
    const real = h.spec.beginReal(S);
    const claimed = h.spec.beginReal(S, true);
    expect(claimed.onServer).toBe(false);
    h.advance(400);
    // The hooks turned the claim down and the call ran after all: still not counted.
    once(h, GET, claimed);
    once(h, LIST, real);
    await settle();
    expect(h.spec.tools.concurrency(S)).toBe(1);
    expect(h.spec.budget.realInFlight(S)).toBe(0);
  });
});
