/** Compact, bounded model-facing projections of triggers, tickets, threads, and decisions; full texts stay behind readable resources. */
import { latestAssignment, latestReport, reasonText, reportHistory, threadKey, ticketStage, type Decision, type Mandate, type ReportEntry, type Thread, type Ticket, type TicketInput,
  type Trigger, type TriggerDisposition } from '../core/index.ts'
import { pullOf } from '../sources/github-pull.ts'
import { batchLine, inputResource } from '../executor/dsh.ts'

/** Collapses whitespace and truncates text for display previews while keeping code, angle brackets, and links intact for model readers. */
export function preview(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 160) }
export function triggerCard(trigger: Trigger, disposition?: TriggerDisposition) {
  return { trigger_id: trigger.id, source: trigger.source, ...(trigger.url ? { source_url: trigger.url } : {}), actor: trigger.actor.id,
    ...(typeof trigger.meta.actor_name === 'string' ? { actor_name: trigger.meta.actor_name } : {}),
    ...(trigger.meta.operator === true ? { operator: true } : {}),
    thread: threadKey(trigger.threads[0]!), human: trigger.human, at: trigger.at,
    preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}`,
    ...(disposition ? { disposition: { ...(disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {}),
      ...(disposition.decisionId ? { decision_id: disposition.decisionId } : {}),
      delivered_to: disposition.fanout } } : {}) }
}
/** The states a ticket card shows: an open ticket's stage (docs/003), and an ended ticket's outcome. */
export const TICKET_STATES = ['person/delivery', 'person/answer', 'person/review', 'person/returned', 'person/blocked', 'person/failed', 'person/held',
  'review/running', 'working', 'working/queued', 'idle', 'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type TicketCardState = typeof TICKET_STATES[number]
function cardState(ticket: Ticket): TicketCardState {
  if (ticket.ended) return ticket.ended.outcome
  // A card says whether a running review or a returned result belongs to a person or to the worker, as the stage rules do.
  const stage = ticketStage(ticket, true)
  if (stage.stage === 'person') return `person/${stage.action}`
  if (stage.stage === 'review') return 'review/running'
  return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? 'working/queued' : 'working'
}
/**
 * The latest report with its author, which `assignment.report` alone does not carry: a card has to tell a worker's account of
 * its work from a failure the host recorded for the machinery that ran it.
 */
function latestEntry(ticket: Pick<Ticket, 'assignments'>): ReportEntry | undefined {
  const assignment = ticket.assignments.findLast(item => item.report)
  return assignment ? reportHistory(assignment).at(-1) : undefined
}
/**
 * Whether a report's summary is the worker's account of its work or a host-recorded failure of the machinery that ran it. A
 * `failed` report the host wrote carries the thrown error (a provider refusing the call, a command that could not run), which
 * says nothing about the ticket's business: a card that shows it reads as the ticket's state and hides what the ticket is for.
 */
const hostFault = (report: ReportEntry): boolean => report.by === 'host' && report.state === 'failed'
/** The ticket's own account of where it stands, or a plain statement that the machinery failed rather than the work. */
function cardPreview(ticket: Ticket): string {
  const report = latestEntry(ticket)
  if (!report) return ''
  return hostFault(report) ? 'The worker could not run; the ticket itself is unchanged.' : preview(report.summary)
}
export function ticketCard(ticket: Ticket) {
  const ended = ticket.ended && { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome }
  const { attention, hold } = ticket
  const report = latestEntry(ticket)
  // A ticket waiting out an upstream outage is not stuck on its work, so the list says which attempt it is on and when the next
  // one runs; without it the card reads as an ordinary running ticket and nobody knows why nothing advances.
  const retry = latestAssignment(ticket)?.retry
  return { ticket_id: ticket.id, title: ticket.title, state: cardState(ticket), strength: ticket.mandate.strength,
    ...(pullOf(ticket) ? { pr_number: pullOf(ticket) } : {}), ...(ended ? { ended } : {}),
    ...(hold && !hold.released ? { hold: { question: hold.question, ...hold.triggerId ? { trigger_id: hold.triggerId } : {}, at: hold.at } } : {}),
    ...(attention ? { attention: { question: attention.question, ...attention.triggerId ? { trigger_id: attention.triggerId } : {} } } : {}),
    ...(report && hostFault(report) ? { worker_failed: true } : {}),
    ...(retry ? { retrying: { attempts: retry.attempts, next_at: retry.nextAt } } : {}),
    preview: cardPreview(ticket), read: `ticket/${ticket.id}` }
}
/** Strips `policyVersion`, an internal hash that callers never query by. */
const mandateOf = ({ policyVersion: _version, ...mandate }: Mandate) => mandate
export const INPUTS = 10, ASSIGNMENTS = 3
const INPUT_TEXT = 80
/** Summarizes a ticket input inline for short text or as a resource reference, omitting decision IDs for worker Sessions. */
export function inputLine(ticket: Ticket, input: TicketInput, worker = false) {
  const read = { read: inputResource(ticket.id, input.id) }
  const names = input.kind === 'trigger' || input.kind === 'resumed' ? { trigger_id: input.triggerId }
    : input.kind === 'reopen' && !worker ? { decision_id: input.decisionId }
    : input.kind !== 'text' ? read
    : input.text.length <= INPUT_TEXT ? { text: input.text }
    : { preview: preview(input.text).slice(0, INPUT_TEXT), chars: input.text.length, ...read }
  return { kind: input.kind, at: input.at, ...names, ...ticket.undelivered.includes(input.id) ? { undelivered: true } : {} }
}
export function assignmentLine(ticket: Ticket, item: Ticket['assignments'][number]) {
  return { id: item.id, state: item.state, at: item.createdAt, ...(item.endedReason ? { ended_reason: reasonText({ code: item.endedReason }) } : {}),
    // An upstream failure keeps the ticket alive, so the attempt count, when it retries and the provider's own words are what
    // tell a person waiting on it that the work is not stuck, only the provider.
    ...(item.retry ? { retry: { attempts: item.retry.attempts, backoff_seconds: Math.round(item.retry.backoffMs / 1000),
      next_at: item.retry.nextAt, at: item.retry.at, error: preview(item.retry.error).slice(0, 300),
      chars: item.retry.error.length, read: `ticket/${ticket.id}/retry/${item.id}` } } : {}),
    ...(item.report ? { report: { state: item.report.state, at: item.report.at, preview: preview(item.report.summary).slice(0, 100),
      chars: item.report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` } } : {}) }
}
export function newestPage<T, L>(items: readonly T[], offset: number, size: number, line: (item: T) => L, next: string) {
  const newest = items.slice().reverse()
  const more = offset + size < newest.length
  return { items: newest.slice(offset, offset + size).map(line), ...more ? { next_resource: next, next_offset: offset + size } : {} }
}
export interface TicketThread { thread: string; context?: true; bound?: true }
/** Projects a ticket with its linked triggers, threads, and first pages of assignments and inputs, omitting decision IDs for workers. */
export function ticketDetails(ticket: Ticket, threads: TicketThread[], batch: readonly Trigger[], worker = false) {
  // Drop card preview because the latest report's preview is already shown on the first assignment entry.
  const { preview: _preview, ...card } = ticketCard(ticket)
  return { ...card, trigger_id: ticket.origin.triggerId, ...batch.length ? { batch: batch.map(batchLine) } : {},
    ...worker ? {} : { decision_id: ticket.decisionId }, threads, directory: ticket.execution?.directory,
    scope: ticket.mandate.scope, requested_by: ticket.mandate.actor.id,
    assignments: newestPage(ticket.assignments, 0, ASSIGNMENTS, item => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
    inputs: newestPage(ticket.inputs, 0, INPUTS, input => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`),
    assignment: `ticket/${ticket.id}/assignment`, result: `ticket/${ticket.id}/result`, transcript: `ticket/${ticket.id}/transcript` }
}

export function threadCard(thread: Thread, label: string) {
  return { thread: thread.key, label, source: thread.ref.source, tickets: thread.subscriptions,
    ...(thread.evaluating ? { evaluating: { since: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {}),
    pending: thread.pending.length,
    ...(thread.meta.pollError ? { error: preview(String(thread.meta.pollError)) } : {}), ...(thread.meta.url ? { url: thread.meta.url } : {}),
    read: `thread/${thread.key}` }
}
export function decisionCard(decision: Decision) {
  return { decision_id: decision.id, kind: decision.kind, reason: reasonText(decision.reason), strength: decision.strength,
    thread: decision.threadKey,
    trigger_ids: decision.triggerIds, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), at: decision.at,
    read: `decision/${decision.id}` }
}
export function decisionDetails(decision: Decision) {
  return { ...decisionCard(decision), ...(decision.mandate ? { mandate: mandateOf(decision.mandate) } : {}),
    ...(decision.audit ? { audit: decision.audit } : {}) }
}
/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
export function textPage(resource: string, text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit)
  return { resource, offset, total_chars: text.length, next_offset: end < text.length ? end : null, text: text.slice(offset, end) }
}
/** How many live tickets a candidate card carries at most: a hard guard against a flooded board, not an expected count. */
export const OPEN_TICKET_CARDS = 60
/** How many ended tickets of the candidate's thread a card carries at most. */
export const ENDED_TICKET_CARDS = 8
/** How long an ended ticket stays on candidate cards; older ones are archived from the card, and `orchestrator_read` tickets still lists them. */
export const ENDED_TICKET_CARD_DAYS = 7
/**
 * The tickets a candidate card lists: every live ticket, newest first, then the ended ones of the thread that ended within
 * `ENDED_TICKET_CARD_DAYS`; `tickets_total` tells when the limits cut some off, which `orchestrator_read` tickets pages through.
 */
export function relatedTickets(tickets: readonly Ticket[], now = new Date()) {
  const newest = (a: Ticket, b: Ticket) => b.createdAt.localeCompare(a.createdAt)
  const archived = new Date(now.getTime() - ENDED_TICKET_CARD_DAYS * 86_400_000).toISOString()
  const open = tickets.filter(ticket => !ticket.ended).sort(newest).slice(0, OPEN_TICKET_CARDS)
  const ended = tickets.filter(ticket => ticket.ended && ticket.ended.at > archived).sort(newest).slice(0, ENDED_TICKET_CARDS)
  return { related_tickets: [...open, ...ended].map(ticketCard), tickets_total: tickets.length }
}
/** The card an Eval's Session gets when another message arrives on the Thread it assesses. */
export function followupWhileAssessing(trigger: Trigger) {
  return { kind: 'followup_while_assessing', trigger: triggerCard(trigger),
    note: 'This message arrived on the same thread while you assess. Route it now with orchestrator_route (attach, ignore or accept), or answer it with kind=answer; otherwise it is assessed separately after your decision.' }
}
/** A short Session title for an Eval: the text of its first Trigger. */
export function evalTitle(store: { threads: { active(): readonly { evaluating?: { id: string; triggerIds: string[] } }[] }; triggers: { get(id: string): { text: string } | undefined } }, evalId: string): string {
  const evaluation = store.threads.active().find(thread => thread.evaluating?.id === evalId)?.evaluating
  const text = evaluation && store.triggers.get(evaluation.triggerIds[0]!)?.text
  return `eval ${(text ?? evalId).replace(/\s+/g, ' ').slice(0, 40)}`
}
