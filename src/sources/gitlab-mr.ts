/** GitLab merge request following: binds the agent's MR to the ticket whose branch it comes from, and reports its end. */
import { z } from 'zod'
import { key, type OutboundMessage, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'

export const SOURCE = 'gitlab'
/** A merge request as `glab api` returns it; `state` is opened, closed, locked or merged. */
export const MrSchema = z.looseObject({
  iid: z.number(), project_id: z.number(), state: z.string(), source_branch: z.string(), web_url: z.string().optional(), updated_at: z.string(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), author: z.looseObject({ username: z.string() }).nullish(),
})
export type Mr = z.infer<typeof MrSchema>
/** The thread id of an MR: `<project_id>!<iid>`, so the same iid in two projects never collides. */
export const mrId = (mr: Pick<Mr, 'iid' | 'project_id'>): string => `${mr.project_id}!${mr.iid}`
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, as in `agent/<name>`. */
const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const followsOpen = (ticket: Pick<Ticket, 'follows'>, id: string): boolean => (ticket.follows ?? []).some(item => item.thread === `${SOURCE}:${id}` && !item.closed)

/**
 * Reconciles one polled MR of the agent account with the open tickets: an opened MR on a ticket's branch binds to that ticket
 * when it is the only one on the branch and the ticket follows no other open MR; a merged or closed one is reported to the
 * tickets that follow it, whose end the core decides.
 */
export function observeMr(ctx: SourceContext, mr: Mr, me: string): void {
  if (!sameName(mr.author?.username ?? '', me)) return
  const id = mrId(mr)
  const open = ctx.tickets.open()
  const owners = open.filter(ticket => followsOpen(ticket, id))
  if (mr.state === 'merged' || mr.state === 'closed') {
    if (!owners.length) return
    ctx.tickets.threadClosed({ source: SOURCE, id }, mr.state, mr.merged_at ?? mr.closed_at ?? mr.updated_at)
    // The core ends a ticket that is done with the Threads it follows inside `threadClosed`, so the notices go out here.
    for (const owner of owners) {
      const ticket = ctx.tickets.get(owner.id)
      if (!ticket?.ended) continue
      const request = ctx.triggers.get(ticket.origin.triggerId)?.text ?? ''
      for (const message of mrEndNotices(ticket, request)) ctx.notify(message)
    }
    return
  }
  if (mr.state !== 'opened' || owners.length) return
  const candidates = open.filter(ticket => ticketBranch(ticket, mr.source_branch))
  if (candidates.length !== 1) return
  const ticket = candidates[0]!
  // A ticket follows one open MR at a time; the Executor's report is what changes that.
  if ((ticket.follows ?? []).some(item => item.thread.startsWith(`${SOURCE}:`) && !item.closed)) return
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticket.id, { source: SOURCE, id }, true)
    ctx.threads.patch(`${SOURCE}:${id}`, { iid: mr.iid, projectId: mr.project_id, ...mr.web_url ? { url: mr.web_url } : {} })
  })
}

/**
 * Builds idempotent notices for the ticket's conversations when it ends with its MR (the last one it opened, else the last it
 * followed). The language follows the ticket's request: Chinese when it contains Han characters and no kana, otherwise English.
 */
export function mrEndNotices(ticket: Ticket, request: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && item.thread.startsWith(`${SOURCE}:`))
  const latest = (items: typeof follows) => [...items].sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = follow.thread.slice(follow.thread.indexOf('!') + 1)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `MR !${iid} 已合并。` : `MR !${iid} 已关闭，未合并。`
    : outcome === 'merged' ? `MR !${iid} has merged.` : `MR !${iid} was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', follow.thread, channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
