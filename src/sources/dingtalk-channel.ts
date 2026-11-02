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
/** `bizId` of a card `dws chat message send-card` created; the CLI names it at the top level or under `data`. */
export function cardId(value: unknown): string | undefined {
  const found = (item: unknown, depth = 0): string | undefined => {
    if (depth > 4 || typeof item !== 'object' || item === null) return undefined
    const record = item as Record<string, unknown>
    for (const name of ['bizId', 'biz_id']) if (typeof record[name] === 'string' && record[name]) return record[name] as string
    return found(record.data, depth + 1)
  }
  return found(value)
}
/** The card a reply finishes: the open card of the message's own thread, if an acknowledgement opened one. */
const openCard = (state: ChannelState, thread: string) => state.get(KV.dingtalk.cards)?.[thread]
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
    const cards = { ...host.state.get(KV.dingtalk.cards), [thread]: { bizId, text, at: Date.now() } }
    host.state.set(KV.dingtalk.cards, cards)
    return 'sent'
  }
  if (message.kind === 'reply' && card) {
    await updateCard(host, card.bizId, text, 3)
    const cards = { ...host.state.get(KV.dingtalk.cards) }
    delete cards[thread]
    host.state.set(KV.dingtalk.cards, Object.keys(cards).length ? cards : undefined)
    await clearReaction(host, conversationId ?? '', String(message.channel.address.messageId ?? ''))
    return 'sent'
  }
  const args = direct === 'true'
    ? ['chat', 'message', 'send', '--open-dingtalk-id', peerOpenId ?? '', '--content', text,
      '--idempotency-key', message.id, '--format', 'json']
    : ['chat', 'message', 'send', '--conversation-id', conversationId ?? '', '--at-open-dingtalk-ids', peerOpenId ?? '',
      '--content', `<@${peerOpenId ?? ''}> ${text}`, '--idempotency-key', message.id]
  await host.commands.dws<unknown>(args)
  // The person has an answer now, so the message stops showing the working reaction.
  if (message.kind === 'reply') await clearReaction(host, conversationId ?? '', String(message.channel.address.messageId ?? ''))
  return 'sent'
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
 * Takes the working reaction off a message. The reaction is cosmetic, so a failed removal is left to the sweep in the history loop
 * rather than failing the reply it followed.
 */
export async function clearReaction(host: Pick<SourceContext, 'commands'> & { state: ChannelState }, conversationId: string,
  messageId: string): Promise<void> {
  const key = KV.dingtalk.reactions(conversationId)
  const kept = (host.state.get(key) ?? []).filter(entry => entry.messageId !== messageId)
  host.state.set(key, kept.length ? kept : undefined)
  await host.commands.dws<unknown>(['chat', 'message', 'remove-emoji', '--conversation-id', conversationId,
    '--message-id', messageId, '--emoji', WORKING_EMOJI]).catch(() => { /* the sweep retries nothing; the reaction is cosmetic */ })
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
