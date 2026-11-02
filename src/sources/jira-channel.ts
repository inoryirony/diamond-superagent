/** Jira outbound channel: posts issue comments under the Personal Access Token's account. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import { jiraMarker, toWiki } from './jira-text.ts'
import { jiraPage } from './jira-trigger.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** True when the issue no longer exists or the account may no longer comment on it. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 403)
/** Posts a comment with a hidden marker; a retry first scans the issue's recent comments for the marker so it never posts twice. */
export async function sendJira(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const issue = message.channel.address.issue
  if (!issue) throw new Error('Missing Jira reply target')
  const marker = jiraMarker(message.id)
  try {
    const listed = await commands.jira<{ comments?: { body?: string | null }[] }>(`/rest/api/2/issue/${issue}/comment?orderBy=-created&maxResults=100`)
    if ((listed.comments ?? []).some(comment => (comment.body ?? '').includes(marker))) return 'sent'
    await commands.jira(`/rest/api/2/issue/${issue}/comment`, { method: 'POST', body: { body: `${toWiki(message.text)}\n\n${marker}` } })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function jiraLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const issue = address.issue ?? ''
  const base = links.jira?.baseUrl
  return { url: base && issue ? jiraPage(base, issue) : '', label: { zh: `Jira ${issue}`, en: `Jira ${issue}` } }
}
