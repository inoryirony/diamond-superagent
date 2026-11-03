/** The conversation guard: a message of a chat is attached or answered only after its conversation was read, and its trigger resource carries that conversation live. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { readConversation } from '../src/app/session-actions.ts'
import type { TriggerContext } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** A call as DSH logs it: the tool's name and the raw JSON the model produced. */
const call = (name: string, args: unknown) => ({ name, arguments: JSON.stringify(args) })
const GUARD = /^Read the conversation first: orchestrator_read trigger\//
const route = async (...decisions: Record<string, unknown>[]) =>
  ((await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions })) as { results: Record<string, unknown>[] }).results

it('counts a read of the trigger\'s own resource, an Eval read of it, or a dws listing of its conversation, and nothing else', () => {
  const trigger = { id: 't1', conversationId: 'cid-1', peerOpenId: 'ou_peer' }
  expect(readConversation([call('orchestrator_read', { resource: 'trigger/t1' })], trigger)).toBe(true)
  expect(readConversation([call('orchestrator_eval_read', { trigger_id: 't1', resource: 'thread' })], trigger)).toBe(true)
  expect(readConversation([call('bash', { command: 'dws chat message list --conversation-id cid-1 --limit 20' })], trigger)).toBe(true)
  expect(readConversation([call('bash', { command: 'dws chat message list --open-dingtalk-id ou_peer --limit 20' })], trigger)).toBe(true)
  // Another trigger, another conversation, or a command that lists nothing is no read of this one.
  expect(readConversation([call('orchestrator_read', { resource: 'trigger/t2' }), call('orchestrator_eval_read', { trigger_id: 't2', resource: 'thread' })], trigger)).toBe(false)
  expect(readConversation([call('bash', { command: 'dws chat message list --conversation-id cid-2' })], trigger)).toBe(false)
  expect(readConversation([call('bash', { command: 'echo cid-1' })], trigger)).toBe(false)
  expect(readConversation([], trigger)).toBe(false)
})

it('refuses an attach whose conversation was not read, alone, and lets it through once its trigger was read', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const other = feishu('3', '@bot 为什么'), chatter = feishu('4', '@bot 谢谢'), elsewhere = feishu('5', '@bot 另一句')
  for (const trigger of [other, chatter, elsewhere]) h.runtime.receive(trigger)
  await h.runtime.idle()
  // Reading another trigger is no read of this one.
  await h.readTrigger(h.runtime.masterId, elsewhere.id)
  const first = await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id }, { kind: 'ignore', trigger_id: chatter.id, reason: 'thanks' })
  expect(first[0]).toEqual({ trigger_id: other.id, kind: 'attach', refused: expect.stringMatching(GUARD) })
  // An ignore holds no gate, and the refused item left it alone.
  expect(first[1]).toMatchObject({ kind: 'ignore', decision: 'ignore' })
  await h.readTrigger(h.runtime.masterId, other.id)
  const second = await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })
  expect(second[0]).not.toHaveProperty('refused')
  expect(second[0]).toMatchObject({ kind: 'attach', ticket: { ticket_id: ticket.id } })
})

it('holds an answer to the same read', async () => {
  const question = feishu('1', '@bot 晨报的窗口是按什么日期算的？')
  h.runtime.receive(question); await h.runtime.idle()
  expect((await route({ kind: 'answer', trigger_id: question.id, text: '是配置。' }))[0]).toEqual({ trigger_id: question.id, kind: 'answer', refused: expect.stringMatching(GUARD) })
  expect(h.runtime.store.triggers.disposition(question.id)?.decisionId).toBeUndefined()
  await h.readTrigger(h.runtime.masterId, question.id)
  expect((await route({ kind: 'answer', trigger_id: question.id, text: '是配置。' }))[0]).toMatchObject({ kind: 'answer', decision: 'ignore' })
})

it('does not hold a trigger of a Source that is no chat', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const issue: Trigger = { id: 'issue-7', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'bob' }, human: true,
    at: '2026-09-09T00:00:07.000Z', text: 'issue 7', url: 'https://github.com/acme/widgets/issues/7', meta: { number: 7 } }
  h.runtime.receive(issue); await h.runtime.idle()
  // Without the trigger stored the check below would pass for the wrong reason.
  expect(h.runtime.store.triggers.get(issue.id)).toBeDefined()
  const [result] = await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: issue.id })
  expect(JSON.stringify(result)).not.toMatch(/Read the conversation first/)
})

/** A reader that serves `read` for every trigger, as a chat Source's does. */
const reading = (read: TriggerContext['read']) => vi.spyOn(h.runtime.sources, 'threadContext').mockImplementation((): TriggerContext =>
  ({ chat: true, messageId: 'om_9', read, images: () => [], image: async () => { throw new Error('no images') } }))
const message = (id: string, second: number, text: string) => ({ id, from: `from-${id}`, at: `2026-09-09T00:00:${String(second).padStart(2, '0')}.000Z`, text })

it('carries the latest messages before the trigger, read live, with each text cut and the reader cached', async () => {
  const trigger = feishu('9', '@bot 为什么')
  h.runtime.receive(trigger); await h.runtime.idle()
  const earlier = [message('om_a', 1, '工单进展如何'), message('om_b', 2, '还在跑'), message('om_c', 3, 'x'.repeat(500))]
  // The reader's page also holds the trigger itself and a later message, which are no history.
  const read = vi.fn(async () => ({ messages: [...earlier, message('om_9', 9, '为什么'), message('om_z', 10, '之后的话')], body: {} }))
  reading(read)
  const page = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${trigger.id}` })
  expect(page.history).toEqual([earlier[0], earlier[1], { ...earlier[2], text: 'x'.repeat(400) }])
  expect(page).toHaveProperty('around')
  await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${trigger.id}` })
  expect(read).toHaveBeenCalledTimes(1)
})

it('reports a failed read of the conversation in place of the history and keeps the rest of the resource', async () => {
  const trigger = feishu('9', '@bot 为什么')
  h.runtime.receive(trigger); await h.runtime.idle()
  reading(vi.fn(async () => { throw new Error('dws exited 1\nstderr: token expired') }))
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${trigger.id}` }))
    .toMatchObject({ history: { status: 'unavailable', error: 'dws exited 1' }, acknowledgement: 'not_requested', text: expect.stringContaining('为什么') })
})

it('refuses an attach that would subscribe the ticket to a conversation it does not follow and the message does not name it', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  // A message in another chat, on a similar subject: attaching it would subscribe the ticket to that whole conversation.
  const elsewhere = feishu('2', '@bot 同样的功能也有问题', { chat_id: 'oc_other' })
  h.runtime.receive(elsewhere); await h.runtime.idle()
  await h.readTrigger(h.runtime.masterId, elsewhere.id)
  const [refused] = await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: elsewhere.id })
  expect(refused).toEqual({ trigger_id: elsewhere.id, kind: 'attach', refused: expect.stringMatching(/would subscribe .* to a conversation it does not follow/) })
  // Naming the ticket, or a message the ticket already received, is the pointer dispatch asks for.
  const naming = feishu('3', `@bot 接着 ${ticket.id} 修`, { chat_id: 'oc_third' })
  h.runtime.receive(naming); await h.runtime.idle()
  await h.readTrigger(h.runtime.masterId, naming.id)
  const [attached] = await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: naming.id })
  expect(attached).toMatchObject({ kind: 'attach', ticket: { ticket_id: ticket.id } })
  // A message in the ticket's own chat adds no subscription, so subject similarity there is not held.
  const same = feishu('4', `@bot 为什么`, { chat_id: (trigger.meta as { chatId: string }).chatId })
  h.runtime.receive(same); await h.runtime.idle()
  await h.readTrigger(h.runtime.masterId, same.id)
  const [own] = await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: same.id })
  expect(own).toMatchObject({ kind: 'attach', ticket: { ticket_id: ticket.id } })
})
