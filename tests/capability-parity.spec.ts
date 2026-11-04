/** One tool surface for every role: the main Session, a worker and a reviewer get the same allow list, and a reviewer that changes code voids its verdict. */
import { afterEach, expect, it, vi } from 'vitest'
import { SESSION_TOOLS } from '../src/app/sessions.ts'
import { reviewerSessionId } from '../src/executor/dsh.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

/** A ticket whose ready result waits in review, with the Reviewer Session up. */
async function reviewing() {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', evidence: [{ what: 'pnpm test', result: '12 passed' }] })
  const reviewer = reviewerSessionId(ticket.id, 1)
  // The Session exists before it is decorated, so wait for the tools its review is judged through rather than for the agent.
  await vi.waitFor(() => expect(host.tools.get(reviewer)?.has('orchestrator_review')).toBe(true), { timeout: 5000 })
  return { host, ticket, sessionId, reviewer }
}
const endedReview = (host: Host, ticketId: string) => host.runtime.store.tickets.get(ticketId)!.reviews![0]!.ended

it('gives the main Session, a worker and a reviewer the same allow list, filtered by what the profile registered', async () => {
  const { host, sessionId, reviewer } = await reviewing()
  // The fake profile registers every tool but pwsh, so the list is SESSION_TOOLS without it, and the same for every role.
  const allowed = SESSION_TOOLS.filter(name => name !== 'pwsh')
  for (const id of [host.runtime.masterId, sessionId, reviewer]) expect(host.restricts.get(id), id).toEqual([{ allow: allowed }])
  // A reviewer is no longer the narrower role: it can write and edit, which the audit of its verdict answers instead.
  expect(host.restricts.get(reviewer)).toEqual([{ allow: expect.arrayContaining(['write', 'edit']) }])
})

it('voids a verdict whose Reviewer Session changed a file, leaving the result to a person', async () => {
  const { host, ticket, reviewer } = await reviewing()
  host.ran(reviewer, 'edit')
  await host.finishReview(ticket.id, { outcome: 'passed', summary: 'Looks fine.' })
  expect(endedReview(host, ticket.id)).toMatchObject({ outcome: 'passed', unfinished: true, summary: expect.stringContaining('changed the code it judged') })
  expect(host.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
})

it('keeps the verdict of a Reviewer Session that only ran checks', async () => {
  const { host, ticket, reviewer } = await reviewing()
  host.ran(reviewer, 'bash')
  await host.finishReview(ticket.id, { outcome: 'passed', summary: 'Ran the tests: green.' })
  await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'completed' }))
  expect(endedReview(host, ticket.id)?.unfinished).toBeUndefined()
})

it('voids the verdict a Reviewer Session gives through orchestrator_review after it changed a file', async () => {
  const { host, ticket, reviewer } = await reviewing()
  host.ran(reviewer, 'write')
  const result = await host.runTool(reviewer, 'orchestrator_review', { outcome: 'passed', summary: 'Looks fine.' })
  expect(result).toMatchObject({ reviewed: true, void: expect.stringContaining('void') })
  expect(endedReview(host, ticket.id)).toMatchObject({ outcome: 'passed', unfinished: true })
  expect(host.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
})
