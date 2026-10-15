/** Default prompts, following Codex's token-budget messages, and the `<context_window>` block. */
const ITEM_IDS = 'Note that every non-assistant item, such as user requests, replies and tool results, has an item id `[id: #N]` immediately after its item content; N is its event sequence number in this session.'

/** Guidance repeated once in each new window. */
export const GUIDANCE = `<context_window_guidance>
For tasks that may span context windows, use the notes tools to maintain a concise checkpoint of the goal, decisions, progress, learnings and next steps. Include the item ID of every relevant user request you are currently solving as well as important actions/tool calls. You can use the history tools to look up details with the references later. ${ITEM_IDS}

It is a good idea to take incremental notes while you work so that you do not miss any important info. You can also use \`get_context_remaining\` to find the remaining token budget for better planning. Once the token budget is exhausted, you will lose access to the current window and continue in a fresh context window, and you can only recover through the notes and history tools. So be careful not to over-run the context window without any documentation.

If Previous context window id is present in \`<context_window>\`, it means a context reset occurred and this is a new window. After a reset, read the checkpoint and use the read-only history tools to recover any missing details. When an item ID \`#N\` is known, prefer \`history_read_item({ seq: N })\` directly; when it is missing or uncertain, use \`history_list_items\` or \`history_search_contents\` to locate the item first.
</context_window_guidance>`

/** Remaining tokens are measured to the soft limit. */
export const REMINDER = `<context_window_reminder>
Your current context window is nearly exhausted; only {n_remaining} tokens remain. Before starting a new context window, save concise progress notes with \`notes_write_file\` or \`notes_append_to_file\` with the goal, decisions, progress, learnings, next steps, and the item ID of every relevant user request still being solved, as well as important actions/tool calls for future reference. ${ITEM_IDS} You should write or append notes in a way to best help you recover in a new context window. It is also a good idea to clean up your old notes if they become obsolete or irrelevant. Future context windows will not automatically include the current conversation. After saving your state, call \`new_context\` to continue in a fresh context window.
</context_window_reminder>`

/** Prompt-only fallback; normal tool policy remains authoritative. */
export const FALLBACK = `<context_window_reminder>
The current context window is exhausted. Do not continue the task or give a final answer in this window. The next window will not automatically include this conversation. Make exactly one successful \`notes_write_file\` or \`notes_append_to_file\` call now to save a concise checkpoint with the goal, decisions, progress, learnings, next steps, and the item ID of every relevant user request still being solved, as well as important actions/tool calls for future reference. ${ITEM_IDS} If the write fails, correct it and retry. After the notes result returns, call \`new_context\`; do not use any tools other than the notes tools and \`new_context\`.
</context_window_reminder>`

/** Render window identities and at most 4000 UTF-8 bytes of complete hint lines. */
export function windowBlock(ids: readonly string[], lines: readonly string[]): string {
  const hints: string[] = []
  for (const line of lines) {
    if (Buffer.byteLength([...hints, line].join('\n'), 'utf8') > 4000) break
    hints.push(line)
  }
  return [
    '<context_window>',
    `First context window id: ${ids[0]}`,
    `Current context window id: ${ids.at(-1)}`,
    ...(ids.length > 1 ? [`Previous context window id: ${ids.at(-2)}`] : []),
    ...hints,
    '</context_window>',
  ].join('\n')
}
