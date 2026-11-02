/** DingTalk background loops: the live event consumer and the history backfill that reconciles missed messages. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { DingtalkAccount } from '../deployment.ts'
import { dingtalkThreadId, dingtalkTrigger, historyEvent, historyMessages, HistoricalMessageSchema, localTime, SOURCE,
  type DingtalkEvent, type DingtalkThreads } from './dingtalk-trigger.ts'
import { health, type SourceContext } from './host.ts'
import type { DingtalkConfig } from './dingtalk.ts'
import { cursorAt } from './poll.ts'

export const runDingtalk = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop].map(loop => loop(ctx, signal)))
const enabled = (ctx: SourceContext): DingtalkConfig | undefined => ctx.config<DingtalkConfig>(SOURCE)
const account = (ctx: SourceContext): DingtalkAccount => {
  const resolved = ctx.deployment.dingtalk
  if (!resolved) throw new Error('The DingTalk Source has no working account CLI')
  return resolved
}
/** A conversation this Source knows: the other person of a direct chat, and whether a direct chat it is. */
interface KnownChat { peerOpenId: string; direct: boolean; name: string }
/** The episodes and quote roots the Source keeps in KV, so a restart continues each conversation's thread. */
function threadsOf(ctx: SourceContext): DingtalkThreads {
  return {
    root: (conversationId, messageId) => ctx.state.get(KV.dingtalk.roots(conversationId))?.[messageId],
    episode: conversationId => ctx.state.get(KV.dingtalk.episodes(conversationId)),
    peer: conversationId => ctx.state.get(KV.dingtalk.chats)?.[conversationId]?.peerOpenId,
    remember: (conversationId, messageId, rootId, at) => {
      ctx.atomic(() => {
        const rootKey = KV.dingtalk.roots(conversationId)
        ctx.state.set(rootKey, { ...ctx.state.get(rootKey), [messageId]: rootId })
        ctx.state.set(KV.dingtalk.episodes(conversationId), { rootId, lastAt: at })
      })
    },
  }
}
/** Records the conversation and the people in it, so the history loop and a message the operator typed can find its peer. */
function rememberChat(ctx: SourceContext, step: DingtalkEvent): void {
  const direct = step.type === 'user_im_message_receive_o2o_all'
  const self = account(ctx).openDingtalkId === step.sender_open_dingtalk_id
  const chats = { ...ctx.state.get(KV.dingtalk.chats) }
  const known = chats[step.conversation_id]
  // The agent's own message names nobody else in a direct chat, so the known peer stays.
  const peerOpenId = self ? known?.peerOpenId ?? '' : step.sender_open_dingtalk_id
  chats[step.conversation_id] = { peerOpenId, direct, name: self ? known?.name ?? '' : step.sender || known?.name || '' }
  ctx.state.set(KV.dingtalk.chats, chats)
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const conversationId = String(trigger.meta.conversationId ?? '')
  if (!conversationId) return
  const name = ctx.state.get(KV.dingtalk.chats)?.[conversationId]?.name || conversationId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
}
function available(ctx: SourceContext): boolean {
  const resolved = ctx.deployment.dingtalk
  if (ctx.configured() && resolved && (resolved.openDingtalkId)) return true
  const waiting = health('paused', ctx.configured() ? 'dingtalkCliUnset' : 'setupPending')
  ctx.report('dingtalk', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the account; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('dingtalk', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report('dingtalk', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
/**
 * Consumes direct and group events until the signal aborts. `dws` stops on a closed stdin and a terminating signal, and a killed
 * consumer leaves nothing behind, so neither the stream nor the history cursor is advanced by a hard kill. The loop never sends
 * `SIGKILL`: the CLI's event bus would keep its subscription open.
 */
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const child = spawn(account(ctx).cli, ['event', 'consume', 'user_im_message_receive_o2o_all',
    'user_im_message_receive_at', '--flatten', '--ephemeral'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'DingTalk event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      ctx.report('dingtalk', { state: 'ready', detail: 'Listening for direct and group messages', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report('dingtalk', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('DingTalk event exceeds 1 MiB')
      const step = JSON.parse(line) as DingtalkEvent
      // Events already read when the Source is disabled are dropped; the consumer stops shortly after.
      if (!enabled(ctx)) return
      rememberChat(ctx, step)
      const trigger = dingtalkTrigger(step, account(ctx).openDingtalkId, threadsOf(ctx))
      if (trigger) await receive(ctx, trigger)
    }).catch(error => { ctx.report('dingtalk', { state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`DingTalk event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/**
 * Reconciles each known conversation every minute with `chat message list --direction newer`, from the time the previous round
 * started, so a message the consumer missed (a restart, a dropped event) still becomes a Trigger with the same ID the live path
 * would give it, and the Engine answers `duplicate` for the ones both paths read.
 */
async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('history', health('paused', 'dingtalkCliUnset')); return }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    const known = ctx.state.get(KV.dingtalk.chats) ?? {}
    const chats: Record<string, KnownChat> = { ...known }
    for (const chat of config.chats) chats[chat.conversationId] ??= { peerOpenId: '', direct: false, name: chat.name ?? '' }
    const errors: string[] = []
    for (const [conversationId, chat] of Object.entries(chats)) {
      if (signal.aborted) break
      if (chat.direct && !config.directMessages && !known[conversationId]) continue
      const started = new Date().toISOString()
      const cursorKey = KV.dingtalk.history(conversationId)
      const since = ctx.state.get(cursorKey)
      // The first round only records where to start; it reads nothing, so a new install does not replay old messages.
      if (since === undefined) { ctx.state.set(cursorKey, started); continue }
      try {
        await backfillChat(ctx, config, conversationId, chat, since, signal)
        if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      } catch (error) { if (!signal.aborted) errors.push(`${conversationId}: ${String(error)}`) }
    }
    if (!signal.aborted) ctx.report('history', errors.length
      ? { state: 'error', detail: errors.join('\n') }
      : { state: 'ready', detail: 'Known conversations reconciled', at: new Date().toISOString() })
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/** Reads the messages posted since `since` in one conversation and receives each as a Trigger, oldest first. */
export async function backfillChat(ctx: SourceContext, config: DingtalkConfig, conversationId: string,
  chat: KnownChat, since: string, signal: AbortSignal): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  // `--time` takes Shanghai local time, and both the peer and the conversation address one chat.
  const args = ['chat', 'message', 'list', ...(chat.direct && chat.peerOpenId ? ['--open-dingtalk-id', chat.peerOpenId]
    : ['--conversation-id', conversationId]), '--time', localTime(since), '--direction', 'newer', '--page-all',
  '--max-items', '200', '--format', 'json']
  const page = await commands.dws<unknown>(args)
  const threads = threadsOf(ctx)
  for (const item of historyMessages(page)) {
    if (signal.aborted) throw signal.reason
    const parsed = HistoricalMessageSchema.safeParse(item)
    if (!parsed.success) continue
    const step = historyEvent(parsed.data, conversationId, chat.direct)
    const trigger = dingtalkTrigger(step, account(ctx).openDingtalkId, threads)
    if (!trigger) continue
    // A listed group message names no mention; admit it only where the Source listens to the whole chat.
    if (!chat.direct && !config.chats.some(entry => entry.conversationId === conversationId)) continue
    await receive(ctx, trigger)
  }
}
