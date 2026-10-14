/** Context windows, checkpoint notes, and history in one Cordis plugin. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.js'
import { registerWindow } from './window/index.js'
import { registerNotes } from './notes/index.js'
import { registerHistory } from './notes/history.js'

export { Config }
export const name = 'dsh-context-windows'
export const inject = ['tokenMeter', 'llm', 'sessionProjections', 'tools', 'sessions', 'sessionQuery']

export function apply(ctx: Context, input: ReturnType<typeof Config>): void {
  const config = resolveConfig(input)
  registerNotes(ctx, config.maxFileBytes)
  registerWindow(ctx, config)
  registerHistory(ctx)
}
