import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as ContextWindows from '../../dist/index.js'
import { harness, send } from './harness.ts'

it.skipIf(!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL)('recovers an original instruction through notes and history with a real model', {
  timeout: 180_000,
  retry: 0,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-context-recovery-e2e-'))
  onTestFinished(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
  vi.stubEnv('DSH_HOME', home)
  const { ctx, fiber } = await harness([])
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const model = process.env.DEEPSEEK_MODEL ?? 'deepseek/deepseek-v4.1-flash'
    await ctx.plugin(PiAi, {
      providers: {
        'dsh-context-windows-test': {
          api: 'openai-completions',
          baseURL: process.env.DEEPSEEK_BASE_URL,
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          compat: { thinkingFormat: 'openrouter' },
          models: [{ id: model, contextWindow: 1000000, maxTokens: 2048, reasoningEfforts: { off: null, high: 'high' } }],
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        },
      },
    })
    await fiber.dispose()
    await ctx.plugin(ContextWindows, {})
    const agent = await ctx.agentLoop.create(SessionId(randomUUID()), {
      provider: 'dsh-context-windows-test', model, reasoningEffort: ReasoningEffortId('off'),
    })
    timeout = setTimeout(() => { agent.cancel({ kind: 'user' }) }, 160_000)
    const code = `RECOVER-${randomUUID()}`
    const checkpoint = 'Continue this task after switching: read checkpoint.md, use history_list_items to find the original human user message in window w0, then history_read_item to read it. Answer with only its RECOVERY_CODE. Do not switch again.'
    await send(agent, [
      'Exercise context recovery using tools in the following order:',
      `1. Call notes_write_file with path checkpoint.md and exactly this text: ${JSON.stringify(checkpoint)}`,
      '2. Call new_context. Do not call any other tools in the same batch.',
      '3. Continue from the checkpoint in the new window. Read the note, list the original human message in w0, and read its returned event sequence number with history_read_item before answering.',
      'Do not put the code in notes. Retrieve it from history after switching.',
      `RECOVERY_CODE: ${code}`,
    ].join('\n'))
    const events = agent.session.snapshotEvents()
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    const required = ['notes_write_file', 'new_context', 'notes_read_file', 'history_list_items', 'history_read_item']
    let previous = -1
    for (const name of required) {
      const index = calls.indexOf(name, previous + 1)
      expect(index, `Missing ordered recovery call ${name}: ${calls.join(', ')}`).toBeGreaterThan(previous)
      previous = index
    }
    expect(ctx.sessionProjections.stateOf(agent.session, 'contextWindow')?.windows).toHaveLength(2)
    expect(ctx.sessionProjections.stateOf(agent.session, 'historyNotes')?.files['checkpoint.md']?.text).toBe(checkpoint)
    const final = events.findLast(event => event.type === 'assistant/message')
    expect(final?.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()).toBe(code)
  } finally {
    clearTimeout(timeout)
    await ctx.fiber.dispose()
  }
})
