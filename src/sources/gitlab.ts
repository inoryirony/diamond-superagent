/** GitLab Source kind: follows the agent's merge requests so a ticket ends when its MR merges or closes. It receives no Triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS } from './poll.ts'
import { MrSchema, observeMr, SOURCE } from './gitlab-mr.ts'

export const GitlabConfigSchema = GitlabAccountSchema.extend({ pollSeconds: z.number().int().min(30).max(3600).default(60) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: {
    zh: '智能体的 GitLab 账号；跟随它在 group 里开的合并请求（MR），MR 合并或关闭时结束对应的工单。不接收消息，也不回复。',
    en: 'The agent\'s GitLab account; follows the merge requests it opens in the group and ends the ticket when its MR merges or closes. It receives and sends no messages.',
  },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '智能体的 glab CLI', en: 'Agent glab CLI' },
      hint: { zh: '命令名或绝对路径，已用智能体账号登录的 glab。执行器以 glab 调用它。保存时检查登录账号，然后重启 dsh-superagent。', en: 'A command name or absolute path of a glab signed in to the agent account; the Executor calls it as glab. Saving checks the signed-in account, then restarts dsh-superagent.' } },
    { key: 'group', type: 'text', label: { zh: '监听的 group', en: 'Group' },
      hint: { zh: '例如 xk/product/zk-ai。这个来源在该 group 的所有项目里找智能体开的 MR。', en: 'Such as xk/product/zk-ai. The Source looks for the agent\'s MRs in every project of the group.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [SOURCE],
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_MR', description: { zh: '这个来源监听的 GitLab group。智能体从 dev 切出分支 agent/$DSH_SUPERAGENT_NAME 并开合并请求，再在工单上报 mr 时绑定；没有配置 GitLab 时为空。ZKAI 仓库的分支纪律是先进 dev，由人把 dev 提升到 test 才部署测试环境', en: 'The GitLab group this Source watches. A merge request the agent opens from a branch named after the ticket binds to the ticket through the report\'s `mr`; empty when GitLab is not configured. The ZKAI repositories move work into dev first, and a person promotes dev to test to deploy the test environment' } },
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: '这个工单发起时的 GitLab 地址；要让部署与端到端检查用它确认 MR 已经上线，需要改由 `orchestrator_read` 读取工单跟随的 MR', en: 'The GitLab URL of the message that started this ticket; a deploy or end-to-end check that confirms the MR is live reads the MR the ticket follows with orchestrator_read instead' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_GITLAB_MR: deployment.gitlab?.group ?? '',
      DSH_SUPERAGENT_GITLAB_URL: trigger?.source === SOURCE ? String(trigger.meta.url ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.username}`, en: `Current account @${deployment.gitlab.username}` },
  } : {},
}

/** One round: reads the agent's MRs in the group updated since the cursor, oldest first, and reconciles each with the open tickets. */
export async function pollGitlab(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const account = ctx.deployment.gitlab
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!account || !config) return
  const started = new Date().toISOString()
  // The first round reads back over the polling horizon so an MR opened before the Source was switched on is still claimed.
  const since = ctx.state.get(KV.gitlab.cursor) ?? new Date(Date.parse(started) - POLL_HORIZON_MS).toISOString()
  const path = `groups/${encodeURIComponent(account.group)}/merge_requests?author_username=${encodeURIComponent(account.username)}&state=all&updated_after=${encodeURIComponent(since)}&per_page=100`
  const listed = z.array(z.unknown()).parse(await ctx.commands.withSignal(signal).glab<unknown>(['api', path]))
  const requests = listed.flatMap(raw => { const parsed = MrSchema.safeParse(raw); return parsed.success ? [parsed.data] : [] })
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  for (const mr of requests) {
    if (signal?.aborted) return
    observeMr(ctx, mr, account.username)
  }
  ctx.atomic(() => ctx.state.set(KV.gitlab.cursor, cursorAt(started)))
  ctx.report(SOURCE, { state: 'ready', detail: `${requests.length} merge requests updated; next poll ≥ ${config.pollSeconds}s`, at: started })
}

/** Polls GitLab until `signal` aborts; health turns to error only after three consecutive failed rounds. */
export async function runGitlab(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  if (!ctx.deployment.gitlab) { ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'gitlabUnset')); return }
  let failures = 0
  while (!signal.aborted) {
    try {
      if (ctx.config<GitlabConfig>(SOURCE)) { await pollGitlab(ctx, signal); failures = 0 } else ctx.report(SOURCE, health('paused', 'sourceOff'))
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= 3) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    if (signal.aborted) return
    await pause((ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = runGitlab(source, controller.signal).catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
