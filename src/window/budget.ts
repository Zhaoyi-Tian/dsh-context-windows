/** Token budgets for the routed model. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ResolvedConfig } from '../config.js'

/** Reserve output and fallback capacity; reject configurations without a positive working budget. */
export function resolveBudget(config: ResolvedConfig, window: number, reserve: number, total: number) {
  const hard = Math.min(config.contextTokens ?? window, window - reserve)
  const soft = hard - (config.prompts.fallback ? config.fallbackBufferTokens : 0)
  if (soft <= 0) {
    throw new HarnessError(`context-window: no working budget (contextWindow=${window}, maxTokens=${reserve}, `
      + `contextTokens=${config.contextTokens}, fallbackBufferTokens=${config.fallbackBufferTokens})`, 'BUDGET_INVALID')
  }
  return { total, hard, remaining: Math.max(soft - total, 0) }
}

/** Measure against a route, by default the last logged one; null when no route or window bound is known. */
export async function measureBudget(ctx: Context, session: Session, config: ResolvedConfig, signal: AbortSignal,
  route: { provider: string; model: string; maxTokens?: number } | undefined = session.requestHeader()?.config) {
  if (route === undefined) return null
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  signal.throwIfAborted()
  const window = info.context?.contextWindow ?? (config.contextTokens === null ? undefined : Infinity)
  if (window === undefined) return null
  return resolveBudget(config, window, route.maxTokens ?? info.defaultMaxTokens ?? 0,
    ctx.tokenMeter.measure(session).totalTokens)
}
