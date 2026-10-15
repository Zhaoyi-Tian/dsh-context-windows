import { describe, expect, it } from 'vitest'
import { requestTokens } from '../../src/window/budget.ts'
import { harness, send, textResponse, toolCallResponse } from './harness.ts'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

const usage = (chunks: StreamChunk[], value: TokenUsage) => chunks.map(chunk => chunk.type === 'usage' ? { type: 'usage' as const, usage: value } : chunk)

describe('request tokens', () => {
  it('uses provider usage even when the host estimate is higher', async () => {
    const { ctx, agent } = await harness([usage(textResponse('done'), { inputTokens: 139, cacheReadTokens: 35968, outputTokens: 4 })])
    try {
      await send(agent, 'x'.repeat(400000))
      // The host meter keeps its larger estimate; the window budget follows the provider's count.
      expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(36111)
      expect(requestTokens(ctx, agent.session)).toBe(139 + 35968 + 4)
    } finally { await ctx.fiber.dispose() }
  })

  it('prefers the provider total and adds estimates for later nodes', async () => {
    const { ctx, agent } = await harness([
      usage(toolCallResponse('call', 'get_context_remaining', {}), { inputTokens: 900, outputTokens: 50, totalTokens: 1000 }),
      textResponse('done'),
    ])
    try {
      let afterCall = 0
      ctx.on('tools/result', () => {
        // The tool has finished but its result is not logged yet: only the provider count applies.
        afterCall = requestTokens(ctx, agent.session)
      })
      await send(agent, 'check')
      expect(afterCall).toBe(1000)
      const nodes = ctx.tokenMeter.measure(agent.session).nodes
      const last = nodes.findLast(node => agent.session.eventAt(node.seq)?.type === 'assistant/message')!
      const later = nodes.filter(node => node.seq > last.seq).reduce((sum, node) => sum + node.tokens, 0)
      expect(requestTokens(ctx, agent.session)).toBe(10 + 4 + later)
    } finally { await ctx.fiber.dispose() }
  })

  it('falls back to the host estimate before any call in the window', async () => {
    const { ctx, agent } = await harness([])
    try {
      expect(requestTokens(ctx, agent.session)).toBe(ctx.tokenMeter.measure(agent.session).totalTokens)
    } finally { await ctx.fiber.dispose() }
  })
})
