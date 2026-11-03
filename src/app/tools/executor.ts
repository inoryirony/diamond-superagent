/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { latestAssignment, liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import { MrSchema, mrId, SOURCE as GITLAB } from '../../sources/gitlab-mr.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { Commands } from '../../infra/commands.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { missingEvidence, toolCalls } from '../session-actions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

/**
 * Binds a GitLab merge request named by a report to the ticket, so the ticket follows it and ends when it merges or closes,
 * as a reported GitHub pull request does. The argument is the MR's web URL or `<project path>!<iid>`; both forms are what a
 * worker reads from `glab`, and the API call is how the project id and the MR's real state are learned.
 * @returns what was bound, or a note saying why nothing was, which the report still records.
 */
async function bindMergeRequest(host: ExecutorToolsHost, ticketId: string, name: string,
  signal?: AbortSignal): Promise<{ bound: string } | { note: string }> {
  const parsed = parseMergeRequest(name)
  if (!parsed) return { note: `mr was ignored: "${name}" is neither a merge request URL nor "<project path>!<iid>"` }
  let mr: z.infer<typeof MrSchema>
  try {
    const project = encodeURIComponent(parsed.project)
    mr = MrSchema.parse(await host.commands.withSignal(signal).glab(['api', `projects/${project}/merge_requests/${parsed.iid}`]))
  } catch (error) {
    return { note: `mr was ignored: reading ${parsed.project}!${parsed.iid} failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}` }
  }
  if (mr.state !== 'opened') return { note: `mr was ignored: ${parsed.project}!${parsed.iid} is ${mr.state}, so there is nothing to follow` }
  const id = mrId(mr)
  // The ticket follows the merge request as its own work, the way a reported pull request is bound.
  host.gitlabContext.tickets.bindThread(ticketId, { source: GITLAB, id }, true)
  host.gitlabContext.threads.patch(`${GITLAB}:${id}`, { iid: mr.iid, projectId: mr.project_id, ...mr.web_url ? { url: mr.web_url } : {} })
  return { bound: `${GITLAB}:${id}` }
}

/** Splits an MR's web URL or `<project path>!<iid>` into the project path and its iid, or undefined when it is neither. */
export function parseMergeRequest(name: string): { project: string; iid: number } | undefined {
  const url = name.match(/^(?:https?:\/\/[^/]+)\/(.+?)(?:\.git)?\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/)
  if (url) return { project: url[1]!, iid: Number(url[2]) }
  const short = name.match(/^([\w.@-]+(?:\/[\w.@-]+)+)!(\d+)$/)
  return short ? { project: short[1]!, iid: Number(short[2]) } : undefined
}

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** Whether the deployment resolved a GitHub account; a report's `pr_number` is read only when it did. */
  readonly hasGithub: boolean
  /** Whether the deployment resolved a GitLab account; a report's `mr` is read only when it did. */
  readonly hasGitlab: boolean
  /** Commands used to read a merge request the report names, through the agent's `glab`. */
  readonly commands: Commands
  /** Source context that binds a followed merge request to the ticket, so its merge ends the ticket. */
  readonly gitlabContext: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket, agent: Pick<Agent, 'session'>): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, { ticketId }, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's GitHub pull request: its source PR, or one by the agent's GitHub account from a branch named after this ticket (DSH_SUPERAGENT_NAME). Only a deployment with a GitHub account reads it.`),
        mr: z.string().trim().min(1).nullish().describe(`The ticket's GitLab merge request, as its web URL or "<project path>!<iid>", such as https://git.example.com/group/project/-/merge_requests/7 or group/project!7. Only a deployment with a GitLab account reads it.`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        evidence: z.array(z.object({
          what: z.string().trim().min(1).max(300).describe('What was checked: the command, query or file read.'),
          result: z.string().trim().min(1).max(600).describe('What it actually showed.'),
        })).max(12).optional().describe('With ready: what you ran after your last change and what it showed; ready without it is refused.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // A ready result must show what ran after the last change: the host reads that from the Session's own log, not from the claim.
        if (args.state === 'ready') {
          const started = (runningAssignment(current) ?? latestAssignment(current))?.startedAt
          const refused = missingEvidence(toolCalls(agent, started ? Date.parse(started) : 0), args.evidence)
          if (refused) throw new Error(refused)
        }
        const proof = args.evidence?.length ? { evidence: args.evidence } : {}
        // A deployment runs one source control account or the other, so a report names its change on that one. Reading the PR
        // through a GitHub account the deployment does not have used to throw and lose the whole report, even on a ticket whose
        // work is a GitLab merge request, so the branch that does not apply is skipped rather than attempted.
        const pull = args.pr_number != null && host.hasGithub ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          if (args.pr_number != null && !host.hasGithub) {
            // Naming a PR with no GitHub account is a mistake the report survives: record it, and say what to send instead.
            const ignored = 'pr_number was ignored: this deployment has no GitHub account, so name the change with mr.'
            const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
              ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
              ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
            const updated = host.engine.report(ticketId, { ...report, ...proof })
            const relay = reportRelay(updated, report)
            if (relay) host.sessions.relay(relay.id, relay.text)
            return { reported: true, notification: relay ? 'orchestrator' : 'internal_only', note: ignored,
              ...(updated.attention ? { attention: updated.attention } : {}) }
          }
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          // A merge request names a change to follow, so the ticket ends with it; an unparseable name is reported, not thrown,
          // because the work reached ready either way and losing the report helps nobody.
          const merge = args.mr != null && host.hasGitlab ? bindMergeRequest(host, ticketId, args.mr) : undefined
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, { ...report, ...proof })
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(merge ? { merge_request: merge } : {}),
            ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
