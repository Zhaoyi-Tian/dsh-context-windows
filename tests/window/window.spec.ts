import { settings as resolveConfig } from './harness.ts'
import { describe, expect, it } from 'vitest'
import { createSystemMessage, createUserMessage, createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { foldWindow, initialWindowState, windowStateSchema, windowState } from '../../src/window/windows.ts'
import { resetWindow } from '../../src/window/reset.ts'
import { harness } from './harness.ts'
import { notesStateSchema, foldNotes } from '../../src/notes/notes.ts'

function fold(session: Session) {
  return session.snapshotEvents().reduce(foldWindow, initialWindowState())
}

describe('window state and replacement', () => {
  it('recognizes successful native and PTC outcomes, excluding failed results', () => {
    const session = Session.create(SessionId('outcomes'))
    const callId = ToolCallId('new')
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'new_context', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text: 'cancelled' }] }),
    }, { surfaceOp: 'append' })
    expect(fold(session).requested).toBe(false)
    session.append('tool/ptc-dispatch', {
      rootCallId: ToolCallId('run'), parentCallId: ToolCallId('run'), subCallId: ToolCallId('sub'),
      name: 'new_context', arguments: {}, isError: false, content: [],
    })
    expect(fold(session).requested).toBe(true)
    expect(windowStateSchema.parse(fold(session)).windows[0]?.id).toBe('w0')
  })

  it('keeps the system head and commits a priced replace without a summary', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(TokenMeter)
      ctx.sessionProjections.register({ key: 'contextWindow', stateVersion: 1, stateSchema: windowStateSchema, init: initialWindowState, apply: foldWindow })
      ctx.sessionProjections.register({ key: 'historyNotes', stateVersion: 1, stateSchema: notesStateSchema, init: () => ({ files: {}, failure: null }), apply: foldNotes })
      const session = ctx.sessions.create(SessionId('replace'))
      const head = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('keep system') }, { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old user text' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const originalTokens = ctx.tokenMeter.measure(session).totalTokens
      const result = resetWindow(ctx, session, resolveConfig({}), new AbortController().signal)
      expect(result?.windowId).toBe('w1')
      expect(session.surface.nodes).toEqual([head.seq, result?.seq])
      expect(session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('old user text')))).toBe(false)
      const events = session.snapshotEvents()
      const prune = events.at(-2)
      expect(prune?.type).toBe('compaction/prune')
      expect(events.at(-1)?.type).toBe('user/message')
      expect(events.some(event => event.type === 'compaction/summary')).toBe(false)
      expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(0)
      const detached = Session.create(SessionId('replay'), events)
      expect(detached.deriveMessages()).toEqual(session.deriveMessages())
      expect(fold(detached).windows.map(window => window.id)).toEqual(['w0', 'w1'])
      const interrupted = Session.create(SessionId('interrupted'), events.slice(0, -1))
      expect(fold(interrupted).windows).toHaveLength(1)
      expect(ctx.tokenMeter.measure(interrupted).totalTokens).toBe(originalTokens)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not request a window for a failed PTC child or an unrelated native result', () => {
    const session = Session.create(SessionId('failed-outcomes'))
    session.append('tool/ptc-dispatch', {
      rootCallId: ToolCallId('run'), parentCallId: ToolCallId('run'), subCallId: ToolCallId('failed-child'),
      name: 'new_context', arguments: {}, isError: true, content: [{ type: 'text', text: 'denied' }],
    })
    session.append('tool/ptc-dispatch', {
      rootCallId: ToolCallId('run'), parentCallId: ToolCallId('run'), subCallId: ToolCallId('other-child'),
      name: 'other_tool', arguments: {}, isError: false, content: [],
    })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('unrelated'), isError: false, content: [{ type: 'text', text: 'done' }] }),
    }, { surfaceOp: 'append' })
    expect(fold(session)).toMatchObject({ requested: false, newContextCalls: [], conversationItems: 1 })
  })

  it('retains the original system head when another system message is appended', () => {
    const session = Session.create(SessionId('system-head'))
    const first = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('first') }, { surfaceOp: 'append' })
    session.append('system/message', { turn: 1, step: 2, message: createSystemMessage('later update') }, { surfaceOp: 'append' })
    expect(fold(session).systemHeadSeq).toBe(first.seq)
    const replacement = session.append('system/message', { turn: 1, step: 3, message: createSystemMessage('consolidated') }, {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })
    expect(fold(session).systemHeadSeq).toBe(replacement.seq)
  })

  it('refuses an unanswered tool-call span before appending any prune', async () => {
    const { ctx, agent } = await harness([])
    try {
      agent.session.append('step/start', { turn: 1, step: 1 })
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'pending work' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        turn: 1, step: 1, stream: [],
        message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId('pending'), name: 'work', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      const before = agent.session.seq
      expect(() => resetWindow(ctx, agent.session, resolveConfig({}), new AbortController().signal)).toThrow(/unanswered tool calls/)
      expect(agent.session.seq).toBe(before)
      expect(fold(agent.session).windows).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves an empty window unchanged', async () => {
    const { ctx, agent } = await harness([])
    try {
      const before = agent.session.seq
      expect(resetWindow(ctx, agent.session, resolveConfig({}), new AbortController().signal)).toBeNull()
      expect(agent.session.seq).toBe(before)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects empty window checkpoints and unregisters its projection on dispose', async () => {
    const { ctx, agent, fiber } = await harness([])
    try {
      expect(windowStateSchema.safeParse({ ...initialWindowState(), windows: [] }).success).toBe(false)
      expect(windowState(ctx, agent.session).windows).toHaveLength(1)
      await fiber.dispose()
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('does not reset when a valid surface rewrite has removed all conversation nodes', async () => {
    const { ctx, agent } = await harness([])
    try {
      const user = agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'removed conversation' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const cleared = agent.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, {
        surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq }, sourceEventSeqs: [user.seq],
      })
      expect(agent.session.deriveMessages()).toEqual([])
      expect(agent.session.surface.nodes).toEqual([cleared.seq])
      expect(windowState(ctx, agent.session).conversationItems).toBe(1)
      const before = agent.session.seq
      expect(resetWindow(ctx, agent.session, resolveConfig({}), new AbortController().signal)).toBeNull()
      expect(agent.session.seq).toBe(before)
    } finally { await ctx.fiber.dispose() }
  })

  it('ignores reminders and fallback notices attributed to an older window', async () => {
    const { ctx, agent } = await harness([])
    try {
      const initial = fold(agent.session).windows[0]!.id
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old conversation' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      resetWindow(ctx, agent.session, resolveConfig({}), new AbortController().signal)
      const before = fold(agent.session)
      for (const event of ['reminder', 'fallback'] as const) {
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'old notice' }],
          source: { kind: 'context-window', windowId: initial, event, form: 'notice', summary: 'old notice' },
        }), { surfaceOp: 'append' })
      }
      expect(fold(agent.session)).toEqual(before)
      expect(before).toMatchObject({ reminded: false, fellBack: false })
    } finally { await ctx.fiber.dispose() }
  })
})
