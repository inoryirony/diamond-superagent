/** Follow-up routing: a human message on a subscribed thread reaches the ticket worker, and the main Session reads it as a candidate it usually ignores. */
import { afterEach, expect, it, vi } from 'vitest'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
import { repliedTo } from '../src/app/links.ts'
import { inputMessage } from '../src/executor/dsh.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const THREAD = `feishu:${CHAT}:om_1`
const followup = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text, { mentions: [], root_id: 'om_1',
  ...overrides })
const notices = (host: Host) => host.relays(host.runtime.masterId).filter(item => item.kind === 'follow_up')

it('delivers a follow-up to the worker, tells the main Session with a card, and leaves it a candidate to read', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  const message = followup('2', '顺便把标题也改了', { parent_id: 'om_1' })
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: message.id, text: '顺便把标题也改了' })])
  expect(notices(h)).toEqual([{ kind: 'follow_up', trigger_id: message.id, from: 'ou_alice', thread: THREAD, at: message.at,
    text: '顺便把标题也改了',
    replies_to: { trigger_id: ticket.origin.triggerId, preview: '@bot 修一下回归' },
    delivered_to: [{ ticket_id: ticket.id, title: ticket.title, state: 'working' }],
      note: expect.stringContaining('worker has it and decides') }])
  // The main Session reads the message too, as a candidate it may ignore; the worker still decides it.
  expect(h.candidates()).toEqual([message.id])
  expect(h.runtime.store.decisions.byThread(THREAD)).toHaveLength(1)
  expect(h.runtime.store.triggers.disposition(message.id)).toMatchObject({ fanout: [ticket.id] })
})

it('sends a person\'s message that reaches no ticket, such as only one a person stopped, to Eval as before', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.stopTicket(ticket.id)
  h.deliveries.mockClear()
  const message = followup('2', '@bot 换个方式修', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(notices(h)).toEqual([])
  expect(h.candidates()).toEqual([message.id])
})

it('leaves a delivered follow-up to its ticket\'s worker: the main Session may stop the ticket on it, and route it only once handed back',
  async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const other = await h.acceptedTicket(feishu('3', '@bot 另一件事'))
  const settle = async (id: string, text: string, sender?: string) => {
    const message = followup(id, text, sender ? { sender_id: sender } : {})
    h!.runtime.receive(message); await h!.runtime.idle()
    return message.id
  }
  const master = (name: string, args: Record<string, unknown>) => h!.runTool(h!.runtime.masterId, name, args)
  const decides = /its worker decides whether it belongs there/
  // A guest's follow-up stays inferred, so its stop does not stop the work; the main Session cannot route or requeue it.
  const guest = await settle('4', '别做了', 'ou_guest')
  expect(await h!.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: guest })).toMatchObject({ decision: 'ignore' })
  await expect(h!.route({ kind: 'accept', trigger_id: guest, title: 'More', worktree_name: 'more', acknowledgement: 'ok' }))
    .rejects.toThrow(decides)
  // The agent holds no requeue tool; a person sends it to Eval from the panel, which is the only writer of that decision.
  expect((await h.api('POST', `triggers/${encodeURIComponent(guest)}/requeue`)).status).toBe(200)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.candidates()).toContain(guest)
  // Alice's follow-ups carry her authority once the worker hands them back: one goes to the other ticket, one becomes new work.
  const attach = await settle('5', '这个其实是另一件事的')
  await expect(h!.route({ kind: 'attach', ticket_id: other.ticket.id, trigger_id: attach })).rejects.toThrow(decides)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ handback: attach, reason: 'It is about the other request.' }] })
  expect(await h!.route({ kind: 'attach', ticket_id: other.ticket.id, trigger_id: attach }))
    .toMatchObject({ ticket: expect.objectContaining({ ticket_id: other.ticket.id }) })
  const work = await settle('6', '另外把导出按钮也加上')
  const request = { trigger_id: work, title: '导出按钮', worktree_name: 'export', acknowledgement: '收到，加导出按钮。' }
  await expect(h!.route({ kind: 'accept', ...request })).rejects.toThrow(decides)
  // The attach subscribed the other ticket to this thread, so its worker decides the message too; it is new work once both
  // hand it back.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ handback: work, reason: 'It asks for an export button.' }] })
  await expect(h!.route({ kind: 'accept', ...request })).rejects.toThrow(decides)
  await h.runTool(other.sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ handback: work, reason: 'Not this ticket either.' }] })
  const accepted = await h!.route({ kind: 'accept', ...request })
  expect(h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!.mandate).toMatchObject({ strength: 'explicit' })
  // A stop on a person's request needs no hand-back.
  const stop = await settle('7', '先停一下')
  expect(await h!.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: stop })).toMatchObject({ decision: 'stop' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
})

/**
 * Count main-session model turns triggered by steers: each steer while idle starts a new turn,
 * whereas all steers arriving while running batch into the next step.
 */
function modelCalls(host: Host) {
  const master = host.agents.get(host.runtime.masterId)!
  const seen: string[] = []
  const steer = master.steer.getMockImplementation() as (message: unknown) => void
  master.steer.mockImplementation((message: unknown) => { seen.push(master.status); steer(message) })
  return () => seen.filter(status => status === 'idle').length + (seen.includes('running') ? 1 : 0)
}

it('costs the main Session one model call for a burst of follow-ups while it works, and two while it idles', async () => {
  for (const busy of [true, false]) {
    h = await startRuntime()
    await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const master = h.agents.get(h.runtime.masterId)!
    master.status = busy ? 'running' : 'idle'
    h.deliveries.mockClear()
    const calls = modelCalls(h)
    for (const id of ['2', '3', '4', '5', '6']) h.runtime.receive(followup(id, `第 ${id} 条补充`, { sender_id: 'ou_guest' }))
    await h.runtime.idle()
    // Five follow-ups reach the worker and the main Session alike. One Eval runs at a time on a Thread, so the first is its
    // candidate and the rest wait behind it; each of the five is accounted for, and the turn costs what it did before.
    const thread = h.runtime.store.threads.get(THREAD)!
    const judged = 1 + thread.pending.length
    expect([notices(h).length, judged, calls()]).toEqual([5, 5, busy ? 1 : 2])
    await h.stop(); h = undefined
  }
})

it('keeps a follow-up\'s notice in the effect queue until the main Session takes it, and sends it once', async () => {
  h = await startRuntime()
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  h.agents.get(h.runtime.masterId)!.steer.mockImplementationOnce(() => { throw new Error('session gone') })
  const message = followup('2', '补充一点')
  h.runtime.receive(message)
  await h.runtime.idle()
  // The notice is stored with the intake's transaction, keyed by its Trigger, and a duplicate message adds nothing.
  expect(h.runtime.store.db.prepare("SELECT key FROM effect WHERE kind = 'relay'").all()).toEqual([{ key: `followup:${message.id}` }])
  expect(h.runtime.receive(followup('2', '补充一点'))).toBe('duplicate')
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(notices(h).map(item => item.trigger_id)).toEqual([message.id])
  expect(h.runtime.effects.pending('relay')).toBe(false)
})

it('relays a message a worker handed back as a candidate with the worker\'s reason', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '另外把导出按钮也加上')
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ handback: message.id, reason: 'It asks for an export button.' }] }))
    .toMatchObject({ reported: true, threads: [{ trigger_id: message.id, queued: false }] })
  await h.runtime.pump(); await h.runtime.idle()
  // The message already waited for the main Session as a candidate; the hand-back adds its reason to what the Session reads,
  // and no requeue notice comes before it.
  const injected = h.agents.get(h.runtime.masterId)!.inject.mock.calls.map(([notice]) => JSON.stringify(notice))
  expect(injected.filter(notice => notice.includes('trigger_requeued'))).toEqual([])
  expect(h.runtime.store.triggers.disposition(message.id)!.handbacks)
    .toEqual([{ ticketId: ticket.id, reason: 'It asks for an export button.', at: expect.any(String) }])
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x',
    threads: [{ handback: message.id, reason: 'Again' }] })).rejects.toThrow(/handed that trigger back/)
  // Attaching it back to the ticket that returned it is refused.
  await expect(h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id }))
    .rejects.toThrow(/handed that trigger back as beyond it/)
})

it('lets a worker follow a related thread for context, which the main Session hears of without waking, and notes a ticket', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const master = h.agents.get(h.runtime.masterId)!
  master.inject.mockClear(); h.deliveries.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x',
    threads: [{ follow: 'github:7', reason: 'The issue it fixes.' }] }))
    .toMatchObject({ threads: [{ followed: true, thread: 'github:7' }] })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get('github:7')).toMatchObject({ subscriptions: [ticket.id], context: [ticket.id] })
  const text = (message: unknown) => (message as { content: { text: string }[] }).content[0]!.text
  const injected = master.inject.mock.calls.map(([message]) => JSON.parse(text(message)) as Record<string, unknown>)
  expect(injected).toEqual([expect.objectContaining({ thread_followed: { ticket_id: ticket.id, thread: 'github:7',
    reason: 'The issue it fixes.' } })])
  expect(h.relays(h.runtime.masterId)).toEqual([])
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ follow: 'github', reason: 'x' }] })).rejects.toThrow(/<source>:<id>/)
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_ticket', { action: 'note', ticket_id: ticket.id, text: 'Ticket B renamed the setting.' }))
    .toMatchObject({ reason: 'Noted for the worker' })
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => call.text))
    .toEqual([expect.stringContaining('Note from the orchestrator, for context only: Ticket B renamed the setting.')])
})

it('takes the message a follow-up answers from its Source kind, whichever kind it is', async () => {
  h = await startRuntime()
  const parent = feishu('1', 'the earlier message')
  h.runtime.store.triggers.save(parent)
  const reply = { ...feishu('2', 'a reply'), source: 'other' }
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: trigger => trigger.id === reply.id ? parent.id : undefined } },
    reply)).toEqual(parent)
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: () => undefined } }, reply)).toBeUndefined()
  expect(repliedTo(h.runtime, followup('3', 'yes', { parent_id: 'om_1' }))).toEqual(parent)
})

it('tells the main Session of a follow-up to an ended ticket once the ticket resumes, and not when it cannot', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  // The ready result waits in a review of its own, and passing it ends the ticket, which the message then resumes.
  await vi.waitFor(() => expect(h!.runtime.store.tickets.get(ticket.id)!.reviews).toHaveLength(1))
  await h.finishReview(ticket.id)
  expect(h.runtime.store.tickets.get(ticket.id)!.reviews![0]!.ended).toMatchObject({ outcome: 'passed' })
  // While processing is paused the message waits for the ticket, which has not resumed: the main Session hears nothing yet.
  await h.runtime.settings.pause(true, 'panel')
  h.deliveries.mockClear()
  const message = followup('2', '再改一下标题')
  h.runtime.receive(message); await h.runtime.idle()
  expect(notices(h)).toEqual([])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: message.id, delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] })])
})

it('tells the main Session nothing of a message it attached to an ended ticket, which resumes for it', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const request = feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  h.runtime.receive(request); await h.runtime.idle()
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: request.id })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(notices(h)).toEqual([])
})

it('assesses a follow-up an earlier version queued for Eval instead of dropping it, and tells the main Session with its notice', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '顺便看看日志')
  h.deliveries.mockClear()
  // An earlier version delivered a follow-up to the ticket and queued it for Eval; the queue no longer drops it, since the
  // main Session reads every person's message, so it becomes a candidate the worker still decides.
  h.runtime.store.atomic(() => {
    h!.runtime.store.triggers.save(message)
    h!.runtime.store.triggers.saveDisposition(message.id, { fanout: [ticket.id], at: message.at })
    h!.runtime.store.threads.save({ ...h!.runtime.store.threads.get(THREAD)!, pending: [message.id] })
  })
  await h.runtime.pump(); await h.runtime.idle()
  // The queued follow-up became an Eval the main Session reads, which its ticket's worker still decides.
  expect(h.candidates()).toEqual([message.id])
  // The notice of a follow-up a ticket reached comes with the receive; reading its message again now tells it.
  h.runtime.receive(followup('3', '顺便看看日志'))
  await h.runtime.idle()
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: followup('3', '顺便看看日志').id,
    delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] })])
})

it('sends a request on a thread a worker follows only for context to Eval, and marks the worker\'s copy as context', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ follow: `feishu:${CHAT}:om_9`, reason: 'The same page.' }] })
  h.deliveries.mockClear()
  const request = feishu('10', '@bot 把这里的按钮也改了', { root_id: 'om_9' })
  h.runtime.receive(request)
  await h.runtime.idle()
  // It is nobody's follow-up: the main Session assesses it, and the worker reads it as context.
  expect(h.candidates()).toEqual([request.id])
  expect(notices(h)).toEqual([])
  expect(h.runtime.store.triggers.disposition(request.id)).toMatchObject({ fanout: [ticket.id], context: [ticket.id] })
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: request.id, context: true })])
})

it('shows a candidate\'s message as its workers would read it, with the message it answers', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const long = `另外，${'导出按钮的文案也需要改。'.repeat(60)}`
  const reply = followup('2', long, { parent_id: 'om_1' })
  h.runtime.receive(reply); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', threads: [{ handback: reply.id, reason: 'Another change.' }] })
  await h.runtime.pump(); await h.runtime.idle()
  const card = h.cards().find(item => item.trigger_id === reply.id)!
  // The message arrives whole: a candidate card is what the worker would read, and a cut request sends every reader to a second
  // tool to learn what was already said.
  expect(card).toMatchObject({ from: 'ou_alice', text: long,
    replies_to: { trigger_id: ticket.origin.triggerId, preview: '@bot 修一下回归' } })
  expect(card).not.toHaveProperty('triggers')
  expect(card).not.toHaveProperty('chars')
})

it('keeps a listed member\'s request on a ticket\'s thread to that ticket, so it is not done twice', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下设置页保存按钮的文案'))
  h.deliveries.mockClear()
  // The benchmark's case: an addressed request from a listed member on the ticket's own thread.
  const request = followup('2', '@bot [W1-a] 概览页的保存按钮也按同样方式改一下', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(request); await h.runtime.idle()
  // The worker has it and decides; the main Session hears of it and cannot open a second ticket for it.
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: request.id })])
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: request.id,
    note: expect.stringContaining('orchestrator_route kind stop') })])
  await expect(h.route({ kind: 'accept', trigger_id: request.id, title: '概览页按钮',
    worktree_name: 'overview-button', acknowledgement: '收到。' })).rejects.toThrow(/its worker decides whether it belongs there/)
  // The worker takes it as within its ticket and says so.
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: request.id, text: '收到：概览页的保存按钮也一起改。' }))
    .toMatchObject({ trigger_id: request.id })
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual([ticket.id])
  // The main Session read it as a candidate and left it to the worker, which took it up: the candidate stays readable.
  expect(h.candidates()).toEqual([request.id])
})

it('leaves a follow-up to its ticket\'s worker after the main Session drops the subscriptions of its thread', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const request = followup('2', '@bot 另外把导出按钮也加上', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(request); await h.runtime.idle()
  // Dropping a thread's subscriptions is a person's action in the panel; the agent no longer holds that tool.
  expect((await h.api('POST', `threads/${encodeURIComponent(THREAD)}/unsubscribe`)).body).toMatchObject({ removed: true, thread: THREAD })
  // The worker has the message and still decides it, so the main Session cannot open a second ticket for it.
  await expect(h!.route({ kind: 'accept', trigger_id: request.id, title: '导出按钮', worktree_name: 'export',
    acknowledgement: '收到，加导出按钮。' })).rejects.toThrow(/its worker decides whether it belongs there/)
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual([ticket.id])
})

it('tells a worker it may hand back a message beyond its ticket or for another one, also when the message resumed it', async () => {
  expect(inputMessage({ id: 'r', kind: 'resumed', triggerId: 't', at: '' })).toContain('hand it back')
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  expect((h.tools.get(sessionId)!.get('orchestrator_report') as unknown as { parameters: unknown }).parameters)
    .toMatchObject({ properties: { threads: expect.anything() } })
})
