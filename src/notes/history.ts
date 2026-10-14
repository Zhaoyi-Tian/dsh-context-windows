/** Window-scoped history tools over DSH's event query service. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEventType } from '@deepseek-ai/dsh-session'
import { extractSessionEventText, type SessionEventResultFilter } from '@deepseek-ai/dsh-session-query'
import { defineTool, type InferArgs, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { windowState } from '../window/windows.js'
import { sessionFor, TEXT_OUTPUT } from '../tools.js'
import { countArg } from './notes.js'

const FILTERS = {
  window_id: { type: 'string', description: 'Optional window ID from history_list_windows.' },
  event_type: { type: 'string', description: 'Optional DSH event type, such as user/message or tool/result.' },
  recent_first: { type: 'boolean', description: 'Newest first when true; otherwise chronological.' },
  limit: { type: 'integer', description: 'Maximum results; default 50.' },
} as const

/** Register history tools; DSH owns text extraction, matching, and exact event reads. */
export function registerHistory(ctx: Context): void {
  const scope = (exec: ToolRunContext) => {
    const session = sessionFor(exec)
    const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')?.lastStepStartSeq
    if (boundary == null) {
      throw new HarnessError('History requires the turnBoundary projection and an admitted agent step', 'HISTORY_NOTES_NO_STEP')
    }
    const windows = windowState(ctx, session).windows.filter(window => window.id === 'w0' || window.startSeq < boundary)
    return { sessionId: session.header.id, boundary, windows }
  }
  const label = (seq: number, type: string, windows: ReturnType<typeof scope>['windows']) =>
    `#${seq} [${windows.findLast(window => window.startSeq <= seq)!.id}] ${type}`
  const list = async (args: InferArgs<typeof FILTERS> & { query?: string }, exec: ToolRunContext) => {
    const { sessionId, boundary, windows } = scope(exec)
    const selected = args.window_id === undefined ? undefined : windows.find(window => window.id === args.window_id)
    if (args.window_id !== undefined && !selected) return `Unknown window ${args.window_id}; use history_list_windows.`
    const from = selected?.startSeq ?? 0
    const to = (selected ? windows[windows.indexOf(selected) + 1]?.startSeq ?? boundary : boundary) - 1
    const filters: SessionEventResultFilter[] = [{ kind: 'seq', from, to }]
    if (args.event_type !== undefined) filters.push({ kind: 'type', values: [args.event_type as SessionEventType] })
    if (args.query !== undefined) filters.push({ kind: 'text', text: args.query })
    const limit = countArg(args.limit, 50, 'limit')
    const items = from > to || limit === 0 ? [] : await ctx.sessionQuery.filterEvents(sessionId, filters)
    if (args.recent_first) items.reverse()
    return items.slice(0, limit)
      .map(item => `${label(item.seq, item.type, windows)}: ${item.text.slice(0, 200).replaceAll('\n', ' ')}`)
      .join('\n') || 'No matching history.'
  }

  ctx.tools.register(defineTool({
    name: 'history_list_windows',
    description: 'List this session’s context windows and inclusive event-sequence ranges before the current step.',
    parameters: { limit: FILTERS.limit, recent_first: FILTERS.recent_first },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { boundary, windows } = scope(exec)
      const rows = windows.map((window, i) => {
        const end = (windows[i + 1]?.startSeq ?? boundary) - 1
        const range = end < window.startSeq ? 'empty' : `#${window.startSeq}–#${end}`
        return `${window.id} (${range})${i === windows.length - 1 ? ' (current)' : ''}`
      })
      if (args.recent_first) rows.reverse()
      return rows.slice(0, countArg(args.limit, 50, 'limit')).join('\n') || 'No windows.'
    },
  }))
  ctx.tools.register(defineTool({
    name: 'history_list_items',
    description: 'List earlier text events in this session, optionally filtered by window and DSH event type.',
    parameters: FILTERS,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: list,
  }))
  ctx.tools.register(defineTool({
    name: 'history_search_contents',
    description: 'Search earlier text events in this session using DSH’s case-insensitive, whitespace-flexible literal matching.',
    parameters: { ...FILTERS, query: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: list,
  }))
  ctx.tools.register(defineTool({
    name: 'history_read_item',
    description: 'Read the complete text of an earlier event in this session. Large results follow the host’s spill policy.',
    parameters: {
      seq: { type: 'integer', required: true, description: 'Event sequence number shown as #N in history results or as [id: #N] after an item; pass N.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { sessionId, boundary, windows } = scope(exec)
      if (args.seq < 0 || args.seq >= boundary) return `No history item #${args.seq}.`
      const { target } = await ctx.sessionQuery.readEvent({ sessionId, seq: SessionSeq(args.seq) }, exec.signal)
      const text = extractSessionEventText(target)
      return text ? `${label(target.seq, target.type, windows)}\n${text}` : `No history text at #${args.seq}.`
    },
  }))
}
