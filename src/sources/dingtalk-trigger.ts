/** Normalizes DingTalk live events and `chat message list` items into domain Triggers, and names a conversation's Thread. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'dingtalk'
/**
 * How close a message must follow a conversation's latest one to join its reply chain, which the root of a quote or of the
 * `root` resource reads. It no longer decides the Thread: a conversation is one Thread however long the pauses in it (see
 * `dingtalkThreadId`).
 */
export const EPISODE_GAP_MS = 10 * 60_000
/** Reply address of a DingTalk message; `direct` is explicit because a group and a direct chat are told apart by the event type. */
export const dingtalkChannel = (conversationId: string, peerOpenId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `dingtalk:${conversationId}`,
    address: { conversationId, peerOpenId, messageId, ...direct ? { direct: 'true' } : {} } })
/**
 * Thread ID of a conversation: one Thread per chat, not per reply chain. A conversation's messages belong together however
 * long the gaps: a question and its contradicting correction are the same work, and slicing them apart by a pause left each
 * slice judged without the other. `feishuThreadId` names a topic's Thread this way because a Feishu chat is several topics;
 * a DingTalk chat has one.
 */
export const dingtalkThreadId = (conversationId: string): string => conversationId
/** Deterministic trigger ID for a DingTalk message; the live and the history paths produce the same one. */
export const dingtalkTriggerId = (messageId: string): string => key('dingtalk', messageId)

const QuotedMessageSchema = z.looseObject({ message_id: z.string(), conversation_id: z.string().optional(),
  content: z.string().optional(), create_time: z.string().optional(), sender: z.string().optional(),
  sender_open_dingtalk_id: z.string().optional() })
/**
 * A message as `dws event consume --flatten` prints it. `mentioned` never comes from the CLI: the history path sets it, because
 * a listed group's history holds messages that were not addressed to the agent, which must not become explicit requests.
 */
const EventSchema = z.object({
  type: z.enum(['user_im_message_receive_o2o_all', 'user_im_message_receive_at']),
  event_id: z.string().optional(), message_id: z.string(), conversation_id: z.string(),
  sender: z.string().default(''), sender_open_dingtalk_id: z.string(),
  content: z.string().default(''), create_time: z.string().optional(), timestamp: z.number().optional(),
  event_time: z.number().optional(), mentioned: z.boolean().optional(),
  messageAiSendFlag: z.string().nullish(), quoted_message: QuotedMessageSchema.optional(),
})
export type DingtalkEvent = z.infer<typeof EventSchema>
/** The conversation's latest root, kept for the `root` and `parent` resources of a message that quotes or chains onto one. */
export interface Episode { rootId: string; lastAt: number }
/** The conversation's latest root and each message's root, which the Source keeps in KV and tests keep in memory. */
export interface DingtalkThreads {
  /** The root a message was recorded under, if the Source saw it. */
  root(conversationId: string, messageId: string): string | undefined
  /** The conversation's latest root, if it has one. */
  episode(conversationId: string): Episode | undefined
  /** The conversation's known peer, so a message the operator typed himself is answered to the other person. */
  peer(conversationId: string): string | undefined
  /**
   * Whether this account sent the message as the agent, which is what tells its own reply from a person's. The AI flag is not
   * enough: the history path never sees it, and a send may not carry it, so the Source keeps the send record instead.
   */
  own?(conversationId: string, messageId: string, text: string): boolean
  /** Records the message's root and makes it the conversation's latest episode. */
  remember(conversationId: string, messageId: string, rootId: string, at: number): void
}
/**
 * The root a message chains onto: the root of the message it quotes, or failing that the quoted message itself; otherwise the
 * conversation's latest root when this message follows it within `EPISODE_GAP_MS`; otherwise the message itself. It names the
 * `root` and `parent` resources a reader opens, not the Thread the message is filed under.
 */
export function dingtalkRoot(event: DingtalkEvent, at: number, threads: DingtalkThreads): string {
  const quoted = event.quoted_message?.message_id
  if (quoted) return threads.root(event.conversation_id, quoted) ?? quoted
  const episode = threads.episode(event.conversation_id)
  if (episode && at - episode.lastAt <= EPISODE_GAP_MS) return episode.rootId
  return event.message_id
}

/** Mirrors the acknowledgement matcher of `dws-chat-agent` (`_ACK_TEXT`): a whole message that is only an acknowledgement. */
const ACK_TEXT = /^(?:好(?:的|嘞|滴)?|收到|知道了|明白|了解|行|可以|没问题|ok|okay|嗯+|哦+|谢(?:谢|啦)|辛苦(?:了|啦)?|哈哈+|嗯嗯|1|666)[。！!~～,.， ]*$/i
/**
 * Mirrors `_ONLY_REACTION`: at most eight brackets or symbols, so a bare `[赞]`, a lone emoji or `?` is a reaction rather than a
 * request. Letters and digits are excluded so a short Chinese answer is not mistaken for one.
 */
const ONLY_REACTION = /^(?:\[[^\]\n]{1,16}\]|[^\p{L}\p{N}]){1,8}$/u
/** Whether a message carries no request: an acknowledgement, a bare reaction, or nothing at all. */
export const isNoise = (text: string): boolean => {
  const cleaned = text.trim()
  return !cleaned || ACK_TEXT.test(cleaned) || ONLY_REACTION.test(cleaned)
}

/**
 * Parses a DingTalk time into an ISO-8601 string. Events carry `timestamp` in milliseconds and `create_time` as Shanghai local
 * time without a zone, which `dws` also prints for history items.
 */
export function dingtalkTime(input: { timestamp?: number | undefined; create_time?: string | undefined }): string {
  const raw = input.timestamp !== undefined ? input.timestamp : input.create_time
  const time = typeof raw === 'number' ? raw
    : raw === undefined ? Number.NaN
    : /^\d+$/.test(raw) ? Number(raw)
    : Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? `${raw.replace(' ', 'T')}+08:00` : raw)
  if (!Number.isFinite(time)) throw new Error(`Unreadable DingTalk message time: ${String(raw)}`)
  return new Date(time).toISOString()
}
/** Formats an ISO time as the Shanghai local `yyyy-MM-dd HH:mm:ss` that `dws chat message list --time` takes. */
export function localTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

/**
 * Converts one DingTalk message into a Trigger. Returns undefined for a message this account sent as the agent, and for messages
 * `isNoise` drops. A message the operator typed himself is a normal Trigger marked `meta.operator`, so a chat he answers in is
 * settled by him rather than by the agent. The AI flag alone does not settle that: the history path never carries one, and a
 * send may omit it, so the Source's send record is consulted with it.
 */
export function dingtalkTrigger(input: unknown, selfOpenId: string, threads: DingtalkThreads): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (isNoise(event.content)) return
  const self = selfOpenId !== '' && event.sender_open_dingtalk_id === selfOpenId
  if (self && (event.messageAiSendFlag || threads.own?.(event.conversation_id, event.message_id, event.content))) return
  const direct = event.type === 'user_im_message_receive_o2o_all'
  const at = dingtalkTime(event)
  const rootId = dingtalkRoot(event, Date.parse(at), threads)
  threads.remember(event.conversation_id, event.message_id, rootId, Date.parse(at))
  const peerOpenId = self ? threads.peer(event.conversation_id) ?? event.sender_open_dingtalk_id : event.sender_open_dingtalk_id
  const mentioned = event.mentioned ?? !direct
  // A direct message marks `addressed`, which for a message someone else wrote means they wrote it to this account. The
  // operator's own direct message is the opposite: it is his words to the other person, not a request to the agent, so it is
  // marked `forPeer` and the gate decides whether that person is someone this deployment serves.
  const forPeer = self && direct
  return { id: dingtalkTriggerId(event.message_id), source: SOURCE,
    threads: [{ source: SOURCE, id: dingtalkThreadId(event.conversation_id) }],
    actor: { source: SOURCE, id: event.sender_open_dingtalk_id }, human: true,
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at, text: event.content,
    channel: dingtalkChannel(event.conversation_id, peerOpenId, event.message_id, direct),
    meta: { conversationId: event.conversation_id, messageId: event.message_id, peerOpenId, direct, rootId, sender: event.sender,
      ...(forPeer ? { forPeer: true } : {}),
      ...(event.quoted_message?.message_id ? { parentId: event.quoted_message.message_id } : {}), ...(self ? { operator: true } : {}) } }
}

/** A message from `dws chat message list`; the CLI names the body `text` or `content` depending on the message type. */
export const HistoricalMessageSchema = z.looseObject({
  messageId: z.string().optional(), openMessageId: z.string().optional(), openMessage: z.string().optional(),
  text: z.string().optional(), content: z.string().optional(), sendType: z.string().optional(),
  sender: z.string().optional(), senderId: z.string().optional(), senderOpenDingTalkId: z.string().optional(),
  createTime: z.string().optional(), timestamp: z.number().optional(), openConversationId: z.string().optional(),
  messageAiSendFlag: z.string().nullish(),
  quotedMessage: z.looseObject({ messageId: z.string().optional(), openMessageId: z.string().optional(),
    content: z.string().optional(), sender: z.string().optional() }).optional(),
}).refine(message => !!(message.openMessageId ?? message.messageId ?? message.openMessage), 'A listed message has no id')
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>
export const historyId = (message: HistoricalMessage): string => String(message.openMessageId ?? message.messageId ?? message.openMessage)
/** The body of a listed message; a rich-text message carries JSON where a plain one carries text. */
export const historyText = (message: HistoricalMessage): string => message.text ?? message.content ?? ''
/** One page of `chat message list`, which nests its items under `data` in some versions. */
export function historyMessages(value: unknown): unknown[] {
  const page = z.looseObject({ messages: z.array(z.unknown()).optional(), data: z.unknown().optional() }).parse(value)
  if (page.messages) return page.messages
  const nested = z.looseObject({ messages: z.array(z.unknown()).optional() }).safeParse(page.data)
  return nested.success ? nested.data.messages ?? [] : []
}
/**
 * Adapts a listed message into the live-event schema, so both paths give a message the same trigger ID and time. A listed
 * message is never known to be addressed to the agent unless it is a direct one, so `mentioned` defaults to false.
 */
export function historyEvent(message: HistoricalMessage, conversationId: string, direct: boolean, mentioned = false): unknown {
  const quoted = message.quotedMessage?.openMessageId ?? message.quotedMessage?.messageId
  return { type: direct ? 'user_im_message_receive_o2o_all' : 'user_im_message_receive_at',
    message_id: historyId(message), conversation_id: conversationId,
    sender: message.sender ?? '', sender_open_dingtalk_id: message.senderOpenDingTalkId ?? '',
    content: historyText(message), create_time: message.createTime, timestamp: message.timestamp,
    mentioned: direct || mentioned, messageAiSendFlag: message.messageAiSendFlag,
    ...quoted ? { quoted_message: { message_id: quoted, content: message.quotedMessage?.content } } : {} }
}
