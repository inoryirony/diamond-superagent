/** Reads the messages around a DingTalk Trigger: the episode it belongs to, and the message it roots at or answers. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { dingtalkTime, historyId, historyText, localTime, SOURCE } from './dingtalk-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'

/** A listed message as `dws chat message list --format json` prints it; timestamps come as local time or as milliseconds. */
const MessageSchema = z.looseObject({
  messageId: z.string().optional(), openMessageId: z.string().optional(), openMessage: z.string().optional(),
  text: z.string().optional(), content: z.string().optional(), sender: z.string().optional(),
  senderId: z.string().optional(), senderOpenDingTalkId: z.string().optional(),
  createTime: z.string().optional(), timestamp: z.number().optional(), messageAiSendFlag: z.string().nullish(),
})
type Message = z.infer<typeof MessageSchema>
/** One page of `chat message list`; some versions nest the items under `data`. */
const PageSchema = z.looseObject({ messages: z.array(z.unknown()).optional(), data: z.unknown().optional() })
interface DingtalkAddress { conversationId: string; direct: boolean; peerOpenId: string }

function address(trigger: Trigger): DingtalkAddress & { messageId: string; at: string; rootId?: string; parentId?: string } {
  const meta = trigger.meta as Record<string, unknown>
  const conversationId = typeof meta.conversationId === 'string' ? meta.conversationId : ''
  const messageId = typeof meta.messageId === 'string' ? meta.messageId : ''
  if (trigger.source !== SOURCE || !conversationId || !messageId) throw new Error('A DingTalk source trigger is required')
  return { conversationId, messageId, direct: meta.direct === true, at: trigger.at,
    peerOpenId: typeof meta.peerOpenId === 'string' ? meta.peerOpenId : '',
    ...(typeof meta.rootId === 'string' ? { rootId: meta.rootId } : {}),
    ...(typeof meta.parentId === 'string' ? { parentId: meta.parentId } : {}) }
}
/** The CLI addresses a direct chat by its peer and a group by its conversation. */
const target = (ref: DingtalkAddress): string[] =>
  ref.direct ? ['--open-dingtalk-id', ref.peerOpenId] : ['--conversation-id', ref.conversationId]
async function list(commands: Commands, ref: DingtalkAddress, time: string, direction: 'older' | 'newer',
  limit: number): Promise<Message[]> {
  const args = ['chat', 'message', 'list', ...target(ref), '--time', localTime(time), '--direction', direction,
    '--limit', String(limit), '--format', 'json']
  const page = PageSchema.parse(await commands.dws<unknown>(args))
  const items = page.messages ?? z.looseObject({ messages: z.array(z.unknown()).optional() }).parse(page.data).messages ?? []
  return items.flatMap(item => { const parsed = MessageSchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
}
// A listed message carries its time as `createTime`, where an event carries `create_time`; both forms reach `dingtalkTime`.
const timeOf = (message: Message): string => dingtalkTime({ timestamp: message.timestamp, create_time: message.createTime })
export function dingtalkView(message: Message): ContextMessage {
  const body = message.text ?? message.content ?? ''
  return { id: String(message.openMessageId ?? message.messageId ?? message.openMessage ?? ''), from: message.sender ?? '',
    senderId: message.senderOpenDingTalkId || undefined,
    at: timeOf(message), text: body }
}
/** Merges the older and the newer page into one ascending list of unique messages. */
function merged(messages: Message[]): ContextMessage[] {
  const seen = new Set<string>()
  return messages.map(dingtalkView).sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id))
    .filter(message => !seen.has(message.id) && !!seen.add(message.id))
}
/**
 * Reads a page of the episode around the Trigger. The trigger message sits between the older and the newer page, so the initial
 * read holds both; a later page continues from the earliest message it returned, as the cursor is that message's time.
 */
async function readThread(commands: Commands, ref: DingtalkAddress & { at: string }, cursor: string | undefined,
  pageSize: number): Promise<ContextPart> {
  const before = await list(commands, ref, cursor || ref.at, 'older', pageSize)
  const after = cursor ? [] : await list(commands, ref, ref.at, 'newer', pageSize)
  const messages = merged([...before, ...after])
  // The trigger message is normally the newest of the older page; paginate from the earliest message read so far.
  const earliest = messages[0]?.at
  return { messages, ...earliest && messages.length >= pageSize ? { next: earliest } : {},
    body: { status: 'available', messages }, status: 'available' }
}
/** A listed message the Trigger roots at or answers, read from the same episode page so it matches what the model saw. */
async function readOne(commands: Commands, ref: DingtalkAddress & { at: string }, id: string, pageSize: number,
  page: ContextMessage[] | undefined): Promise<ContextPart> {
  // The page holds the root and the parent whenever they fall within the episode's window; only a quote from outside needs a read.
  const known = page?.find(message => message.id === id)
  if (known) return { messages: [known], body: { status: 'available', messages: [known] }, status: 'available' }
  const around = await list(commands, ref, ref.at, 'older', Math.max(pageSize, 2))
  const found = around.find(message => String(message.openMessageId ?? message.messageId ?? '') === id)
  const messages = found ? [dingtalkView(found)] : []
  return { messages, body: { status: messages.length ? 'available' : 'unavailable', messages }, status: messages.length ? 'available' : 'unavailable' }
}
export const dingtalkThreadContext: ThreadContext<{ readPageSize: number }> = {
  chat: true,
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part: ContextPartName, cursor, config) => {
    const ref = address(trigger)
    if (part === 'thread') return readThread(commands, ref, cursor, config.readPageSize)
    const id = part === 'root' ? ref.rootId : ref.parentId
    if (!id) return { messages: [], body: { status: `no_${part}`, messages: [] }, status: `no_${part}` }
    const page = (await readThread(commands, ref, undefined, config.readPageSize)).messages
    return readOne(commands, ref, id, config.readPageSize, page)
  },
}
