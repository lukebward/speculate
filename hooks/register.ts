/**
 * Speculate as a Claude Code mod.
 *
 * Claude Code raises `tool.run` when a call has been allowed and is about to
 * run: after the permission check, after the person's PreToolUse hooks, after
 * any question about it was answered. This module answers such a call from a
 * prefetched result when it holds one for exactly that call; otherwise the
 * tool runs and the speculator learns from it. `prompt.submit` and
 * `session.start` feed it the two earlier signals: the person's words and the
 * session's habitual openers.
 *
 * The hook names the MCP tools it is for, and no other tool. Claude Code
 * treats a tool that a mod may answer with more caution, so a hook on every
 * tool call costs every tool something (src/watch.ts). The names are whatever
 * servers the person has connected, which nothing knows when hooks register,
 * so the module keeps them itself in its one option, written when a turn
 * ends, and Claude Code reloads it when that option changes. Until there are
 * names it is asked about every call. A call it is not asked about before it
 * runs (a built-in tool, an MCP tool it does not name yet) it hears of
 * afterwards, at PostToolUse.
 *
 * Every host operation is spelled here, inside a hook or a function a hook
 * hands `$` to, and reaches the speculator as a closure (SpeculationIo). The
 * speculator itself is pure.
 */
import type { EngineInterface, Register } from 'claude-code'
import { addUsage, mcpToolName, parseMcpToolName, Speculator, type SpeculationIo } from '../src/speculator.js'
import { MemoryCodec } from '../src/persistence.js'
import { mayWriteByName, mayWriteOutside } from '../src/sideEffects.js'
import { recordOf } from '../src/tools.js'
import { formatReport, type Watch } from '../src/report.js'
import { mergeWatched, WATCH_OPTION, watchedTools, watchOption } from '../src/watch.js'
import type { ToolResult } from '../src/types.js'

const MEMORY_KEY = 'memory'
const TOTALS_KEY = 'totals'
const SAVE_DELAY_MS = 2_000
const SWEEP_EVERY_MS = 5_000
/** The longest a call waits for a prefetch of it that is still in flight. */
const MAX_JOIN_WAIT_MS = 8_500
/** This plugin's name: what Claude Code keys its option by (`<plugin>.<field>`). */
const PLUGIN = 'speculate'
/** The call's keys that are the engine's, never the tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

type Store = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

/** The host as the speculator's hands: its own MCP calls, its permission check, its clock. */
function hostIo($: EngineInterface): SpeculationIo {
  return {
    call: (server, tool, args) => $.mcp.call(server, tool, args) as Promise<ToolResult>,
    authorize: async (server, tool, args) =>
      (await $.tool.check({ tool: mcpToolName(server, tool), input: args })).decision === 'allow',
    sleep: ms => $.clock.sleep(ms),
  }
}

/** The plugin's own store. */
function hostStore($: EngineInterface): Store {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) }
}

export const register: Register = (on, options) => {
  /** The MCP tools the `tool.run` hook names: what this module last kept in its option. */
  const watched = watchedTools(options[WATCH_OPTION])
  const names = new Set(watched)
  /** With names, the hook is for those tools alone. With none yet, it is asked about every call. */
  const named = watched.length > 0
  /** The MCP tools this session offers, as of its last prompt. */
  let offered: string[] = []
  /** The value this instance asked the host to keep; the host reloads the module when it does. */
  let asked: string | null = null
  /** The host's settings would not keep the names, or kept them and did not reload: no more is asked. */
  let refused = false

  // Module state starts over on a reload; learned memory comes back from the
  // store at the next session.start, which a reload raises too.
  const fresh = (): Speculator => {
    const made = new Speculator()
    // A prefetch for a tool the hook is not asked about could never be used.
    if (named) made.tools.setWatched((server, tool) => names.has(mcpToolName(server, tool)))
    return made
  }
  let speculator = fresh()
  let codec = new MemoryCodec()
  let savedRevision = speculator.revision
  let saveQueued = false
  let saving: Promise<void> = Promise.resolve()

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
  /** Saves soon, once, however many calls ask. */
  const saveSoon = (after: (ms: number, run: () => void) => unknown, store: Store): void => {
    if (saveQueued || speculator.revision === savedRevision) return
    saveQueued = true
    after(SAVE_DELAY_MS, () => {
      saveQueued = false
      void persist(store)
    })
  }
  const watch = (): Watch => (named ? { named: watched.length } : { all: refused ? 'refused' : 'unsaved' })

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
    // MCP servers are connected by the first prompt, and the model is about
    // to spend seconds reading it.
    offered = (await $.tool.list()).filter(info => info.mcp).map(info => info.name)
    const io = hostIo($)
    speculator.sessionStart(offered, io)
    speculator.prompt(e.text, await $.session.cwd(), io, await $.clock.now())
    return result
  }).catch(($, e, next) => next(e))

  // The turn is over, and nothing is in flight that a reload would lose: name
  // the tools this session offers, where the hook does not name them yet. The
  // host keeps the names in this plugin's option and reloads the module with
  // them. (Asked at the prompt instead, the reload would cost the module that
  // prompt: what it names, and the reads it starts.)
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn ends inside the turn that spawned it, which goes on.
    if (!speculator.enabled || refused || e.agentId !== undefined) return result
    const wanted = mergeWatched(watched, offered)
    if (wanted === null) return result
    const value = watchOption(wanted)
    // Kept before, and this module is still the one running: it will not be reloaded.
    if (value === asked) {
      refused = true
      return result
    }
    await persist(hostStore($))
    asked = value
    const kept = await $.config
      .set({ key: `${PLUGIN}.${WATCH_OPTION}`, value })
      .then(set => !('deny' in set && set.deny !== undefined), () => false)
    if (!kept) refused = true
    return result
  })

  // A call the host has allowed, about to run. Only the model's own calls are
  // served or learned from: a plugin's call (this mod's prefetches through
  // $.mcp.call among them) runs untouched. A hook here that fails is skipped
  // and the tool runs, which is what a failure of this one should come to.
  on('tool.run', (named ? { tool: watched } : {}) as { tool?: RegExp[] }, async ($, e, next) => {
    if (!speculator.enabled || next.origin.plugin !== 'engine') return next(e)
    const name = parseMcpToolName(String(e.tool))
    if (!name) {
      // Asked about every call, for want of names: a shell command or a file
      // edit can change what any server would return, so once one that may
      // have written settles, nothing prefetched before it is kept.
      try {
        const ran = await next(e)
        if (mayWriteOutside(String(e.tool), ran)) speculator.externalWrite()
        return ran
      } catch (err) {
        speculator.externalWrite() // interrupted partway: assume it wrote
        throw err
      }
    }
    const { server, tool } = name
    const args: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(e)) if (!RESERVED.has(key)) args[key] = value
    const io = hostIo($)

    // When the model made this call: with when it gets its answer, what
    // tells the learner a step of several calls from a sequence of them.
    const beganAt = await $.clock.now()
    // The wait for a prefetch still in flight is bounded by a host timer,
    // started only if there is such a prefetch to wait for.
    let stop: AbortController | undefined
    const deadline = (): Promise<unknown> => {
      stop = new AbortController()
      return $.clock.sleep(MAX_JOIN_WAIT_MS, { signal: stop.signal }).catch(() => new Promise<never>(() => {}))
    }
    // The host allowed this exact call before it asked: it is not asked again.
    let claim = await speculator.serve(server, tool, args, io, deadline, MAX_JOIN_WAIT_MS, true)
    const waited = stop !== undefined
    stop?.abort()
    // The answer goes back in the form the host recorded this tool's real
    // result in. A prefetch that cannot take that form is not the record.
    const answer = claim ? recordOf(claim.result, speculator.tools.form(server, tool)) : null
    if (claim && answer === null) {
      claim.discard('record-form')
      claim = null
    }

    const started = speculator.beginReal(server, claim !== null)
    if (claim) {
      claim.commit()
      speculator.observeServed(server, tool, args, claim, io, { startedAt: beganAt, endedAt: await $.clock.now() })
      const { hits, joins, estimatedSavedMs } = speculator.stats()
      $.ui.status(`speculate: ${hits + joins} served, ${(estimatedSavedMs / 1000).toFixed(1)}s saved`)
      saveSoon((ms, run) => $.clock.after(ms, run), hostStore($))
      return { result: answer }
    }

    // A join that came to nothing waited; the tool's own latency starts after it.
    const startedAt = waited ? await $.clock.now() : beganAt
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (err) {
      speculator.observe(server, tool, args, null, io, started)
      throw err
    }
    const endedAt = await $.clock.now()
    const outcome = ran.deny !== undefined
      ? null
      : {
          result: toToolResult(ran.result, ran.text, ran.isError === true),
          isReadOnly: ran.isReadOnly === true,
          // Content blocks, or the one text the host keeps for a tool that
          // returns structured content: either can be handed back as it came.
          servable: ran.isError !== true && (Array.isArray(ran.result) || typeof ran.result === 'string'),
          form: typeof ran.result === 'string' ? ('text' as const) : ('blocks' as const),
          isError: ran.isError === true,
          latencyMs: endedAt - startedAt,
          span: { startedAt: beganAt, endedAt },
        }
    speculator.observe(server, tool, args, outcome, io, started)
    saveSoon((ms, run) => $.clock.after(ms, run), hostStore($))
    return ran
  })

  // What the hook above is not asked about, heard of once it has run: with
  // names, that is every built-in tool and any MCP tool not named yet. The
  // host gives no read-only verdict here, so a built-in call is judged by its
  // tool's name, and an MCP tool that was never seen run counts as a write.
  on('classic.PostToolUse', async ($, e, next) => {
    if (named && speculator.enabled && next.origin.plugin === 'engine') {
      const toolName = String(e.tool_name)
      const name = parseMcpToolName(toolName)
      if (!name) {
        if (mayWriteByName(toolName)) speculator.externalWrite()
      } else if (!names.has(toolName)) {
        const endedAt = await $.clock.now()
        const took = typeof e.duration_ms === 'number' && e.duration_ms >= 0 ? e.duration_ms : 0
        speculator.observeLate(name.server, name.tool, argsOf(e.tool_input), {
          result: toToolResult(e.tool_response, undefined, false),
          form: typeof e.tool_response === 'string' ? 'text' : 'blocks',
          isError: false,
          latencyMs: took,
          span: { startedAt: endedAt - took, endedAt },
        }, hostIo($))
        saveSoon((ms, run) => $.clock.after(ms, run), hostStore($))
      }
    }
    return next(e)
  })

  // The same for a call that failed or was interrupted: it may have run partway.
  on('classic.PostToolUseFailure', async ($, e, next) => {
    if (named && speculator.enabled && next.origin.plugin === 'engine') {
      const toolName = String(e.tool_name)
      const name = parseMcpToolName(toolName)
      if (!name) {
        if (mayWriteByName(toolName)) speculator.externalWrite()
      } else if (!names.has(toolName)) {
        speculator.observeLate(name.server, name.tool, argsOf(e.tool_input), {
          result: toToolResult(String(e.error ?? ''), undefined, true),
          form: 'text',
          isError: true,
          latencyMs: typeof e.duration_ms === 'number' && e.duration_ms >= 0 ? e.duration_ms : 0,
        }, hostIo($))
      }
    }
    return next(e)
  })

  on('command.run', { command: 'speculate' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'forget') {
      speculator.close()
      await $.store.delete(MEMORY_KEY)
      await $.store.delete(TOTALS_KEY)
      speculator = fresh()
      codec = new MemoryCodec()
      savedRevision = speculator.revision
      return { text: 'Speculate forgot everything it learned, and cleared its totals.' }
    }
    await persist(hostStore($))
    return { text: formatReport(speculator.stats(), await $.store.get(TOTALS_KEY), speculator.tools.exportState(), watch()) }
  })

  on('session.end', async ($, e, next) => {
    speculator.close()
    await persist(hostStore($))
    return next(e)
  })
}

/** A call's arguments as the settings hooks carry them. */
function argsOf(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {}
}

/** The host's record of an MCP call as an MCP result, for the learner. */
function toToolResult(record: unknown, text: string | undefined, isError: boolean): ToolResult {
  const content = Array.isArray(record)
    ? record.filter((block): block is ToolResult['content'][number] =>
        block !== null && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string')
    : [{ type: 'text', text: typeof record === 'string' ? record : text ?? '' }]
  return { content, isError }
}
