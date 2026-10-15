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
    const fix = window - reserve <= (config.contextTokens ?? window)
      ? `the model's contextWindow ${window} leaves ${window - reserve} tokens after its maxTokens output reserve ${reserve}; `
        + 'lower that model\'s maxTokens instead of shrinking its contextWindow'
      : `contextTokens ${config.contextTokens} does not exceed fallbackBufferTokens ${config.fallbackBufferTokens}; `
        + 'raise contextTokens or lower fallbackBufferTokens'
    throw new HarnessError(`context-window: no working budget: ${fix}`, 'BUDGET_INVALID')
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
  return resolveBudget(config, window, route.maxTokens ?? info.defaultMaxTokens ?? 0, requestTokens(ctx, session))
}

/**
 * The latest provider usage in the active window plus estimates for nodes added after it. The host meter
 * prefers its own estimate whenever that is higher, which overstates code-heavy windows.
 */
export function requestTokens(ctx: Context, session: Session): number {
  const measurement = ctx.tokenMeter.measure(session)
  let added = 0
  for (const node of measurement.nodes.toReversed()) {
    const event = session.eventAt(node.seq)
    if (event?.type === 'assistant/message' && event.data.usage !== undefined) {
      const usage = event.data.usage
      return (usage.totalTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        + usage.outputTokens) + added
    }
    added += node.tokens
  }
  // No call in this window yet, such as right after a switch.
  return measurement.totalTokens
}
