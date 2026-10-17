/**
 * The Speculator read path (DESIGN.md §3.1) against a fake SpeculationIo and
 * an injected clock: serve/claim accounting, learning from real and served
 * calls, invalidation, prompt intent, session start, and the helpers the mod
 * hooks use.
 */
import { describe, expect, it } from 'vitest';
import {
  addUsage,
  mcpToolName,
  parseMcpToolName,
  Speculator,
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
