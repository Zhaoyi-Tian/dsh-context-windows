import { describe, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { harness, send, textResponse, toolCallResponse, requestText, withUsage } from './harness.ts'

describe('window plugin in AgentLoop', () => {
  it('opens once and switches after a successful native request', async () => {
    const { ctx, agent, adapter } = await harness([
      toolCallResponse('switch', 'new_context', {}), textResponse('continued'), textResponse('next turn'),
    ])
    try {
      await send(agent, 'Original user request')
      expect(adapter.requests).toHaveLength(2)
      expect(requestText(adapter.requests[0]!)).toContain('First context window id: w0')
      expect(requestText(adapter.requests[1]!)).toContain('Current context window id: w1')
      expect(requestText(adapter.requests[1]!)).not.toContain('Original user request')
      expect(requestText(adapter.requests[1]!)).not.toContain('ended at the hard limit')
      expect(requestText(adapter.requests[1]!)).not.toContain('A new context window will start')
      await send(agent, 'New user request')
      expect(requestText(adapter.requests[2]!)).toContain('New user request')
      const opens = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'context-window' && event.data.source.event === 'open')
      expect(opens).toHaveLength(2)
      expect(agent.session.snapshotEvents().at(-1)?.type).toBe('turn/end')
    } finally { await ctx.fiber.dispose() }
  })

  it('emits fallback once, leaves tools usable, and forces a later switch', async () => {
    const { ctx, agent, adapter } = await harness([
      withUsage(toolCallResponse('one', 'work', {}), 30000),
      withUsage(toolCallResponse('two', 'work', {}), 30000),
      withUsage(toolCallResponse('three', 'work', {}), 50000),
      textResponse('done'),
    ], { contextTokens: 40000, fallbackBufferTokens: 15000, prompts: { reminder: 'Save your progress soon.' } })
    try {
      ctx.tools.register(defineTool({
        name: 'work', description: 'work', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'work completed' },
      }))
      await send(agent, 'Start work')
      expect(adapter.requests).toHaveLength(4)
      expect(requestText(adapter.requests[1]!)).toContain('Save your progress soon.')
      expect(requestText(adapter.requests[1]!)).toContain('The current context window is exhausted')
      expect(requestText(adapter.requests[3]!)).toContain('Current context window id: w1')
      // A forced switch tells the model the previous checkpoint may be stale.
      expect(requestText(adapter.requests[3]!)).toMatch(/Previous context window w0 ended at the hard limit; .* Items #\d+–#\d+ are in that window\./)
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'context-window' && event.data.source.event === 'fallback')).toHaveLength(1)
      expect(events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'context-window' && event.data.source.event === 'reminder')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError !== true)).toHaveLength(3)
    } finally { await ctx.fiber.dispose() }
  })

  it('switches before sampling when the routed model has a smaller window', async () => {
    const { ctx, agent, adapter } = await harness([withUsage(textResponse('large'), 60000), textResponse('small')], { contextTokens: null })
    try {
      vi.spyOn(adapter, 'resolveModel').mockImplementation((provider, model) => Promise.resolve({
        provider, id: model, name: model, context: { contextWindow: model === 'small' ? 50000 : 1000000 },
      }))
      await send(agent, 'old input')
      // A later model selection routes this request to the smaller model.
      ctx.on('agent/request', async (_payload, next) => ({ ...await next(), model: 'small' }))
      await send(agent, 'new input')
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]!.model).toBe('small')
      const text = requestText(adapter.requests[1]!)
      expect(text).toContain('Current context window id: w1')
      expect(text).not.toContain('old input')
      expect(text).toContain('new input')
    } finally { await ctx.fiber.dispose() }
  })

  it('waits until the next turn after a final answer reaches the hard limit', async () => {
    const { ctx, agent, adapter } = await harness([
      withUsage(textResponse('final'), 90000), textResponse('fresh'),
    ])
    try {
      await send(agent, 'old input')
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows).toHaveLength(1)
      await send(agent, 'fresh input')
      expect(requestText(adapter.requests[1]!)).toContain('Current context window id: w1')
      expect(requestText(adapter.requests[1]!)).toContain('fresh input')
      expect(requestText(adapter.requests[1]!)).not.toContain('old input')
    } finally { await ctx.fiber.dispose() }
  })

  it('removes tools and the projection on plugin disposal', async () => {
    const { ctx, agent, fiber } = await harness([textResponse('done')])
    try {
      expect(ctx.tools.schemas().some(tool => tool.name === 'new_context')).toBe(true)
      await fiber.dispose()
      expect(ctx.tools.schemas().some(tool => tool.name === 'new_context')).toBe(false)
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
