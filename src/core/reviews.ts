/** Reviews: a ticket's result goes to a review of its own before the ticket delivers or ends it. */
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, reportHistory, reviewRequired, reviewRound, reviewedWork, reviewsInAttempt } from './model.ts'
import type { Assignment, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { ReviewReport, ReviewerPort } from './ports.ts'
import type { Tickets } from './tickets.ts'

/**
 * How many review rounds one attempt at the work may take before a returned result waits for a person instead of going back to
 * the worker. The bound is per attempt: a review that returns a result gives the worker a new Assignment that revises the same
 * work, so without it a reviewer and a worker could loop; but a person's follow-up, a retry or the orchestrator acting on the
 * findings starts a new attempt, which has its own rounds.
 */
export const REVIEW_ROUNDS = 3

/**
 * Reviews keeps the reviews of a ticket's results and their verdicts. A ready report goes to `start`, which records the
 * review and asks the Reviewer to judge that result in a Session of its own; the Reviewer reports back through `end`, which
 * passes the result on as the report would have, or returns it to the worker with the findings as an Input. The rounds keep
 * a loop between a reviewer and a worker bounded, the last one leaving a returned result for a person. It depends on
 * Tickets to restart the worker and end the ticket, and on the Executor and Reviewer ports to run both roles.
 */
export class Reviews extends EnginePart {
  private readonly reviewer: ReviewerPort
  constructor(options: EngineOptions, reviewer: ReviewerPort, private readonly tickets: Tickets) {
    super(options)
    this.reviewer = reviewer
  }
  /**
   * Whether this ticket's ready result asks for a review: reviews are on, the work changed code, and its rounds last. A
   * Reviewer judges a diff; a result that only read data, ran a check or edited prose has nothing for it to judge, so it goes
   * to a person directly instead of spending a round on a review that can only restate the report.
   */
  required(ticket: Ticket): boolean {
    const on = this.options.executor.reviews?.() ?? false
    if (!on) return false
    // The latest report says what the work was; a report that did not say is read as a code change, the stricter default.
    const work = reportHistory(latestAssignment(ticket) ?? ({} as Assignment)).at(-1)?.work
    if (!reviewedWork(work)) return false
    return reviewRequired(ticket, true, REVIEW_ROUNDS)
  }
  /**
   * Ends any review still running on `assignment`'s earlier result, for a newer report that replaces it. The worker revised
   * and reported again before the reviewer finished, so that review judged a result nobody will deliver; leaving it open
   * would keep it `unfinished` for a person forever. It ends as unfinished, naming why, and the new report gets its own review.
   */
  supersede(ticket: Ticket, assignmentId: string): void {
    const stale = (ticket.reviews ?? []).filter(review => review.assignmentId === assignmentId && !review.ended)
    if (!stale.length) return
    const at = this.now()
    for (const review of stale) {
      review.ended = { at, outcome: 'passed', unfinished: true,
        summary: `Review ${review.round} was superseded: the worker reported a newer result before this review finished, so this one judged a result the ticket no longer has.` }
      this.reviewer.stopReview(ticket, `review ${review.round} superseded by a newer result`)
    }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
  }
  /** Record that `assignment`'s ready result goes to review round `round` and queue the review. */
  start(ticket: Ticket, assignment: Assignment): void {
    const round = reviewRound(ticket)
    const at = this.now()
    ticket.reviews = [...ticket.reviews ?? [], { assignmentId: assignment.id, round, at }]
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.reviewer.review({ ticketId: ticket.id, assignmentId: assignment.id, round })
    this.emit('ticket.reviewing', { ticketId: ticket.id, round, assignmentId: assignment.id })
  }
  /** The review still running on `ticketId`, for the Reviewer's report. */
  running(ticketId: string): boolean {
    const ticket = this.repo.tickets.get(ticketId)
    return !!ticket && liveTicket(ticket) && !!ticket.reviews?.at(-1) && !ticket.reviews.at(-1)!.ended
  }
  /**
   * Record the verdict of the review running on `ticketId`. A pass delivers the result as the ready report would have, and
   * ends the ticket when its work is done; a return sends the findings to the worker, which revises the same work, unless the
   * rounds are spent and the result waits for a person after all.
   * @throws UserError when the ticket is unknown, ended, or has no review running.
   */
  end(ticketId: string, report: ReviewReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const review = ticket.reviews?.at(-1)
    if (!review || review.ended) throw new UserError('noReviewRunning')
    const at = this.now()
    review.ended = { at, outcome: report.outcome, summary: report.summary,
      ...report.findings?.length ? { findings: report.findings } : {}, ...report.unfinished ? { unfinished: true as const } : {} }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    // A review that could not judge the result leaves it for a person: it is delivered as once, not passed on as if judged.
    if (report.unfinished) return this.require(ticketId)
    if (report.outcome === 'passed') { this.tickets.finishReviewed(ticketId, at); return this.require(ticketId) }
    // The rounds bound this attempt, counted after this review ended, so the third returned result of an attempt is the last
    // that goes back to the worker.
    if (report.findings?.length && reviewsInAttempt(this.require(ticketId)) < REVIEW_ROUNDS) {
      this.tickets.returned(ticketId, report); return this.require(ticketId)
    }
    // The rounds are spent with the result still returned: nothing runs on its own any more, so the main Session is told what
    // the reviewer kept finding. It may start the worker again with a narrower instruction or hand the ticket to a person;
    // until it does, the ticket waits at `person / returned`.
    if (report.findings?.length) this.emit('ticket.reviewRoundsSpent',
      { ticketId, round: review.round, assignmentId: review.assignmentId, findings: report.findings })
    return this.require(ticketId)
  }
  /** Stop the review running on `ticket`, such as when a person stops the ticket. */
  stop(ticket: Ticket, reason: string): void {
    if (ticket.reviews?.some(review => !review.ended)) this.reviewer.stopReview(ticket, reason)
  }
  /** The Assignment whose result the newest review judges, for a restart of its worker. */
  reviewed(ticket: Ticket): Assignment | undefined {
    const review = ticket.reviews?.at(-1)
    return review ? ticket.assignments.find(assignment => assignment.id === review.assignmentId) ?? latestAssignment(ticket) : undefined
  }
}
