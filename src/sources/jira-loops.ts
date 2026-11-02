/** Jira polling: one JQL search per round, advanced by `updated`, deduplicated by Trigger ID. */
import { z } from 'zod'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { cursorAt, pause } from './poll.ts'
import { CommentSchema, commentTrigger, isDone, IssueSchema, issueTrigger, SOURCE } from './jira-trigger.ts'
import type { JiraConfig } from './jira.ts'

const PAGE = 50
const MAX_PAGES = 5
/** How many Trigger IDs of one issue are remembered to suppress repeats; a busy issue keeps its most recent ones. */
const SEEN = 200
const SearchSchema = z.looseObject({ issues: z.array(z.unknown()).default([]), total: z.number().default(0) })
const CommentsSchema = z.array(z.unknown())

/** Quotes a project key for JQL. */
const quote = (project: string): string => `"${project.replaceAll('"', '')}"`
/** The search a round runs: an explicit `jql` wins, otherwise the configured projects. Jira writes timestamps as `yyyy-MM-dd HH:mm`. */
export function jqlOf(config: JiraConfig, cursor: string): string {
  const filter = config.jql.trim() || `project in (${config.projects.map(quote).join(', ')})`
  return `${filter} AND updated >= "${cursor.slice(0, 16).replace('T', ' ')}" ORDER BY updated ASC`
}

/** Records the Trigger once per ID per issue; true when it is new and should be received. */
function first(ctx: SourceContext, issueKey: string, id: string): boolean {
  const stored = KV.jira.seen(issueKey)
  const seen = ctx.state.get(stored) ?? []
  if (seen.includes(id)) return false
  ctx.state.set(stored, [...seen, id].slice(-SEEN))
  return true
}

/**
 * One polling round: reads every issue updated since the cursor and receives its new representation as a Trigger, then
 * closes the thread of an issue whose status entered Jira's `done` category.
 * @returns the cursor the next round reads from, stepped back five seconds so overlapping updates are not missed.
 */
export async function pollJira(ctx: SourceContext, signal?: AbortSignal): Promise<string> {
  const config = ctx.config<JiraConfig>(SOURCE)
  const started = new Date().toISOString()
  if (!config) return cursorAt(started)
  const commands = ctx.commands.withSignal(signal)
  const stored = ctx.state.get(KV.jira.cursor)
  const firstRound = stored === undefined
  const from = stored ?? started
  // An installation without a Jira account cannot build trigger URLs, and no issue can be read anyway.
  const account = ctx.deployment.jira
  if (!account) return from
  const jql = jqlOf(config, from)
  const fields = 'summary,description,status,assignee,reporter,created,updated,resolutiondate,comment'
  const bots = ctx.bots()
  let newest = from
  let count = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const startAt = page * PAGE
    const found = SearchSchema.parse(await commands.jira(`/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${PAGE}&startAt=${startAt}`))
    for (const raw of found.issues) {
      if (signal?.aborted) return newest
      const parsed = IssueSchema.safeParse(raw)
      if (!parsed.success) continue
      const issue = parsed.data
      if (issue.fields.updated > newest) newest = issue.fields.updated
      count += 1
      // The first round only places the cursor, so switching the Source on never replays history.
      if (firstRound) continue
      const announced = issueTrigger(issue, account, bots)
      // Any update to a received issue is a Trigger for its thread; the Policy decides whether it becomes a candidate.
      if ((announced.addressed || config.observeIssues) && first(ctx, issue.key, announced.id)) ctx.receive(announced)
      const observeComments = config.observeComments
      for (const entry of CommentsSchema.parse(issue.fields.comment?.comments ?? [])) {
        const comment = CommentSchema.safeParse(entry)
        if (!comment.success) continue
        const trigger = commentTrigger(issue, comment.data, account, bots)
        // Without "receive comments", only a comment that addresses the agent is received, and the agent's own never is.
        if (!observeComments && (!trigger.addressed || !trigger.human)) continue
        if (first(ctx, issue.key, trigger.id)) ctx.receive(trigger)
      }
      if (isDone(issue)) ctx.tickets.threadClosed({ source: SOURCE, id: issue.key }, 'closed', issue.fields.resolutiondate ?? issue.fields.updated)
    }
    if (found.issues.length < PAGE || startAt + found.issues.length >= found.total) break
  }
  const cursor = newest === from ? cursorAt(started) : cursorAt(new Date(Date.parse(newest) + 1000).toISOString())
  ctx.atomic(() => ctx.state.set(KV.jira.cursor, cursor))
  ctx.report(SOURCE, { state: 'ready', detail: `${count} issues updated; next poll ≥ ${config.pollSeconds}s`, at: started })
  return cursor
}

/** Reports Jira's health only after `threshold` consecutive failed polls, so one network interruption stays quiet. */
export function jiraFailure(failures: number, threshold: number, error: unknown): ReturnType<typeof health> | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

/** Polls Jira until `signal` aborts, pausing `pollSeconds` between rounds. */
export async function runJira(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  if (!ctx.deployment.jira) { ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'jiraUnset')); return }
  let failures = 0
  while (!signal.aborted) {
    try {
      if (ctx.config<JiraConfig>(SOURCE)) { await pollJira(ctx, signal); failures = 0 } else ctx.report(SOURCE, health('paused', 'sourceOff'))
    } catch (error) {
      failures += 1
      const failed = jiraFailure(failures, 3, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    if (signal.aborted) return
    await pause((ctx.config<JiraConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
