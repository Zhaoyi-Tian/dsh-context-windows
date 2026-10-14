import { settings as resolveConfig } from './harness.ts'
import { describe, expect, it } from 'vitest'
import { resolveBudget } from '../../src/window/budget.ts'
import { windowBlock } from '../../src/window/prompts.ts'

describe('working budget', () => {
  it('reserves output and a fallback buffer without overstating the 80Ki cap', () => {
    const config = resolveConfig({})
    expect(resolveBudget(config, 128000, 8192, 2500)).toEqual({
      total: 2500, hard: 81920, remaining: 63036,
    })
    expect(resolveBudget(config, 60000, 10000, 80000).remaining).toBe(0)
    expect(resolveBudget(config, 60000, 10000, 0).hard).toBe(50000)
  })
  it('follows the adapter when uncapped and removes the buffer when fallback is disabled', () => {
    const config = resolveConfig({ contextTokens: null, prompts: { fallback: null } })
    expect(resolveBudget(config, 10000, 0, 2500).remaining).toBe(7500)
  })
  it('allows reminders from the first measurable step in a small window', () => {
    const config = resolveConfig({ contextTokens: 100, fallbackBufferTokens: 0, reminderThresholdTokens: 1000 })
    expect(resolveBudget(config, 10000, 0, 1).remaining).toBe(99)
  })
  it.each([
    { contextTokens: 0 }, { contextTokens: -1 }, { contextTokens: NaN },
    { fallbackBufferTokens: -1 }, { reminderThresholdTokens: 1.5 },
  ])('rejects an invalid setting before registration: %j', (input) => {
    expect(() => resolveConfig(input)).toThrow()
  })
  it('reports capacity, output and buffer values when there is no positive budget', () => {
    for (const [window, reserve] of [[10000, 10000], [10000, -1], [10000, 0]]) {
      expect(() => resolveBudget(resolveConfig({}), window!, reserve!, 0)).toThrow(/no working budget/)
    }
  })
  it('accepts an exact one-token working budget', () => {
    const config = resolveConfig({ contextTokens: null, prompts: { fallback: null, guidance: '', reminder: '{n_remaining}/{n_remaining}' } })
    expect(resolveBudget(config, 10000, 9999, 0)).toEqual({ total: 0, hard: 1, remaining: 1 })
    expect(resolveBudget(config, 10000, 9999, 1).remaining).toBe(0)
  })
  it('bounds complete multibyte hint lines rather than splitting one', () => {
    const ids = ['w0', 'w1']
    const block = windowBlock(ids, ['Recent notes:', '界'.repeat(1400), 'omitted'])
    expect(block).toContain('Previous context window id: w0')
    expect(block).toContain('Recent notes:')
    expect(block).not.toContain('omitted')
    expect(block).not.toContain('界')
  })
})
