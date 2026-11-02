/** The DingTalk Channel: sends a message to a direct chat or a group, addressing the person in a group. */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { dingtalkTriggerId } from './dingtalk-trigger.ts'

/** The longest body `dws chat message send` takes without splitting a message in two. */
export const DINGTALK_TEXT_LIMIT = 4000
/** Cuts a body to `DINGTALK_TEXT_LIMIT`; the Executor's own limit is shorter, so this only bounds a retry or a notice. */
export const clip = (text: string): string => text.length <= DINGTALK_TEXT_LIMIT ? text : `${text.slice(0, DINGTALK_TEXT_LIMIT - 1)}…`
/**
 * Sends a message as the operator's own account, idempotently by the queued message's ID. A group message must name the person it
 * answers, since the agent speaks there without a bot identity: the `<@openDingTalkId>` placeholder and the ID list go together.
 * A missing conversation or an unknown target is retried rather than reported gone, because the CLI names no such code.
 */
export async function sendDingtalk(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversationId, peerOpenId, direct } = message.channel.address as Record<string, string | undefined>
  const text = clip(message.text)
  const args = direct === 'true'
    ? ['chat', 'message', 'send', '--open-dingtalk-id', peerOpenId ?? '', '--content', text,
      '--idempotency-key', message.id, '--format', 'json']
    : ['chat', 'message', 'send', '--conversation-id', conversationId ?? '', '--at-open-dingtalk-ids', peerOpenId ?? '',
      '--content', `<@${peerOpenId ?? ''}> ${text}`, '--idempotency-key', message.id]
  await host.commands.dws<unknown>(args)
  return 'sent'
}
/** DingTalk's web client opens at one page for every conversation; `triggerId` names the Trigger the link belongs to. */
export const dingtalkLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink =>
  ({ url: 'https://im.dingtalk.com/', label: { zh: '钉钉消息', en: 'DingTalk message' },
    ...address.messageId ? { triggerId: dingtalkTriggerId(address.messageId) } : {} })
