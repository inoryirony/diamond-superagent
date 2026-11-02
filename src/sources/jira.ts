/** Jira Source kind: issues and comments in a Jira Server project, received as Triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { JiraAccountSchema } from '../deployment.ts'
import { sendJira, jiraLink } from './jira-channel.ts'
import { runJira } from './jira-loops.ts'
import { jiraThreadContext } from './jira-read.ts'
import { SOURCE } from './jira-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export const JiraConfigSchema = JiraAccountSchema.extend({
  projects: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'project key')).default([]),
  jql: z.string().trim().default(''),
  observeIssues: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
}).strict()
export type JiraConfig = z.infer<typeof JiraConfigSchema>

/** Which admission-table row a trigger's meta belongs to: a comment, or the issue itself. */
const scopeOf = (meta: Record<string, unknown>): 'issues' | 'comments' | undefined =>
  meta.kind === 'comment' ? 'comments' : meta.kind === 'issue' ? 'issues' : undefined

export const jiraKind: SourceKind<JiraConfig> = {
  kind: SOURCE,
  title: { zh: 'Jira', en: 'Jira' },
  description: {
    zh: '有数内网 Jira Server 的项目；接收指派给智能体的 Issue、@ 了它的评论，以及工单被关闭。',
    en: 'Projects on the internal Jira Server; receives Issues assigned to the agent, comments that mention it, and closed tickets.',
  },
  schema: JiraConfigSchema,
  fields: [
    { key: 'projects', type: 'rows', label: { zh: '监听的项目', en: 'Projects' },
      hint: { zh: '项目 key，例如 ZKAI。这个来源在这些项目里搜索更新的 Issue。', en: 'Project keys, such as ZKAI. The Source searches for updated Issues in these projects.' },
      columns: [{ key: 'key', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[A-Z][A-Z0-9_]*' }] },
    { key: 'jql', type: 'text', advanced: true, label: { zh: '自定义 JQL 过滤条件', en: 'Custom JQL filter' },
      hint: { zh: '留空时用上面的项目；写了就以它为准（仍会自动加上 updated 与排序）。', en: 'Empty uses the projects above; when written it replaces them, and the Source still adds `updated` and the ordering.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the projects' },
      hint: { zh: '打开后，没有指派给智能体的 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'Issues not assigned to the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'Jira 每次搜索按 updated 前进，间隔越长单次返回的 Issue 越多。', en: 'Each search advances by `updated`; a longer interval returns more Issues per search.' } },
  ],
  health: [SOURCE],
  // What the Source observes across its projects; elsewhere the search only returns what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    const observe = row === 'issues' ? config.observeIssues : row === 'comments' ? config.observeComments : false
    return { listened: true, observed: observe, ...row ? { row } : {} }
  },
  channel: { send: sendJira, link: jiraLink },
  threadContext: jiraThreadContext,
  // `ZKAI-123` or its browse page names the issue's thread.
  find: query => {
    const issue = /[A-Z][A-Z0-9_]*-\d+/.exec(query)?.[0]
    return { threads: issue ? [`jira:${issue}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.@-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.@-]+$/) }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Jira 账号', en: 'Jira accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.@\\-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        hint: { zh: 'Jira Server 不标记机器人账号，所以只能在这里列出它们。名单里的账号的评论在来源收到时成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人账号的评论当作人写的。', en: 'Jira Server does not mark bot accounts, so they are listed here. A comment of an account on this list becomes an inferred candidate for an assessment when the Source receives it; it never makes an explicit request or stops a ticket. A comment of any other bot is treated as a person\'s.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.@\\-]+' }] },
    ],
    explicit: { zh: '名单里的账号把 Issue 指派给智能体的账号，或在评论里用 [~账号] 提到它。', en: 'An account on the list assigns the Issue to the agent\'s account, or mentions it in a comment as [~account].' },
    rows(stored) {
      const config = JiraConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: 'issues' | 'comments', label: Localized) => ({ id, label, note: note(id === 'issues' ? config.observeIssues : config.observeComments),
        cells: { listedUnaddressed: !!(id === 'issues' ? config.observeIssues : config.observeComments), unlistedAddressed: true,
          unlistedUnaddressed: !!(id === 'issues' ? config.observeIssues : config.observeComments) } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_JIRA_ISSUE', description: { zh: '接下工单的 Jira Issue key，例如 ZKAI-123；工单不是从 Jira 来的时为空。访问令牌不在这个环境里，评论请用 orchestrator_reply', en: 'Key of the Jira Issue that started the ticket, such as ZKAI-123; empty when the ticket did not start on Jira. The Personal Access Token is not in this environment: comment through orchestrator_reply' } },
      { key: 'DSH_SUPERAGENT_JIRA_URL', description: { zh: '这个 Issue 的浏览地址；工单不是从 Jira 来的时为空', en: 'Browse URL of that Issue; empty when the ticket did not start on Jira' } },
    ],
    values: ({ deployment, trigger }) => {
      const issue = trigger?.source === SOURCE ? String(trigger.meta.issueKey ?? '') : ''
      const base = deployment.jira?.baseUrl ?? ''
      return { DSH_SUPERAGENT_JIRA_ISSUE: issue, DSH_SUPERAGENT_JIRA_URL: issue && base ? `${base}/browse/${issue}` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.jira ? {
    account: { zh: `当前账号 ${deployment.jira.displayName || deployment.jira.name}`, en: `Current account ${deployment.jira.displayName || deployment.jira.name}` },
    server: { zh: deployment.jira.baseUrl, en: deployment.jira.baseUrl },
  } : {},
}

export { SOURCE }
export const name = 'dsh-superagent-jira'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(jiraKind), 'jira: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, jiraKind)
    const controller = new AbortController()
    const running = runJira(source, controller.signal).catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
