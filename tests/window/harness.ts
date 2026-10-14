import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import * as ContextWindows from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { resolveConfig } from '../../src/config.ts'
import { MockAdapter } from '../support/mock-adapter.ts'

export { textResponse, toolCallResponse, MockAdapter } from '../support/mock-adapter.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/** The same schema-then-defaults sequence used by Cordis activation. */
export const settings = (input: Config = {}) => resolveConfig(ContextWindows.Config(input))

/** Real services and AgentLoop; only the external model is scripted. */
export async function harness(script: Script, config: Config = {}) {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ":memory:", openAt: "never" })
    const fiber = await ctx.plugin(ContextWindows, config)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter(script)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'mock', model: 'mock' })
    return { ctx, agent, adapter, fiber }
  } catch (error: unknown) {
    await ctx.fiber.dispose()
    throw error
  }
}

export async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

export function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

export function withUsage(chunks: StreamChunk[], inputTokens: number): StreamChunk[] {
  return chunks.map(chunk => chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens, outputTokens: 1 } } : chunk)
}
