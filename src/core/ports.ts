/** Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific. */
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, ReviewOutcome, Strength, Thread, Ticket, TicketEndBy,
  TicketOutcome, Trigger } from './model.ts'
import type { Reason } from './reasons.ts'

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  revalidate(mandate: Mandate): boolean
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  admitsInferred(rules: readonly string[]): boolean
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs: number
}

/** What the assessor receives: bounded facts, never authority. */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every live ticket, on any thread, and the ended ones of this thread, for duplicate and relation judgement. */
  tickets: Ticket[]
  /**
   * The board's revision when this candidate was formed. A decision holds to it: a ticket that changed after it is shown to
   * the main Session before its decision is recorded, so two lanes never open the same work twice.
   */
  boardSeq: number
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** An accept: `rules` the assessment matched, `name` the ticket's requested short name, and `note` a routing note for its worker. */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** What a review found: the work passes or goes back to the worker, with a summary and, when it goes back, the findings it must fix. */
export interface ReviewReport {
  outcome: ReviewOutcome
  summary: string
  findings?: string[]
  /**
   * The result waits for a person instead: the review could not judge it, such as when its Session could not start or gave no
   * verdict. The ticket then reads `person/review`, and a retry reviews the same result again.
   */
  unfinished?: true
}

/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
export interface Assessor {
  request(candidate: Candidate): void
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void
}

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
export interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in the domain. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
  /** End an assignment as `returned`: a review sent its result back, and the worker takes it up again in a new assignment. */
  returned?(ticket: Ticket, assignment: Assignment, reason: string): void
  /**
   * Whether results are reviewed before a ticket delivers or ends them; a ready report then asks for a review rather than
   * being the ticket's result (see `Ticket.reviews`).
   */
  reviews?(): boolean
}

/** What a review asks of an Executor: which ticket, the result it reviews, and the round it is. */
export interface ReviewRequest {
  ticketId: string
  /** The Assignment whose ready result the review judges; a review of a ticket without a result judges its last assignment. */
  assignmentId: string
  round: number
}

/**
 * Judges a ticket's result in a Session of its own, with code and the original request; the Engine queues it inside its
 * commands and it reports back through `Engine.reviewEnded`.
 */
export interface ReviewerPort {
  /** Queue a review; reports back through `Engine.reviewEnded`, an `unfinished` verdict when it cannot run or give one. */
  review(request: ReviewRequest): void
  /** End the review running on `ticket`; called after the ticket ended or a person restarted its worker. */
  stopReview(ticket: Ticket, reason: string): void
}

/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** A queued message waits (`pending`), went out (`sent`), or was dropped because its conversation can never receive it (`dropped`). */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
export interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  send(message: OutboundMessage): void
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined
  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void
}

/** What the Engine reports after a change, by event type. */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  /** A ticket's result went to review: the round, and the Assignment whose result it judges. */
  'ticket.reviewing': { ticketId: string; round: number; assignmentId: string }
  /**
   * A review returned a result in its last round: the rounds are spent, so nothing more happens on its own. The main
   * Session decides what comes next — start the worker again with a narrower instruction, change the approach, or leave it
   * to a person. Emitted instead of silently parking the ticket, so the orchestrator learns why the worker keeps failing.
   */
  'ticket.reviewRoundsSpent': { ticketId: string; round: number; assignmentId: string; findings: string[] }
  /**
   * A running worker stayed silent, or only `waiting`, past `STALL_MS` after the host asked it for its status once: the main
   * Session decides whether to ask again or restart it. The ticket and its Assignment are left as they are.
   */
  'ticket.stalled': { ticketId: string; assignmentId: string; idleForMs: number }
  /**
   * A held ticket's `dueAt` passed with nobody settling it: the main Session asks the people again, or escalates to the
   * operator. A hold that is never asked about would be a second kind of silent stop.
   */
  'ticket.holdDue': { ticketId: string; question: string; askedAt?: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** A person dropped every ticket's Subscription, or a ticket's Executor its own, for `reason`. */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  'trigger.followup': { triggerId: string }
  /** A Trigger queued on a Thread whose Eval is in progress; it waits for the next Eval unless that Eval's Session routes it. */
  'trigger.queuedBehindEval': { triggerId: string; evalId: string }
  'policy.changed': { from: string; to: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    active(): Ticket[]
    /** The board's newest change; a Candidate carries it so a later decision can tell what changed since. */
    boardSeq(): number
    /** The open tickets whose content changed after `since`, with the revision each changed at. */
    changedSince(since: number): { ticket: Ticket; revision: number }[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
