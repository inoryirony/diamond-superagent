/** DingTalk source kind definition and Cordis plugin entry; the operator's own account speaks, so there is no bot identity. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { DingtalkAccountSchema } from '../deployment.ts'
import { dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { dingtalkThreadContext } from './dingtalk-read.ts'
import { runDingtalk } from './dingtalk-loops.ts'
import { dingtalkTriggerId, SOURCE } from './dingtalk-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, dingtalkThreadId, dingtalkTime, dingtalkTrigger, dingtalkTriggerId, historyEvent, isNoise }
  from './dingtalk-trigger.ts'
export type { DingtalkEvent } from './dingtalk-trigger.ts'
export { backfillChat, consumerRetry, runDingtalk } from './dingtalk-loops.ts'
const ChatSchema = z.object({ conversationId: z.string().trim().min(1), name: z.string().trim().max(60).optional() }).strict()
const DingtalkConfigSchema = DingtalkAccountSchema.extend({
  directMessages: z.boolean().default(true),
  chats: z.array(ChatSchema).refine(chats => new Set(chats.map(chat => chat.conversationId)).size === chats.length,
    'Duplicate conversation IDs').default([]),
  otherChats: z.enum(['none', 'mentions']).default('mentions'),
  readPageSize: z.number().int().min(1).max(50).default(20),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>
export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '以本人账号接收单聊和 @ 本人的群消息，按上下文的接续分成一段段对话，并补收错过的消息。',
    en: "Receives direct messages and group messages that mention the operator, through his own account, groups messages that follow one another into episodes, and recovers missed ones." },
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '本人的 dws', en: 'Your dws' },
      hint: { zh: '命令名或绝对路径，指向已经登录的 dws；执行器以 dws 调用它，并且只允许读取上下文。保存时读取本人的账号，然后重启 dsh-superagent。',
        en: 'A command name or absolute path of a signed-in dws; the Executor calls it as dws, and only to read context. Saving reads your account, then restarts dsh-superagent.' } },
    { key: 'openDingtalkId', type: 'text', label: { zh: '本人的 openDingTalkId', en: 'Your openDingTalkId' },
      hint: { zh: '用来认出哪些消息是本人发的：智能体发的带 AI 标记，本人手打的作为本人的插话。钉钉的接口不返回它，需要手动填写。',
        en: 'Tells your own messages apart: the agent sets an AI flag, while the ones you type are your own interjections. No DingTalk API returns it, so enter it by hand.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '这些群里的历史和对账都读取；其中 @ 本人的消息成为请求，其余消息不成为请求。',
        en: 'History and reconciliation read these chats; messages there that mention you become requests, the rest do not.' },
      columns: [
        { key: 'conversationId', type: 'text', label: { zh: '群', en: 'Chat' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' },
      options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '没列在上面的群。“仅 @”接收那里 @ 本人的实时消息，但不对账、不读历史；谁的消息能发起工作看策略里的准入。',
        en: 'Chats not listed above. "@ only" receives live messages there that mention you, but reads no history and reconciles none; whose messages may originate work is the admission of the Policy.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收单聊', en: 'Direct messages' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' },
      hint: { zh: '智能体读取一段对话时，前后各取多少条消息。', en: 'How many messages an agent reads before and after the Trigger.' } },
  ],
  health: ['dingtalk', 'history'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.conversationId === meta.conversationId)
    if (chat) return { listened: true, observed: false, row: chat.conversationId }
    // A group message carries no mention list, so an unlisted chat's messages are listened to only through `otherChats`.
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a conversation the Source still receives.
  channel: {
    allowed: (address, config) =>
      dingtalkKind.scope!({ meta: { conversationId: address.conversationId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendDingtalk, link: dingtalkLink,
  },
  threadContext: dingtalkThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[0-9a-f]{24,}\b/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it quotes is named after the quote.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? dingtalkTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '钉钉用户', en: 'DingTalk user' }, bot: { zh: '钉钉机器人', en: 'DingTalk bot' } },
    schema: z.object({
      // An open DingTalk ID is an opaque token; the CLI documents no shape, so only its presence is checked.
      allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open DingTalk IDs').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'openDingTalkId', en: 'openDingTalkId' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 本人或私聊本人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions you or messages you directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = DingtalkConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.conversationId, label: chat.name || chat.conversationId, note: mentions,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '单聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_PEER', description: { zh: '发来消息的人；dws 从不以机器人身份行事', en: 'The person whose message this is; dws never acts as a bot' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_CONVERSATION', description: { zh: '接下工单的钉钉会话；工单不是从钉钉来的时为空', en: 'The DingTalk conversation that started the ticket; empty when the ticket did not start on DingTalk' } },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_DINGTALK_PEER: trigger?.source === SOURCE ? String(trigger.meta.peerOpenId ?? '') : '',
      DSH_SUPERAGENT_DINGTALK_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversationId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> =>
    deployment?.dingtalk ? { cli: { zh: `当前账号 ${deployment.dingtalk.name || deployment.dingtalk.userId}`,
      en: `Current account ${deployment.dingtalk.name || deployment.dingtalk.userId}` } } : {},
}
/** Returns the DingTalk Source's settings, falling back to schema defaults while the DingTalk plugin is disabled. */
export const dingtalkSettings = (sources: SourceRegistry): DingtalkConfig => sources.instance<DingtalkConfig>(SOURCE)?.config ?? DingtalkConfigSchema.parse({})

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runDingtalk(sourceContext(ctx.orchestrator, dingtalkKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
