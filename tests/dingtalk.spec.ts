/** The DingTalk Source: events into Triggers, episodes, the noise gate, the operator's own messages, and the replies it sends. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { dingtalkKind } from '../src/sources/dingtalk.ts'
import { runDingtalk } from '../src/sources/dingtalk-loops.ts'
import { clip, dingtalkLink, sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { dingtalkThreadContext } from '../src/sources/dingtalk-read.ts'
import { dingtalkChannel, dingtalkThreadId, dingtalkTrigger, dingtalkTriggerId, EPISODE_GAP_MS, historyEvent, isNoise, localTime, SOURCE,
  type DingtalkThreads } from '../src/sources/dingtalk-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SELF = 'Oo_self_0000000000000000000000000'
const PEER = 'Oo_peer_1111111111111111111111111'
const CONVERSATION = 'cid_direct_0001'
const GROUP = 'cid_group_0002'

/** The episodes and quote roots in memory, as the Source keeps them in KV. */
function threads(peers: Record<string, string> = {}): DingtalkThreads & { roots: Map<string, Record<string, string>>;
  episodes: Map<string, { rootId: string; lastAt: number }> } {
  const roots = new Map<string, Record<string, string>>()
  const episodes = new Map<string, { rootId: string; lastAt: number }>()
  return {
    roots, episodes,
    root: (conversationId, messageId) => roots.get(conversationId)?.[messageId],
    episode: conversationId => episodes.get(conversationId),
    peer: conversationId => peers[conversationId],
    remember: (conversationId, messageId, rootId, at) => {
      roots.set(conversationId, { ...roots.get(conversationId), [messageId]: rootId })
      episodes.set(conversationId, { rootId, lastAt: at })
    },
  }
}
/** One `--flatten` event line, as `dws event consume` prints it. */
const event = (id: string, overrides: Record<string, unknown> = {}) => ({
  type: 'user_im_message_receive_o2o_all' as const, event_id: `e-${id}`, message_id: id,
  conversation_id: CONVERSATION, sender: 'Alice', sender_open_dingtalk_id: PEER,
  content: 'the login page is broken', create_time: '2026-11-02 10:00:00', timestamp: Date.parse('2026-11-02T02:00:00Z'),
  ...overrides,
})

describe('dingtalk triggers', () => {
  it('reads a direct message as a human Trigger addressed to the operator, on a thread named after its episode', () => {
    const state = threads()
    const trigger = dingtalkTrigger(event('mid_1'), SELF, state)!
    expect(trigger).toEqual({ id: key('dingtalk', 'mid_1'), source: SOURCE,
      threads: [{ source: SOURCE, id: dingtalkThreadId(CONVERSATION, 'mid_1') }],
      actor: { source: SOURCE, id: PEER }, human: true, addressed: 'direct', at: '2026-11-02T02:00:00.000Z',
      text: 'the login page is broken',
      channel: dingtalkChannel(CONVERSATION, PEER, 'mid_1', true),
      meta: { conversationId: CONVERSATION, messageId: 'mid_1', peerOpenId: PEER, direct: true, rootId: 'mid_1', sender: 'Alice' } })
    expect(trigger.threads[0]!.id).toBe(`${CONVERSATION}:mid_1`)
    expect(state.episodes.get(CONVERSATION)).toEqual({ rootId: 'mid_1', lastAt: Date.parse('2026-11-02T02:00:00Z') })
  })
  it('reads a message that mentions the operator in a group as an admitted mention, and the group as its address', () => {
    const trigger = dingtalkTrigger(event('mid_2', { type: 'user_im_message_receive_at', conversation_id: GROUP }), SELF, threads())!
    expect(trigger).toMatchObject({ addressed: 'mention', human: true,
      threads: [{ source: SOURCE, id: `${GROUP}:mid_2` }], channel: { source: SOURCE, thread: `dingtalk:${GROUP}` } })
    expect(trigger.channel!.address).toEqual({ conversationId: GROUP, peerOpenId: PEER, messageId: 'mid_2' })
  })
  it('keeps a conversation in one episode for ten minutes, opens a new one after the gap, and continues from a quoted message', () => {
    const state = threads()
    const first = dingtalkTrigger(event('mid_1'), SELF, state)!
    // Half a minute later: the same episode.
    const second = dingtalkTrigger(event('mid_2', { timestamp: Date.parse('2026-11-02T02:00:30Z') }), SELF, state)!
    expect(second.threads[0]!.id).toBe(first.threads[0]!.id)
    expect(second.meta.rootId).toBe('mid_1')
    // Far longer than the gap: a new episode, rooted at that message.
    const later = dingtalkTrigger(event('mid_3', { timestamp: Date.parse('2026-11-02T02:30:00Z') }), SELF, state)!
    expect(later.meta.rootId).toBe('mid_3')
    expect(EPISODE_GAP_MS).toBe(600_000)
    // A quote wins over the episode: it continues the quoted message's episode, and `repliesTo` names that Trigger.
    dingtalkTrigger(event('mid_4', { timestamp: Date.parse('2026-11-02T02:31:00Z') }), SELF, state)
    const quoted = dingtalkTrigger(event('mid_5', { timestamp: Date.parse('2026-11-02T02:32:00Z'),
      quoted_message: { message_id: 'mid_1', conversation_id: CONVERSATION, content: 'the login page is broken' } }), SELF, state)!
    expect(quoted.meta).toMatchObject({ rootId: 'mid_1', parentId: 'mid_1' })
    expect(dingtalkKind.repliesTo!(quoted)).toBe(dingtalkTriggerId('mid_1'))
    // A quote the Source never saw roots the episode at the quoted message itself.
    const unseen = dingtalkTrigger(event('mid_6', { timestamp: Date.parse('2026-11-02T02:33:00Z'),
      quoted_message: { message_id: 'mid_0' } }), SELF, state)!
    expect(unseen.meta.rootId).toBe('mid_0')
  })
  it('drops acknowledgements and reactions, and keeps an acknowledgement that carries a request', () => {
    for (const text of ['收到', '[OK]', '好的', '嗯嗯', '[赞]', '👍', '  ']) expect(isNoise(text), text).toBe(true)
    for (const text of ['好的，那个接口还是 500', 'ok 但是部署失败了', '1 号机挂了']) expect(isNoise(text), text).toBe(false)
    expect(dingtalkTrigger(event('mid_7', { content: '收到' }), SELF, threads())).toBeUndefined()
  })
  it('drops the agent\'s own message and marks one the operator typed by hand, so an interruption settles the thread', () => {
    const own = { sender_open_dingtalk_id: SELF, sender: 'Me' }
    expect(dingtalkTrigger(event('mid_8', { ...own, messageAiSendFlag: 'DWS' }), SELF, threads())).toBeUndefined()
    // A hand-typed message has no AI flag: it is the operator's own interjection, not the agent's.
    const typed = dingtalkTrigger(event('mid_9', { ...own, messageAiSendFlag: null }), SELF, threads({ [CONVERSATION]: PEER }))!
    expect(typed.meta).toMatchObject({ operator: true, direct: true })
    // The peer stays the person the Source talks to, not the operator himself.
    expect(typed.channel!.address.peerOpenId).toBe(PEER)
    // Without a known peer the message's own sender is the only address there is.
    expect(dingtalkTrigger(event('mid_10', { ...own }), SELF, threads())!.channel!.address.peerOpenId).toBe(SELF)
  })
  it('gives a listed message the same Trigger as the live event would, so the recovery path reconciles rather than duplicates', () => {
    const live = dingtalkTrigger(event('mid_11'), SELF, threads())!
    const listed = historyEvent({ openMessageId: 'mid_11', text: 'the login page is broken', sender: 'Alice',
      senderOpenDingTalkId: PEER, createTime: '2026-11-02 10:00:00' }, CONVERSATION, true)
    const recovered = dingtalkTrigger(listed, SELF, threads())!
    expect(recovered.id).toBe(live.id)
    expect(recovered.at).toBe(live.at)
    expect(recovered.text).toBe(live.text)
    expect(recovered.actor).toEqual(live.actor)
  })
  it('reads a create time as Shanghai local time and an unknown form as an error', () => {
    expect(dingtalkTrigger(event('mid_12', { timestamp: undefined }), SELF, threads())!.at).toBe('2026-11-02T02:00:00.000Z')
    expect(() => dingtalkTrigger(event('mid_13', { timestamp: undefined, create_time: 'yesterday' }), SELF, threads()))
      .toThrow('Unreadable DingTalk message time: yesterday')
    expect(localTime('2026-11-02T02:00:00.000Z')).toBe('2026-11-02 10:00:00')
  })
})

describe('dingtalk channel', () => {
  const deployment = testDeployment({ dingtalk: { cli: '/path/dws', openDingtalkId: SELF, userId: '1735868923313459',
    name: 'Me', corpId: 'ding1' } })
  const reply = (direct: boolean): OutboundMessage => ({ id: 'stable-operation', kind: 'reply', text: 'Done',
    channel: dingtalkChannel(CONVERSATION, PEER, 'mid_1', direct) })
  it('answers a direct message as the operator\'s own account, idempotently by the queued reply', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const dws = vi.spyOn(commands, 'dws').mockResolvedValue({ openTaskId: 'task-1' })
    expect(await sendDingtalk({ commands }, reply(true))).toBe('sent')
    expect(dws).toHaveBeenCalledWith(['chat', 'message', 'send', '--open-dingtalk-id', PEER, '--content', 'Done',
      '--idempotency-key', 'stable-operation', '--format', 'json'])
  })
  it('names the person it answers in a group, since the agent has no bot identity there', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const dws = vi.spyOn(commands, 'dws').mockResolvedValue({ openTaskId: 'task-2' })
    await sendDingtalk({ commands }, reply(false))
    expect(dws).toHaveBeenCalledWith(['chat', 'message', 'send', '--conversation-id', CONVERSATION,
      '--at-open-dingtalk-ids', PEER, '--content', `<@${PEER}> Done`, '--idempotency-key', 'stable-operation'])
  })
  it('cuts a long body at 4000 characters and links the Trigger on DingTalk\'s web client', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const dws = vi.spyOn(commands, 'dws').mockResolvedValue({})
    await sendDingtalk({ commands }, { ...reply(true), text: 'x'.repeat(4001) })
    const content = (dws.mock.calls[0]![0] as string[])[6]!
    expect(content).toHaveLength(4000)
    expect(content.endsWith('…')).toBe(true)
    expect(clip('short')).toBe('short')
    expect(dingtalkLink({ conversationId: CONVERSATION, messageId: 'mid_1' }, {})).toEqual({ url: 'https://im.dingtalk.com/',
      label: { zh: '钉钉消息', en: 'DingTalk message' }, triggerId: dingtalkTriggerId('mid_1') })
    expect(dingtalkLink({ conversationId: CONVERSATION }, {})).not.toHaveProperty('triggerId')
  })
})

describe('dingtalk policy', () => {
  const settings = SettingsSchema.parse({ eval: { mode: 'observe' },
    policy: { sources: { dingtalk: { allowed: [{ id: PEER, name: 'Alice' }] } } },
    sources: { dingtalk: { enabled: true, config: { directMessages: true, chats: [{ conversationId: GROUP }] } } } })
  const registry = new SourceRegistry(() => settings)
  registry.register(dingtalkKind)
  const policy = settingsPolicy(settings, registry)
  const trigger = (sender: string, overrides: Partial<Trigger> = {}): Trigger =>
    ({ ...dingtalkTrigger(event('mid_1', { sender_open_dingtalk_id: sender }), SELF, threads())!, ...overrides })
  const thread = { key: `dingtalk:${CONVERSATION}:mid_1`, ref: { source: SOURCE, id: `${CONVERSATION}:mid_1` }, createdAt: '',
    subscriptions: [], correlated: [], pending: [], meta: {} }
  it('admits a listed sender\'s direct message as an explicit request', () => {
    expect(policy.gate(trigger(PEER), thread, [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { via: 'addressed', source: SOURCE, sender: 'Alice', addressed: 'direct' } })
  })
  it('refuses a sender who is not on the allowed list, even though the Source heard the message', () => {
    expect(policy.gate(trigger('Oo_stranger_000000000000000000000'), thread, [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('listens to a configured group and to direct messages, and to an unlisted group only while other chats are received', () => {
    expect(registry.scope({ source: SOURCE, meta: { conversationId: CONVERSATION, direct: true } }))
      .toEqual({ listened: true, observed: false, row: 'direct' })
    expect(registry.scope({ source: SOURCE, meta: { conversationId: GROUP, direct: false } }))
      .toEqual({ listened: true, observed: false, row: GROUP })
    expect(registry.scope({ source: SOURCE, meta: { conversationId: 'cid_other', direct: false } }))
      .toEqual({ listened: true, observed: false, row: 'other' })
    const quiet = new SourceRegistry(() => SettingsSchema.parse({ sources: { dingtalk: { enabled: true,
      config: { otherChats: 'none', chats: [] } } } }))
    quiet.register(dingtalkKind)
    expect(quiet.scope({ source: SOURCE, meta: { conversationId: 'cid_other', direct: false } }))
      .toEqual({ listened: false, reason: 'chat_not_allowed' })
  })
  it('sends no reply once the chat is no longer received', () => {
    const config = dingtalkKind.schema.parse({ chats: [], directMessages: false })
    expect(dingtalkKind.channel!.allowed!({ conversationId: CONVERSATION, direct: 'true' }, config)).toBe(false)
  })
})

describe('dingtalk reads', () => {
  const trigger = dingtalkTrigger(event('mid_2', { type: 'user_im_message_receive_at', conversation_id: GROUP }), SELF, threads())!
  it('reads the episode before and after the Trigger as one ascending page', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const dws = vi.spyOn(commands, 'dws').mockImplementation(async args => args.includes('older')
      ? { messages: [{ openMessageId: 'mid_1', text: 'before', sender: 'Bob', createTime: '2026-11-02 09:59:00' }] }
      : { messages: [{ openMessageId: 'mid_3', text: 'after', sender: 'Bob', createTime: '2026-11-02 10:01:00' }] })
    const part = await dingtalkThreadContext.read(commands, trigger, 'thread', undefined, { readPageSize: 20 })
    expect(part.messages.map(message => message.text)).toEqual(['before', 'after'])
    expect(dws.mock.calls.map(([args]) => [args[3], args[8], args[10]])).toEqual([['--conversation-id', 'older', '20'], ['--conversation-id', 'newer', '20']])
  })
  it('reads a direct chat by its peer, and returns nothing for a root the episode does not hold', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const direct = dingtalkTrigger(event('mid_1'), SELF, threads())!
    const dws = vi.spyOn(commands, 'dws').mockResolvedValue({ messages: [] })
    expect(await dingtalkThreadContext.read(commands, direct, 'root', undefined, { readPageSize: 5 }))
      .toMatchObject({ messages: [], status: 'unavailable' })
    expect((dws.mock.calls[0]![0] as string[])[3]).toBe('--open-dingtalk-id')
    await expect(dingtalkThreadContext.read(commands, { ...direct, meta: {} }, 'thread', undefined, { readPageSize: 5 }))
      .rejects.toThrow('A DingTalk source trigger is required')
  })
})

describe('dingtalk loops', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-consumer-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  /** A dws CLI whose `event consume` reports ready and then prints the events in `${dir}/events`. */
  function cli(): string {
    const path = join(dir, 'dws')
    writeFileSync(path, `#!/bin/sh
  [ "$1" = event ] || { echo '{"ok":true,"data":{}}'; exit 0; }
  echo $$ > '${dir}/pid'
  echo '[event] ready event_count=2 bus_pid=1' >&2
  cat '${dir}/events'
  exec sleep 60
  `, { mode: 0o755 })
    return path
  }
  function source(path: string, config: Record<string, unknown> = { chats: [] }) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { dingtalk: { enabled: true, config } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(dingtalkKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
    // The account resolves only through setup; the fixture stands in for the resolved DingTalk account.
    const deployment = testDeployment({ dingtalk: { cli: path, openDingtalkId: SELF, userId: '1', name: 'Me', corpId: 'ding1' } })
    const commands = new Commands(() => deployment, {}, controller.signal)
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(),
      configured: () => true, problems: [], receive: (trigger: Trigger) => engine.receive(trigger) }
    return { ctx: sourceContextOf(deps, dingtalkKind), health: board.all, store }
  }
  it('takes in the events it reads, keeps each conversation, and reports the consumer ready', async () => {
    writeFileSync(join(dir, 'events'), [event('mid_1'), event('mid_2', { conversation_id: GROUP, type: 'user_im_message_receive_at' })].map(item => JSON.stringify(item)).join('\n') + '\n')
    const { ctx, health, store } = source(cli())
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(dingtalkTriggerId('mid_2'))).toBeDefined(), until)
    expect(health.dingtalk).toMatchObject({ state: 'ready', detail: 'Listening for direct and group messages' })
    expect(store.get(KV.dingtalk.chats)).toMatchObject({ [CONVERSATION]: { peerOpenId: PEER, direct: true },
      [GROUP]: { peerOpenId: PEER, direct: false } })
    // The second message continues the first one's episode, in its own conversation thread.
    expect(store.triggers.get(dingtalkTriggerId('mid_2'))!.threads[0]!.id).toBe(`${GROUP}:mid_2`)
    controller.abort(); await running
    // Stopping closes stdin and sends SIGTERM, so nothing keeps the CLI's event bus open.
    expect(existsSync(join(dir, 'pid'))).toBe(true)
    store.close()
  }, 20_000)
  it('recovers a message the consumer missed with the same Trigger the live path gives it', async () => {
    writeFileSync(join(dir, 'events'), event('mid_1').content + '\n')
    const { ctx, store } = source(cli())
    const dws = vi.spyOn(Commands.prototype, 'dws').mockImplementation(async args => args[0] === 'chat'
      ? { messages: [{ openMessageId: 'mid_7', text: 'missed this', sender: 'Alice', senderOpenDingTalkId: PEER,
        createTime: '2026-11-02 10:00:00' }] }
      : {})
    store.set(KV.dingtalk.chats, { [CONVERSATION]: { peerOpenId: PEER, direct: true, name: 'Alice' } })
    store.set(KV.dingtalk.history(CONVERSATION), '2026-11-02T01:59:00.000Z')
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(dingtalkTriggerId('mid_7'))).toBeDefined(), until)
    const recovered = store.triggers.get(dingtalkTriggerId('mid_7'))!
    expect(recovered).toMatchObject({ source: SOURCE, text: 'missed this', addressed: 'direct' })
    expect(dws.mock.calls.map(([args]) => args).find(args => Array.isArray(args) && args[0] === 'chat'))
      .toEqual(['chat', 'message', 'list', '--open-dingtalk-id', PEER, '--time', '2026-11-02 09:59:00', '--direction', 'newer',
        '--page-all', '--max-items', '200', '--format', 'json'])
    controller.abort(); await running
    store.close()
  }, 20_000)
  it('reports history as paused while the DingTalk account is unset, and starts no consumer', async () => {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { dingtalk: { enabled: true, config: { chats: [] } } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(dingtalkKind)
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
      assessor: { request: vi.fn(async () => {}) }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() } as unknown as Executor,
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands: new Commands(() => testDeployment(), {}, controller.signal),
      sources, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, problems: [],
      receive: (trigger: Trigger) => engine.receive(trigger) }
    await runDingtalk(sourceContextOf(deps, dingtalkKind), controller.signal)
    expect(board.all.dingtalk).toMatchObject({ state: 'paused', code: 'dingtalkCliUnset' })
    expect(board.all.history).toMatchObject({ state: 'paused' })
    store.close()
  })
  it('backs off a consumer that keeps exiting and waits a minute before its first retry', async () => {
    const { consumerRetry } = await import('../src/sources/dingtalk-loops.ts')
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 0)).toBe(2000)
    expect(consumerRetry(32_000, 0)).toBe(60_000)
    // A run that stayed up for a minute restarts at once: it was not the CLI failing to start.
    expect(consumerRetry(32_000, 60_000)).toBe(1000)
  })
})

describe('dingtalk threads kept for recovery', () => {
  it('names the thread after the conversation and the episode, across a restart', () => {
    const state = threads()
    dingtalkTrigger(event('mid_1'), SELF, state)
    dingtalkTrigger(event('mid_2', { timestamp: Date.parse('2026-11-02T02:01:00Z') }), SELF, state)
    // The same conversation asked again after a restart still yields the stored episode's thread.
    expect(threadKey({ source: SOURCE, id: state.episodes.get(CONVERSATION)!.rootId })).toBe(`dingtalk:mid_1`)
  })
})
