/** Read-only Jira issue inspection for assessments: the issue and its comments as one conversation. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import { CommentSchema, IssueSchema, nameOf } from './jira-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const PAGE = 100
const MAX_PAGES = 20
const CommentPage = z.looseObject({ comments: z.array(z.unknown()).default([]), total: z.number().default(0) })

/** Reads the issue and all of its comments, oldest first; the issue's summary and description are the first message. */
export async function readJira(commands: Commands, issueKey: string): Promise<{ messages: ContextMessage[]; status: string }> {
  const issue = IssueSchema.parse(await commands.jira(`/rest/api/2/issue/${issueKey}?fields=summary,description,status,reporter,assignee,created,updated`))
  const messages: ContextMessage[] = [{ id: `issue:${issue.key}`, from: nameOf(issue.fields.reporter), at: issue.fields.created,
    text: `${issue.fields.summary}\n\n${issue.fields.description ?? ''}`.trim() }]
  for (let page = 0, start = 0; page < MAX_PAGES; page++) {
    const listed = CommentPage.parse(await commands.jira(`/rest/api/2/issue/${issueKey}/comment?orderBy=created&startAt=${start}&maxResults=${PAGE}`))
    for (const raw of listed.comments) {
      const comment = CommentSchema.safeParse(raw)
      if (comment.success) messages.push({ id: comment.data.id, from: nameOf(comment.data.author), at: comment.data.created ?? issue.fields.created, text: comment.data.body ?? '' })
    }
    start += listed.comments.length
    if (!listed.comments.length || start >= listed.total) break
  }
  return { messages, status: issue.fields.status?.name ?? '' }
}
/** Context reader for a Jira Trigger: the whole issue is its thread, and its first message is the root and the parent. */
export const jiraThreadContext: ThreadContext<unknown> = {
  messageId: trigger => typeof trigger.meta.commentId === 'string' ? trigger.meta.commentId : `issue:${String(trigger.meta.issueKey)}`,
  read: async (commands, trigger, part) => {
    const { messages, status } = await readJira(commands, String(trigger.meta.issueKey))
    const read = part === 'thread' ? messages : messages.slice(0, 1)
    return { messages: read, body: { status, messages: read }, status }
  },
}
