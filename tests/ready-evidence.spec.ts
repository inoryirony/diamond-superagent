/** A ready report must show what ran: after a change to files it needs evidence and a run after that change, read from the worker's own log. */
import { afterEach, expect, it } from 'vitest'
import { latestAssignment, reportHistory } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const evidence = [{ what: 'pnpm test', result: '12 passed, 0 failed' }]

/** A worker whose fake model has called nothing yet: the fixture's automatic check before ready is off. */
async function worker() {
  h = await startRuntime()
  const host = h
  host.checks.before = false
  return { host, ...await host.acceptedTicket(feishu('1', '@bot 修一下回归')) }
}
const ready = (host: Host, sessionId: string, extra: Record<string, unknown> = {}) =>
  host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', ...extra })

it('refuses ready after a change to files that brings no evidence', async () => {
  const { host, sessionId } = await worker()
  host.ran(sessionId, 'edit'); host.ran(sessionId, 'bash')
  await expect(ready(host, sessionId)).rejects.toThrow(/changed files/)
})

it('refuses ready with no run in the assignment and no evidence', async () => {
  const { host, sessionId } = await worker()
  await expect(ready(host, sessionId)).rejects.toThrow(/nothing has run/)
})

it('refuses ready whose evidence has no run after the last change to files', async () => {
  const { host, sessionId } = await worker()
  host.ran(sessionId, 'bash'); host.ran(sessionId, 'edit')
  await expect(ready(host, sessionId, { evidence })).rejects.toThrow(/Nothing ran after/)
})

it('lets ready stand with evidence and a run after the last change, and keeps the evidence on the report in the ledger', async () => {
  const { host, ticket, sessionId } = await worker()
  host.ran(sessionId, 'edit'); host.ran(sessionId, 'bash')
  await ready(host, sessionId, { evidence })
  const stored = host.runtime.store.tickets.get(ticket.id)!
  expect(reportHistory(latestAssignment(stored)!).at(-1)).toMatchObject({ state: 'ready', evidence })
})

it('shows the evidence of a report when a model reads it through orchestrator_read', async () => {
  const { host, ticket, sessionId } = await worker()
  host.ran(sessionId, 'edit'); host.ran(sessionId, 'bash')
  await ready(host, sessionId, { evidence })
  const assignment = latestAssignment(host.runtime.store.tickets.get(ticket.id)!)!
  const page = await host.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/report/${assignment.id}` })
  expect(JSON.stringify(page)).toContain('pnpm test: 12 passed, 0 failed')
})

it('lets a ready result that changed no file stand on a run alone', async () => {
  const { host, sessionId } = await worker()
  host.ran(sessionId, 'bash')
  await expect(ready(host, sessionId)).resolves.toMatchObject({ reported: true })
})
