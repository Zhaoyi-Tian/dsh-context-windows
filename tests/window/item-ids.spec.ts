import { describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { harness, send, textResponse, toolCallResponse, requestText } from './harness.ts'

const MARKED = /\[id: #\d+\]/
const markers = (request: GenerateOptions) => [...requestText(request).matchAll(/\[id: #(\d+)\]/g)].map(match => Number(match[1]))

describe('item ids', () => {
  it('marks user requests and tool results before the next request without changing the log', async () => {
    const { ctx, agent, adapter } = await harness([
      toolCallResponse('call-1', 'get_context_remaining', {}),
      textResponse('done'),
    ])
    try {
      await send(agent, 'Check the budget.')
      const events = agent.session.snapshotEvents()
      const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!
      const result = events.find(event => event.type === 'tool/result')!
      // This step's input is marked from the next request on.
      expect(markers(adapter.requests[0]!)).toEqual([])
      expect(markers(adapter.requests[1]!)).toEqual([user.seq, result.seq])
      // The window notice and other host messages stay unmarked.
      const open = adapter.requests[1]!.messages.find(message => message.source?.kind === 'context-window')!
      expect(JSON.stringify(open.content)).not.toMatch(MARKED)
      // Durable events keep their original content; only the derived message carries the marker.
      expect(JSON.stringify(agent.session.eventAt(user.seq))).not.toMatch(MARKED)
      expect(JSON.stringify(agent.session.deriveEventMessage(user))).toContain(`[id: #${user.seq}]`)
      // History reads return the original text, addressable by the marker number.
      const read = await ctx.tools.execute({
        agent, signal: new AbortController().signal, callId: 'read' as never,
        name: 'history_read_item', arguments: { seq: user.seq },
      })
      const text = read.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(text).toContain('Check the budget.')
      expect(text).not.toMatch(MARKED)
    } finally { await ctx.fiber.dispose() }
  })

  it('marks each item once across turns', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('one'), textResponse('two'), textResponse('three')])
    try {
      await send(agent, 'first')
      await send(agent, 'second')
      await send(agent, 'third')
      const users = agent.session.snapshotEvents()
        .filter(event => event.type === 'user/message' && event.data.source.kind === 'user').map(event => event.seq)
      expect(markers(adapter.requests[2]!)).toEqual(users.slice(0, 2))
      const records = agent.session.snapshotEvents().filter(event => (event.type as string) === 'plugin:dsh-context-windows/item-ids')
      expect(records).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('marks user-role messages from other sources but not runtime context or window notices', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('one'), textResponse('two')])
    try {
      // For example, a reply to a question the model asked carries its own source kind.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'reply' }], source: { kind: 'user-question-reply' } as never }))
      await agent.whenIdle()
      await send(agent, 'next')
      const reply = agent.session.snapshotEvents().find(event => event.type === 'user/message' && (event.data.source.kind as string) === 'user-question-reply')!
      expect(markers(adapter.requests[1]!)).toEqual([reply.seq])
      const runtime = adapter.requests[1]!.messages.filter(message => ['runtime-context', 'context-window'].includes(message.source?.kind as string))
      expect(JSON.stringify(runtime)).not.toMatch(MARKED)
    } finally { await ctx.fiber.dispose() }
  })

  it('restores an unmarked session without the plugin', async () => {
    const { ctx, agent } = await harness([textResponse('one'), textResponse('two')])
    try {
      await send(agent, 'first')
      await send(agent, 'second')
      // No projection definitions: DSH skips the ignorable record instead of refusing the log.
      const restored = Session.create(SessionId('without-dsh-context-windows'), agent.session.snapshotEvents())
      expect(JSON.stringify(restored.deriveMessages())).not.toMatch(MARKED)
      expect(restored.deriveMessages()).toHaveLength(agent.session.deriveMessages().length)
    } finally { await ctx.fiber.dispose() }
  })
})
