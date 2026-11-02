/** Reporting a merge request, and what the orchestrator may do once a review's rounds are spent. */
import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { parseMergeRequest } from '../src/app/tools/executor.ts'

let h: Host | undefined
const ticketOf = (host: Host, id: string) => host.runtime.store.tickets.get(id)!
afterEach(async () => { await h?.stop(); h = undefined })

it('reads a merge request from its web URL or its short form, and refuses anything else', () => {
  expect(parseMergeRequest('https://git.youshu.com.cn/xk/product/zk-ai/zkai-opportunity-engine/-/merge_requests/4'))
    .toEqual({ project: 'xk/product/zk-ai/zkai-opportunity-engine', iid: 4 })
  expect(parseMergeRequest('https://git.example.com/group/project/-/merge_requests/7#note_1'))
    .toEqual({ project: 'group/project', iid: 7 })
  expect(parseMergeRequest('xk/product/zk-ai/zkai-opportunity-engine!4'))
    .toEqual({ project: 'xk/product/zk-ai/zkai-opportunity-engine', iid: 4 })
  // A bare number is what the GitHub parameter takes; it cannot identify a GitLab project, so it is refused rather than guessed.
  expect(parseMergeRequest('4')).toBeUndefined()
  expect(parseMergeRequest('project')).toBeUndefined()
})

it('tells the main Session that a review\'s rounds are spent, and lets it restart the worker with an instruction', async () => {
  h = await startRuntime()
  const host = h
  // Notices go to the main Session through `notify`; recording them here pins what the orchestrator is told.
  const notices: { name: string; value: Record<string, unknown> }[] = []
  const real = host.runtime.sessions.notify.bind(host.runtime.sessions)
  vi.spyOn(host.runtime.sessions, 'notify').mockImplementation((name, value, summary) => {
    notices.push({ name, value }); return real(name, value, summary)
  })
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  host.review({ outcome: 'returned', summary: 'Still cut off at 320px.', findings: ['src/app.css: the header still does not wrap.'] })
  for (const round of [1, 2, 3]) {
    await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: `Round ${round}.` })
    await vi.waitFor(() => expect(host.runtime.reviewers.agent(ticket.id, round)).toBeDefined(), { timeout: 5000 })
    await host.finishReview(ticket.id)
    await host.runtime.idle()
    if (round < 3) { host.step(sessionId); await host.runtime.idle() }
  }
  // The last round leaves the result returned, so nothing runs on its own; the orchestrator is told, with the findings.
  expect(ticketOf(host, ticket.id).reviews!.map(review => [review.round, review.ended?.outcome])).toEqual([[1, 'returned'], [2, 'returned'], [3, 'returned']])
  const notice = notices.find(item => 'ticket_review_rounds_spent' in item.value)
  expect(notice?.value.ticket_review_rounds_spent).toMatchObject({ ticket_id: ticket.id, round: 3,
    findings: ['src/app.css: the header still does not wrap.'] })
  // Acting on it starts a fresh assignment whose first input is the instruction, so the next worker starts from that decision.
  const before = ticketOf(host, ticket.id).assignments.length
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_restart',
    { ticket_id: ticket.id, instruction: 'Only change src/app.css; do not touch the layout module.' })
  await host.runtime.idle()
  const after = ticketOf(host, ticket.id)
  expect(after.assignments.length).toBe(before + 1)
  expect(after.inputs.some(input => 'text' in input && input.text.includes('Only change src/app.css'))).toBe(true)
})
