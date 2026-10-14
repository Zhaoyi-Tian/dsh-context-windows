import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, appendPluginRecord, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ContextWindows from '../../src/index.ts'
import { normalizeNotePath, readLines, countArg, notesStateSchema, recentNotes } from '../../src/notes/notes.ts'
import { harness, send, textResponse, toolCallResponse, requestText } from '../window/harness.ts'

async function setup(script: Parameters<typeof harness>[0] = [], maxFileBytes = 16384) {
  const result = await harness(script, { maxFileBytes })
  const notesFiber = result.fiber
  const call = async (name: string, args: object, agent = result.agent, signal = new AbortController().signal) => {
    const resultValue = await result.ctx.tools.execute({
      agent, signal,
      callId: ToolCallId(randomUUID()), name, arguments: args,
    })
    return { ...resultValue, text: resultValue.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }
  }
  return { ...result, notesFiber, call }
}

describe('virtual notes', () => {
  it('declares reads concurrent while writes stay exclusive', async () => {
    const { ctx } = await setup()
    try {
      for (const name of ['notes_list_files_by_prefix', 'history_list_windows', 'history_list_items']) {
        expect(ctx.tools.get(name)?.isConcurrencySafe?.({})).toBe(true)
      }
      for (const name of ['notes_append_to_file', 'notes_write_file']) {
        expect(ctx.tools.get(name)?.isConcurrencySafe?.({ path: 'checkpoint', text: 'next' }) ?? false).toBe(false)
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects invalid note limits before registering tools and malformed checkpoints on restore', async () => {
    const ctx = new Context()
    try {
      for (const input of [{ maxFileBytes: 0 }, { maxFileBytes: 1.5 }, { maxFileBytes: NaN }]) {
        expect(() => ContextWindows.Config(input)).toThrow()
      }
      for (const files of [null, [], 1, { note: { text: 'bad metadata', lines: -1, bytes: 1, createdSeq: 0, updatedSeq: 0 } }]) {
        expect(notesStateSchema.safeParse({ files, failure: null }).success).toBe(false)
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('checks complete UTF-8 size and preserves the previous file after failure', async () => {
    const { ctx, agent, call } = await setup([], 10)
    try {
      expect((await call('notes_write_file', { path: 'progress.md', text: '界界界' })).isError).not.toBe(true)
      expect((await call('notes_append_to_file', { path: 'progress.md', text: 'x' })).text).toContain('10 UTF-8 bytes')
      const before = agent.session.seq
      const tooLarge = await call('notes_append_to_file', { path: 'progress.md', text: '界' })
      expect(tooLarge.isError).toBe(true)
      expect(tooLarge.text).toContain('note was not changed')
      expect(agent.session.seq).toBe(before)
      expect((await call('notes_read_file', { path: 'progress.md' })).text).toContain('界界界x')
    } finally { await ctx.fiber.dispose() }
  })

  it('lists, searches and reads line ranges without filesystem paths', async () => {
    const { ctx, call } = await setup()
    try {
      await call('notes_write_file', { path: 'work/b.md', text: 'first\nneedle\nlast' })
      await call('notes_write_file', { path: 'work/a.md', text: 'needle two' })
      const listed = await call('notes_list_files_by_prefix', { prefix: 'work/', file_order_by: 'updated_at', file_order: 'descending' })
      expect(listed.text.split('\n')[0]).toContain('work/a.md')
      expect((await call('notes_read_file', { path: 'work/b.md', start_line: -2, stop_line: -1 })).text).toContain('needle\nlast')
      expect((await call('notes_search_contents', { query: 'needle', max_files: 1, recent_file_first: true })).text).toBe('work/a.md:1: needle two')
      expect((await call('notes_search_contents', { query: 'Needle' })).text).toBe('No matching note lines.')
      expect((await call('notes_read_file', { path: 'absent' })).isError).toBe(true)
      expect((await call('notes_list_files_by_prefix', { prefix: 'missing/' })).text).toBe('No notes.')
      expect((await call('notes_write_file', { path: 'toString', text: 'ordinary note' })).isError).not.toBe(true)
      expect((await call('notes_read_file', { path: 'toString' })).text).toContain('ordinary note')
    } finally { await ctx.fiber.dispose() }
  })

  it('rebuilds notes on resume and inherits independent files on fork', async () => {
    const { ctx, agent, call } = await setup()
    try {
      await call('notes_write_file', { path: 'checkpoint', text: 'parent state' })
      const resumed = Session.create(SessionId('resumed-notes'), agent.session.snapshotEvents())
      expect(ctx.sessionProjections.stateOf(resumed, 'historyNotes')?.files.checkpoint?.text).toBe('parent state')
      const child = ctx.sessions.fork(agent.session, undefined, SessionId('notes-child'))
      expect(ctx.sessionProjections.stateOf(child, 'historyNotes')?.files.checkpoint?.text).toBe('parent state')
      appendPluginRecord(child, 'plugin:history-notes/file', { version: 1, path: normalizeNotePath('checkpoint'), text: 'child state' })
      expect((await call('notes_read_file', { path: 'checkpoint' })).text).toContain('parent state')
    } finally { await ctx.fiber.dispose() }
  })

  it('removes registrations on dispose and restores one copy on reload', async () => {
    const { ctx, agent, notesFiber, call } = await setup()
    try {
      appendPluginRecord(agent.session, 'plugin:history-notes/file', { version: 1, path: normalizeNotePath('ok'), text: 'valid' })
      const result = await call('notes_read_file', { path: '__proto__' })
      expect(result.isError).toBe(true)
      await notesFiber.dispose()
      expect(ctx.tools.schemas().some(tool => tool.name.startsWith('notes_'))).toBe(false)
      expect(ctx.sessionProjections.stateOf(agent.session, 'historyNotes')).toBeUndefined()
      await ctx.plugin(ContextWindows)
      expect(ctx.tools.schemas().filter(tool => tool.name === 'notes_read_file')).toHaveLength(1)
      expect((await call('notes_read_file', { path: 'ok' })).text).toContain('valid')
    } finally { await ctx.fiber.dispose() }
  })

  it('uses the default 16384-byte cap on plugin activation', async () => {
    const { ctx, agent, notesFiber, call } = await setup()
    try {
      await notesFiber.dispose()
      await ctx.plugin(ContextWindows)
      const text = 'x'.repeat(16384)
      expect((await call('notes_write_file', { path: 'exact-cap', text })).isError).not.toBe(true)
      const before = agent.session.seq
      const rejected = await call('notes_append_to_file', { path: 'exact-cap', text: 'x' })
      expect(rejected.isError).toBe(true)
      expect(rejected.text).toContain('maximum is 16384')
      expect(agent.session.seq).toBe(before)
      expect(ctx.sessionProjections.stateOf(agent.session, 'historyNotes')?.files['exact-cap']?.text).toBe(text)
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    { version: 2, path: 'broken', text: 'unsupported version' },
    { version: 1, path: 'broken', text: 123 },
    { version: 1, path: '../escape', text: 'invalid path' },
  ])('blocks note reads and writes after restoring malformed durable data: %j', async (data) => {
    const { ctx, call, adapter } = await setup([textResponse('still running')])
    try {
      // Stored plugin payloads are owner-validated JSON, unlike typed live writes.
      const seed = JSON.parse(JSON.stringify([{ type: 'plugin:history-notes/file', seq: 0, time: 1, ignorable: true, data }])) as SessionEvent[]
      const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'mock', model: 'mock' }, seed })
      const before = handle.agent.session.seq
      for (const [name, args] of [
        ['notes_read_file', { path: 'broken' }],
        ['notes_write_file', { path: 'replacement', text: 'must not hide failure' }],
        ['notes_list_files_by_prefix', {}],
      ] as const) {
        const result = await call(name, args, handle.agent)
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/Invalid note (record|path)/)
        expect(result.text).toContain('at #0')
      }
      expect(handle.agent.session.seq).toBe(before)
      // Window hints degrade so a malformed record cannot block opening or switching windows.
      expect(recentNotes(ctx, handle.agent.session)).toEqual([])
      await send(handle.agent, 'continue')
      expect(adapter.requests).toHaveLength(1)
      expect(requestText(adapter.requests[0]!)).toContain('First context window id: w0')
    } finally { await ctx.fiber.dispose() }
  })

  it('stores prototype-named files as independent ordinary notes and preserves creation order', async () => {
    const { ctx, agent, call } = await setup()
    try {
      for (const path of ['__proto__', 'constructor', 'toString', '笔记/进度.md']) {
        expect((await call('notes_append_to_file', { path, text: path })).isError).not.toBe(true)
      }
      await call('notes_write_file', { path: '__proto__', text: 'replacement' })
      const state = ctx.sessionProjections.stateOf(agent.session, 'historyNotes')
      expect(state?.files.__proto__?.text).toBe('replacement')
      expect(notesStateSchema.parse(state).files.__proto__?.text).toBe('replacement')
      expect(notesStateSchema.parse(state).files['constructor']?.text).toBe('constructor')
      const created = (await call('notes_list_files_by_prefix', { file_order_by: 'created_at' })).text.split('\n')
      expect(created.map(line => line.split(' (')[0])).toEqual(['__proto__', 'constructor', 'toString', '笔记/进度.md'])
      const updated = (await call('notes_list_files_by_prefix', { file_order_by: 'updated_at', file_order: 'descending', max_results: 1 })).text
      expect(updated).toContain('__proto__')
      for (const path of ['constructor', 'toString', '笔记/进度.md']) expect((await call('notes_read_file', { path })).text).toContain(path)
      expect((await call('notes_list_files_by_prefix', { max_results: 0 })).text).toBe('No notes.')
    } finally { await ctx.fiber.dispose() }
  })

  it('supports empty notes, bounded line reads and zero search limits', async () => {
    const { ctx, call } = await setup()
    try {
      await call('notes_write_file', { path: 'empty', text: '' })
      expect((await call('notes_read_file', { path: 'empty' })).text).toBe('empty: no lines in this range.')
      await call('notes_write_file', { path: 'lines', text: 'a\nneedle\nneedle\n' })
      expect((await call('notes_read_file', { path: 'lines', start_line: -99, stop_line: 2 })).text).toBe('lines lines 1–2 of 4\na\nneedle')
      expect((await call('notes_read_file', { path: 'lines', start_line: 9 })).text).toBe('lines: no lines in this range.')
      expect((await call('notes_search_contents', { query: 'needle', max_matches_per_file: 1 })).text).toBe('lines:2: needle')
      expect((await call('notes_search_contents', { query: 'needle', max_matches_per_file: 0 })).text).toBe('No matching note lines.')
      expect((await call('notes_search_contents', { query: 'needle', max_files: 0 })).text).toBe('No matching note lines.')
      expect((await call('notes_read_file', { path: 'lines', stop_line: 0 })).isError).toBe(true)
      expect((await call('notes_read_file', { path: 'lines', start_line: 1.5 })).text).toContain('invalid arguments')
      expect((await call('notes_list_files_by_prefix', { max_results: 'many' })).text).toContain('invalid arguments')
      expect((await call('notes_search_contents', { query: 'needle', max_files: -1 })).isError).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('requires an admitted step before history and rejects cancelled note writes', async () => {
    const { ctx, agent, call } = await setup()
    try {
      expect((await call('history_list_items', {})).text).toContain('admitted agent step')
      const controller = new AbortController()
      controller.abort(new Error('cancelled before note write'))
      const before = agent.session.seq
      expect((await call('notes_write_file', { path: 'cancelled', text: 'not saved' }, agent, controller.signal)).isError).toBe(true)
      expect(agent.session.seq).toBe(before)
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(randomUUID()), name: 'notes_list_files_by_prefix', arguments: {} })
      expect(result.isError).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['', '/root/note', '../note', 'a//b', 'a/./b', 'a\\b', 'a\u0000b'])('rejects unsupported virtual path %j', (path) => {
    expect(() => normalizeNotePath(path)).toThrow()
  })

  it('validates line/count arguments without banning legitimate tiny ranges', () => {
    expect(normalizeNotePath('~/note')).toBe('~/note')
    expect(readLines('', undefined, undefined).text).toBe('')
    expect(readLines('a\nb\nc', -2, -1).text).toBe('b\nc')
    expect(() => readLines('a', 0)).toThrow()
    expect(() => countArg(-1, 50, 'limit')).toThrow()
    expect(countArg(0, 50, 'limit')).toBe(0)
  })
})

describe('cross-window recovery through DSH queries', () => {
  it('lists window ranges from the projection without reading the log again', async () => {
    const { ctx, agent, adapter, call } = await setup([
      toolCallResponse('empty', 'history_list_windows', {}),
      toolCallResponse('switch', 'new_context', {}),
      toolCallResponse('windows', 'history_list_windows', {}),
      textResponse('done'),
    ])
    try {
      const read = vi.spyOn(ctx.sessionQuery, 'readSession')
      const filter = vi.spyOn(ctx.sessionQuery, 'filterEvents')
      await send(agent, 'switch windows')
      expect(requestText(adapter.requests[1]!)).toMatch(/w0 \(#0–#\d+\) \(current\)/)
      expect(requestText(adapter.requests[3]!)).toMatch(/w0 \(#0–#\d+\)\nw1 \(#\d+–#\d+\) \(current\)/)
      const windows = ctx.sessionProjections.stateOf(agent.session, 'contextWindow')!.windows
      const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')!.lastStepStartSeq!
      expect((await call('history_list_windows', { recent_first: true })).text)
        .toBe(`w1 (#${windows[1]!.startSeq}–#${boundary - 1}) (current)\nw0 (#0–#${windows[1]!.startSeq - 1})`)
      expect(read).not.toHaveBeenCalled()
      expect(filter).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('uses native event filters and exact reads, omitting current-step and nontext records', async () => {
    const { ctx, agent, call } = await setup([textResponse('first answer'), textResponse('current answer')])
    try {
      await send(agent, 'first request')
      agent.session.append('step/start', { turn: 1, step: 2 })
      const source = { kind: 'model' as const, provider: 'mock', model: 'mock' }
      const empty = agent.session.append('assistant/message', { turn: 1, step: 2, stream: [], message: createMessage({ role: 'assistant', content: [], source }) }, { surfaceOp: 'append' })
      const fullText = '界abc\nneedle near the end\n' + 'complete event '.repeat(500) + 'END_OF_EVENT'
      const user = agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: fullText }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const callId = ToolCallId('echo-call')
      const invocation = agent.session.append('tool/call', { turn: 1, step: 2, callId, name: 'echo', arguments: '{"text":"needle"}' })
      const result = agent.session.append('tool/result', { turn: 1, step: 2, message: createMessage({ role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'echo returned needle' }], source: { kind: 'tool', name: 'echo', callId } }) }, { surfaceOp: 'append' })
      appendPluginRecord(agent.session, 'plugin:history-notes/file', { version: 1, path: 'inert', text: 'plugin payload must not become history' })
      agent.session.append('step/end', { turn: 1, step: 2 })
      await send(agent, 'current request excluded by cutoff')
      const filter = vi.spyOn(ctx.sessionQuery, 'filterEvents')
      const read = vi.spyOn(ctx.sessionQuery, 'readEvent')
      const rawLog = vi.spyOn(ctx.sessionQuery, 'readSession')
      expect((await call('history_list_items', { event_type: 'tool/result' })).text)
        .toBe(`#${result.seq} [w0] tool/result: echo returned needle`)
      expect((await call('history_list_items', { event_type: 'tool/call' })).text)
        .toBe(`#${invocation.seq} [w0] tool/call: echo {"text":"needle"}`)
      const all = (await call('history_list_items', {})).text
      expect(all).toContain(`#${user.seq} [w0] user/message: 界abc needle near the end`)
      expect(all).not.toContain(`#${empty.seq} `)
      expect(all).not.toContain('plugin payload')
      expect(all).not.toContain('current request excluded')
      expect((await call('history_read_item', { seq: user.seq })).text)
        .toBe(`#${user.seq} [w0] user/message\n${fullText}`)
      expect((await call('history_search_contents', { query: 'NEEDLE   NEAR', event_type: 'user/message' })).text)
        .toContain(`#${user.seq} [w0] user/message:`)
      expect((await call('history_search_contents', { query: 'NEEDLE', event_type: 'tool/result', recent_first: true, limit: 1 })).text)
        .toBe(`#${result.seq} [w0] tool/result: echo returned needle`)
      expect(filter).toHaveBeenCalledTimes(5)
      expect(read).toHaveBeenCalledTimes(1)
      expect(rawLog).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('observes cancellation after the host event query settles', async () => {
    const { ctx, agent, call } = await setup([textResponse('first')])
    const reading = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      await send(agent, 'readable history')
      const filterEvents = ctx.sessionQuery.filterEvents.bind(ctx.sessionQuery)
      const read = vi.spyOn(ctx.sessionQuery, 'filterEvents').mockImplementation(async (...args) => {
        reading.resolve(undefined)
        await release.promise
        return filterEvents(...args)
      })
      const controller = new AbortController()
      const operation = call('history_list_items', {}, agent, controller.signal)
      await reading.promise
      controller.abort(new Error('query cancelled'))
      release.resolve(undefined)
      const result = await operation
      expect(result.isError).toBe(true)
      expect(result.text).not.toContain('readable history')
      expect(read).toHaveBeenCalledTimes(1)
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })

  it('reads checkpoint notes and the original request across windows', async () => {
    const { ctx, agent, adapter } = await setup([
      toolCallResponse('note', 'notes_write_file', { path: 'checkpoint.md', text: 'Continue the quartz task; find the original user request in w0.' }),
      toolCallResponse('switch', 'new_context', {}),
      toolCallResponse('checkpoint', 'notes_read_file', { path: 'checkpoint.md' }),
      toolCallResponse('list', 'history_list_items', { event_type: 'user/message', window_id: 'w0' }),
      (request) => {
        const match = /#(\d+) \[w0\] user\/message: Keep/.exec(requestText(request))
        if (!match?.[1]) throw new Error('The original user reference was not returned')
        return toolCallResponse('read', 'history_read_item', { seq: Number(match[1]) })
      },
      toolCallResponse('search', 'history_search_contents', { query: 'QUARTZ', event_type: 'user/message', window_id: 'w0' }),
      textResponse('Recovered the original request.'),
    ])
    try {
      await send(agent, 'Keep the quartz rule and finish this task.')
      expect(adapter.requests).toHaveLength(7)
      const fresh = requestText(adapter.requests[2]!)
      expect(fresh).toContain('Current context window id: w1')
      expect(fresh).toContain('checkpoint.md')
      expect(fresh).not.toContain('Keep the quartz rule')
      expect(requestText(adapter.requests[5]!)).toContain('Keep the quartz rule and finish this task.')
      expect(requestText(adapter.requests[6]!)).toContain('Keep the quartz rule and finish this task.')
    } finally { await ctx.fiber.dispose() }
  })

  it('returns useful misses and excludes the current step from lists, searches and exact reads', async () => {
    const { ctx, agent, call } = await setup([textResponse('first'), textResponse('second')])
    try {
      await send(agent, 'first request')
      await send(agent, 'current request')
      const current = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')!
      expect((await call('history_list_items', { event_type: 'user/message' })).text).toContain('first request')
      expect((await call('history_list_items', { event_type: 'user/message' })).text).not.toContain('current request')
      expect((await call('history_search_contents', { query: 'current request' })).text).toBe('No matching history.')
      expect((await call('history_read_item', { seq: current.seq })).text).toContain('No history item')
      expect((await call('history_list_items', { window_id: 'w99' })).text).toContain('Unknown window')
      expect((await call('history_list_items', { event_type: 'plugin:other/event' })).text).toBe('No matching history.')
      expect((await call('history_read_item', { seq: 999999 })).text).toContain('No history item')
      expect((await call('history_read_item', { seq: 'not-a-number' })).isError).toBe(true)
      expect((await call('history_list_items', { limit: 0 })).text).toBe('No matching history.')
      expect((await call('history_list_windows', { limit: 0 })).text).toBe('No windows.')
    } finally { await ctx.fiber.dispose() }
  })
})
