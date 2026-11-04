/** Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor. */
import type { Reason } from './reasons.ts'

/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
export interface ActorRef { source: string; id: string }
/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
export interface ThreadRef { source: string; id: string }
/** Write-only address on a thread; the address format belongs to the source. */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** Stable key of a thread across the whole domain. */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
export interface Trigger {
  id: string
  source: string
  /** Every thread the trigger belongs to; the first (`threads[0]`) is the primary thread that hosts its evaluation. */
  threads: ThreadRef[]
  actor: ActorRef
  /** Source-declared: the event was written by a person rather than a bot, CI, or this agent. */
  human: boolean
  /** Source-declared: the sender addressed the agent, by mentioning it or in a direct message to it. */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** Source-native details for adapters; the core never interprets them. */
  meta: Record<string, unknown>
}

/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
export interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not resume
   * without its worker taking it up no longer counts.
   */
  fanout: string[]
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs. */
  context?: string[]
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it. */
  requeued?: true
  /** The tickets whose Executor handed it back as beyond the ticket, each once, with why; it goes to Eval once none decides it. */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket. */
  acked?: string[]
  at: string
}
/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions, as the Store and the core keep them. */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or, unless
 * `underEval` says otherwise, while an Eval holds it. While a ticket owns it, the message goes to no Eval, and the main
 * Session may only stop the work on it.
 *
 * `underEval` is for the main Session, which now reads every person's message as a candidate even while a ticket's worker
 * decides it: the owner still decides, and the candidate exists only for the Session to read, ignore, or stop.
 */
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords,
  options: { underEval?: boolean } = {}): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
  const returned = new Set(disposition.handbacks?.map(item => item.ticketId))
  const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id))
  if (!reached.length) return []
  if (!options.underEval && records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)) return []
  return reached.filter(id => {
    const ticket = records.tickets.get(id)
    return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))))
  })
}
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * Whether proactive candidates are assessed and accepted (`auto`), still assessed so Decisions record what they would accept
 * (`would_accept`) without accepting (`observe`), or not admitted (`off`).
 */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** Where a Mandate's Trigger was received: its Source, its receiving scope as the Source recorded it, and its admission row. */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks (see `docs/002`):
 * - `addressed`: a sender on the Source's list addressed the agent;
 * - `followup`: a message on a Thread that has tickets;
 * - `admission`: the cell of the receiving scope's admission row; `observation` when it made an inferred candidate under
 *   an accept mode;
 * - `listed`: accepted before Mandates recorded their basis, from a sender who must still be on the list; `authority` is
 *   what an earlier version recorded instead.
 * `sender` names the allowed sender at acceptance time, and `rules` the rules an assessment matched.
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop. */
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
)

/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** How the gate admitted it, for re-validation and audit. */
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** Active trigger evaluation on a thread; at most one exists per thread. */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  primary?: string
  strength: Strength
  /** Actor and gate basis of the strongest admissible trigger; they seed the mandate on accept. */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** Timestamp when the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  delivered?: string
  /** Expiration timestamp, counted from delivery (or from start until delivered); a processing pause shifts it forward by the pause duration. */
  deadline: string
  /** Timestamp when processing pause began; resuming shifts `deadline` forward by the pause duration; cleared on resume. */
  pausedAt?: string
}

/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** Time of the newest trigger on the thread. */
  lastAt?: string
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  subscriptions: string[]
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context, such as an Issue or another pull request
   * it found: its messages reach them, but grant nothing, and a person's message there resumes none of them that ended.
   */
  context?: string[]
  /** Keys of threads that shared a trigger with this one; context only. */
  correlated: string[]
  /** Triggers waiting for the next eval (debounce buffer). */
  pending: string[]
  evaluating?: Evaluation
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  expired?: number
  /**
   * Source-native attributes needed by channels or readers (for example a Feishu thread id). Its Source may also describe
   * the thread for people: `label`, a display name, and `facts`, a {@link ThreadFacts} map.
   */
  meta: Record<string, unknown>
}
/** Text in both interface languages, or the same text in both. */
export type Text = string | { zh: string; en: string }
/** One fact a Source states about its thread, such as an issue number or a CI result; `problem` marks one that needs a person. */
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** A thread's facts by id, ordered for display; each writer owns its fact ids. */
export type ThreadFacts = Record<string, ThreadFact>

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'
/** Outcome of one eval, recorded on the thread. */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  audit?: Record<string, unknown>
  /** A person dismissed the problem an unavailable Decision shows. */
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * What an Assignment reports: work is in progress (`progress`), its worker waits for a Trigger (`waiting`), a result is
 * ready (`ready`), a person must act to unblock or recover it (`blocked` or `failed`), or nothing is left to do (`dropped`).
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/**
 * What a result changed, and so who reads it. `code` is the one a Reviewer reviews: a change whose correctness a second reader
 * establishes from the diff, its tests and the ticket. `data` reports what a read of data, logs or a database showed; `verify`
 * reports what running an existing check showed; `docs` reports prose that changed. The last three have no code to judge, so
 * they reach a person directly and spend no review round.
 */
export type WorkKind = 'code' | 'data' | 'verify' | 'docs'
/** Whether a Reviewer reads a result of this kind: only a kind that changed code has something for it to judge. */
export const reviewedWork = (work: WorkKind | undefined): boolean => work === undefined || work === 'code'
/** One report in an Assignment's ledger, with its author: the worker, or the host when it closed a turn on the worker's behalf. */
export interface ReportEntry { by: 'worker' | 'host'; state: ReportState; summary: string; at: string
  /** What a ready report showed: the commands run, queries made or files read after the last change, and what each printed. */
  evidence?: ReportEvidence[]
  /** What kind of work the result was (see `WorkKind`); an entry written before reports carried it has none. */
  work?: WorkKind }
/** One check a report names as evidence: what was done, and what it actually showed. */
export interface ReportEvidence { what: string; result: string }
/**
 * One worker Session a ticket used. A worker Session carries its context forward, so it is reused while that helps and replaced
 * once it stops: after `WORKER_REUSES` Assignments, whose history a fresh read of the ticket costs less than, or after a turn the
 * provider failed for want of context. `index` numbers them from 1, and the Executor names the Session after it.
 */
export interface WorkerRecord {
  /** Which generation of worker this is, from 1. */
  index: number
  from: string
  /** How it stopped being the ticket's worker: it served its Assignments, or a turn ran out of context. */
  closed?: 'rounds' | 'overflow'
  closedAt?: string
}
/**
 * How many Assignments one worker Session serves before a fresh one replaces it. Retries, restarts and review returns rewrite the
 * same work, so the history grows with each Assignment; three is where reading the ticket afresh is cheaper than the history.
 */
export const WORKER_REUSES = 3
/** The worker Session that runs a ticket's next Assignment: its newest, unless that one is closed. */
export const activeWorker = (ticket: Pick<Ticket, 'workers'>): WorkerRecord | undefined =>
  ticket.workers?.at(-1)?.closed ? undefined : ticket.workers?.at(-1)
/** The worker Session an Assignment runs in: its named generation, or 1 for one recorded before generations existed. */
export const workerOf = (assignment: Pick<Assignment, 'worker'>): number => assignment.worker ?? 1
/** Binding between a ticket and one executor instance. */
export interface Assignment {
  id: string
  state: AssignmentState
  /** The ticket's worker Session that runs it (see `WorkerRecord.index`), so a reader tells which history it starts from. */
  worker?: number
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
  /** Every report in order, with its author; `report` mirrors the last. An Assignment written before the ledger has none (see `reportHistory`). */
  reports?: ReportEntry[]
  /** When the host last asked this stalled worker for its status (see `stalledSince`); it asks again only once the worker has been active since. */
  probedAt?: string
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy with Inputs since that report. */
  deliveredAt?: string
  /**
   * When a turn of its worker last ended with nothing left to run for it and nothing waiting for it: what its Session took
   * into a step before, the worker read.
   */
  idleAt?: string
  /**
   * Set when a review returned this Assignment's predecessor: the worker revises the same work, so the new Assignment
   * continues the attempt that was under review and its review rounds carry on. Unset on an Assignment a person's follow-up,
   * a retry or the orchestrator started, which begins a new attempt with its own rounds.
   */
  revises?: true
  /**
   * Where the last turn stood when the provider or the network failed it: how many attempts this Assignment has made, the
   * full error the upstream returned, and when it will try again. It never gives up — an upstream outage is not the work's
   * verdict — so this is how a person sees that a ticket waits on the provider rather than on the work.
   */
  retry?: AssignmentRetry
}

/** A turn the upstream failed, and the attempt now waiting out its backoff before trying again. */
export interface AssignmentRetry {
  /** How many times this Assignment has retried after a passing failure; the first retry is 1. */
  attempts: number
  /** The error exactly as the upstream or the network returned it, kept whole: cutting it is what makes an outage unreadable. */
  error: string
  /** When this attempt was recorded. */
  at: string
  /** When the next attempt runs. */
  nextAt: string
  /** How long the backoff before that attempt is, so a person tells a fast retry from one backing off for an hour. */
  backoffMs: number
}

export type TicketInput =
  /** A Trigger on one of its Threads, or attached to it; `human` when a person wrote it. */
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** It reached the ticket only on a Thread its Executor follows for context. */
    context?: true
    /**
     * When the worker's Session took the message that carried it into a step, from which its model reads it; `null` while
     * it waits in the Session. One delivered before reads were recorded has none, and counts as read from `deliveredAt`.
     */
    readAt?: string | null
    /** The Assignment it was last delivered to. */
    deliveredTo?: string
    /** When an earlier version handed it to the worker. */
    deliveredAt?: string }
  /** The Policy changed in a way that bears on the ticket, as `effect` says; Inputs written before effects have none. */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** A Decision reopened the ticket; written before ended tickets resumed on their own. */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate. */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed, with their instruction now, or no
 * longer apply; `proactive: false` once inferred work is no longer accepted, as when the accept mode leaves `auto`; and
 * `requesterAllowed: false` once the sender it is for, `requester`, a person or a bot, may no longer start work there.
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** How a ticket ended: with its result, with its pull request merged or closed unmerged, with nothing to do, or stopped by a person. */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
export interface Attention { id: string; question: string; triggerId?: string }
/**
 * A hold on a ticket: two conversations gave it opposite directions and neither is plainly right, so it parks until someone
 * settles which stands. It locks only the messages in dispute (`inputs`), not the ticket: work the conflict does not touch
 * carries on. The question names both directions with who gave each; `options` are the directions a release may choose from.
 */
export interface Hold {
  id: string
  /** What conflicts, naming both directions and the person who gave each, each quoting the message it came from. */
  question: string
  /** The directions a release may settle on, most likely first; a release names one or says which it stands for. */
  options?: { id: string; text: string; by: string }[]
  /** The message that raised the conflict, so a reader can open it. */
  triggerId?: string
  /** The Thread the conflict came from, when its message is not enough to place it. */
  thread?: string
  /** The inputs it locks: they wait, and the rest of the ticket does not. Empty while a conflict names only the ticket itself. */
  inputs: string[]
  at: string
  /** When a person was last asked to settle it, and when a reminder is due, so a silent conflict cannot become a quiet stop. */
  dueAt?: string
  remindedAt?: string
  /** How it was settled, once it was; a held ticket has none. */
  released?: { at: string; resolution: string; by: 'person' | 'orchestrator'; triggerId?: string; option?: string }
}
/** Ticket aggregate: an authorized work item with its assignments, channels, thread bindings, and inputs. */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** The Channels of the messages it was accepted from, which its replies go to. */
  channels: ChannelRef[]
  /** When, by whom, and how the ticket ended, with a person's or the host's reason beyond the outcome; an open ticket has none. */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  attention?: Attention
  /** A conflict parked until someone settles which direction stands (see `Hold`); none on an unheld ticket. */
  hold?: Hold
  assignments: Assignment[]
  inputs: TicketInput[]
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[]
  /**
   * Threads a Source made the ticket follow, such as its pull requests': a `ready` report ends the ticket only once
   * `followsDone` holds; the close that makes it hold ends the ticket with that outcome unless its work has not finished (see
   * `Tickets.unfinished`), and then its next `ready` or `dropped` report ends it.
   */
  follows?: Follow[]
  /** People's questions the worker answered, whose answers the main Session may send. */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** The Triggers it was accepted from: the one that started it, and the batch its Eval held. */
  origin: { triggerId: string; triggerIds: string[] }
  /** What its Executor chose: its short name, directory and assignment text. */
  execution?: Execution
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  delivery?: { error: string; at: string }
  /**
   * Reviews of its results, in order. A ready report does not end a ticket whose executor reviews results: it asks for a review
   * of that result, which passes it towards delivery or returns it to the worker with findings. Only a review that passes the
   * result, or a worker's `dropped` report, finishes the ticket.
   */
  reviews?: TicketReview[]
  /** Set when a ready result ended the ticket although reviews are on and its rounds were spent, so no review judged it. */
  unreviewed?: true
  /**
   * The worker Sessions it used, oldest first. The newest runs its next Assignment; the ones before it are kept as the reading of
   * the work they did, which a fresh worker reads through `ticket/<id>/worker/<index>` instead of carrying their whole history.
   */
  workers?: WorkerRecord[]
}

/** How a review of a ticket's result ended: the work passed it, or it sent the work back with findings. */
export type ReviewOutcome = 'passed' | 'returned'
/** What one review of a ticket's result found. */
export interface TicketReview {
  /** The Assignment whose result it reviews, the round it is (1 is the first review of the ticket), and when it was asked for. */
  assignmentId: string
  round: number
  at: string
  /** When it ended, how and why, with what the review found; empty while it runs. */
  ended?: { at: string; outcome: ReviewOutcome; summary: string; findings?: string[]
    /** The review could not judge the result, which waits for a person. */
    unfinished?: true }
}
/**
 * A Thread a ticket follows, by its key: `own` when the ticket opened it, such as its own pull request, and when and how it
 * closed. `followsDone` holds once no Thread of its own is open, or, when the ticket has no `own` Thread, once every followed
 * Thread closed; the ticket then ends unless its work has not finished (see `Tickets.unfinished`).
 */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Execution { name: string; directory: string; assignment: string }

/** Whether a ticket is open: it has not ended. */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** How a ticket ended. */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/** The review of a ticket's result still running, if any: its newest review without an end. */
export const pendingReview = (ticket: Pick<Ticket, 'reviews'>): TicketReview | undefined =>
  ticket.reviews?.findLast(review => !review.ended)
/**
 * Whether a ready report of an Assignment asks for a review, or is the result itself: with reviews on, every ready result is
 * reviewed once, and a returned one again until it runs out of rounds; with reviews off, the result is the ticket's.
 *
 * The rounds bound one attempt at the work, not the ticket's whole life. They count the reviews since the current Assignment
 * started, because a new Assignment is a new attempt: a person's follow-up, a retry, or the orchestrator acting on what the
 * reviewer kept finding each begin one. Counting every review the ticket ever had made those restart paths pointless — the
 * worker would revise, report ready, and no review would run because an earlier attempt had already spent the budget.
 */
export const reviewRequired = (ticket: Pick<Ticket, 'reviews' | 'assignments'>, reviews: boolean, rounds: number): boolean => {
  if (!reviews) return false
  const report = latestReport(ticket)
  if (!report) return false
  // A review already asked for by this exact result runs or ran: `>=` because a review recorded in the same millisecond as
  // the report is a review of that report, not one that predates it.
  const reviewed = (ticket.reviews ?? []).some(review => review.at >= report.at)
  return !reviewed && reviewsInAttempt(ticket) < rounds
}
/** The Assignment the ticket is on now: the newest one, whose result a review of the current work judges. */
const currentAssignment = (ticket: Pick<Ticket, 'assignments'>): Assignment | undefined => ticket.assignments.at(-1)
/**
 * How many reviews with a verdict the current attempt has taken: one that ended unfinished, because its Session could not run or
 * a newer result superseded it, judged nothing and spends no round. An attempt begins at the newest Assignment a person, a retry or the
 * orchestrator started, and every Assignment after it that only revises the same work belongs to it.
 */
export const reviewsInAttempt = (ticket: Pick<Ticket, 'reviews' | 'assignments'>): number => {
  const assignments = ticket.assignments
  let start = assignments.length - 1
  while (start > 0 && assignments[start]?.revises) start--
  const attemptIds = new Set(assignments.slice(Math.max(start, 0)).map(assignment => assignment.id))
  return (ticket.reviews ?? []).filter(review => attemptIds.has(review.assignmentId) && !!review.ended && !review.ended.unfinished
    && (review.ended.outcome === 'passed' || review.ended.outcome === 'returned')).length
}
/** The review round a new review of the ticket's latest result is: one more than every review the ticket has had, so a round
 * number never repeats and the Reviewer Session id built from it stays unique across attempts. */
export const reviewRound = (ticket: Pick<Ticket, 'reviews'>): number => (ticket.reviews?.length ?? 0) + 1
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
export function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context = true): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id)
  return trigger.threads.some(ref => {
    const current = thread(threadKey(ref))
    return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id))
  }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))))
}
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it. A hold is
 * not this wait: it locks the inputs it names, and the rest of the ticket carries on (see `holdsInput`).
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
}
/** Whether an open hold locks `input`: a message in dispute waits for someone to settle it, and others do not. */
export const holdsInput = (ticket: Pick<Ticket, 'hold'>, input: { id: string }): boolean =>
  !!ticket.hold && !ticket.hold.released && (ticket.hold.inputs.includes(input.id) || ticket.hold.inputs.length === 0)
/** The reports of an Assignment in order: its ledger, or, for one written before the ledger, the one report it kept, which a worker wrote. */
export const reportHistory = (assignment: Assignment): ReportEntry[] =>
  assignment.reports ?? (assignment.report ? [{ by: 'worker', ...assignment.report }] : [])
/** How long a running worker may say nothing, or only `waiting`, before the host asks it for its status, and again before it tells the main Session. */
export const STALL_MS = 20 * 60_000
/** Where a running Assignment's silence is counted from: the newest sign of life the host recorded for it. */
export const stallAnchor = (assignment: Assignment): string =>
  assignment.idleAt ?? assignment.report?.at ?? assignment.deliveredAt ?? assignment.startedAt ?? assignment.createdAt
/** The anchor of a running Assignment that has been silent past `STALL_MS` at `now` (no report yet, or `waiting`); undefined while it is not stalled. */
export function stalledSince(assignment: Assignment, now: string): string | undefined {
  if (assignment.report && assignment.report.state !== 'waiting') return undefined
  const anchor = stallAnchor(assignment)
  return Date.parse(anchor) < Date.parse(now) - STALL_MS ? anchor : undefined
}
