import { describe, expect, it } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as Window from '../../src/index.ts'
import { harness, send, textResponse } from './harness.ts'

async function setup() {
  const test = await harness([textResponse('done')])
  await test.ctx.plugin(CommandRuntime)
  const run = (line = '/compact', signal = new AbortController().signal) =>
    test.ctx.commands.execute(test.agent, line, [], signal)
  return { ...test, run }
}

describe('/compact', () => {
  it('rejects arguments and leaves an empty conversation unchanged', async () => {
    const { ctx, agent, adapter, run } = await setup()
    try {
      expect((await run('/compact extra'))?.result).toEqual({ kind: 'error', text: 'Usage: /compact (no arguments)' })
      expect((await run())?.result).toEqual({ kind: 'success', text: 'No conversation in this window yet.' })
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
      expect(adapter.requests).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('commits adjacent prune and open events, then waits for flush before reporting success', async () => {
    const { ctx, agent, adapter, run } = await setup()
    const flushing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      await send(agent, 'original request')
      ctx.on('session/flush', async () => { flushing.resolve(undefined); await release.promise })
      let settled = false
      const operation = run().finally(() => { settled = true })
      await flushing.promise
      expect(settled).toBe(false)
      const events = agent.session.snapshotEvents()
      const prune = events.findLast(event => event.type === 'compaction/prune')
      const open = events.at(-1)
      expect(open).toMatchObject({ type: 'user/message', seq: Number(prune?.seq) + 1, data: { source: { kind: 'context-window', event: 'open', windowId: 'w1' } } })
      expect(events.at(-2)).toBe(prune)
      release.resolve(undefined)
      expect((await operation)?.result).toEqual({ kind: 'success', text: 'New context window w1 opened.', sourceEventSeq: open?.seq })
      expect(adapter.requests).toHaveLength(1)
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows.map(window => window.id)).toEqual(['w0', 'w1'])
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })

  it('refuses maintenance while the agent is busy', async () => {
    const { ctx, agent, run } = await setup()
    const release = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => release.promise)
    try {
      await expect(run()).rejects.toThrow()
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'command/done')?.data.kind).toBe('error')
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
    } finally { release.resolve(undefined); await maintenance; await ctx.fiber.dispose() }
  })

  it('rejects a cancelled request before committing', async () => {
    const { ctx, agent, run } = await setup()
    try {
      await send(agent, 'preserve this conversation')
      const controller = new AbortController()
      controller.abort(new Error('operator cancelled'))
      await expect(run('/compact', controller.signal)).rejects.toThrow('operator cancelled')
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('reports persistence failure after retaining the committed window', async () => {
    const { ctx, agent, run } = await setup()
    try {
      await send(agent, 'original')
      ctx.on('session/flush', async () => { throw new Error('disk unavailable') })
      await expect(run()).rejects.toThrow('disk unavailable')
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'command/done')?.data)
        .toMatchObject({ kind: 'error', text: 'disk unavailable' })
      expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows).toHaveLength(2)
      expect(agent.session.deriveMessages().flatMap(message => message.content).some(block => block.type === 'text' && block.text === 'original')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('unregisters on dispose, drains an active flush, and reloads one command', async () => {
    const { ctx, agent, fiber, run } = await setup()
    const flushing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      await send(agent, 'original')
      ctx.on('session/flush', async () => { flushing.resolve(undefined); await release.promise })
      const operation = run()
      await flushing.promise
      let disposed = false
      const disposal = fiber.dispose().then(() => { disposed = true })
      await expect.poll(() => ctx.commands.list(agent).some(command => command.name === 'compact')).toBe(false)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await operation
      await disposal
      await ctx.plugin(Window)
      expect(ctx.commands.list(agent).filter(command => command.name === 'compact')).toHaveLength(1)
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })
})
