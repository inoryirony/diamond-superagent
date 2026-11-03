/** Display names for DingTalk senders: a message shows a nick, the company directory knows a flower name, and the two together read
 * 花名（真名）. Resolved once per nick through `dws contact user search` and cached in the KV, with `null` remembering a nick that
 * resolved to nobody so it is not looked up again. */
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import type { Trigger } from '../core/model.ts'
import { SOURCE } from './dingtalk-trigger.ts'
export { SOURCE as DINGTALK }

/** One contact as the directory resolved him: the nick a message shows, his flower name, and his open DingTalk ID. */
export interface Contact { nick: string; flowerName: string; openDingTalkId: string }
/** The KV record shape; `null` (the cached absence of a record) means the nick resolved to nobody. */
export type ContactRecord = Contact | null

/** The name a person is shown under: 花名（真名） when a distinct flower name is known, the nick alone otherwise. */
export function displayName(contact: Contact): string {
  return contact.flowerName && contact.flowerName !== contact.nick ? `${contact.flowerName}（${contact.nick}）` : contact.nick
}

/** The store faces of the KV: read one key and write one key, as `SourceContext.state` and `Store` both already provide them. */
export interface NameCache {
  get(key: unknown): unknown
  set(key: unknown, value: unknown): void
}

/** Resolves one nick to a contact, through the cache; a nick that resolves to nobody or fails to look up stays unresolved. */
export async function resolveContact(commands: Commands, cache: NameCache, nick: string): Promise<Contact | undefined> {
  if (!nick) return undefined
  const key = KV.dingtalk.names(nick)
  const cached = cache.get(key) as ContactRecord | undefined
  if (cached !== undefined) return cached ?? undefined
  try {
    const page = await commands.dws<{ result?: { nick?: string; flowerName?: string; openDingTalkId?: string }[] }>(
      ['contact', 'user', 'search', '--query', nick])
    const found = page.result?.find(entry => entry.nick === nick) ?? page.result?.[0]
    const contact = found?.nick ? { nick: found.nick, flowerName: found.flowerName ?? '', openDingTalkId: found.openDingTalkId ?? '' } : null
    cache.set(key, contact)
    return contact ?? undefined
  } catch {
    return undefined // A failed lookup is not cached: the next trigger by the same sender tries again.
  }
}

/**
 * Writes the sender's display name into a DingTalk Trigger's `meta.actor_name`, so every reader of the trigger — the candidate
 * card, a worker input, `orchestrator_read trigger/<id>` — shows 花名（真名） without another lookup. `meta.operator`, decided from
 * the open DingTalk ID, is already there and travels with the same meta.
 */
export async function enrichActorName(commands: Commands, cache: NameCache, trigger: Trigger): Promise<Trigger> {
  const sender = trigger.meta.sender
  if (typeof sender !== 'string' || !sender || trigger.meta.actor_name !== undefined) return trigger
  const contact = await resolveContact(commands, cache, sender)
  if (!contact) return trigger
  return { ...trigger, meta: { ...trigger.meta, actor_name: displayName(contact) } }
}

/** One resolved sender of a conversation's history: his directory contact, and whether he is the operator himself. */
export type NamedSender = Contact & { self: boolean }

/**
 * Resolves every nick a conversation's history shows, in one pass over the shared cache, telling the operator himself apart by
 * the open DingTalk ID the deployment configured. A nick that resolves to nobody keeps its own name and is not marked self.
 */
export async function resolveNames(commands: Commands, cache: NameCache, selfOpenId: string, nicks: readonly string[]):
  Promise<Map<string, NamedSender>> {
  const out = new Map<string, NamedSender>()
  for (const nick of [...new Set(nicks)].filter(Boolean)) {
    const contact = await resolveContact(commands, cache, nick)
    if (!contact) continue
    out.set(nick, { ...contact, self: !!selfOpenId && contact.openDingTalkId === selfOpenId })
  }
  return out
}
