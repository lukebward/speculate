/**
 * The mod against the engine's own test kit: the hooks module as Claude Code
 * loads it, with the test's hooks standing beneath it for the host (the MCP
 * server, the permission check, the tool list, settings and the store).
 *
 * Run with `claude plugin test .` (vitest runs the *.spec.ts files).
 */
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

type Args = Record<string, unknown>

interface Fixture {
  readOnly: boolean
  latencyMs: number
  answer: (args: Args) => unknown
  /**
   * The tool returns structured content: the host records its result as one
   * text (the JSON), and hands a mod's own call that text as one block.
   */
  structured?: boolean
  /** What a mod's own call gets back, when it is not that one block. */
  prefetched?: (args: Args) => Array<{ type: string; text?: string }>
}

const ISSUES = [
  { number: 41, title: 'Login flow flaky on Safari' },
  { number: 42, title: 'Rate limiter drops burst traffic' },
]

const TOOLS: Record<string, Fixture> = {
  mcp__gh__list_issues: { readOnly: true, latencyMs: 400, answer: () => ISSUES },
  mcp__gh__get_issue: {
    readOnly: true,
    latencyMs: 400,
    answer: args => ISSUES.find(issue => issue.number === args.issue_number) ?? { error: 'not found' },
  },
  mcp__gh__create_issue: { readOnly: false, latencyMs: 100, answer: () => ({ number: 43 }) },
  mcp__gh__search_issues: {
    readOnly: true,
    latencyMs: 500,
    structured: true,
    answer: args => ({ query: args.q, results: ISSUES }),
  },
  mcp__gh__search_code: {
    readOnly: true,
    latencyMs: 500,
    structured: true,
    answer: args => ({ query: args.q, results: [] }),
    prefetched: () => [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  },
  mcp__gh__get_pull_request: {
    readOnly: true,
    latencyMs: 600,
    answer: args => ({ number: args.pull_number, title: `PR ${String(args.pull_number)}` }),
  },
}

/** Built-in tools the model calls between its MCP reads, and the host's verdict on each. */
const BUILTINS: Record<string, { readOnly: boolean }> = {
  Bash: { readOnly: false },
  Read: { readOnly: true },
}

interface Upstream {
  tool: string
  args: Args
  by: 'model' | 'plugin'
}

interface WorldOptions {
  allow?: readonly string[]
  store?: Record<string, unknown>
  /** The host's settings do not keep what a mod sets (an organization's, say). */
  refuseConfig?: boolean
}

/** One change a mod asked the host's settings to keep. */
interface ConfigSet {
  key: string
  value: unknown
}

/** Tools a PreToolUse settings hook denies; a test adds to it mid-session. */
const denyPre = new Set<string>()

function world(on: On, options: WorldOptions = {}) {
  denyPre.clear()
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  on('store.get', async ($, e) => ({ value: copy(store.get(e.key)) }))
  on('store.set', async ($, e) => {
    store.set(e.key, copy(e.value))
    return { value: undefined }
  })
  on('store.delete', async ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('ui.status', async () => ({ value: undefined }) as never)
  const upstream: Upstream[] = []
  const configured: ConfigSet[] = []
  on('config.set', async ($, e) => {
    configured.push({ key: e.key, value: e.value })
    return (options.refuseConfig ? { deny: 'managed settings own this row' } : { value: e.value }) as never
  })
  const allow = new Set(options.allow ?? [...Object.keys(TOOLS), ...Object.keys(BUILTINS)])
  const deny = denyPre

  const run = async (tool: string, args: Args) => {
    const fixture = TOOLS[tool]!
    await clock.sleep(fixture.latencyMs)
    return [{ type: 'text', text: JSON.stringify(fixture.answer(args)) }]
  }

  on('classic.PreToolUse', async ($, e, next) =>
    deny.has(String(e.tool)) ? { deny: 'a settings hook refused it' } : next(e))
  // No settings hook waits on a tool's result in these sessions.
  on('classic.PostToolUse', async () => ({}) as never)
  on('classic.PostToolUseFailure', async () => ({}) as never)
  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: _id, ...args } = e as unknown as { tool: string; tool_use_id: string } & Args
    const by = next.origin.plugin === 'engine' ? 'model' : 'plugin'
    const builtin = BUILTINS[tool]
    if (builtin) {
      upstream.push({ tool, args, by })
      return (builtin.readOnly ? { result: {}, text: 'ok', isReadOnly: true } : { result: {}, text: 'ok' }) as never
    }
    const fixture = TOOLS[tool]
    if (!fixture) return next(e)
    upstream.push({ tool, args, by })
    const content = await run(tool, args)
    const text = content[0]!.text
    const result = fixture.structured ? text : content
    return (fixture.readOnly ? { result, text, isReadOnly: true } : { result, text }) as never
  })
  on('mcp.call', async ($, e) => {
    const tool = `mcp__${e.server}__${e.tool}`
    upstream.push({ tool, args: e.args, by: 'plugin' })
    const content = await run(tool, e.args)
    return { value: { content: TOOLS[tool]?.prefetched?.(e.args) ?? content, isError: false } }
  })
  on('tool.check', async ($, e) => ({ decision: allow.has(e.tool) ? 'allow' : 'ask' }) as const)
  on('tool.list', async () => ({ value: Object.keys(TOOLS).map(name => ({ name, description: name, mcp: true })) }))
  on('session.cwd', async () => ({ value: '/work' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async ($, e) => e as never)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)

  return { clock, upstream, store, allow, configured }
}

/**
 * The mod's option as the host hands it over once the mod has named this
 * session's tools: every test but the ones about that first session runs so.
 */
const NAMED = { tools: Object.keys(TOOLS).sort().join(',') }
const WATCHING = { timeoutMs: 20_000, options: NAMED }

type Kit = Parameters<Parameters<typeof test>[1] extends infer B ? B extends (...a: infer P) => unknown ? (...a: P) => unknown : never : never>[0]

/** Calls a tool as the model would, letting the clock run while it does. */
async function call(
  $: Kit,
  clock: ReturnType<typeof mock.clock>,
  tool: string,
  args: Args,
): Promise<{ text: string; isError: boolean; result: unknown }> {
  const pending = $.tool.call({ tool, ...args } as never) as Promise<{ result?: unknown; text?: string; isError?: boolean }>
  await clock.advance(1_000)
  const ran = await pending
  const text = typeof ran.text === 'string'
    ? ran.text
    : typeof ran.result === 'string'
      ? ran.result
      : Array.isArray(ran.result) ? String((ran.result[0] as { text?: string })?.text ?? '') : ''
  return { text, isError: ran.isError === true, result: ran.result }
}

let toolUse = 0

/** What a session raises once a tool has run: the mod hears of a built-in call only here. */
async function settled($: Kit, tool: string, args: Args, response: unknown = 'ok') {
  await ($ as never as { classic: { PostToolUse(e: object): Promise<unknown> } }).classic.PostToolUse({
    tool_name: tool,
    tool_input: args,
    tool_response: response,
    tool_use_id: `toolu_${++toolUse}`,
    duration_ms: 5,
  })
}

/** The model's turn ends: what a session raises once it has answered. */
async function endTurn($: Kit) {
  await ($ as never as { turn: { complete(e: object): Promise<unknown> } }).turn.complete({
    answer: 'done',
    durationMs: 3_000,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
  })
}

async function startSession($: Kit, clock: ReturnType<typeof mock.clock>, prompt = 'Look at the open issues.') {
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  const submitted = $.prompt.submit({ text: prompt } as never)
  await clock.advance(1_000)
  await submitted
}

async function endSession($: Kit, clock: ReturnType<typeof mock.clock>) {
  const ended = $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as never)
  await clock.advance(5_000)
  await ended
}

const LIST = { owner: 'acme', repo: 'api' }
const GET_42 = { owner: 'acme', repo: 'api', issue_number: 42 }

async function learnChain($: Kit, clock: ReturnType<typeof mock.clock>, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await call($, clock, 'mcp__gh__list_issues', LIST)
    await call($, clock, 'mcp__gh__get_issue', GET_42)
  }
}

test('learns a list-then-get chain and serves the get from a prefetch', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)

  // The reads are new, so they run through the host until the learner has
  // seen the list-then-get transition often enough to bet on it.
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)

  const before = upstream.length
  const got = await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(JSON.parse(got.text).title).toBe('Rate limiter drops burst traffic')
  // The prefetch the list started answered the model's get: the model's call
  // never went upstream. (The chain goes on predicting past the served get.)
  expect(upstream.slice(before).filter(u => u.by === 'model')).toEqual([])
  expect(upstream.some(u => u.by === 'plugin' && u.tool === 'mcp__gh__get_issue')).toBe(true)
})

const SEARCH = { q: 'is:open label:bug' }

test('serves a tool that returns structured content, in the form the host records it', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)

  // A real call shows the host keeps this tool's result as one text.
  const real = await call($, clock, 'mcp__gh__search_issues', SEARCH)
  expect(typeof real.result).toBe('string')
  for (let i = 0; i < 3; i++) {
    await call($, clock, 'mcp__gh__list_issues', LIST)
    await call($, clock, 'mcp__gh__search_issues', SEARCH)
  }
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.some(u => u.by === 'plugin' && u.tool === 'mcp__gh__search_issues')).toBe(true)

  const before = upstream.length
  const got = await call($, clock, 'mcp__gh__search_issues', SEARCH)
  // Served from the prefetch, and as the same text a real call is recorded as.
  expect(upstream.slice(before).filter(u => u.by === 'model')).toEqual([])
  expect(got.result).toBe(real.result)
  expect(JSON.parse(got.text).results).toHaveLength(2)
})

test('a prefetch that is not the one text the host records is not served', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)
  for (let i = 0; i < 4; i++) {
    await call($, clock, 'mcp__gh__list_issues', LIST)
    await call($, clock, 'mcp__gh__search_code', SEARCH)
  }
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.some(u => u.by === 'plugin' && u.tool === 'mcp__gh__search_code')).toBe(true)

  const before = upstream.length
  const got = await call($, clock, 'mcp__gh__search_code', SEARCH)
  expect(upstream.slice(before).filter(u => u.by === 'model').map(u => u.tool)).toEqual(['mcp__gh__search_code'])
  expect(typeof got.result).toBe('string')
  expect(JSON.parse(got.text)).toEqual({ query: SEARCH.q, results: [] })
})

test('never prefetches a call the person does not allow', WATCHING, async ($, on) => {
  const { clock, upstream, allow } = world(on)
  const prefetchedGets = () => upstream.filter(u => u.by === 'plugin' && u.tool === 'mcp__gh__get_issue').length
  await startSession($, clock)

  // While the get is allowed, the chain is learned and the get is prefetched,
  // then used, so nothing prefetched is left standing.
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  await call($, clock, 'mcp__gh__get_issue', GET_42)
  const whileAllowed = prefetchedGets()
  expect(whileAllowed).toBeGreaterThan(0)

  // The person's settings change: the get would now ask. The same list still
  // predicts it, and the prediction starts nothing.
  allow.delete('mcp__gh__get_issue')
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(prefetchedGets()).toBe(whileAllowed)
})

test('a PreToolUse hook that refuses the call wins over a prefetched result', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.at(-1)).toEqual({ tool: 'mcp__gh__get_issue', args: GET_42, by: 'plugin' })

  // A settings hook now refuses get_issue: the prefetched answer must not reach the model.
  denyPre.add('mcp__gh__get_issue')
  const got = await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(got.isError).toBe(true)
  expect(got.text).toContain('a settings hook refused it')
})

test('a call that may write clears what was prefetched', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.at(-1)).toEqual({ tool: 'mcp__gh__get_issue', args: GET_42, by: 'plugin' })
  await call($, clock, 'mcp__gh__create_issue', { owner: 'acme', repo: 'api', title: 'x' })

  const before = upstream.length
  await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(upstream.slice(before).filter(u => u.by === 'model').map(u => u.tool)).toEqual(['mcp__gh__get_issue'])
})

test('a shell command clears what was prefetched', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.at(-1)).toEqual({ tool: 'mcp__gh__get_issue', args: GET_42, by: 'plugin' })
  // The shell reaches the same service by another road: the prefetched issue may be stale.
  // The mod is not asked about a shell command; it hears of it once it has run.
  await call($, clock, 'Bash', { command: 'gh issue edit 42 --title Renamed' })
  await settled($, 'Bash', { command: 'gh issue edit 42 --title Renamed' })

  const before = upstream.length
  await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(upstream.slice(before).filter(u => u.by === 'model').map(u => u.tool)).toEqual(['mcp__gh__get_issue'])
})

test('a built-in tool that only reads leaves what was prefetched', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.at(-1)).toEqual({ tool: 'mcp__gh__get_issue', args: GET_42, by: 'plugin' })
  await call($, clock, 'Read', { file_path: '/work/README.md' })
  await settled($, 'Read', { file_path: '/work/README.md' })

  const before = upstream.length
  const got = await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(JSON.parse(got.text).title).toBe('Rate limiter drops burst traffic')
  expect(upstream.slice(before).filter(u => u.by === 'model')).toEqual([])
})

test('what one session learned starts the next one', WATCHING, async ($, on) => {
  const { clock, upstream, store } = world(on)
  // Openers are the session's habitual first reads: a few sessions establish one.
  for (let session = 0; session < 3; session++) {
    await startSession($, clock)
    await learnChain($, clock, 1)
    await endSession($, clock)
  }
  const saved = store.get('memory')
  expect(saved).toEqual(expect.objectContaining({ version: 1 }))
  expect(JSON.stringify(saved)).not.toContain('Rate limiter') // results never persist

  // The next session's first prompt fires the learned opener.
  upstream.length = 0
  await startSession($, clock, 'Anything new?')
  await clock.advance(1_000)
  expect(upstream.filter(u => u.by === 'plugin').map(u => u.tool)).toContain('mcp__gh__list_issues')
})

test('a prompt naming a pull request prefetches it before the model asks', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  await startSession($, clock)
  // One real call teaches Speculate the tool is a read and its argument shape.
  await call($, clock, 'mcp__gh__get_pull_request', { owner: 'acme', repo: 'api', pull_number: 3 })

  upstream.length = 0
  const submitted = $.prompt.submit({ text: 'Review https://github.com/acme/api/pull/7' } as never)
  await clock.advance(1_000)
  await submitted
  expect(upstream).toEqual([
    { tool: 'mcp__gh__get_pull_request', args: { owner: 'acme', repo: 'api', pull_number: 7 }, by: 'plugin' },
  ])
  const got = await call($, clock, 'mcp__gh__get_pull_request', { owner: 'acme', repo: 'api', pull_number: 7 })
  expect(JSON.parse(got.text).title).toBe('PR 7')
  expect(upstream.filter(u => u.by === 'model')).toEqual([])
})

test('a prompt that names an issue prefetches its read, once two such prompts were seen', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  const issue = (issue_number: number) => ({ owner: 'acme', repo: 'api', issue_number })
  const ask = async (text: string) => {
    const submitted = $.prompt.submit({ text } as never)
    await clock.advance(1_000)
    await submitted
  }
  await startSession($, clock)
  // Two exchanges: the person names an issue, the model reads it.
  await ask('Read issue 7 and summarise it.')
  await call($, clock, 'mcp__gh__get_issue', issue(7))
  await ask('Read issue 8 and summarise it.')
  await call($, clock, 'mcp__gh__get_issue', issue(8))

  // A third issue, never read before: its number is in the prompt, and the
  // read starts while the model is still reading it.
  upstream.length = 0
  await ask('Read issue 42 and summarise it.')
  expect(upstream).toEqual([{ tool: 'mcp__gh__get_issue', args: issue(42), by: 'plugin' }])
  const got = await call($, clock, 'mcp__gh__get_issue', issue(42))
  expect(JSON.parse(got.text).title).toBe('Rate limiter drops burst traffic')
  expect(upstream.filter(u => u.by === 'model')).toEqual([])

  // A prompt that names nothing the reads were ever taken from starts nothing.
  upstream.length = 0
  await ask('Thanks. What does "flaky" mean here?')
  expect(upstream).toEqual([])
})

test('prefetches reads together on a server the agent itself ran reads together on', WATCHING, async ($, on) => {
  const { clock, upstream } = world(on)
  const GET_41 = { owner: 'acme', repo: 'api', issue_number: 41 }
  const prefetchedGets = () => upstream.filter(u => u.by === 'plugin' && u.tool === 'mcp__gh__get_issue').length
  /** The model issues both reads in one step: they run at the same time. */
  const readBoth = async () => {
    const pending = [GET_41, GET_42].map(args => $.tool.call({ tool: 'mcp__gh__get_issue', ...args } as never))
    await clock.advance(1_000)
    await Promise.all(pending)
  }
  await startSession($, clock)
  for (let round = 0; round < 3; round++) {
    await call($, clock, 'mcp__gh__list_issues', LIST)
    await readBoth()
  }

  // The list now predicts both reads. A get takes 400 ms, so within 300 ms of
  // the list's answer a server taken one call at a time has started only one.
  const before = prefetchedGets()
  const listing = $.tool.call({ tool: 'mcp__gh__list_issues', ...LIST } as never)
  await clock.advance(400)
  await listing
  for (let step = 0; step < 3; step++) await clock.advance(100)
  expect(prefetchedGets() - before).toBe(2)

  // Both were ready when the model asked: neither read went to the server again.
  await clock.advance(500)
  const mark = upstream.length
  await readBoth()
  expect(upstream.slice(mark).filter(u => u.by === 'model')).toEqual([])
})

const FIRST = { timeoutMs: 20_000 }

test('names the tools a session offers once its first turn ends', FIRST, async ($, on) => {
  const { clock, upstream, configured } = world(on)
  await startSession($, clock)
  // No names yet, so it is asked about every call, and the turn runs as ever:
  // the chain is learned and served.
  expect(configured).toEqual([])
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  const before = upstream.length
  await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(upstream.slice(before).filter(u => u.by === 'model')).toEqual([])
  expect((await $.command.run({ command: 'speculate' } as never)).text).toContain('Watching every tool call until the list')

  // The turn ends: it asks the host to keep this session's MCP tools in the
  // plugin's option, sorted, under the plugin's own key. The host reloads a
  // module whose option changed.
  await endTurn($)
  expect(configured).toEqual([{ key: 'speculate.tools', value: NAMED.tools }])
  // Where the host did not reload it after all, it does not ask again.
  await endTurn($)
  await endTurn($)
  expect(configured).toHaveLength(1)
})

test('has nothing to keep once it names every tool the session offers', WATCHING, async ($, on) => {
  const { clock, configured } = world(on)
  await startSession($, clock)
  await endTurn($)
  expect(configured).toEqual([])
})

test('works with every call watched where the settings do not keep the names', FIRST, async ($, on) => {
  const { clock, upstream, configured } = world(on, { refuseConfig: true })
  await startSession($, clock)
  await endTurn($)
  expect(configured).toHaveLength(1)
  await learnChain($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  expect(upstream.at(-1)).toEqual({ tool: 'mcp__gh__get_issue', args: GET_42, by: 'plugin' })

  // Asked about every call, it has the host's own verdict on a built-in one:
  // a read leaves the prefetched issue, a shell command does not.
  await call($, clock, 'Read', { file_path: '/work/README.md' })
  let before = upstream.length
  await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(upstream.slice(before).filter(u => u.by === 'model')).toEqual([])

  await call($, clock, 'mcp__gh__list_issues', LIST)
  await clock.advance(2_000)
  await call($, clock, 'Bash', { command: 'gh issue edit 42 --title Renamed' })
  before = upstream.length
  await call($, clock, 'mcp__gh__get_issue', GET_42)
  expect(upstream.slice(before).filter(u => u.by === 'model').map(u => u.tool)).toEqual(['mcp__gh__get_issue'])

  // It asks once, not at the end of every turn, and says how it is running.
  await endTurn($)
  expect(configured).toHaveLength(1)
  const report = await $.command.run({ command: 'speculate' } as never)
  expect(report.text).toContain('your settings did not keep the list of MCP tools')
})

test('hears of a tool it does not name once it has run, and names it when the turn ends', {
  timeoutMs: 20_000,
  options: { tools: Object.keys(TOOLS).filter(name => name !== 'mcp__gh__get_pull_request').sort().join(',') },
}, async ($, on) => {
  const { clock, upstream, configured } = world(on)
  const PULL = { owner: 'acme', repo: 'api', pull_number: 3 }
  // A server connected since the names were kept offers a tool the hook does not name.
  await startSession($, clock, 'Read pull request 3.')
  for (let i = 0; i < 3; i++) {
    const got = await call($, clock, 'mcp__gh__get_pull_request', PULL)
    await settled($, 'mcp__gh__get_pull_request', PULL, [{ type: 'text', text: got.text }])
    await clock.advance(1_000)
  }
  // It learned the tool is there. It was never asked about it before a run,
  // so it has no word that the tool only reads, and it prefetches nothing for it.
  const report = await $.command.run({ command: 'speculate' } as never)
  expect(report.text).toContain(`Known MCP tools: 1, prefetchable reads: 0`)
  expect(report.text).toContain(`Watching ${Object.keys(TOOLS).length - 1} MCP tools by name.`)
  expect(upstream.filter(u => u.by === 'plugin')).toEqual([])

  // The turn ends, and it names the tool with the rest.
  await endTurn($)
  expect(configured).toEqual([{ key: 'speculate.tools', value: NAMED.tools }])
})

test('/speculate reports, and /speculate forget clears what was learned', WATCHING, async ($, on) => {
  const { clock, store } = world(on)
  await startSession($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  const report = await $.command.run({ command: 'speculate' } as never)
  expect(report.text).toContain('Known MCP tools: 1')
  expect(report.text).toContain(`Watching ${Object.keys(TOOLS).length} MCP tools by name.`)

  const forgot = await $.command.run({ command: 'speculate', args: 'forget' } as never)
  expect(forgot.text).toContain('forgot')
  expect(store.has('memory')).toBe(false)
  const after = await $.command.run({ command: 'speculate' } as never)
  expect(after.text).toContain('Known MCP tools: 0')
})
