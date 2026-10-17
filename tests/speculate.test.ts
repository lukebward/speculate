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
  mcp__gh__get_pull_request: {
    readOnly: true,
    latencyMs: 600,
    answer: args => ({ number: args.pull_number, title: `PR ${String(args.pull_number)}` }),
  },
}

interface Upstream {
  tool: string
  args: Args
  by: 'model' | 'plugin'
}

interface WorldOptions {
  allow?: readonly string[]
  store?: Record<string, unknown>
  settings?: Record<string, unknown>
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
  const allow = new Set(options.allow ?? Object.keys(TOOLS))
  const deny = denyPre

  const run = async (tool: string, args: Args) => {
    const fixture = TOOLS[tool]!
    await clock.sleep(fixture.latencyMs)
    return [{ type: 'text', text: JSON.stringify(fixture.answer(args)) }]
  }

  on('classic.PreToolUse', async ($, e, next) =>
    deny.has(String(e.tool)) ? { deny: 'a settings hook refused it' } : next(e))
  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: _id, ...args } = e as unknown as { tool: string; tool_use_id: string } & Args
    const fixture = TOOLS[tool]
    if (!fixture) return next(e)
    upstream.push({ tool, args, by: next.origin.plugin === 'engine' ? 'model' : 'plugin' })
    const content = await run(tool, args)
    return (fixture.readOnly
      ? { result: content, text: content[0]!.text, isReadOnly: true }
      : { result: content, text: content[0]!.text }) as never
  })
  on('mcp.call', async ($, e) => {
    const tool = `mcp__${e.server}__${e.tool}`
    upstream.push({ tool, args: e.args, by: 'plugin' })
    return { value: { content: await run(tool, e.args), isError: false } }
  })
  on('tool.check', async ($, e) => ({ decision: allow.has(e.tool) ? 'allow' : 'ask' }) as const)
  on('tool.list', async () => ({ value: Object.keys(TOOLS).map(name => ({ name, description: name, mcp: true })) }))
  on('settings.read', async () => ({ value: options.settings ?? {} }))
  on('session.cwd', async () => ({ value: '/work' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async ($, e) => e as never)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('command.register', async () => ({ value: undefined }) as never)

  return { clock, upstream, store }
}

type Kit = Parameters<Parameters<typeof test>[1] extends infer B ? B extends (...a: infer P) => unknown ? (...a: P) => unknown : never : never>[0]

/** Calls a tool as the model would, letting the clock run while it does. */
async function call(
  $: Kit,
  clock: ReturnType<typeof mock.clock>,
  tool: string,
  args: Args,
): Promise<{ text: string; isError: boolean }> {
  const pending = $.tool.call({ tool, ...args } as never) as Promise<{ result?: unknown; text?: string; isError?: boolean }>
  await clock.advance(1_000)
  const ran = await pending
  const text = typeof ran.text === 'string'
    ? ran.text
    : Array.isArray(ran.result) ? String((ran.result[0] as { text?: string })?.text ?? '') : ''
  return { text, isError: ran.isError === true }
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

test('learns a list-then-get chain and serves the get from a prefetch', { timeoutMs: 20_000 }, async ($, on) => {
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

test('never prefetches a tool the person has not allowed', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, upstream } = world(on, { allow: ['mcp__gh__list_issues'] })
  await startSession($, clock)
  await learnChain($, clock, 4)
  expect(upstream.filter(u => u.by === 'plugin' && u.tool === 'mcp__gh__get_issue')).toEqual([])
  // The allowed read in the same chain is still prefetched.
  expect(upstream.some(u => u.by === 'plugin' && u.tool === 'mcp__gh__list_issues')).toBe(true)
})

test('a PreToolUse hook that refuses the call wins over a prefetched result', { timeoutMs: 20_000 }, async ($, on) => {
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

test('a call that may write clears what was prefetched', { timeoutMs: 20_000 }, async ($, on) => {
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

test('a PostToolUse hook written for a tool keeps that tool out of speculation', { timeoutMs: 20_000 }, async ($, on) => {
  const settings = { hooks: { PostToolUse: [{ matcher: 'mcp__gh__get_issue', hooks: [{ type: 'command', command: 'true' }] }] } }
  const { clock, upstream } = world(on, { settings })
  await startSession($, clock)
  await learnChain($, clock, 4)
  expect(upstream.filter(u => u.by === 'plugin' && u.tool === 'mcp__gh__get_issue')).toEqual([])
  expect(upstream.some(u => u.by === 'plugin' && u.tool === 'mcp__gh__list_issues')).toBe(true)
})

test('what one session learned starts the next one', { timeoutMs: 20_000 }, async ($, on) => {
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

test('a prompt naming a pull request prefetches it before the model asks', { timeoutMs: 20_000 }, async ($, on) => {
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

test('/speculate reports, and /speculate forget clears what was learned', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, store } = world(on)
  await startSession($, clock)
  await call($, clock, 'mcp__gh__list_issues', LIST)
  const report = await $.command.run({ command: 'speculate' } as never)
  expect(report.text).toContain('Known MCP tools: 1')

  const forgot = await $.command.run({ command: 'speculate', args: 'forget' } as never)
  expect(forgot.text).toContain('forgot')
  expect(store.has('memory')).toBe(false)
  const after = await $.command.run({ command: 'speculate' } as never)
  expect(after.text).toContain('Known MCP tools: 0')
})
