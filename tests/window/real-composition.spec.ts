import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import * as ContextWindows from '../../dist/index.js'
import { MockAdapter, textResponse, toolCallResponse, send, requestText } from './harness.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Loader composition', () => {
  it.each(['native', 'ptc', 'ptc-parent-failure'] as const)('switches through the real %s tool pipeline', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-window-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    const program = 'await tools.notes_write_file({path:"checkpoint.md",text:"Continue after the window switch."}); await tools.new_context({});'
      + (mode === 'ptc-parent-failure' ? 'throw new Error("parent failed after the successful child call");' : '')
    const adapter = new MockAdapter([
      mode === 'native' ? toolCallResponse('switch', 'new_context', {})
        : toolCallResponse('program', 'run_code', { code: program, description: 'Save checkpoint and start a new window' }),
      textResponse('continued'),
    ])
    const modules = new Map<string, unknown>([
      ['llm', LlmRuntime], ['session', SessionStore], ['projection', SessionProjectionRegistry],
      ['prompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop],
      ['meter', TokenMeter], ['query', SqliteSessionQuery], ['dsh-context-windows', ContextWindows],
      ['fs', FileSystem], ['cwd', WorkingDirectory], ['subprocess', Subprocess], ['sandbox', Sandbox],
      ['sandbox-policy', SandboxPolicy], ['ptc', NodeRuntime],
      ['model', { name: 'fixture-model', inject: ['llm'], apply(inner: Context) { inner.llm.registerAdapter(['mock'], adapter) } }],
    ])
    const entries = [
      '- name: llm', '- name: session', '- name: projection',
      '- name: prompt', '  config: { includeHarnessIdentity: false, includeRuntimeContext: false }',
      '- name: tools', `  config: { mode: ${mode === 'native' ? 'native' : 'ptc'} }`,
      '- name: agents', '- name: meter', '- name: fs', '- name: cwd',
      '- name: query', '  config: { path: ":memory:", openAt: never }',
      '- name: dsh-context-windows', '- name: model',
      ...(mode === 'native' ? [] : [
        '- name: subprocess', '- name: sandbox', '- name: sandbox-policy',
        '  config: { mode: danger-full-access }', '- name: ptc',
      ]),
      '- name: loop', '  config: { agents: [] }', '',
    ].join('\n')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, entries)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      loadCache: new Map(),
      register() { throw new Error('Unexpected Loader register') },
      getOrCreateModuleJob() { throw new Error('Unexpected Loader module job') },
      resolveSync() { throw new Error('Unexpected Loader resolve') },
      load() { throw new Error('Unexpected Loader load') },
      async import(specifier: string) {
        const loaded = modules.get(specifier)
        if (loaded === undefined) throw new Error(`Unexpected Loader import: ${specifier}`)
        return loaded
      },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
    const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'mock', model: 'mock' }, { cwd: root })
    await send(agent, 'Original request before the context switch')
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).toContain('Current context window id: w1')
    expect(requestText(adapter.requests[1]!)).not.toContain('Original request before the context switch')
    if (mode !== 'native') {
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
      const nested = agent.session.snapshotEvents().filter(event =>
        event.type === 'tool/ptc-dispatch' && event.data.name === 'new_context')
      expect(nested).toHaveLength(1)
      expect(nested[0]?.data).toMatchObject({ isError: false })
      expect(requestText(adapter.requests[1]!)).toContain('checkpoint.md')
    }
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })
})
