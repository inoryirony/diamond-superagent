import { expect, it } from 'vitest'
import { displayName, enrichActorName, resolveContact, resolveNames } from '../src/sources/dingtalk-names.ts'
import { KV } from '../src/kv.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Trigger } from '../src/core/index.ts'

/** A Commands whose dws answers each nick's query with that person's record, recording the queries it served. */
const directory = (people: { nick: string; flowerName: string; openDingTalkId: string }[]): { commands: Commands; queries: string[] } => {
  const queries: string[] = []
  return { queries, commands: { dws: async (args: string[]) => {
    const nick = args.at(-1)!
    queries.push(args.join(' '))
    return { result: people.filter(person => person.nick.includes(nick)) }
  } } as Commands }
}
const cache = () => {
  const store = new Map<string, unknown>()
  return { get: (key: unknown) => store.get(String(key)), set: (key: unknown, value: unknown) => { store.set(String(key), value) } }
}
const CONTACT = { nick: '蒋涛', flowerName: '虚竹', openDingTalkId: 'DLpeer' }
const SELF = { nick: '马天泽', flowerName: '天泽', openDingTalkId: 'DXself' }
const trigger = (meta: Record<string, unknown>): Trigger =>
  ({ id: 't1', source: 'dingtalk', threads: [{ source: 'dingtalk', id: 'th1' }], actor: { source: 'dingtalk', id: 'DXself' },
    human: true, at: '2026-11-03T11:43:34.000Z', text: 'x', meta }) as Trigger

it('shows 花名（真名） for a distinct flower name, and the nick alone without one', () => {
  expect(displayName(CONTACT)).toBe('虚竹（蒋涛）')
  expect(displayName({ nick: '杨培', flowerName: '', openDingTalkId: 'DXp' })).toBe('杨培')
  expect(displayName({ nick: '马天泽', flowerName: '马天泽', openDingTalkId: 'DXm' })).toBe('马天泽')
})

it('resolves a nick once and caches it, including the cached nobody', async () => {
  const { commands, queries } = directory([CONTACT])
  const kv = cache()
  expect(await resolveContact(commands, kv, '蒋涛')).toEqual(CONTACT)
  await resolveContact(commands, kv, '蒋涛')
  expect(queries).toEqual(['contact user search --query 蒋涛'])

  const miss = directory([])
  const kvMiss = cache()
  expect(await resolveContact(miss.commands, kvMiss, '无名氏')).toBeUndefined()
  expect(await resolveContact(miss.commands, kvMiss, '无名氏')).toBeUndefined()
  expect(miss.queries).toEqual(['contact user search --query 无名氏'])
})

it('enriches a DingTalk trigger meta with the display name, once, and leaves other metas alone', async () => {
  const { commands } = directory([CONTACT])
  const enriched = await enrichActorName(commands, cache(), trigger({ sender: '蒋涛' }))
  expect(enriched.meta.actor_name).toBe('虚竹（蒋涛）')
  expect((await enrichActorName(commands, cache(), enriched)).meta).toBe(enriched.meta)
  expect((await enrichActorName(commands, cache(), trigger({ sender: '' }))).meta).toEqual({ sender: '' })
})

it('tells the operator himself apart by the configured open DingTalk ID while resolving every nick', async () => {
  const { commands } = directory([SELF])
  const names = await resolveNames(commands, cache(), SELF.openDingTalkId, ['马天泽', '蒋涛'])
  expect(names.get('马天泽')).toMatchObject({ self: true })
  expect(names.get('蒋涛')).toBeUndefined()
})

it('caches names under the KV the store shares, so a resolved nick survives restarts', async () => {
  const { commands } = directory([CONTACT])
  const kv = cache()
  await resolveContact(commands, kv, '蒋涛')
  const again = directory([])
  expect(await resolveContact(again.commands, kv, '蒋涛')).toEqual(CONTACT)
  expect(again.queries).toEqual([])
  expect(KV.dingtalk.names('蒋涛')).toBeDefined()
})
