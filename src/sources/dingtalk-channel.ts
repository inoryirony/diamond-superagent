/** The DingTalk Channel: sends a message to a direct chat or a group, addressing the person in a group, and streams a card while working. */
import type { OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, ChannelState } from './kind.ts'
import { dingtalkTriggerId } from './dingtalk-trigger.ts'

/** The longest body `dws chat message send` takes without splitting a message in two. */
export const DINGTALK_TEXT_LIMIT = 4000
/** Cuts a body to `DINGTALK_TEXT_LIMIT`; the Executor's own limit is shorter, so this only bounds a retry or a notice. */
export const clip = (text: string): string => text.length <= DINGTALK_TEXT_LIMIT ? text : `${text.slice(0, DINGTALK_TEXT_LIMIT - 1)}…`
/** `bizId` of a card `dws chat message send-card` created; the CLI names it under `data` (older) or `result` (v1.0.64). */
export function cardId(value: unknown): string | undefined {
  const found = (item: unknown, depth = 0): string | undefined => {
    if (depth > 4 || typeof item !== 'object' || item === null) return undefined
    const record = item as Record<string, unknown>
    for (const name of ['bizId', 'biz_id']) if (typeof record[name] === 'string' && record[name]) return record[name] as string
    for (const child of [record.data, record.result]) { const hit = found(child, depth + 1); if (hit) return hit }
    return undefined
  }
  return found(value)
}
/** The card a reply finishes: the open card of the message's own thread, if an acknowledgement opened one. */
const openCard = (state: ChannelState, thread: string) => state.get(KV.dingtalk.cards)?.[thread]
/** One message this account sent as the agent: DingTalk's `openMessageId` when the CLI reported one, and a digest of its words. */
export interface SentMessage { id?: string; digest: string; at: number }
/** How long a send record keeps a message out of intake: long enough for any backfill round to have listed it. */
export const SENT_WINDOW_MS = 24 * 60 * 60_000
/** A stable digest of a message body, so the same words match however the CLI names them. */
export function textDigest(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index++) hash = Math.imul(31, hash) + text.charCodeAt(index) | 0
  return `${hash}:${text.length}`
}
/** Records that this account sent `text` into `conversationId`, under `id` when the CLI reported the message's own ID. */
export function recordSent(state: ChannelState, conversationId: string, text: string, id?: string, now = Date.now()): void {
  const key = KV.dingtalk.sent(conversationId)
  const kept = (state.get(key) ?? []).filter(entry => now - entry.at < SENT_WINDOW_MS)
  state.set(key, [...kept, { digest: textDigest(text), ...id ? { id } : {}, at: now }])
}
/**
 * Whether `messageId`, or failing that the text, is a message this account sent as the agent. Matching the text as well as the ID
 * covers a reply the CLI reported no ID for, and a card update, which carries the words but no message of its own.
 */
export function isOwnSend(sent: readonly SentMessage[] | undefined, messageId: string, text: string, now = Date.now()): boolean {
  if (!sent?.length) return false
  const recent = sent.filter(entry => now - entry.at < SENT_WINDOW_MS)
  if (recent.some(entry => entry.id !== undefined && entry.id === messageId)) return true
  const digest = textDigest(text)
  return recent.some(entry => entry.digest === digest)
}
/**
 * Sends a message as the operator's own account, idempotently by the queued message's ID. A group message must name the person it
 * answers, since the agent speaks there without a bot identity: the `<@openDingTalkId>` placeholder and the ID list go together.
 * An acknowledgement opens a streaming card that the reply of the same thread finishes, so a person sees one card turn from
 * "working on it" into the answer (the shape `dws-chat-agent` uses); a reply with no open card is sent as a plain message.
 * A missing conversation or an unknown target is retried rather than reported gone, because the CLI names no such code.
 */
export async function sendDingtalk(host: Pick<SourceContext, 'commands'> & { state: ChannelState }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversationId, peerOpenId, direct } = message.channel.address as Record<string, string | undefined>
  const text = clip(message.text)
  const thread = message.channel.thread
  const card = openCard(host.state, thread)
  if (message.kind === 'acknowledgement') {
    const args = direct === 'true'
      ? ['chat', 'message', 'send-card', '--open-dingtalk-id', peerOpenId ?? '', '--format', 'json']
      : ['chat', 'message', 'send-card', '--conversation-id', conversationId ?? '', '--at-open-dingtalk-ids', peerOpenId ?? '', '--format', 'json']
    const bizId = cardId(await host.commands.dws<unknown>(args))
    if (!bizId) throw new Error('DingTalk created no streaming card to acknowledge in')
    await updateCard(host, bizId, text, 1)
    // The card's own message is the acknowledgement's: its words are the first text a person sees there.
    recordSent(host.state, conversationId ?? '', text)
    const cards = { ...host.state.get(KV.dingtalk.cards), [thread]: { bizId, text, at: Date.now() } }
    host.state.set(KV.dingtalk.cards, cards)
    return 'sent'
  }
  if (message.kind === 'reply' && card) {
    await updateCard(host, card.bizId, text, 3)
    recordSent(host.state, conversationId ?? '', text)
    const cards = { ...host.state.get(KV.dingtalk.cards) }
    delete cards[thread]
    host.state.set(KV.dingtalk.cards, Object.keys(cards).length ? cards : undefined)
    await clearConversationReactions(host, conversationId ?? '')
    return 'sent'
  }
  const args = direct === 'true'
    ? ['chat', 'message', 'send', '--open-dingtalk-id', peerOpenId ?? '', '--content', text,
      '--idempotency-key', message.id, '--format', 'json']
    : ['chat', 'message', 'send', '--conversation-id', conversationId ?? '', '--at-open-dingtalk-ids', peerOpenId ?? '',
      '--content', `<@${peerOpenId ?? ''}> ${text}`, '--idempotency-key', message.id]
  const sentId = await messageIdOf(host, await host.commands.dws<unknown>(args))
  recordSent(host.state, conversationId ?? '', text, sentId)
  // The person has an answer now, so the messages it settles stop showing the working reaction.
  if (message.kind === 'reply') await clearConversationReactions(host, conversationId ?? '')
  return 'sent'
}
/**
 * The message ID a send produced. `dws chat message send` returns an `openTaskId`, and `query-send-status` turns that into the
 * `openMessageId` the history path lists the message by; a send that reports neither is recorded by its text alone.
 */
async function messageIdOf(host: Pick<SourceContext, 'commands'>, result: unknown): Promise<string | undefined> {
  const direct = messageIdIn(result)
  if (direct) return direct
  const task = taskIdIn(result)
  if (!task) return undefined
  try {
    return messageIdIn(await host.commands.dws<unknown>(['chat', 'message', 'query-send-status', '--open-task-id', task]))
  } catch { return undefined }
}
/** The `openMessageId` a CLI response carries, at any depth the CLI nests its envelope. */
export function messageIdIn(value: unknown): string | undefined { return fieldIn(value, ['openMessageId', 'open_message_id']) }
/** The `openTaskId` a CLI response carries, at any depth the CLI nests its envelope. */
export function taskIdIn(value: unknown): string | undefined { return fieldIn(value, ['openTaskId', 'open_task_id']) }
/** The first non-empty string a response holds under `names`, recursing through the CLI's `data` and `result` envelopes. */
function fieldIn(value: unknown, names: readonly string[]): string | undefined {
  const found = (item: unknown, depth = 0): string | undefined => {
    if (depth > 4 || typeof item !== 'object' || item === null) return undefined
    const record = item as Record<string, unknown>
    for (const name of names) if (typeof record[name] === 'string' && record[name]) return record[name] as string
    for (const child of [record.data, record.result]) { const hit = found(child, depth + 1); if (hit) return hit }
    return undefined
  }
  return found(value)
}
/** Updates a card's text and flow status: 1 processing, 2 typing, 3 finished. The last update of a card must be 3. */
const updateCard = (host: Pick<SourceContext, 'commands'>, bizId: string, text: string, flow: 1 | 2 | 3): Promise<unknown> =>
  host.commands.dws<unknown>(['chat', 'message', 'update-card', '--biz-id', bizId, '--content', text, '--flow-status', String(flow)])
/**
 * Finishes open cards, so none keeps spinning after the work it announced is over; the card keeps the acknowledgement's text.
 * `staleAfterMs` limits it to cards older than that (the history loop's sweep); without it every card is finished (a ticket ended).
 */
export async function finishCards(host: Pick<SourceContext, 'commands'> & { state: ChannelState },
  staleAfterMs?: number): Promise<void> {
  const cards = host.state.get(KV.dingtalk.cards)
  if (!cards) return
  const errors: unknown[] = []
  const left = { ...cards }
  for (const [thread, card] of Object.entries(cards)) {
    if (staleAfterMs !== undefined && Date.now() - card.at < staleAfterMs) continue
    try { await updateCard(host, card.bizId, card.text, 3); delete left[thread] }
    catch (error) { errors.push(error) }
  }
  host.state.set(KV.dingtalk.cards, Object.keys(left).length ? left : undefined)
  if (errors.length) throw errors[0]
}
/** DingTalk's web client opens at one page for every conversation; `triggerId` names the Trigger the link belongs to. */
export const dingtalkLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink =>
  ({ url: 'https://im.dingtalk.com/', label: { zh: '钉钉消息', en: 'DingTalk message' },
    ...address.messageId ? { triggerId: dingtalkTriggerId(address.messageId) } : {} })

/** The reaction a received message carries while it is being worked on, as `dws-chat-agent` used it. */
export const WORKING_EMOJI = '专注'
/** How long a message may keep the reaction before the history loop takes it off, in case no reply ever cleared it. */
export const REACTION_LIMIT_MS = 30 * 60_000
/** How long a streaming card may stay open before the history loop finishes it, in case its ticket ended without a reply. */
export const CARD_LIMIT_MS = 30 * 60_000
/** Adds the working reaction to a message, remembering it so a reply or a later sweep can take it off. */
export async function addReaction(host: Pick<SourceContext, 'commands'> & { state: ChannelState }, conversationId: string,
  messageId: string): Promise<void> {
  const key = KV.dingtalk.reactions(conversationId)
  host.state.set(key, [...host.state.get(key) ?? [], { messageId, at: Date.now() }])
  await host.commands.dws<unknown>(['chat', 'message', 'add-emoji', '--conversation-id', conversationId,
    '--message-id', messageId, '--emoji', WORKING_EMOJI])
}
/**
 * Takes the working reaction off a message, and keeps it on the record when the removal failed so the sweep tries again. A reaction
 * that leaves its record behind would never be removed by anything.
 */
export async function clearReaction(host: Pick<SourceContext, 'commands'> & { state: ChannelState }, conversationId: string,
  messageId: string): Promise<void> {
  const key = KV.dingtalk.reactions(conversationId)
  try {
    await host.commands.dws<unknown>(['chat', 'message', 'remove-emoji', '--conversation-id', conversationId,
      '--message-id', messageId, '--emoji', WORKING_EMOJI])
  } catch {
    // The reaction is cosmetic, so a failed removal leaves the record for the sweep instead of failing the reply it followed.
    return
  }
  const kept = (host.state.get(key) ?? []).filter(entry => entry.messageId !== messageId)
  host.state.set(key, kept.length ? kept : undefined)
}
/**
 * Takes the working reaction off every message of a conversation a reply just answered. One reply settles the messages it weighs
 * together, so the rest of that batch must not keep a marker that the next reply would never clear.
 */
export async function clearConversationReactions(host: Pick<SourceContext, 'commands'> & { state: ChannelState },
  conversationId: string): Promise<void> {
  for (const entry of host.state.get(KV.dingtalk.reactions(conversationId)) ?? []) {
    await clearReaction(host, conversationId, entry.messageId).catch(() => { /* the sweep retries it */ })
  }
}
/** Takes the working reaction off every message that has carried it too long, so a quiet thread does not keep a stale marker. */
export async function sweepReactions(host: Pick<SourceContext, 'commands'> & { state: ChannelState }, conversationId: string,
  now = Date.now()): Promise<void> {
  const key = KV.dingtalk.reactions(conversationId)
  const entries = host.state.get(key) ?? []
  const stale = entries.filter(entry => now - entry.at >= REACTION_LIMIT_MS)
  if (!stale.length) return
  host.state.set(key, entries.filter(entry => now - entry.at < REACTION_LIMIT_MS))
  for (const entry of stale) await clearReaction(host, conversationId, entry.messageId)
}
