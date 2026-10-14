/** Window state folded from committed session events. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

const seqSchema = z.number().int().nonnegative().transform(SessionSeq)

/** JSON checkpoint schema for the window projection. */
export const windowStateSchema = z.object({
  // Always includes w0; the fold preserves this nonempty invariant.
  windows: z.array(z.object({ id: z.string().regex(/^w\d+$/), startSeq: seqSchema })).min(1),
  newContextCalls: z.array(z.string().transform(ToolCallId)),
  requested: z.boolean(),
  opened: z.boolean(),
  reminded: z.boolean(),
  fellBack: z.boolean(),
  conversationItems: z.number().int().nonnegative(),
  systemHeadSeq: seqSchema.nullable(),
})

export type ContextWindowState = z.infer<typeof windowStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { contextWindow: ContextWindowState }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'context-window': { kind: 'context-window'; windowId: string } & (
      | { event: 'open'; form: 'instructions' }
      | { event: 'reminder' | 'fallback'; form: 'notice'; summary: string }
    )
  }
}

/** Initialize the first window before its open message. */
export function initialWindowState(): ContextWindowState {
  return {
    windows: [{ id: 'w0', startSeq: SessionSeq(0) }],
    newContextCalls: [],
    requested: false,
    opened: false,
    reminded: false,
    fellBack: false,
    conversationItems: 0,
    systemHeadSeq: null,
  }
}

/** Fold one committed event, preserving identity for unrelated events. */
export function foldWindow(state: ContextWindowState, event: SessionEvent): ContextWindowState {
  if (event.type === 'system/message') {
    if (state.systemHeadSeq === null
      || (event.surfaceOp !== 'append' && event.surfaceOp.startSeq === state.systemHeadSeq)) {
      return { ...state, systemHeadSeq: event.seq }
    }
    return state
  }
  if (event.type === 'user/message' && event.data.source.kind === 'context-window') {
    const source = event.data.source
    if (source.event === 'open') {
      if (event.surfaceOp !== 'append') {
        return {
          ...initialWindowState(),
          systemHeadSeq: state.systemHeadSeq,
          windows: [...state.windows, { id: source.windowId, startSeq: event.seq }],
          opened: true,
        }
      }
      return { ...state, opened: true }
    }
    if (source.windowId !== state.windows.at(-1)!.id) return state
    return source.event === 'reminder'
      ? { ...state, reminded: true }
      : { ...state, fellBack: true }
  }
  if (event.type === 'tool/call' && event.data.name === 'new_context') {
    return { ...state, newContextCalls: [...state.newContextCalls, event.data.callId] }
  }
  if (event.type === 'tool/ptc-dispatch'
    && event.data.name === 'new_context' && !event.data.isError) {
    return { ...state, requested: true }
  }
  if (event.type === 'tool/result') {
    const pending = state.newContextCalls.filter(id => id !== event.data.message.toolCallId)
    return {
      ...state,
      conversationItems: state.conversationItems + 1,
      newContextCalls: pending,
      requested: state.requested || (pending.length < state.newContextCalls.length && event.data.message.isError !== true),
    }
  }
  if (event.type === 'assistant/message'
    || (event.type === 'user/message' && event.data.source.kind === 'user')) {
    return { ...state, conversationItems: state.conversationItems + 1 }
  }
  return state
}

/** Available throughout the plugin's lifetime. */
export function windowState(ctx: Context, session: Session): ContextWindowState {
  return ctx.sessionProjections.stateOf(session, 'contextWindow')!
}
