/** Normalizes Jira issues and comments into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { JiraAccount } from '../deployment.ts'
import { sameName } from '../infra/text.ts'

export const SOURCE = 'jira'
const UserSchema = z.looseObject({ name: z.string().optional(), displayName: z.string().optional() }).nullish()
const StatusSchema = z.looseObject({ name: z.string().default(''), statusCategory: z.looseObject({ key: z.string().default('') }).nullish() })
/** A Jira comment; Jira Server numbers comments as strings and writes bodies as wiki markup. */
export const CommentSchema = z.looseObject({ id: z.string(), body: z.string().nullish(), author: UserSchema, created: z.string().nullish(), updated: z.string().nullish() })
export type JiraComment = z.infer<typeof CommentSchema>
/** An issue with the fields the Source reads; `comment` holds the first comments Jira embeds in a search result. */
export const IssueSchema = z.looseObject({ key: z.string(), fields: z.looseObject({
  summary: z.string().default(''), description: z.string().nullish(), status: StatusSchema.nullish(), assignee: UserSchema, reporter: UserSchema,
  created: z.string(), updated: z.string(), resolutiondate: z.string().nullish(),
  comment: z.looseObject({ comments: z.array(z.unknown()).default([]), total: z.number().optional() }).nullish() }) })
export type JiraIssue = z.infer<typeof IssueSchema>
type Self = Pick<JiraAccount, 'baseUrl' | 'name'>

/** Jira reply address: the issue's comment list. */
export const jiraChannel = (issueKey: string): ChannelRef => ({ source: SOURCE, thread: `jira:${issueKey}`, address: { issue: issueKey } })
export const jiraPage = (baseUrl: string, issueKey: string): string => `${baseUrl}/browse/${issueKey}`
export const projectOf = (issueKey: string): string => issueKey.replace(/-\d+$/, '')
export const nameOf = (user: z.infer<typeof UserSchema>): string => user?.name ?? ''
/** True when the text mentions the account the way Jira does, `[~name]`. */
export const mentions = (text: string, name: string): boolean => !!name && text.toLowerCase().includes(`[~${name.toLowerCase()}]`)
/** True when the issue's status is in Jira's `done` category. */
export const isDone = (issue: JiraIssue): boolean => issue.fields.status?.statusCategory?.key === 'done'

/** Jira Server has no bot flag: a name on the Policy's `bots` list is a bot, and the agent's own account is never a person. */
function author(user: z.infer<typeof UserSchema>, me: string, bots: readonly string[]) {
  const id = nameOf(user)
  return { actor: { source: SOURCE, id }, human: !!id && !sameName(id, me) && !bots.some(bot => sameName(bot, id)) }
}
function addressedOf(text: string, issue: JiraIssue, me: string): { addressed?: 'direct' | 'mention' } {
  if (me && sameName(nameOf(issue.fields.assignee), me)) return { addressed: 'direct' }
  return mentions(text, me) ? { addressed: 'mention' } : {}
}
const metaOf = (issue: JiraIssue, kind: 'issue' | 'comment', commentId?: string): Record<string, unknown> =>
  ({ issueKey: issue.key, ...commentId ? { commentId } : {}, kind, status: issue.fields.status?.name ?? '', project: projectOf(issue.key) })

/** Builds the trigger for an issue's summary and description; its ID changes only when the issue is created anew. */
export function issueTrigger(issue: JiraIssue, account: Self, bots: readonly string[] = []): Trigger {
  const { fields } = issue
  const text = `${fields.summary}\n\n${fields.description ?? ''}`.trim()
  return { id: key('jira-issue', issue.key, fields.created), source: SOURCE, threads: [{ source: SOURCE, id: issue.key }],
    ...author(fields.reporter, account.name, bots), at: fields.created, text, ...addressedOf(text, issue, account.name),
    channel: jiraChannel(issue.key), url: jiraPage(account.baseUrl, issue.key), meta: metaOf(issue, 'issue') }
}
/** Builds the trigger for a comment; an edit (a new `updated`) is a new Trigger. */
export function commentTrigger(issue: JiraIssue, comment: JiraComment, account: Self, bots: readonly string[] = []): Trigger {
  const text = comment.body ?? ''
  return { id: key('jira-comment', issue.key, comment.id, comment.updated ?? ''), source: SOURCE, threads: [{ source: SOURCE, id: issue.key }],
    ...author(comment.author, account.name, bots), at: comment.updated ?? comment.created ?? issue.fields.updated, text,
    ...addressedOf(text, issue, account.name), channel: jiraChannel(issue.key), url: jiraPage(account.baseUrl, issue.key),
    meta: metaOf(issue, 'comment', comment.id) }
}
