/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  return text
}
/**
 * A reply's length limit by Source: Feishu takes `IM_WORDS` words, where a thread reads as a feed; DingTalk takes a
 * character count, where an answer carries its evidence; a Source absent here sets no limit.
 */
export const REPLY_LIMITS: Readonly<Record<string, { words: number } | { chars: number }>> = { feishu: { words: IM_WORDS }, dingtalk: { chars: 4000 } }
/** Validates an outgoing reply against its Source's limit, if it has one. */
export function checkedReplyText(text: string, source: string): string {
  const limit = REPLY_LIMITS[source]
  if (!limit) return text
  if ('words' in limit) return checkedImText(text)
  if (text.length > limit.chars) throw new Error(`Reply has ${text.length} characters; maximum is ${limit.chars} on ${source}. Shorten it; keep the evidence, drop the narration.`)
  return text
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
