/** Plugin settings; defaults that must survive an explicit null are applied after validation. */
import z from '@deepseek-ai/schemastery'
import { GUIDANCE, REMINDER, FALLBACK } from './window/prompts.js'

const integer = (minimum: number) => z.number().step(1).min(minimum).max(Number.MAX_SAFE_INTEGER)

/** Native schema shared by Cordis activation and the settings UI. */
export const Config = z.object({
  contextTokens: z.union([integer(1), z.const(null)]),
  reminderThresholdTokens: integer(0).default(6144),
  fallbackBufferTokens: integer(0).default(16384),
  maxFileBytes: integer(1).default(1_000_000),
  prompts: z.object({
    guidance: z.string().default(GUIDANCE),
    reminder: z.string().default(REMINDER),
    fallback: z.union([z.string(), z.const(null)]),
  }).default({}),
}).default({})

export type Config = Schemastery.TypeS<typeof Config>
export type ResolvedConfig = ReturnType<typeof resolveConfig>

/** Apply only the defaults that must preserve null, after Cordis has validated the settings. */
export function resolveConfig({
  contextTokens = 81920, prompts: { fallback = FALLBACK, ...prompts }, ...config
}: ReturnType<typeof Config>) {
  // Destructuring defaults preserve null; Schemastery's default() replaces it.
  return { ...config, contextTokens, prompts: { ...prompts, fallback } }
}
