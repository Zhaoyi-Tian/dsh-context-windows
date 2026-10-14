/** Session-local checkpoint note tools. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { foldNotes, notesStateSchema, normalizeNotePath, readLines, countArg, notesState, sortedFiles } from './notes.js'
import { sessionFor, TEXT_OUTPUT } from '../tools.js'

const PATH = {
  type: 'string',
  required: true,
  description: "Virtual relative note path. Empty, '.', '..', backslashes and control characters are unsupported.",
} as const
const NOTE_SCOPE = ' Notes survive context resets. Paths are virtual and local to this session, not workspace files.'

/** Register note storage and all five session-local note tools. */
export function registerNotes(ctx: Context, maxFileBytes: number): void {
  ctx.sessionProjections.register({
    key: 'historyNotes',
    stateSchema: notesStateSchema,
    stateVersion: 1,
    init: () => ({ files: {}, failure: null }),
    apply: foldNotes,
  })
  const save = (exec: ToolRunContext, pathInput: string, text: string, append: boolean): string => {
    const session = sessionFor(exec)
    const path = normalizeNotePath(pathInput)
    const state = notesState(ctx, session)
    const previous = Object.hasOwn(state.files, path) ? state.files[path].text : ''
    const content = (append ? previous : '') + text
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > maxFileBytes) {
      throw new HarnessError(`Note ${path} would contain ${bytes} UTF-8 bytes; maximum is ${maxFileBytes}. `
        + 'Shorten it or create another file; the note was not changed.', 'NOTE_TOO_LARGE')
    }
    appendPluginRecord(session, 'plugin:history-notes/file', { version: 1, path, text: content })
    const file = ctx.sessionProjections.stateOf(session, 'historyNotes')!.files[path]!
    return `Saved ${path} (${file.lines} lines, ${file.bytes} UTF-8 bytes).`
  }
  ctx.tools.register(defineTool({
    name: 'notes_list_files_by_prefix',
    description: 'List notes by path prefix.' + NOTE_SCOPE,
    parameters: {
      prefix: { type: 'string' },
      max_results: { type: 'integer', description: 'Maximum files; default 50.' },
      file_order_by: { type: 'string', enum: ['name', 'created_at', 'updated_at'] },
      file_order: { type: 'string', enum: ['ascending', 'descending'] },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const files = sortedFiles(notesState(ctx, sessionFor(exec)), args.prefix, args.file_order_by, args.file_order === 'descending')
      return files.slice(0, countArg(args.max_results, 50, 'max_results'))
        .map(([path, file]) => `${path} (${file.lines} lines, ${file.bytes} UTF-8 bytes)`).join('\n') || 'No notes.'
    },
  }))
  ctx.tools.register(defineTool({
    name: 'notes_read_file',
    description: 'Read all or a line range from notes.' + NOTE_SCOPE,
    parameters: {
      path: PATH,
      start_line: { type: 'integer', description: 'Inclusive first line, 1-based; negative counts from the end.' },
      stop_line: { type: 'integer', description: 'Inclusive last line; negative counts from the end.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = normalizeNotePath(args.path)
      const files = notesState(ctx, sessionFor(exec)).files
      if (!Object.hasOwn(files, path)) throw new HarnessError(`No note ${path}; use notes_list_files_by_prefix.`, 'NOTE_NOT_FOUND')
      const file = files[path]!
      const range = readLines(file.text, args.start_line, args.stop_line)
      return range.stop < range.start ? `${path}: no lines in this range.`
        : `${path} lines ${range.start}–${range.stop} of ${file.lines}\n${range.text}`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'notes_search_contents',
    description: 'Search note lines by case-sensitive literal substring.' + NOTE_SCOPE,
    parameters: {
      query: { type: 'string', required: true },
      max_matches_per_file: { type: 'integer', description: 'Maximum matching lines per file; default 5.' },
      recent_file_first: { type: 'boolean', description: 'Newest updated files first when true.' },
      max_files: { type: 'integer', description: 'Maximum matching files; default 50.' },
      path_prefix: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const maxFiles = countArg(args.max_files, 50, 'max_files')
      const maxMatches = countArg(args.max_matches_per_file, 5, 'max_matches_per_file')
      const matches: string[][] = []
      for (const [path, file] of sortedFiles(notesState(ctx, sessionFor(exec)), args.path_prefix,
        args.recent_file_first ? 'updated_at' : 'name', args.recent_file_first)) {
        if (matches.length >= maxFiles) break
        const lines = file.text.split('\n').flatMap((text, i) => text.includes(args.query) ? [`${path}:${i + 1}: ${text}`] : [])
          .slice(0, maxMatches)
        if (lines.length > 0) matches.push(lines)
      }
      return matches.flat().join('\n') || 'No matching note lines.'
    },
  }))
  for (const append of [false, true]) {
    ctx.tools.register(defineTool({
      name: append ? 'notes_append_to_file' : 'notes_write_file',
      description: (append ? 'Append text to notes.' : 'Create or replace notes.')
        + ` The resulting file must fit in ${maxFileBytes} UTF-8 bytes.` + NOTE_SCOPE,
      parameters: { path: PATH, text: { type: 'string', required: true,
        description: append ? 'Text appended exactly as supplied.' : 'Complete replacement text.' } },
      output: TEXT_OUTPUT,
      async execute(args, exec) { return save(exec, args.path, args.text, append) },
    }))
  }
}
