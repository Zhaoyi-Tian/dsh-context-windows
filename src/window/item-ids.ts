/** Codex-style `[id: #N]` markers after non-assistant items, applied as a message projection. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage, type Message } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionSeq, type Session, type SessionEvent, type SessionEventType } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'

const RECORD = 'plugin:dsh-context-windows/item-ids'
const recordSchema = z.object({
  version: z.literal(1),
  seqs: z.array(z.number().int().nonnegative().transform(SessionSeq)).min(1),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-context-windows/item-ids': z.infer<typeof recordSchema> }
}

const marker = (seq: number) => `[id: #${seq}]`

/** Snapshots the host replaces as a whole, and this plugin's own window notices. */
const UNMARKED_SOURCES: ReadonlySet<string> = new Set(['runtime-context', 'context-window'])

/** Like Codex's non-assistant items: every user-role message and tool result, except system and unmarked sources. */
function itemMessage(event: SessionEvent | undefined): Message | undefined {
  if (event?.type === 'user/message') return UNMARKED_SOURCES.has(event.data.source.kind) ? undefined : event.data
  if (event?.type === 'tool/result') return event.data.message
  return undefined
}

function isMarked(message: Message, seq: number): boolean {
  const last = message.content.at(-1)
  return last?.type === 'text' && last.text === marker(seq)
}

/**
 * A plugin record rather than a SessionEventMap event: without this plugin, DSH skips the
 * ignorable record and restores the session unmarked instead of refusing it.
 */
const itemIdsProjection = {
  type: RECORD as SessionEventType,
  project(event, context) {
    const parsed = recordSchema.safeParse(event.data)
    if (!parsed.success) throw new Error(`${RECORD}: data must contain a nonempty seqs array`)
    const nodes = new Set(context.nodes)
    const messages = new Map<SessionSeq, Message>()
    for (const seq of parsed.data.seqs) {
      const message = nodes.has(seq) ? context.messages.get(seq) ?? itemMessage(context.events[seq - context.baseSeq]) : undefined
      if (message === undefined) throw new Error(`${RECORD}: seq ${seq} is not a current item`)
      messages.set(seq, freezeMessage({ ...message, content: [...message.content, { type: 'text', text: marker(seq) }] }))
    }
    return messages
  },
} satisfies SessionMessageProjection

/** Register the projection; markers change only model-facing content, never the logged events. */
export function registerItemIds(ctx: Context): void {
  ctx.sessions.registerMessageProjection(itemIdsProjection)
}

/** Mark every unmarked item in the active surface before the next request. */
export function markItems(session: Session): void {
  const seqs = session.surface.nodes.filter(seq => {
    const event = session.eventAt(seq)
    if (itemMessage(event) === undefined) return false
    const message = session.deriveEventMessage(event!)
    return message !== null && !isMarked(message, seq)
  })
  if (seqs.length > 0) appendPluginRecord(session, RECORD, { version: 1, seqs })
}
