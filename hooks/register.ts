/**
 * Speculate as a Claude Code mod.
 *
 * Claude Code raises `tool.call` for every MCP call the model makes. This
 * module answers a call from a prefetched result when it holds one for
 * exactly that call and the host would run the call without asking;
 * otherwise the call runs through Claude Code as normal and the speculator
 * learns from it. `prompt.submit` and `session.start` feed it the two
 * earlier signals: the person's words and the session's habitual openers.
 *
 * Every host operation is spelled here, inside a hook, and handed to the
 * speculator as a closure (SpeculationIo). The speculator itself is pure.
 */
import type { Register } from 'claude-code'
import { addUsage, mcpToolName, parseMcpToolName, Speculator, type SpeculationIo } from '../src/speculator.js'
import { MemoryCodec } from '../src/persistence.js'
import { settingsToolWatch } from '../src/hookGuard.js'
import { formatReport } from '../src/report.js'
import type { ToolResult } from '../src/types.js'

const MEMORY_KEY = 'memory'
const TOTALS_KEY = 'totals'
const SAVE_DELAY_MS = 2_000
const SWEEP_EVERY_MS = 5_000
/** Head room a join leaves in the hook's own 10 s budget for the real call path. */
const JOIN_MARGIN_MS = 1_500
/** The `tool.call` keys that are the engine's, never the tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
/** The PreToolUse refusal that stops a claimed call; the model never reads it. */
const SERVED = 'Speculate answered this call from a prefetched result.'

type Store = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

export const register: Register = on => {
  // Module state starts over on a reload; learned memory comes back from the
  // store at the next session.start, which a reload raises too.
  let speculator = new Speculator()
  let codec = new MemoryCodec()
  let savedRevision = speculator.revision
  let saveQueued = false
  let saving: Promise<void> = Promise.resolve()
  /** tool_use_ids of calls a prefetched result is waiting to answer. */
  const claimed = new Set<string>()

  const persist = (store: Store): Promise<void> => {
    saving = saving.then(async () => {
      const revision = speculator.revision
      const delta = speculator.usageDelta()
      if (revision !== savedRevision) {
        const latest = await store.get(MEMORY_KEY)
        await store.set(MEMORY_KEY, codec.encode(speculator.exportMemory(), latest))
        savedRevision = revision
      }
      if (Object.values(delta).some(value => value !== 0)) {
        await store.set(TOTALS_KEY, addUsage(await store.get(TOTALS_KEY), delta))
      }
    }).catch(() => {})
    return saving
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      speculator.importMemory(codec.load(await $.store.get(MEMORY_KEY)))
      savedRevision = speculator.revision
    } catch {
      // A store that cannot be read is a cold start, never an error.
    }
    await $.command.register({
      name: 'speculate',
      description: 'Show what Speculate prefetched and saved; `/speculate forget` clears what it learned',
      argumentHint: '[forget]',
    })
    $.clock.every(SWEEP_EVERY_MS, () => speculator.sweep())

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (!speculator.enabled || 'drop' in result) return result
    // Settings may have changed since the last prompt; so may the tools. The
    // first prompt is when a server's openers fire: MCP servers are connected
    // by then, and the model is about to spend seconds reading the prompt.
    const watch = settingsToolWatch(await $.settings.read())
    speculator.tools.setHooked((server, tool) => watch(mcpToolName(server, tool)))
    const io: SpeculationIo = {
      call: (server, tool, args) => $.mcp.call(server, tool, args) as Promise<ToolResult>,
      authorize: async (server, tool, args) =>
        (await $.tool.check({ tool: mcpToolName(server, tool), input: args })).decision === 'allow',
      sleep: ms => $.clock.sleep(ms),
    }
    speculator.sessionStart((await $.tool.list()).filter(info => info.mcp).map(info => info.name), io)
    speculator.prompt(e.text, await $.session.cwd(), io)
    return result
  }).catch(($, e, next) => next(e))

  // A claimed call runs through the host as far as its PreToolUse hooks.
  // When they let it through unchanged, this hook stops it before the tool
  // runs, and the tool.call hook answers with the claimed result. When they
  // deny, ask, or rewrite it, the call goes on exactly as it would have.
  on('classic.PreToolUse', async ($, e, next) => {
    const decision = await next(e)
    if (!claimed.has(e.tool_use_id)) return decision
    if (decision.deny !== undefined || decision.ask !== undefined || decision.updatedInput !== undefined) {
      return decision
    }
    return { deny: SERVED }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const name = parseMcpToolName(String(e.tool))
    // Only the model's own calls are served or learned from. A plugin's call
    // (this mod's own prefetches through $.mcp.call among them) runs through
    // the host untouched: its permission check, its hooks, the tool.
    if (!name || !speculator.enabled || next.origin.plugin !== 'engine') return next(e)
    const { server, tool } = name
    const args: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(e)) if (!RESERVED.has(key)) args[key] = value

    const io: SpeculationIo = {
      call: (s, t, a) => $.mcp.call(s, t, a) as Promise<ToolResult>,
      authorize: async (s, t, a) =>
        (await $.tool.check({ tool: mcpToolName(s, t), input: a })).decision === 'allow',
      sleep: ms => $.clock.sleep(ms),
    }
    const save = (): void => {
      if (saveQueued || speculator.revision === savedRevision) return
      saveQueued = true
      $.clock.after(SAVE_DELAY_MS, () => {
        saveQueued = false
        void persist({ get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) })
      })
    }

    const stop = new AbortController()
    const deadline = $.clock
      .sleep(Math.max(0, next.budget.remainingMs - JOIN_MARGIN_MS), { signal: stop.signal })
      .catch(() => new Promise<never>(() => {}))
    const claim = await speculator.serve(server, tool, args, io, deadline)
    stop.abort()

    const started = speculator.beginReal(server)
    const startedAt = await $.clock.now()
    if (claim) claimed.add(e.tool_use_id)
    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
    } finally {
      claimed.delete(e.tool_use_id)
    }

    if (claim && ran.isError === true && ran.text === SERVED) {
      claim.commit()
      speculator.observeServed(server, tool, args, claim, io)
      const { hits, joins, estimatedSavedMs } = speculator.stats()
      $.ui.status(`speculate: ${hits + joins} served, ${(estimatedSavedMs / 1000).toFixed(1)}s saved`)
      save()
      return { result: claim.result.content }
    }
    // The hooks had another say, or this session runs no plugin PreToolUse
    // hooks (an organization's managed settings): the tool ran for real.
    claim?.discard('tool-hooks')
    const endedAt = await $.clock.now()
    const outcome = ran.deny !== undefined
      ? null
      : {
          result: toToolResult(ran.result, ran.text, ran.isError === true),
          isReadOnly: ran.isReadOnly === true,
          servable: Array.isArray(ran.result) && ran.isError !== true,
          isError: ran.isError === true,
          latencyMs: endedAt - startedAt,
        }
    speculator.observe(server, tool, args, outcome, io, started)
    save()
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'speculate' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'forget') {
      speculator.close()
      await $.store.delete(MEMORY_KEY)
      await $.store.delete(TOTALS_KEY)
      speculator = new Speculator()
      codec = new MemoryCodec()
      savedRevision = speculator.revision
      return { text: 'Speculate forgot everything it learned, and cleared its totals.' }
    }
    await persist({ get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) })
    return { text: formatReport(speculator.stats(), await $.store.get(TOTALS_KEY), speculator.tools.exportState()) }
  })

  on('session.end', async ($, e, next) => {
    speculator.close()
    await persist({ get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) })
    return next(e)
  })
}

/** The host's record of an MCP call as an MCP result, for the learner. */
function toToolResult(record: unknown, text: string | undefined, isError: boolean): ToolResult {
  const content = Array.isArray(record)
    ? record.filter((block): block is ToolResult['content'][number] =>
        block !== null && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string')
    : [{ type: 'text', text: text ?? '' }]
  return { content, isError }
}
