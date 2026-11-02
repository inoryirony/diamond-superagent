/** Minimal Markdown to Jira wiki markup, and the hidden marker that makes outbound comments idempotent. */

/** The invisible (white) marker appended to an outbound comment so a retry can find it. */
export const jiraMarker = (id: string): string => `{color:#ffffff}dsh-superagent:${id}{color}`
/** True when `text` carries a dsh-superagent outbound marker, which only this agent writes. */
export const hasMarker = (text: string): boolean => /\{color:#ffffff\}dsh-superagent:[^{}\s]+\{color\}/.test(text)

/** Converts headings, inline and fenced code, bold, links and lists; everything else passes through as written. */
export function toWiki(markdown: string): string {
  const kept: string[] = []
  const keep = (text: string): string => `§${kept.push(text) - 1}§`
  const text = markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) => keep(`{code}\n${code.replace(/\n$/, '')}\n{code}`))
    .replace(/`([^`\n]+)`/g, (_match, code: string) => keep(`{{${code}}}`))
    .split('\n').map(line => line
      .replace(/^(#{1,6})\s+(.*)$/, (_match, hashes: string, title: string) => `h${hashes.length}. ${title}`)
      .replace(/^(\s*)[-*]\s+/, (_match, indent: string) => `${'*'.repeat(Math.floor(indent.length / 2) + 1)} `)).join('\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '[$1|$2]')
  return text.replace(/§(\d+)§/g, (_match, index: string) => kept[Number(index)]!)
}
