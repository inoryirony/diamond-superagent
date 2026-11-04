/** Main Session tools for routing triggers, assessing candidates, sending replies, and updating settings and prompts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { UserError, followupOwners, key, reasonText, threadKey, type Decision, type DecisionKind, type EngineForMainSession, type EngineForPeople, type Reason }
  from '../../core/index.ts'
import { IM_WORDS, NOTE_WORDS, wordCount } from '../../infra/text.ts'
import { AssessmentSchema, EvalReadSchema, WorktreeNameSchema, type MasterAssessor } from '../assessment.ts'
import { ticketCard } from '../cards.ts'
import { PromptConfigSchema, savePrompts, type Prompts } from '../prompts.ts'
import { readResource, type MainResourceHost, type ResourceHost } from '../resources.ts'
import { readConversation, toolCallsWithArguments } from '../session-actions.ts'
import type { Sessions } from '../sessions.ts'
import type { Settings } from '../settings.ts'
import type { Store } from '../store.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

const RoutingNoteSchema = z.string().trim()
  .refine(text => wordCount(text) <= NOTE_WORDS, `Routing note must not exceed ${NOTE_WORDS} words (Chinese uses word segmentation). Shorten it; do not split it across deliveries.`)
  .describe(`Optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never add implementation instructions or replace the original source.`)
export interface MainToolsHost {
  readonly context: Context
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note' | 'hold' | 'release'> & EngineForPeople
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'atomic' | 'replyStatus' | 'settings'>
  readonly prompts: Pick<Prompts, 'preview' | 'save'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block' | 'save' | 'pause' | 'sync'>
  readonly assessor: Pick<MasterAssessor, 'context' | 'read' | 'decide'>
  readonly resources: ResourceHost
  /** Schedules a pass to carry out work queued by an Engine command (such as an Eval or ticket resume). */
  requestPass(): void
  sendReplies(): Promise<void>
  /** Runs an Engine command initiated by the main Session without emitting self-notifications. */
  quietly<T>(run: () => T): T
}
/** Schedules an Engine pass to execute the recorded routing decision and formats the tool response. */
function routed(host: MainToolsHost, result: { decision?: DecisionKind; reason: string; ticketId?: string | undefined }) {
  host.requestPass()
  const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
  return { ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
    ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
}
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticketId: decision.ticketId })
/**
 * One routing decision of `orchestrator_route`. The schema holds only its shape: each kind's fields are checked as its item
 * runs (`FIELDS`), so an item that lacks one, or whose value breaks a limit, is refused alone.
 *
 * `kind=assess` is how a proactive candidate is judged: the same call that carries the decision also carries the rule
 * assessments it rests on, so a candidate cannot be decided on facts a second, optional call never delivered.
 */
const RouteItemSchema = z.object({
  kind: z.enum(['accept', 'attach', 'ignore', 'stop', 'answer', 'assess']),
  trigger_id: z.string().describe('The candidate card\'s trigger_id; deciding it decides its batch.'),
  ticket_id: z.string().nullish().describe('attach and stop: the ticket.'),
  title: z.string().nullish().describe('accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice.'),
  worktree_name: z.string().nullish().describe(`accept: ${WorktreeNameSchema.description ?? ''}`),
  acknowledgement: z.string().nullish().describe(`accept: one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result in the source language. It is posted as a reply to the original source on acceptance, so do not quote the source; quote an earlier proposal briefly only when the trigger merely confirms it and the sentence does not already state it. No generic I will handle it.`),
  note: z.string().nullish().describe(`accept and attach: ${RoutingNoteSchema.description ?? ''}`),
  reason: z.string().nullish().describe('ignore and stop: why, at most 500 characters; an ignore needs it. chatter and duplicate are recorded as those reasons.'),
  text: z.string().nullish().describe('answer: the answer, posted where the question was written, naming the file, query or log line used; its Source sets the length limit.'),
  ack_seq: z.number().int().nonnegative().nullish()
    .describe('accept, attach and assess: the board_seq a refusal returned, once you have read its changes and this item is still right. Omit it otherwise.'),
  assessment: AssessmentSchema.nullish().describe('assess: the judgement itself — one entry for every enabled rule, the direction, and for an acceptance its title, worktree_name, scope, intent_evidence and acknowledgement.'),
}).strict()
type RouteItem = z.infer<typeof RouteItemSchema>
type Kind = RouteItem['kind']
type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id' | 'ack_seq'>
/** Each field's check, the kinds whose items read it and those that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Kind[]; needs: readonly Kind[] }> = {
  ticket_id: { check: z.string(), reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: z.string().max(200), reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: WorktreeNameSchema, reads: ['accept'], needs: ['accept'] },
  acknowledgement: { check: AcknowledgementSchema, reads: ['accept'], needs: ['accept'] },
  note: { check: RoutingNoteSchema, reads: ['accept', 'attach'], needs: [] },
  reason: { check: z.string().max(500), reads: ['ignore', 'stop'], needs: ['ignore'] },
  text: { check: z.string().max(20000), reads: ['answer'], needs: ['answer'] },
  assessment: { check: AssessmentSchema, reads: ['assess'], needs: ['assess'] },
}
/** The ignore reasons dispatch names by a word; any other text is kept as said. */
const NAMED_REASONS = ['chatter', 'duplicate'] as const
const ignoreReason = (text: string): string | Reason => (NAMED_REASONS as readonly string[]).includes(text.trim()) ? { code: text.trim() } : text
/**
 * Why an attach or an answer may not run yet: the Session never read the conversation its trigger was written in. A message of
 * two words says nothing without the sentence it follows, so the host holds the Session to the read that dispatch asks for.
 * Only a Source that keeps a conversation to read is held; the others route as before.
 */
function unread(host: MainToolsHost, item: RouteItem, calls: readonly { name: string; arguments: string }[]): string | undefined {
  if (item.kind !== 'attach' && item.kind !== 'answer') return undefined
  const trigger = host.store.triggers.get(item.trigger_id)
  if (!trigger || !host.resources.threadContext(trigger)?.chat) return undefined
  const meta = trigger.meta as Record<string, unknown>
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined
  if (readConversation(calls, { id: trigger.id, conversationId: text(meta.conversationId), peerOpenId: text(meta.peerOpenId) })) return undefined
  return `Read the conversation first: orchestrator_read trigger/${trigger.id} (it carries the live history) or dws chat message list on its conversation, then route again.`
}
/** The conversation a trigger was written in: the Source's own chat identity, which survives an episode boundary. */
const conversationOf = (trigger: { source: string; meta: Record<string, unknown>; threads: readonly { source: string; id: string }[] }): string => {
  const chat = trigger.meta.chatId ?? trigger.meta.conversationId
  return typeof chat === 'string' && chat ? `${trigger.source}:chat:${chat}` : `${trigger.source}:thread:${trigger.threads[0]?.id ?? ''}`
}
/**
 * Why an attach may not run: it would subscribe the ticket to a conversation it does not follow, and the message does not point
 * at the ticket. A wrong attachment subscribes the ticket to that whole conversation and never comes undone; a message in a
 * conversation the ticket already follows adds no subscription, so only the first kind is held. The pointers dispatch names are
 * checked: the message text naming the ticket or a link, or the message answering one this ticket already received. The main
 * Session's read of the conversation is already required (`unread`), so an attach that fails this is a subject similarity the
 * model mistook for a pointer.
 */
function unattached(host: MainToolsHost, item: RouteItem): string | undefined {
  if (item.kind !== 'attach' || !item.ticket_id) return undefined
  const trigger = host.store.triggers.get(item.trigger_id)
  const ticket = host.store.tickets.get(item.ticket_id)
  if (!trigger || !ticket) return undefined // The Engine reports an unknown trigger or ticket itself.
  const conversation = conversationOf(trigger)
  // A conversation this ticket already follows gains no subscription, so the attach cannot widen what reaches it.
  const known = [...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])]
  const followed = known.some(id => {
    const earlier = host.store.triggers.get(id)
    return earlier ? conversationOf(earlier) === conversation : false
  }) || ticket.follows?.some(follow => follow.thread === threadKey(trigger.threads[0]!)) === true
  if (followed) return undefined
  if (trigger.text.includes(ticket.id)) return undefined
  // A reply to a message this ticket already received continues that ticket's discussion.
  const meta = trigger.meta as Record<string, unknown>
  const parent = typeof meta.parentId === 'string' ? meta.parentId : undefined
  const answering = parent
    ? ticket.inputs.some(input => input.kind === 'trigger' && host.store.triggers.get(input.triggerId)?.meta.messageId === parent)
    : false
  if (answering) return undefined
  return `This message would subscribe ${ticket.id} to a conversation it does not follow (${conversation}), and it does not point at the ticket: its text names no ticket or link, and it answers no message the ticket received. Attaching a message on a similar subject subscribes the ticket to that whole conversation for good. Route it as accept or ignore instead, or attach the message that does point at the ticket.`
}
/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalid(item: RouteItem): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    // A field is text or the assessment object; only text can be blank, which `check` itself would refuse anyway.
    const blank = value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    if (blank) {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check.safeParse(value)
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? 'invalid'}`
  }
  return undefined
}
type Routed = { decision?: DecisionKind; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }
/**
 * The tickets this item's decision did not see: open tickets that changed after the board revision the Session assessed,
 * whose change bears on the same work. A lane that accepted or attached without seeing them could duplicate a ticket another
 * conversation just opened, so the item is not committed; the Session reads these cards and routes again with `ack_seq`.
 */
function unseen(host: MainToolsHost, item: RouteItem): { boardSeq: number; changed: unknown[] } | undefined {
  if (item.kind !== 'accept' && item.kind !== 'attach') return undefined
  const candidate = host.engine.candidate(item.trigger_id)
  // A trigger no Eval holds was routed directly, on the message the Session read itself: nothing was assessed to go stale.
  if (!candidate) return undefined
  const since = item.ack_seq ?? candidate.boardSeq
  const known = new Set(candidate.tickets.map(ticket => ticket.id))
  const changed = host.store.tickets.changedSince(since)
    .filter(({ ticket }) => ticket.id !== item.ticket_id && !known.has(ticket.id))
    .map(({ ticket, revision }) => ({ ...ticketCard(ticket), revision }))
  return changed.length ? { boardSeq: host.store.tickets.boardSeq(), changed } : undefined
}
/**
 * Carry out one routing decision as its Engine command, in a transaction of its own. `decided` holds the Triggers that this
 * call's earlier items decided, with their batches.
 */
function route(host: MainToolsHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  const note = item.note ? { note: item.note } : {}
  // A Trigger an earlier item decided went with that item's Decision, also as a member of its batch.
  // A stop of it for another ticket is the Engine's to judge.
  const earlier = decided.get(item.trigger_id)
  if (earlier && item.kind === 'ignore') return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
  switch (item.kind) {
    case 'accept': {
      const before = host.store.triggers.disposition(item.trigger_id)?.decisionId
      const decision = host.engine.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement!, name: item.worktree_name!, ...note })
      // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      if (decision.id === before) {
        return { decision: 'accept', reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId }
      }
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'attach': {
      const ticket = host.quietly(() => host.engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined))
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger', ticketId: ticket.id }
    }
    // Through `engine.decide`, so only a person's message the gate admits with explicit strength stops a ticket.
    case 'stop': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'ignore': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'ignore', reason: ignoreReason(item.reason!) })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    // The answer goes where the question was written, and the Decision records that no ticket was needed.
    case 'answer': {
      host.engine.reply({ purpose: 'answer', triggerId: item.trigger_id, text: item.text! })
      const decision = host.engine.decide(item.trigger_id, { kind: 'ignore', reason: { code: 'answered' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    // A proactive candidate is judged in `routeTool`, which holds the assessor's answer; `route` never sees one.
    case 'assess': throw new Error('An assessment is recorded through the assessor, not through route()')
  }
}
/** The outcome of an assessment, as the route call reports it: a conflict hands the board back instead of deciding. */
function assessmentResult(decided: { conflict?: { board_seq: number; changed: unknown[] }; reason: string; state: string; ticket_id?: string }) {
  if (decided.conflict) return { refused: decided.reason, decision: 'conflict', board_seq: decided.conflict.board_seq, changed: decided.conflict.changed }
  return { decision: decided.state as DecisionKind, reason: decided.reason, ...(decided.ticket_id ? { ticketId: decided.ticket_id } : {}) }
}
/**
 * `orchestrator_route`: routing decisions for several triggers in one call, in order. Each runs as its own Engine command; one
 * that is refused, or fails, is answered so, and the others still run.
 */
function routeTool(host: MainToolsHost, agent: Pick<Agent, 'session'>): Tool {
  return tool({
    name: 'orchestrator_route',
    description: 'Route candidates, one item each by the card\'s trigger_id, in one call, as dispatch says: accept an explicit request as a new ticket, attach a trigger to an existing ticket, stop a ticket on a person\'s stop message, answer a question with text and no ticket, ignore a candidate that needs no ticket, answer or stop, or assess a proactive candidate by its rules. Items run in order and each is answered on its own; a refused item leaves the others.',
    schema: z.object({ decisions: z.array(RouteItemSchema).min(1).max(20) }).strict(),
    execute: async ({ decisions }) => {
      const decided = new Map<string, string>()
      // The whole log counts, so a read made before this call, or by an earlier item of it, is enough.
      const calls = toolCallsWithArguments(agent)
      const results: Record<string, unknown>[] = []
      for (const item of decisions) {
        const head = { trigger_id: item.trigger_id, kind: item.kind }
        const problem = invalid(item)
        if (problem) { results.push({ ...head, refused: problem }); continue }
        // An assessment is the assessor's own command: it holds the Eval the candidate belongs to, which the router does not.
        if (item.kind === 'assess') {
          const assessment = item.assessment
          if (!assessment) { results.push({ ...head, refused: 'assess needs assessment: the rule judgements and direction it rests on' }); continue }
          try {
            const decidedItem = await host.assessor.decide(item.trigger_id, AssessmentSchema.parse({ ...assessment,
              ...item.ack_seq != null ? { ack_seq: item.ack_seq } : {} }))
            results.push({ ...head, ...assessmentResult(decidedItem) })
          } catch (error) {
            if (error instanceof UserError) { results.push({ ...head, refused: error.message }); continue }
            host.context.logger.warn('dsh-superagent could not assess trigger %s: %s', item.trigger_id, String(error))
            results.push({ ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` })
          }
          continue
        }
        const held = unread(host, item, calls)
        if (held) { results.push({ ...head, refused: held }); continue }
        const off = unattached(host, item)
        if (off) { results.push({ ...head, refused: off }); continue }
        // A ticket another conversation changed since this Session assessed would not be in what it weighed: show it rather
        // than commit beside it, and let the Session decide again with `ack_seq` once it has read these cards.
        const stale = unseen(host, item)
        if (stale) {
          results.push({ ...head, refused: `The board changed after this assessment: ${stale.changed.length} ticket(s) touched the same work `
            + 'since you read the candidate. Read them below, then route this item again with ack_seq if it is still right, or change it.', ...stale })
          continue
        }
        try {
          const result = route(host, item, decided)
          if ('refused' in result) { results.push({ ...head, ...result }); continue }
          for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id)
          const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
          results.push({ ...head, ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
            ...(ticket ? { ticket: ticketCard(ticket) } : {}) })
        } catch (error) {
          if (error instanceof UserError) { results.push({ ...head, refused: error.message }); continue }
          host.context.logger.warn('dsh-superagent could not route trigger %s: %s', item.trigger_id, String(error))
          results.push({ ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` })
        }
      }
      host.requestPass()
      if (decisions.some(item => item.kind === 'answer')) await host.sendReplies()
      return { results }
    },
  })
}
/** Builds the main Session's tools; `agent` scopes prompt preview resources to that Session. */
export function mainTools(host: MainToolsHost, agent: Agent): Tool[] {
  const resources: MainResourceHost = { ...host.resources, sessions: host.sessions, settings: host.settings }
  return [
    readTool('Read one page of a resource the resource parameter lists, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.',
      false, (resource, offset, limit, signal) => readResource(resources, resource, offset, limit, { sessionId: agent.id }, signal)),
    routeTool(host, agent),
    tool({
      name: 'orchestrator_ticket',
      description: 'Change one ticket, as the replies and dispatch sections say. do restart starts a fresh assignment with an instruction, '
        + 'retry starts one on an explicit human request, note tells its worker a fact without granting authority, status asks an idle '
        + 'worker for a report, hold parks the inputs two opposite directions are about, release settles a hold, and reply sends a ready '
        + 'result or the ticket\'s current attention to the person who asked.',
      schema: z.object({
        ticket_id: z.string(),
        action: z.enum(['restart', 'retry', 'note', 'status', 'hold', 'release', 'reply']),
        instruction: z.string().trim().min(1).max(4000).optional().describe('restart: what the next worker must do differently, with the findings you act on.'),
        text: z.string().trim().min(1).max(20000).optional().describe('note: the fact, at most ' + IM_WORDS + ' words, for context only; reply: the message to the person.'),
        purpose: z.enum(['result', 'attention']).optional().describe('reply: result sends a ready result, attention asks the ticket\'s current question.'),
        human_action: z.string().trim().min(1).optional().describe('reply purpose=attention: the ticket\'s current attention question, copied exactly.'),
        question: z.string().trim().min(1).max(1000).optional().describe('hold: what conflicts — direction A with who gave it and its words, then direction B the same way.'),
        options: z.array(z.object({
          id: z.string().trim().min(1).max(40).describe('A short id the release names, such as a or b.'),
          text: z.string().trim().min(1).max(500).describe('The direction that option settles on, in the terms the worker must act on.'),
          by: z.string().trim().min(1).max(200).describe('Who gave this direction, by name.'),
        })).min(2).max(4).optional().describe('hold: the directions a release may settle on.'),
        inputs: z.array(z.string()).max(20).optional().describe('hold: the ticket input ids in dispute; omit while the conflict is about the ticket itself.'),
        resolution: z.string().trim().min(1).max(2000).optional().describe('release: which direction stands and why, as the worker must act on it.'),
        option: z.string().trim().min(1).max(40).optional().describe('release: the hold option this settles on, when one of them stands.'),
        trigger_id: z.string().trim().min(1).optional().describe('hold and release: the message that raised or settled the conflict; reply: the question to answer.'),
        due_in_minutes: z.number().int().min(5).max(10_080).optional().describe('hold: when to ask again if nobody settles it; default one day, moved into working hours.'),
      }).strict(),
      execute: async args => {
        switch (args.action) {
          case 'restart':
            if (!args.instruction) throw new Error('restart needs instruction')
            host.engine.restartTicket(args.ticket_id, args.instruction)
            return routed(host, { reason: 'Started a fresh assignment with an instruction', ticketId: args.ticket_id })
          case 'retry':
            return routed(host, { reason: 'Started a new assignment', ticketId: host.engine.retryTicket(args.ticket_id).id })
          case 'status': {
            const asked = host.engine.requestStatus(args.ticket_id)
            return routed(host, { reason: asked ? 'Asked the worker for a status report' : 'The worker is not waiting; nothing was sent', ticketId: args.ticket_id })
          }
          case 'note':
            if (!args.text) throw new Error('note needs text')
            if (wordCount(args.text) > IM_WORDS) throw new Error(`note has at most ${IM_WORDS} words`)
            host.engine.note(args.ticket_id, args.text)
            return routed(host, { reason: 'Noted for the worker', ticketId: args.ticket_id })
          case 'hold': {
            if (!args.question || !args.options?.length) throw new Error('hold needs question and at least two options')
            const dueAt = new Date(Date.now() + (args.due_in_minutes ?? 1440) * 60_000).toISOString()
            const ticket = host.engine.hold(args.ticket_id, { question: args.question, options: args.options,
              ...(args.inputs?.length ? { inputs: args.inputs } : {}), ...(args.trigger_id ? { triggerId: args.trigger_id } : {}), dueAt })
            return routed(host, { reason: 'Held on a conflict until someone settles it', ticketId: ticket.id })
          }
          case 'release': {
            if (!args.resolution) throw new Error('release needs resolution')
            const ticket = host.engine.release(args.ticket_id, args.resolution, 'orchestrator', args.option, args.trigger_id)
            return routed(host, { reason: 'Released with the settled direction', ticketId: ticket.id })
          }
          case 'reply': {
            if (!args.purpose || !args.text) throw new Error('reply needs purpose and text')
            if (args.purpose === 'attention' && !args.human_action) throw new Error('reply purpose=attention needs human_action')
            const reply = host.engine.reply({ purpose: args.purpose, text: args.text, ticketId: args.ticket_id,
              ...(args.trigger_id ? { triggerId: args.trigger_id } : {}), ...(args.human_action ? { question: args.human_action } : {}) })
            await host.sendReplies()
            return { status: host.store.replyStatus(reply.id) ?? reply.status }
          }
        }
      },
    }),
  ]
}
