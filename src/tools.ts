/** Shared tool helpers. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** The host also permits tool calls without an agent; this plugin requires one. */
export function sessionFor(exec: ToolRunContext) {
  if (!exec.agent) throw new HarnessError('Context window tools require an owning agent session', 'CONTEXT_WINDOWS_NO_AGENT')
  return exec.agent.session
}

export const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
