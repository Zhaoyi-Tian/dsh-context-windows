import assert from 'node:assert/strict'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-context-windows-install-test-model'
export const inject = ['llm']

function textOf(request) {
  return request.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function toolResult(request) {
  const message = request.messages.findLast(message => message.role === 'tool')
  assert.ok(message, 'a completed tool result reaches the next request')
  assert.ok(!message.isError, textOf({ messages: [message] }))
  return textOf({ messages: [message] })
}

class InstalledModel extends LlmAdapter {
  step = 0
  constructor(mode) { super(); this.mode = mode }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 1000000 } }
  }
  async *stream(request) {
    const names = request.tools?.map(tool => tool.name) ?? []
    let call
    let answer
    if (this.mode === 'disabled') {
      assert.ok(!names.includes('new_context'))
      assert.ok(!names.includes('notes_read_file'))
      answer = 'CONTEXT_WINDOWS_DISABLED'
    } else {
      assert.ok(names.includes('new_context'), 'installed plugin provides its tools')
      if (this.mode === 'resume') {
        if (this.step === 0) call = ['notes_read_file', { path: 'checkpoint.md' }]
        else { assert.match(toolResult(request), /CHECKPOINT_SAVED/); answer = 'CONTEXT_WINDOWS_RESUMED' }
      } else {
        switch (this.step) {
          case 0:
            assert.match(textOf(request), /Current context window id: w0/)
            call = ['notes_write_file', { path: 'checkpoint.md', text: 'CHECKPOINT_SAVED: recover the original user message from w0.' }]
            break
          case 1:
            assert.match(toolResult(request), /Saved checkpoint.md/)
            call = ['new_context', {}]
            break
          case 2:
            assert.match(textOf(request), /Current context window id: w1/)
            assert.doesNotMatch(textOf(request), /RECOVERY_NEEDLE/)
            call = ['notes_read_file', { path: 'checkpoint.md' }]
            break
          case 3:
            assert.match(toolResult(request), /CHECKPOINT_SAVED/)
            call = ['history_list_items', { window_id: 'w0', event_type: 'user/message', limit: 100 }]
            break
          case 4: {
            const original = toolResult(request).split('\n').find(line => line.includes('RECOVERY_NEEDLE'))
            assert.ok(original, 'history lists the original instruction')
            const id = original.match(/#\d+/)?.[0]
            assert.ok(id)
            call = ['history_read_item', { seq: Number(id.slice(1)) }]
            break
          }
          case 5:
            assert.match(toolResult(request), /RECOVERY_NEEDLE/)
            assert.match(toolResult(request), /Full formatted result stored at:/, 'the host spills the complete large history result')
            answer = 'CONTEXT_WINDOWS_RECOVERED'
            break
          default: throw new Error('Unexpected extra model request')
        }
      }
    }
    this.step++
    const block = call
      ? { type: 'tool-call', id: ToolCallId(`install-${this.step}`), name: call[0], arguments: JSON.stringify(call[1]) }
      : { type: 'text', text: answer }
    yield { type: 'block-start', index: 0, blockType: block.type }
    if (call) yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } }
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter(['dsh-context-windows-test'], new InstalledModel(config.mode))
}
