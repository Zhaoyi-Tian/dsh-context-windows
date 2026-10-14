import { randomUUID } from 'node:crypto'
import { settings as resolveConfig } from './harness.ts'
import { describe, expect, it, vi } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { measureBudget } from '../../src/window/budget.ts'
import * as Window from '../../src/index.ts'
import { harness, send, textResponse, toolCallResponse, requestText } from './harness.ts'


describe('budget and request failures', () => {
  it('only declares budget reads concurrent', async () => {
    const { ctx } = await harness([])
    try {
      const budget = ctx.tools.get('get_context_remaining')
      const reset = ctx.tools.get('new_context')
      expect(budget?.isConcurrencySafe?.({})).toBe(true)
      expect(reset?.isConcurrencySafe?.({}) ?? false).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('reports an unknown budget before routing and without any capacity after routing', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('first')])
    try {
      const execute = (name: string, owningAgent = true) => ctx.tools.execute({
        ...(owningAgent ? { agent } : {}), signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()), name, arguments: {},
      })
      expect((await execute('get_context_remaining')).value).toEqual({ tokens_left: null })
      for (const name of ['get_context_remaining', 'new_context']) {
        expect((await execute(name, false)).isError).toBe(true)
      }
      await send(agent, 'first')
      const info = await adapter.resolveModel('mock', 'mock')
      const { context: _context, ...withoutCapacity } = info
      vi.spyOn(adapter, 'resolveModel').mockResolvedValue(withoutCapacity)
      const signal = new AbortController().signal
      // Without model capacity, the configured limit alone bounds the window.
      expect(await measureBudget(ctx, agent.session, resolveConfig({ contextTokens: 50000 }), signal))
        .toMatchObject({ hard: 50000 })
      expect(await measureBudget(ctx, agent.session, resolveConfig({ contextTokens: null }), signal)).toBeNull()
      expect((await execute('get_context_remaining')).value).toMatchObject({ tokens_left: expect.any(Number) })
      await send(agent, 'second')
      expect(adapter.requests).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('commits recovery for provider overflow without retrying the failed turn', async () => {
    const { ctx, agent, adapter } = await harness([
      textResponse('old answer'),
      () => { throw new LlmError('provider context overflow', CONTEXT_WINDOW_EXCEEDED_CODE) },
      textResponse('recovered'),
    ])
    try {
      await send(agent, 'old conversation')
      await send(agent, 'overflowing input')
      expect(adapter.requests).toHaveLength(2)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
        .toMatchObject({ data: { reason: { kind: 'error', error: { code: CONTEXT_WINDOW_EXCEEDED_CODE } } } })
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows).toHaveLength(2)
      await send(agent, 'fresh request')
      expect(adapter.requests).toHaveLength(3)
      expect(requestText(adapter.requests[2]!)).toContain('Current context window id: w1')
      expect(requestText(adapter.requests[2]!)).toContain('fresh request')
      expect(requestText(adapter.requests[2]!)).not.toContain('old conversation')
      expect(requestText(adapter.requests[2]!)).not.toContain('overflowing input')
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the provider failure if overflow recovery cannot commit its replacement', async () => {
    const { ctx, agent, adapter } = await harness([
      textResponse('first'),
      () => { throw new LlmError('original overflow', CONTEXT_WINDOW_EXCEEDED_CODE) },
    ])
    try {
      await send(agent, 'old request')
      const append = agent.session.append.bind(agent.session)
      vi.spyOn(agent.session, 'append').mockImplementation((...args) => {
        if (args[0] === 'compaction/prune') throw new Error('session append unavailable')
        return (append as (...input: unknown[]) => ReturnType<typeof append>)(...args)
      })
      await send(agent, 'overflow')
      expect(adapter.requests).toHaveLength(2)
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows).toHaveLength(1)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
        .toMatchObject({ data: { reason: { kind: 'error', error: { message: 'original overflow', code: CONTEXT_WINDOW_EXCEEDED_CODE } } } })
    } finally { await ctx.fiber.dispose() }
  })

  it('does not reset for ordinary provider failures or a cancelled overflow', async () => {
    const { ctx, agent, adapter } = await harness([
      textResponse('first'),
      () => { throw new LlmError('server unavailable', 'SERVER_ERROR') },
      () => { agent.cancel({ kind: 'user' }); throw new LlmError('cancelled overflow', CONTEXT_WINDOW_EXCEEDED_CODE) },
    ])
    try {
      await send(agent, 'first request')
      await send(agent, 'ordinary error')
      await send(agent, 'cancelled request')
      expect(adapter.requests).toHaveLength(3)
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows).toHaveLength(1)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['deny', 'cancel'] as const)('does not switch after a native new_context call is %s', async (kind) => {
    const { ctx, agent, adapter } = await harness([toolCallResponse('switch', 'new_context', {}), textResponse('continued')])
    try {
      ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'new_context'
        ? kind === 'deny' ? { kind, reason: 'policy refused' } : { kind }
        : next())
      await send(agent, 'keep this request')
      expect(adapter.requests).toHaveLength(2)
      expect(requestText(adapter.requests[1]!)).toContain('Current context window id: w0')
      expect(requestText(adapter.requests[1]!)).toContain('keep this request')
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.requested).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves a rejected pre-step empty and observes cancellation before the initial open', async () => {
    const { ctx, agent, adapter } = await harness([textResponse('unused')])
    const collecting = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      const reject = ctx.on('agent/pre-step', async () => ({ kind: 'reject', reason: 'test rejects this step' }))
      await send(agent, 'rejected')
      expect(adapter.requests).toHaveLength(0)
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.opened).toBe(false)
      reject()
      ctx.on('agent/pre-step', async (_input, next) => { collecting.resolve(undefined); await release.promise; return next() })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancelled before open' }], source: { kind: 'user' } }))
      await collecting.promise
      agent.cancel({ kind: 'user' })
      release.resolve(undefined)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.opened).toBe(false)
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })

  it('uses reloaded budget settings for subsequent tool queries', async () => {
    const { ctx, agent, fiber } = await harness([textResponse('first')], { contextTokens: 50000 })
    try {
      await send(agent, 'first')
      const query = () => ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId(randomUUID()), name: 'get_context_remaining', arguments: {} })
      const before = (await query()).value
      await fiber.dispose()
      await ctx.plugin(Window, { contextTokens: 70000 })
      const after = (await query()).value
      expect(before).toHaveProperty('tokens_left')
      expect(after).toEqual({ tokens_left: (before as { tokens_left: number }).tokens_left + 20000 })
    } finally { await ctx.fiber.dispose() }
  })
})
