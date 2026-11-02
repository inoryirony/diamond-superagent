/** Reviews: a result is judged in a Session of its own before the ticket delivers it, returned with findings, or left to a person. */
import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { reviewerSessionId } from '../src/executor/dsh.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const ticketOf = (host: Host, id: string) => host.runtime.store.tickets.get(id)!
const latest = (host: Host, id: string) => ticketOf(host, id).assignments.at(-1)!
/** Waits until the review of the ticket's latest result runs in its Session, which the effect queue starts. */
const settle = async (host: Host, ticketId: string) => {
  await vi.waitFor(() => {
    const round = host.runtime.store.tickets.get(ticketId)?.reviews?.at(-1)?.round ?? 0
    expect(host.runtime.reviewers.agent(ticketId, round)).toBeDefined()
  }, { timeout: 5000 })
}
/** Whether the Reviewer Session of `round` was told what to review. */
const reviewedRound = (host: Host, ticketId: string, round: number) => host.deliveries.mock.calls.map(([call]) => call)
  .some(call => call.sessionId === reviewerSessionId(ticketId, round))

it('sends a ready result to a review of its own, and delivers it once the review passes it', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done: the header wraps.' })
  // The result waits in review, in a Session of its own, and the ticket is open until the verdict arrives.
  await settle(host, ticket.id)
  expect(ticketOf(host, ticket.id).ended).toBeUndefined()
  expect(ticketOf(host, ticket.id).reviews).toEqual([expect.objectContaining({ round: 1 })])
  expect(ticketOf(host, ticket.id).reviews![0]!.ended).toBeUndefined()
  expect(host.agents.get(reviewerSessionId(ticket.id, 1))).toBeDefined()
  await host.finishReview(ticket.id)
  await vi.waitFor(() => expect(ticketOf(host, ticket.id).ended).toMatchObject({ outcome: 'completed', by: 'executor' }))
  expect(ticketOf(host, ticket.id).reviews![0]!.ended).toMatchObject({ outcome: 'passed' })
})

it('returns a result to the worker with the findings, which revises the same work, and passes it in the next round', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  host.review({ outcome: 'returned', summary: 'The header is still cut off at 320px.', findings: ['src/app.css: make the header wrap below 320px.'] })
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  await settle(host, ticket.id)
  await host.finishReview(ticket.id)
  // The worker gets the findings as the first input of a new Assignment, on the same ticket and in the same directory.
  await vi.waitFor(() => expect(ticketOf(host, ticket.id).assignments).toHaveLength(2))
  expect(latest(host, ticket.id).state).not.toBe('ended')
  await vi.waitFor(() => expect(host.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .some(call => call.text.includes('make the header wrap below 320px'))).toBe(true))
  expect(ticketOf(host, ticket.id).reviews![0]!.ended).toMatchObject({ outcome: 'returned', findings: ['src/app.css: make the header wrap below 320px.'] })
  // The worker's new turn takes the findings and reports the result again, which goes to the second review, and that one passes.
  host.step(sessionId); await host.runtime.idle()
  host.review({ outcome: 'passed', summary: 'Checked at 320px: wraps.' })
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Fixed.' })
  await vi.waitFor(() => expect(reviewedRound(host, ticket.id, 2)).toBe(true), { timeout: 5000 })
  await host.finishReview(ticket.id)
  await vi.waitFor(() => expect(ticketOf(host, ticket.id).ended).toMatchObject({ outcome: 'completed' }))
  expect(ticketOf(host, ticket.id).reviews!.map(review => [review.round, review.ended?.outcome])).toEqual([[1, 'returned'], [2, 'passed']])
})

it('leaves a result to a person after three returned rounds instead of running the worker in circles', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  host.review({ outcome: 'returned', summary: 'Not yet.', findings: ['Do the thing again.'] })
  for (const round of [1, 2, 3]) {
    await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: `Round ${round}.` })
    await settle(host, ticket.id)
    await host.finishReview(ticket.id)
    await host.runtime.idle()
    host.step(sessionId); await host.runtime.idle()
  }
  // The fourth result asks for no review: it is the ticket's, as a ready result was before reviews, and the ticket ends.
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Round 4.' })
  await host.runtime.idle()
  expect(ticketOf(host, ticket.id).ended).toMatchObject({ outcome: 'completed' })
  expect(ticketOf(host, ticket.id).reviews).toHaveLength(3)
  expect(ticketOf(host, ticket.id).reviews!.every(review => !!review.ended)).toBe(true)
  expect(ticketOf(host, ticket.id).reviews!.at(-1)!.ended).toMatchObject({ outcome: 'returned' })
})

it('leaves the result to a person when the review ends without a verdict', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  await settle(host, ticket.id)
  // The Reviewer's Session ends its turn without calling orchestrator_review.
  host.agents.get(reviewerSessionId(ticket.id, 1))!.status = 'idle'
  await vi.waitFor(() => expect(ticketOf(host, ticket.id).reviews![0]!.ended).toMatchObject({ outcome: 'passed', unfinished: true }))
  expect(ticketOf(host, ticket.id).ended).toBeUndefined()
  expect(ticketOf(host, ticket.id).reviews![0]!.ended!.summary).toContain('did not finish')
})
