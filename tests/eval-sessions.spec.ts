/** Eval Sessions: each Eval is assessed in its own orchestrator Session, with every open ticket in view, and takes messages that arrive while it runs. */
import { afterEach, expect, it } from 'vitest'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { evalOfSession, evalSessionId, isOrchestratorSession } from '../src/app/sessions.ts'
import { ENDED_TICKET_CARD_DAYS, ENDED_TICKET_CARDS, OPEN_TICKET_CARDS, relatedTickets } from '../src/app/cards.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const THREAD = `feishu:${CHAT}:om_1`
const evaluating = (host: Host, thread = THREAD) => host.runtime.store.threads.get(thread)?.evaluating

it('delivers each candidate to a Session of its own, named after the Eval and titled by its first message, with the routing tools', async () => {
  h = await startRuntime()
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger); await h.runtime.idle()
  const evalId = evaluating(h)!.id
  const sessionId = evalSessionId(evalId)
  expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)).toEqual([
    { sessionId, mode: 'steer', id: expect.any(String), text: expect.stringContaining('"kind":"candidate"') }])
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'candidate')).toEqual([])
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId, agentPreset: 'dsh-superagent-router' }))
  expect(h.controller.rename).toHaveBeenCalledWith({ sessionId, title: 'eval @bot 修一下回归' })
  // The Eval Session carries the orchestrator's tools and role, and routes its own candidate.
  for (const name of ['orchestrator_route', 'orchestrator_eval', 'orchestrator_reply', 'orchestrator_read']) expect(h.tools.get(sessionId)!.has(name)).toBe(true)
  expect(isOrchestratorSession(sessionId, h.runtime.masterId)).toBe(true)
  expect(evalOfSession(sessionId)).toBe(evalId)
  expect(evalOfSession(h.runtime.masterId)).toBeUndefined()
  const result = await h.runTool(sessionId, 'orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: trigger.id, reason: 'chatter' }] })
  expect(result).toMatchObject({ results: [{ trigger_id: trigger.id, decision: 'ignore' }] })
})

it('uses a new Session for each Eval, so a thread\'s second request is assessed without the first\'s context', async () => {
  h = await startRuntime()
  const first = feishu('1', '@bot 修一下回归')
  h.runtime.receive(first); await h.runtime.idle()
  const one = evalSessionId(evaluating(h)!.id)
  await h.route({ kind: 'ignore', trigger_id: first.id, reason: 'not now' })
  const second = feishu('2', '@bot 再看一次', { root_id: 'om_1' })
  h.runtime.receive(second); await h.runtime.idle()
  const two = evalSessionId(evaluating(h)!.id)
  expect(two).not.toBe(one)
  expect(h.evalSession(first.id)).toBe(one)
  expect(h.evalSession(second.id)).toBe(two)
  expect(h.controller.create.mock.calls.filter(([request]) => String(request.sessionId).startsWith('eval-'))).toHaveLength(2)
})

it('shows a candidate every open ticket, newest first, and only its own thread\'s ended ones', async () => {
  h = await startRuntime()
  const a = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const b = await h.acceptedTicket(feishu('2', '@bot 另一处'))
  const c = await h.acceptedTicket(feishu('3', '@bot 第三处'))
  h.runtime.engine.stopTicket(c.ticket.id)
  // A message on a fresh thread sees the open tickets of other threads but not their ended ones.
  const elsewhere = feishu('4', '@bot 看看这个')
  h.runtime.receive(elsewhere); await h.runtime.idle()
  const card = h.cards().find(item => item.trigger_id === elsewhere.id)!
  expect((card.related_tickets as { ticket_id: string; state: string }[]).map(({ ticket_id, state }) => [ticket_id, state])).toEqual([
    [b.ticket.id, 'working'], [a.ticket.id, 'working']])
  expect(card.tickets_total).toBe(2)
  // A message on the ended ticket's thread sees it too, after the open ones.
  const back = feishu('5', '@bot 还是那个', { root_id: 'om_3' })
  h.runtime.receive(back); await h.runtime.idle()
  const own = h.cards().find(item => item.trigger_id === back.id)!
  expect((own.related_tickets as { ticket_id: string }[]).map(item => item.ticket_id)).toEqual([b.ticket.id, a.ticket.id, c.ticket.id])
  expect(own.tickets_total).toBe(3)
  expect(OPEN_TICKET_CARDS).toBeGreaterThan(ENDED_TICKET_CARDS)
  // An ended ticket leaves the card after ENDED_TICKET_CARD_DAYS; the ticket list still has it.
  const tickets = [a, b, c].map(item => h!.runtime.store.tickets.get(item.ticket.id)!)
  const later = new Date(Date.parse(c.ticket.createdAt) + (ENDED_TICKET_CARD_DAYS + 1) * 86_400_000)
  expect(relatedTickets(tickets, later).related_tickets.map(item => item.ticket_id)).toEqual([b.ticket.id, a.ticket.id])
  expect(relatedTickets(tickets, later).tickets_total).toBe(3)
})

it('steers a message that arrives on a thread under assessment into that Eval\'s Session, where it may be routed at once', async () => {
  h = await startRuntime()
  const first = feishu('1', '@bot 修一下回归')
  h.runtime.receive(first); await h.runtime.idle()
  const sessionId = evalSessionId(evaluating(h)!.id)
  const more = feishu('2', '@bot 顺便改下标题', { root_id: 'om_1' })
  h.runtime.receive(more); await h.runtime.idle()
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [more.id] })
  const steered = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId && call.text.includes('"followup_while_assessing"'))
  expect(steered).toEqual([{ sessionId, mode: 'steer', id: expect.any(String), text: expect.stringContaining('"kind":"followup_while_assessing"') }])
  expect(JSON.parse(steered[0]!.text)).toMatchObject({ trigger: { trigger_id: more.id, preview: '@bot 顺便改下标题', thread: THREAD }, note: expect.stringContaining('orchestrator_route') })
  // Routed from the Eval Session, the queued message leaves the thread's queue without a second Eval.
  const result = await h.runTool(sessionId, 'orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: more.id, reason: 'chatter' }] })
  expect(result).toMatchObject({ results: [{ trigger_id: more.id, decision: 'ignore' }] })
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(h.cards().filter(item => item.trigger_id === more.id)).toEqual([])
})

it('leaves a steered message to the next Eval when the Session does not route it, and tolerates a Session that cannot take it', async () => {
  h = await startRuntime()
  const first = feishu('1', '@bot 修一下回归')
  h.runtime.receive(first); await h.runtime.idle()
  const sessionId = evalSessionId(evaluating(h)!.id)
  h.agents.get(sessionId)!.steer.mockImplementationOnce(() => { throw new Error('session gone') })
  const more = feishu('2', '@bot 顺便改下标题', { root_id: 'om_1' })
  h.runtime.receive(more); await h.runtime.idle()
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [more.id] })
  await h.route({ kind: 'ignore', trigger_id: first.id, reason: 'not now' })
  await h.runtime.idle()
  expect(h.cards().map(item => item.trigger_id)).toEqual([first.id, more.id])
  expect(h.evalSession(more.id)).not.toBe(sessionId)
})

it('keeps worker reports and follow-up notices on the main Session, which still routes explicit requests', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'The build needs a secret.' })
  const followup = feishu('2', '顺便把标题也改了', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(followup); await h.runtime.idle()
  const kinds = h.relays(h.runtime.masterId).map(item => item.kind)
  expect(kinds).toContain('worker_report')
  expect(kinds).toContain('follow_up')
  expect(kinds).not.toContain('candidate')
  expect(h.relays(sessionId).map(item => item.trigger_id)).toContain(followup.id)
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_ticket_request_status', { ticket_id: ticket.id })).toMatchObject({ ticket: { ticket_id: ticket.id } })
})
