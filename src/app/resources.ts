/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import { UserError, key, latestReport, reached, reportHistory, runningAssignment, threadKey, type Ticket, type Trigger, type WorkerRecord }
  from '../core/index.ts'
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { readGithub } from '../sources/github-read.ts'
import { feishuReferences, feishuRead } from '../sources/feishu-read.ts'
import { feishuRef } from '../sources/feishu.ts'
import { feishuTriggerId } from '../sources/feishu-trigger.ts'
import { DINGTALK, displayName, type NamedSender } from '../sources/dingtalk-names.ts'
import type { ContextMessage } from '../sources/kind.ts'
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.ts'
import { threadTitle } from './views/records.ts'
import { deskLine } from './desk.ts'
import { transcriptEntry } from './context.ts'
import { builtInParts, defaultPrompts } from './prompts.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Commands } from '../infra/commands.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Sessions } from './sessions.ts'
import type { Settings } from './settings.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { TriggerContext } from '../sources/kind.ts'

/** Resource descriptors exposed via orchestrator_read, marking which resources worker sessions may also read for their own ticket. */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: 'tickets', holds: 'ticket cards, newest first; a card\'s state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended' },
  { name: 'desk', holds: 'open tickets, one line each: its state, when it last showed life, whether it is overdue or unreviewed, and its last report' },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  { name: 'threads', holds: 'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors' },
  {
    name: 'lanes',
    holds: 'every lane with activity, newest first: one per conversation, Issue, or other Source thread, whether or not a ticket '
      + 'subscribes to it; each with its label, its tickets and when it last saw a message',
  },
  {
    name: 'lane/<key>',
    holds: 'one lane whatever its Source: its label and link, its tickets and latest decisions, and its messages, newest first. '
      + 'Main Session only, so it may read across conversations; a worker reads its own threads.',
  },
  { name: 'thread/<key>', holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first', executor: true },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  { name: 'ticket/<id>', holds: 'a ticket\'s card, the trigger, decision and threads it is tied to, its latest assignments with the start of each '
    + 'report, and its inputs, newest first', executor: true },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  { name: 'ticket/<id>/assignments', holds: 'its assignments, newest first, with the start of each report', executor: true },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  { name: 'ticket/<id>/retry/<id>', holds: 'the upstream error of an assignment that is retrying, whole, and when it tries again', executor: true },
  { name: 'ticket/<id>/worker/<index>', holds: 'what one earlier worker generation found: assignments, reports, last turns', executor: true },
  { name: 'ticket/<id>/transcript', holds: 'its Executor Session\'s messages, newest first', executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  { name: 'trigger/<id>', holds: 'a trigger\'s text, where it went, the message it replies to, the messages around it on its thread and its live history',
    executor: true },
  { name: 'settings', holds: 'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source '
    + 'instances summarized' },
  { name: 'settings/<block>', holds: "one settings block whole, as the panel's settings save takes it: policy, eval, executor, pause or "
    + 'source:<id>' },
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  { name: 'prompts/<revision>', holds: 'one prompt version by number, or current, the one the Session works under', executor: true },
  { name: 'prompts/defaults', holds: 'the built-in prompt configuration, and the built-in parts by the key an override names' },
  { name: 'prompt-preview/<id>', holds: "a composed prompt the panel's prompt preview rendered" },
  { name: 'models', holds: 'model providers, the DSH default and each role\'s model' },
  { name: 'models/<provider>', holds: 'one provider\'s models' },
  { name: 'feishu/<trigger-id>/…', holds: 'a Feishu original, as the dsh-superagent-feishu skill describes', executor: true },
  { name: 'github/…', holds: 'a GitHub original, as the dsh-superagent-github skill describes', executor: true },
]
export const resourceGrammar = (executor: boolean): string => RESOURCES.filter(resource => !executor || resource.executor)
  .map(resource => `${resource.name}: ${resource.holds}`).join('; ')

export interface ResourceHost {
  readonly store: Pick<Store, 'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  readonly pages: TextCache
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  readonly commands: Commands
  readonly masterId: string
  readonly context: Context
  promptVersion(sessionId: string): PromptVersion
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  mayRead(sessionId: string, revision: number): boolean
  feishuPageSize(): number
  /** Resolves DingTalk sender nicks to directory contacts (flower name, open DingTalk ID, whether each is the operator himself), cached in the store. */
  dingtalkNames(nicks: readonly string[]): Promise<Map<string, NamedSender>>
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Reader of the conversation `trigger` was written in, or undefined when its Source keeps none. */
  threadContext(trigger: Trigger): TriggerContext | undefined
}
export interface MainResourceHost extends ResourceHost {
  readonly sessions: Pick<Sessions, 'status' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block'>
}
interface Read {
  host: ResourceHost; resource: string; rest: string; offset: number; limit?: number
  sessionId: string; ticketId?: string; signal?: AbortSignal
}
type Route = readonly [name: string, read: (read: Read) => unknown]

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('This resource belongs to the main Session')
  return host as MainResourceHost
}
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined) throw new Error(`Read this ${source === 'feishu' ? 'Feishu' : 'GitHub'} resource from offset 0 first`)
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}
const THREAD_DECISIONS = 5
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })
async function transcript(host: ResourceHost, ticketId: string) {
  return (await host.context.sessionController.inspect(workerSessionId(ticketId) as SessionId)).events
}
/** How many characters of a generation's transcript one read renders; the rest is paged with `offset`. */
const WORKER_CHARS = 24_000
/**
 * Renders one worker generation's Session as a summary a fresh generation reads instead of its whole history: what it worked on,
 * what it reported, and the turns it took. A Session this installation no longer has renders the record's own facts.
 */
async function workerTranscript(host: ResourceHost, ticket: Pick<Ticket, 'id' | 'assignments'>, index: number,
  record: WorkerRecord): Promise<string> {
  const assignments = ticket.assignments.filter(item => item.worker === index)
  const facts = [`worker generation ${index}, kept from ${record.from}`
    + (record.closed ? `, closed as ${record.closed} at ${record.closedAt}` : ', still the active generation')
    + `; it served ${assignments.length} assignment(s)`]
  for (const assignment of assignments) {
    const report = reportHistory(assignment).at(-1)
    facts.push(`- assignment ${assignment.id.slice(0, 8)} ${assignment.state}${report ? `, reported ${report.state}: ${preview(report.summary)}` : ''}`)
  }
  try {
    const events = (await host.context.sessionController.inspect(workerSessionId(ticket.id, index) as SessionId)).events
    const turns = events.flatMap((event, position) => event.type === 'assistant/message' && event.data.message.content
      ? [{ at: event.time, said: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(' '), position }] : [])
    const recent = turns.slice(-12)
    const lines = recent.map(turn => `${stamp(new Date(turn.at).toISOString())} ${turn.said.slice(0, 600) || '[no text]'}`)
    return `${facts.join('\n')}\n\nlast ${recent.length} of ${turns.length} assistant messages:\n${lines.join('\n')}`
      .slice(0, WORKER_CHARS)
  } catch {
    return facts.join('\n')
  }
}

/** How many messages before a trigger its live history shows at least, and how much of each. */
const HISTORY = 30, HISTORY_CAP = 100, HISTORY_CHARS = 400
/** A message body that names an attachment by the IDs `dws` prints in it, which the header's download commands take. */
const ATTACHMENT = /mediaId=|fileId[:：]/
/** `MM-dd HH:mm` in the local timezone, as a transcript line's timestamp reads. */
const stamp = (iso: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso))
  const of = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${of('month')}-${of('day')} ${of('hour')}:${of('minute')}`
}
/**
 * Renders a DingTalk conversation's history as one text block the model reads like a chat log: a header saying whose conversation
 * this is (【我方】 marks the operator himself), the dws commands that page earlier messages and fetch attachments, an omitted
 * marker when older messages were cut, then one line per message as 花名（真名）（时间） 正文. Senders the directory did not
 * resolve keep the nick the message itself showed.
 */
async function dingtalkTranscript({ host, sessionId, signal }: Read, found: Trigger,
  messages: readonly ContextMessage[], omitted = messages.length >= HISTORY): Promise<{ transcript: string }> {
  const contacts = await host.dingtalkNames(messages.map(message => message.from))
  const nameOf = (nick: string) => {
    const contact = contacts.get(nick)
    return contact ? displayName(contact) : nick
  }
  const sides = [...contacts.values()]
  const mine = sides.filter(contact => contact.self).map(displayName)
  const theirs = [...new Set(messages.map(message => message.from))]
    .filter(nick => contacts.get(nick)?.self !== true).map(nameOf)
  const conversation = typeof found.meta.conversationId === 'string' ? found.meta.conversationId : ''
  const chatName = host.store.get(KV.dingtalk.chats)?.[conversation]?.name
  const who = found.meta.direct === true
    ? `这是${mine[0] ?? '运营者本人'}【我方】与${theirs.join('、') || '对方'}【对方】的私聊`
    : `这是群聊${chatName ? `「${chatName}」` : ''}的部分记录，${mine[0] ? `${mine[0]}为【我方】，` : ''}其余为群成员`
  const header = `仅显示部分聊天记录：${who}（【我方】=运营者本人；名字为 花名（真名））。`
    + `更早的记录用 dws chat message list --open-dingtalk-id <对方ID> --time "<时间>" --direction older 查看；`
    + `图片/视频/语音用 dws chat message download-media --type mediaId --resource-id <mediaId> --message-id <openMessageId> --open-conversation-id <会话ID> --output <路径> 下载（mediaId 在正文里，openMessageId 在附件标注里）；文件附件的 fileId 用 dws 钉盘命令获取。`
    + (conversation ? `本会话ID：${conversation}` : '')
  const lines = messages.map(message => {
    const text = message.text.slice(0, HISTORY_CHARS).replace(/\]\(mediaId=/g, ' mediaId=')
    const attachment = ATTACHMENT.test(message.text) ? ` [附件：openMessageId=${message.id}]` : ''
    return `${nameOf(message.from)}（${stamp(message.at)}）${text}${attachment}`
  })
  const transcript = [header, ...(omitted ? ['<previous chat message omitted>'] : []), ...lines].join('\n')
  host.pages.set(`${sessionId}:history:${found.id}`, JSON.stringify({ transcript }))
  return { transcript }
}
/**
 * The latest messages of the conversation a trigger was written in, read live from its Source: the store holds only what arrived
 * after subscription, so the first direct message of a conversation has no neighbours there. A failed read is reported in place of
 * the history instead of failing the whole resource, and is not cached, so the next read tries again.
 */
async function liveHistory(read: Read, found: Trigger) {
  const { host, sessionId, signal } = read
  const context = host.threadContext(found)
  // An issue tracker's thread is its own history; only a conversation of people needs one read live.
  if (!context?.chat) return undefined
  const cacheKey = `${sessionId}:history:${found.id}`
  const cached = host.pages.get(cacheKey)
  if (cached !== undefined) return JSON.parse(cached)
  try {
    const anchor = historyAnchor(host, found)
    const messages = await pages(read, found, anchor)
    const triggered = Date.parse(found.at)
    // The reader's page also holds the trigger itself and what came after it; the window ends at the trigger.
    const before = messages.filter(message => !message.deleted && message.id !== context.messageId && !(Date.parse(message.at) > triggered))
    const history = windowOf(before, anchor)
    // A DingTalk conversation renders as a chat log the header above describes; other Sources keep their message list.
    if (found.source === DINGTALK) return await dingtalkTranscript(read, found, history, messages.length > history.length)
    const listed = history.map(({ id, from, at, text }) => ({ id, from, at, text: text.slice(0, HISTORY_CHARS) }))
    host.pages.set(cacheKey, JSON.stringify(listed))
    return listed
  } catch (error) {
    return { status: 'unavailable', error: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200) }
  }
}
/** What the window must reach back to, and how far it may go. */
interface HistoryAnchor { since?: string; floor: number; cap: number }
/**
 * The lane's window rules: at least `HISTORY` messages, extended back to the last decision on the lane and to the origin
 * message of every open ticket on it, so each live intent starts inside the window; never past `HISTORY_CAP`. A day boundary
 * is not an anchor: it would cut work open across it, as an episode gap once did.
 */
function historyAnchor(host: ResourceHost, found: Trigger): HistoryAnchor {
  const lane = threadKey(found.threads[0]!)
  const { store } = host
  const origins = store.tickets.open()
    .filter(ticket => ticket.origin.triggerIds.some(id => store.triggers.get(id)?.threads.some(ref => threadKey(ref) === lane)))
    .flatMap(ticket => ticket.origin.triggerIds.flatMap(id => store.triggers.get(id)?.at ?? []))
  const since = [store.decisions.byThread(lane).at(-1)?.at, ...origins].filter((at): at is string => !!at).sort()[0]
  return { ...(since ? { since } : {}), floor: HISTORY, cap: HISTORY_CAP }
}
/** Reads backwards until the window can stop: past its anchor with at least its floor, at its cap, or at the history's start. */
async function pages(read: Read, found: Trigger, anchor: HistoryAnchor): Promise<ContextMessage[]> {
  const context = read.host.threadContext(found)
  if (!context) return []
  const commands = read.host.commands.withSignal(read.signal)
  const seen = new Map<string, ContextMessage>()
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const part = await context.read(commands, 'thread', cursor)
    for (const message of part.messages) seen.set(message.id, message)
    const oldest = [...seen.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))[0]
    const reached = seen.size >= anchor.floor && (!anchor.since || (!!oldest && oldest.at <= anchor.since))
    if (!part.next || reached || seen.size >= anchor.cap) break
    cursor = part.next
  }
  return [...seen.values()]
}
/** The newest messages within the window: back to its anchor, never fewer than its floor or more than its cap. */
function windowOf(messages: readonly ContextMessage[], anchor: HistoryAnchor): ContextMessage[] {
  const ascending = [...messages].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const floor = ascending.slice(-anchor.floor)
  const anchorIndex = anchor.since ? ascending.findIndex(message => message.at >= anchor.since!) : -1
  const from = anchorIndex < 0 ? floor : ascending.slice(anchorIndex)
  return from.slice(-anchor.cap)
}

const ROUTES: readonly Route[] = [
  ['tickets', read => {
    const host = main(read), tickets = host.store.tickets.list()
    const card = (ticket: Ticket) => ({ ...ticketCard(ticket), ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)) })
    return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card))
  }],
  ['desk', read => {
    const { store } = main(read), now = new Date().toISOString(), reviewing = store.settings().executor.reviews
    return { items: store.tickets.open().map(ticket => deskLine(ticket, now, reviewing)), next_offset: null }
  }],
  ['triggers', read => {
    const { store } = main(read)
    return list(read, (offset, count) => store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))))
  }],
  ['threads', read => {
    const { store } = main(read)
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    return list(read, (offset, count) => threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))))
  }],
  ['lanes', read => {
    const { store } = main(read), now = Date.now()
    return list(read, (offset, count) => store.read.lanes(offset + count).slice(offset, offset + count).map(thread => ({
      lane: thread.key, source: thread.ref.source, label: threadTitle(store, thread),
      ...(thread.lastAt ? { last_at: thread.lastAt, minutes_ago: Math.max(0, Math.floor((now - Date.parse(thread.lastAt)) / 60_000)) } : {}),
      tickets: thread.subscriptions.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [{ ticket_id: ticket.id, title: ticket.title,
        state: ticketCard(ticket).state }] : [] }),
      pending: thread.pending.length, evaluating: !!thread.evaluating, read: `lane/${thread.key}`,
    })))
  }],
  ['lane/', read => {
    const { host, rest } = read
    main(read)
    const thread = host.store.threads.get(rest)
    if (!thread) throw new Error('Unknown lane')
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    return { ...card, tickets, decisions, ...page }
  }],
  ['thread/', read => {
    const { host, rest, ticketId } = read
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // Worker Sessions may only read threads their own ticket subscribes to or follows.
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Unknown or inaccessible thread')
    }
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    // Worker sessions cannot inspect other tickets or decisions on a shared thread.
    if (ticketId) return { ...card, ...page }
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }],
  ['decisions', read => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard))],
  ['decision/', read => {
    const decision = main(read).store.decisions.get(read.rest)
    if (!decision) throw new Error('Unknown decision')
    return decisionDetails(decision)
  }],
  ['settings', read => main(read).settings.view()],
  ['settings/', read => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  ['prompts', read => {
    const host = main(read), current = host.prompts.current(), status = host.sessions.status()
    const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name)
    // The built-in parts whose text changed since the team overrode them, and those this version no longer has, which the
    // panel shows and the next save drops.
    const changes = host.prompts.defaultChanged(current.config)
    const changed = changes.filter(item => !item.removed).map(item => item.part)
    const removed = changes.filter(item => item.removed).map(item => item.part)
    return { revision: status.revision, read: `prompts/${current.revision}`, notification_pending: status.notificationPending,
      ...changed.length ? { default_changed: changed } : {}, ...removed.length ? { removed_parts: removed } : {},
      sessions: status.sessions.map(session => ({ session_id: session.sessionId, revision: session.revision })),
      skills: { built_in: skills.filter(name => !(name in current.config.skills)).map(name => `dsh-superagent-${name}`),
        team: Object.keys(current.config.skills).map(name => `dsh-superagent-${name}`) },
      items: history.revisions.map(({ previousRevision, savedAt, ...version }) =>
        ({ ...version, previous_revision: previousRevision, saved_at: savedAt })),
      next_offset: history.next_offset }
  }],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  ['prompts/', read => {
    const { host, resource, rest, sessionId, ticketId } = read
    const prompts = host.prompts
    const bound = host.promptVersion(sessionId)
    const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    const version = rest === 'current' ? bound : rest === 'defaults' && !ticketId ? { revision: 0, config: defaultPrompts(), parts: parts() }
      : /^\d+$/.test(rest) ? (Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest))) : undefined
    if (!version || (ticketId && !host.mayRead(sessionId, version.revision))) throw new Error('Unknown or inaccessible prompt version')
    return text({ ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource }, JSON.stringify(version))
  }],
  ['prompt-preview/', read => {
    const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
    if (body === undefined) throw new Error('Unknown preview for this Session')
    return text(read, body)
  }],
  ['models', async read => {
    const host = main(read), catalog = await host.context.sessionController.modelCatalog(), settings = host.store.settings()
    const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
    return { default: catalog.default, roles, failures: catalog.failures,
      providers: catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length, read: `models/${group.id}` })) }
  }],
  ['models/', async read => {
    const models = (await main(read).context.sessionController.modelCatalog()).groups.find(group => group.id === read.rest)?.models
    if (!models) throw new Error('Unknown model provider')
    return list(read, (offset, count) => models.slice(offset, offset + count))
  }],
  ['feishu/', async read => {
    const source = trigger(read.host, read.rest.split('/')[0]!, read.ticketId)
    const ref = feishuRef(source)
    if (!ref) throw new Error('A Feishu source trigger is required')
    const commands = read.host.commands.withSignal(read.signal)
    return sourcePage(read, 'feishu', () => feishuRead(commands, ref, read.resource, read.host.feishuPageSize()))
  }],
  ['github/', read => sourcePage(read, 'github', () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    if (!rest || rest.includes('/')) throw new Error('Unknown context resource')
    const found = trigger(host, rest, ticketId)
    const ref = feishuRef(found)
    // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const shown = (item: Trigger | undefined) => item && (!ticket || readable(host, ticket, item)) ? item : undefined
    const disposition = host.store.triggers.disposition(found.id)
    const visible = disposition && ticket ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id) }
      : disposition
    // Omit card preview and self-reference because this resource returns the full text.
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    // A DingTalk trigger names its conversation, which the history header's attachment commands take.
    const conversation = found.source === DINGTALK && typeof found.meta.conversationId === 'string' ? { conversation_id: found.meta.conversationId } : {}
    const parent = found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
    const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    // Only the main Session reads the live conversation: a worker may not see messages its ticket did not reach.
    const history = offset === 0 && !ticketId ? await liveHistory(read, found) : undefined
    return { ...card, ...conversation, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(ref ? { context: feishuReferences(ref) } : {}),
      ...(offset === 0 ? {
        ...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
        ...history !== undefined ? { history } : {},
        around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} },
      } : {}),
      ...text(read, found.text) }
  }],
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('Unknown context resource')
    if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    if (section === undefined) {
      const running = runningAssignment(ticket) && workerSessionId(ticket.id)
      const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
      // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      const marked = (key: string, context: boolean): TicketThread =>
        ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      const threads = [...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false))]
      return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry }
    }
    if (section === 'assignments' || section === 'inputs') {
      if (part !== undefined) throw new Error('Unknown context resource')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    let body: string
    if (section === 'input' && part) {
      // Render the input on demand with its resolved source link, matching either its short key or full input ID.
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      const trigger = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      const card = trigger && input?.kind === 'trigger' ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note) : undefined
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('Unknown ticket input')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      const event = (await transcript(host, id))[Number(part)]
      const entry = event && transcriptEntry(event)
      if (!entry) throw new Error('Unknown transcript entry')
      body = JSON.stringify(entry)
    } else if (section === 'report' && part) {
      const assignment = ticket.assignments.find(item => item.id === part)
      const report = assignment?.report
      if (!assignment || !report) throw new Error('Unknown assignment report')
      // The ledger's last entry carries what a ready report showed; the mirror `report` keeps only its summary.
      const evidence = reportHistory(assignment).at(-1)?.evidence
      body = evidence?.length ? `${report.summary}\n\nEvidence:\n${evidence.map(item => `- ${item.what}: ${item.result}`).join('\n')}` : report.summary
    } else if (section === 'retry' && part) {
      // The upstream's own words, whole: a truncated provider error is what made an outage look like a stuck ticket.
      const assignment = ticket.assignments.find(item => item.id === part)
      if (!assignment?.retry) throw new Error('Unknown assignment retry')
      const { attempts, at, nextAt, backoffMs, error } = assignment.retry
      body = `attempt ${attempts} at ${at}, next in ${Math.round(backoffMs / 1000)}s (${nextAt})\n\n${error}`
    } else if (section === 'worker' && part) {
      // What one worker generation found, as its own Session recorded it. A fresh generation reads the work before it here
      // instead of carrying that Session's whole history, which is exactly what grew past what a single read needs.
      const index = Number(part)
      const record = ticket.workers?.find(item => item.index === index)
      if (!record || !Number.isInteger(index)) throw new Error('Unknown worker generation')
      body = await workerTranscript(host, ticket, index, record)
    } else if (section === 'worker') throw new Error('A worker generation needs its index: ticket/<id>/worker/<index>')
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      body = (await transcript(host, id)).flatMap((event, index) => {
        const entry = transcriptEntry(event)
        const said = entry?.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ') ?? ''
        return entry ? [{ type: entry.type, preview: preview(said).slice(0, 80), chars: JSON.stringify(entry).length,
          read: `ticket/${id}/message/${index}` }] : []
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('Unknown context resource')
    return text(read, body)
  }],
]

/**
 * Read a paginated resource for an orchestrator Session (`reader.sessionId`, the main Session by default) or a ticket's worker Session (`reader.ticketId`).
 * Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
 */
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined,
  reader: { ticketId?: string; sessionId?: string } = {}, signal?: AbortSignal) {
  const { ticketId } = reader
  const name = resource.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')
  const route = ROUTES.find(([route]) => route.endsWith('/') ? name.startsWith(route) : name === route)
  if (!route) throw new Error('Unknown context resource')
  const sessionId = ticketId ? workerSessionId(ticketId) : reader.sessionId ?? host.masterId
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  return route[1]({ host, resource: name, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}
