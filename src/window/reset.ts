/** Opening a new window: replace the active conversation without a summary. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, HarnessError, type UserMessage } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import { windowBlock } from './prompts.js'
import { windowState } from './windows.js'
import type { ResolvedConfig } from '../config.js'
import { recentNotes } from '../notes/notes.js'

/** Guidance plus the `<context_window>` block for the newest of `ids`. */
export function openMessage(config: ResolvedConfig, ids: readonly string[], hints: readonly string[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: [config.prompts.guidance, windowBlock(ids, hints)].filter(Boolean).join('\n') }],
    source: { kind: 'context-window', windowId: ids.at(-1)!, event: 'open', form: 'instructions' },
  })
}

/** Replace everything after the system head; null when the window has no conversation yet. */
export function resetWindow(ctx: Context, session: Session, config: ResolvedConfig, signal: AbortSignal)
  : { windowId: string; seq: SessionSeq } | null {
  signal.throwIfAborted()
  const state = windowState(ctx, session)
  if (state.conversationItems === 0) return null
  const body = session.surface.nodes.filter(seq => seq !== state.systemHeadSeq)
  const start = body[0]
  const end = body.at(-1)
  // A system rewrite can shadow every conversation node without opening a window.
  if (start === undefined || end === undefined) return null
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw new HarnessError('context-window: cannot replace a span with unanswered tool calls', 'CONTEXT_WINDOW_PAIRING')
  }
  const windowId = `w${state.windows.length}`
  const message = openMessage(config, [...state.windows.map(window => window.id), windowId], recentNotes(ctx, session))
  const shadowedTokenCount = ctx.tokenMeter.measure(session).nodes
    .filter(node => node.seq !== state.systemHeadSeq)
    .reduce((sum, node) => sum + node.heuristicTokens, 0)
  const prune = session.append('compaction/prune', {
    shadowedRange: { start, end },
    shadowedSeqs: body,
    shadowedTokenCount,
  })
  const opened = session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [prune.seq, ...body],
  })
  return { windowId, seq: opened.seq }
}
