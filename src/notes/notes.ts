/** Virtual note paths and the whole-file note projection. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

export function notesState(ctx: Context, session: Session): NotesState {
  const state = ctx.sessionProjections.stateOf(session, 'historyNotes')!
  if (state.failure !== null) throw new HarnessError(state.failure, 'HISTORY_NOTES_STATE')
  return state
}

export function sortedFiles(state: NotesState, prefix = '', orderBy = 'name', descending = false) {
  return Object.entries(state.files).filter(([path]) => path.startsWith(prefix)).sort(([aPath, a], [bPath, b]) => {
    const order = orderBy === 'created_at' ? a.createdSeq - b.createdSeq
      : orderBy === 'updated_at' ? a.updatedSeq - b.updatedSeq : 0
    return (descending ? -1 : 1) * (order || aPath.localeCompare(bPath, 'en'))
  })
}

/** Window hints are best effort, as in Codex: unreadable notes omit them instead of blocking a window. */
export function recentNotes(ctx: Context, session: Session): string[] {
  const state = ctx.sessionProjections.stateOf(session, 'historyNotes')!
  if (state.failure !== null) {
    ctx.logger.warn(`context-window: omitting recent notes; ${state.failure}`)
    return []
  }
  const files = sortedFiles(state, '', 'updated_at', true).slice(0, 5)
  return files.length ? [
    'Recent notes (up to 5, most-recent first):',
    ...files.map(([path, file]) => `- ${path} (${file.lines} lines, ${file.bytes} UTF-8 bytes)`),
  ] : []
}

/** Validate a session-local virtual path without touching the filesystem. */
export function normalizeNotePath(path: string): string {
  if (!notePathSchema.safeParse(path).success) {
    throw new HarnessError(`Invalid note path ${JSON.stringify(path)}. Empty, '.', and '..' path components are `
      + 'unsupported; use a relative path without backslashes or control characters.', 'NOTE_PATH')
  }
  return path
}

const notePathSchema = z.string().refine(path => !path.includes('\\')
  && !/[\u0000-\u001f\u007f]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const recordSchema = z.object({
  version: z.literal(1),
  path: notePathSchema,
  text: z.string(),
})
const seqSchema = z.number().int().nonnegative().transform(SessionSeq)

/** Validates restored projection checkpoints. */
export const notesStateSchema = z.object({
  // A Map intermediate preserves legal names such as '__proto__' during validation.
  files: z.preprocess(value => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? new Map(Object.entries(value)) : value, z.map(z.string(), z.object({
    text: z.string(),
    lines: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    createdSeq: seqSchema,
    updatedSeq: seqSchema,
  }))).transform(files => Object.fromEntries(files)),
  failure: z.string().nullable(),
})

export type NotesState = z.infer<typeof notesStateSchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:history-notes/file': z.infer<typeof recordSchema> }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { historyNotes: NotesState }
}

/** Fold complete file records; malformed records become a visible failed state. */
export function foldNotes(state: NotesState, event: SessionEvent): NotesState {
  const record = pluginRecordOf(event)
  if (record?.type !== 'plugin:history-notes/file') return state
  const parsed = recordSchema.safeParse(record.data)
  if (!parsed.success) return { ...state, failure: `Invalid note record at #${event.seq}; inspect the session log before using notes.` }
  const { path, text } = parsed.data
  const previous = Object.hasOwn(state.files, path) ? state.files[path] : undefined
  return {
    ...state,
    files: {
      ...state.files,
      [path]: {
        text,
        lines: text === '' ? 0 : text.split('\n').length,
        bytes: Buffer.byteLength(text, 'utf8'),
        createdSeq: previous?.createdSeq ?? event.seq,
        updatedSeq: event.seq,
      },
    },
  }
}

/** Apply defaults and reject negative counts after DSH validates integer arguments. */
export function countArg(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (result < 0) {
    throw new HarnessError(`${name} must be non-negative`, 'HISTORY_NOTES_ARGUMENT')
  }
  return result
}

/** Read an inclusive, 1-based line range; negative indices count from the end. */
export function readLines(text: string, start?: number, stop?: number): { text: string; start: number; stop: number } {
  const lines = text === '' ? [] : text.split('\n')
  const index = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    if (value === 0) {
      throw new HarnessError('Note line indices cannot be zero; negative values count from the end', 'HISTORY_NOTES_ARGUMENT')
    }
    return value < 0 ? lines.length + value + 1 : value
  }
  const first = Math.max(1, index(start, 1))
  const last = Math.min(lines.length, index(stop, lines.length))
  return { text: lines.slice(first - 1, Math.max(first - 1, last)).join('\n'), start: first, stop: last }
}
