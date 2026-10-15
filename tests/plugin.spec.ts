import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import * as ContextWindows from '../dist/index.js'
import { requestTokens } from '../src/window/budget.ts'
import { harness, send, textResponse, toolCallResponse, requestText } from './window/harness.ts'

it('keeps the serialized settings schema usable without module-local callbacks', () => {
  const schema = new Schema(JSON.parse(JSON.stringify(ContextWindows.Config)))
  expect(schema.type).toBe('object')
  expect(() => schema({})).not.toThrow()
  expect(schema({ contextTokens: null, prompts: { fallback: null } }))
    .toMatchObject({ contextTokens: null, prompts: { fallback: null } })
  expect(() => schema({ maxFileBytes: 0 })).toThrow()
})

it('preserves explicit null settings through the built plugin schema', async () => {
  const { ctx, agent, fiber } = await harness([textResponse('ready')])
  try {
    await fiber.dispose()
    await ctx.plugin(ContextWindows, { contextTokens: null, prompts: { fallback: null } })
    await send(agent, 'Start an uncapped window without a fallback buffer.')
    const total = requestTokens(ctx, agent.session)
    const result = await ctx.tools.execute({
      agent, signal: new AbortController().signal, callId: ToolCallId('budget'),
      name: 'get_context_remaining', arguments: {},
    })
    expect(result.isError).not.toBe(true)
    expect(result.value).toEqual({ tokens_left: 1000000 - total })
  } finally { await ctx.fiber.dispose() }
})

it('loads the built single entry, recovers notes after switching, and disposes every tool', async () => {
  const { ctx, agent, adapter, fiber } = await harness([
    toolCallResponse('save', 'notes_write_file', { path: 'checkpoint.md', text: 'Continue the original task.' }),
    toolCallResponse('switch', 'new_context', {}),
    toolCallResponse('read', 'notes_read_file', { path: 'checkpoint.md' }),
    textResponse('recovered'),
  ])
  try {
    await fiber.dispose()
    const plugin = await ctx.plugin(ContextWindows, { maxFileBytes: 1024 })
    expect(ctx.tools.schemas()).toHaveLength(11)
    await send(agent, 'Original task')
    expect(requestText(adapter.requests[2]!)).toContain('Current context window id: w1')
    expect(requestText(adapter.requests[2]!)).toContain('checkpoint.md')
    expect(requestText(adapter.requests[2]!)).not.toContain('Original task')
    expect(requestText(adapter.requests[3]!)).toContain('Continue the original task.')
    expect(ctx.sessionProjections.stateOf(agent.session, 'historyNotes')?.files['checkpoint.md']?.text).toBe('Continue the original task.')
    await plugin.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(agent.session, 'historyNotes')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
