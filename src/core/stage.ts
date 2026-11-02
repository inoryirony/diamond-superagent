/** Ticket stage classification and retry eligibility (docs/003). */
import { latestAssignment, pendingReview, waitsForPerson, type Ticket } from './model.ts'

/**
 * High-level execution stage of a ticket: waiting on a person, its result under review, actively working or queued, idle
 * between turns, or ended.
 */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'returned' | 'blocked' | 'failed' }
  | { stage: 'review'; action: 'running' } | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/**
 * Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins.
 * @param reviewing - Whether the executor reviews a ready result before the ticket delivers or ends it: the first review of
 * a result is running, and a review that returned the result waits on the worker, not on a person.
 */
export function ticketStage(ticket: Ticket, reviewing = false): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  if (pendingReview(ticket)) return { stage: 'review', action: 'running' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  // A review that returned the result waits on the worker, which revises it before the next review; a passed one waits on a person.
  const last = (ticket.reviews ?? []).at(-1)
  // A review that could not judge the result leaves it to a person, as a result no review took up does.
  if (last?.ended?.unfinished) return { stage: 'person', action: 'review' }
  if (last?.ended?.outcome === 'returned') return reviewing ? { stage: 'working' } : { stage: 'person', action: 'returned' }
  if (report === 'ready') {
    // The first result of a ticket whose executor reviews results is under review until a review ends; with the review off or
    // the rounds spent, it waits on a person as before.
    const reviewed = last && last.at > (ticket.assignments.find(item => item.report?.state === 'ready')?.report?.at ?? '')
    return reviewing && !reviewed ? { stage: 'review', action: 'running' } : { stage: 'person', action: 'review' }
  }
  // A human follow-up after a blocked or failed report returns the ticket to the executor.
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}
