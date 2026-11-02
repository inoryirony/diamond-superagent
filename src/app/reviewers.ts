/** Reviewer runs: each review of a ticket's result in a Session of its own, and its verdict back to the Engine. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { REVIEW_ROUNDS, liveTicket, pendingReview, reviewRound, type ReviewRequest, type ReviewReport, type ReviewerPort, type Ticket }
  from '../core/index.ts'
import { runAsWorker } from '../infra/environment.ts'
import { isReviewerSession, reviewerSessionId, reviewTitle } from '../executor/dsh.ts'
import { Later, type Effects } from './effects.ts'
import { resultRelay } from './notices.ts'

import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

/** How many reviews may run at once: they read and run checks beside the workers, so they are limited on their own. */
export const REVIEW_LIMIT = 4
/** How many review rounds a ticket's results take, which this phase must agree with the core's `Reviews`. */
const ROUNDS = REVIEW_ROUNDS
/** How long a deploy or end-to-end command may run before the review gives up on it and waits for a person. */
const DEPLOY_LIMIT_MS = 30 * 60_000
/** How much of a deploy phase's passing output the ticket keeps as its note. */
const DEPLOY_NOTE_CHARS = 8000

/** What the Reviewer needs from its host. */
export interface ReviewerHost {
  /** Where a review reports its verdict, and what the Relay carries it in. */
  readonly engine: { reviewEnded(ticketId: string, report: ReviewReport): Ticket }
  readonly store: Pick<Store, 'tickets' | 'atomic' | 'afterCommit'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'relay'>
  closing(): boolean
  paused(): boolean
  /** Aborted when dsh-superagent stops, which ends a deploy or end-to-end command that still runs. */
  readonly lifetime: AbortSignal
  /** Runs a command as a worker does, through the DSH subprocess runtime, which strips credential-shaped variables. */
  readonly subprocess: SubprocessRuntime
  /** The execution environment of `ticket`, as its worker reads it. */
  environment(ticket: Ticket): { key: string; value: string }[]
  /** The directory of `ticket`'s workspace, where its worker works and its deploy commands run. */
  directory(ticket: Ticket): string
  /** Records a fact on the ticket for its worker, such as what a deploy phase found; context that asks for nothing. */
  note(ticketId: string, text: string): void
  /**
   * The deploy phase a review runs before it passes a result: the command that deploys the ticket's branch to a test
   * environment and the end-to-end checks that follow it, or undefined while the phase is off.
   */
  deploy(): { command: string; e2e: string } | undefined
}
/**
 * The Reviewer Session a review runs in, and the answer the host gives it when asked: a real Reviewer Session is a language
 * model told, by `prompts/review.md`, to judge the result and finish with `orchestrator_review`; a test answers through
 * `answer` instead. Either way the review ends once its Session is idle, with the verdict it gave or, without one, a verdict
 * that leaves the result to a person.
 */
export interface ReviewerSessions {
  /** The review of `round` of `ticketId` in its Session, or undefined while that Session does not exist. */
  agent(ticketId: string, round: number): Agent | undefined
  /** Dials the review's Session with the request it judges, and returns once the Session is idle, the review over. */
  run(ticketId: string, round: number): Promise<void>
  /** How a review finishes by itself, as a real Reviewer Session's message would make it: the answer a test gives, or nothing. */
  answer?: (ticketId: string, round: number) => ReviewReport | undefined
  /** Finishes the review `sessionId` runs with `report`, as the Reviewer Session's verdict would: a test drives a review this way. */
  reviewed(sessionId: string, report: ReviewReport): Promise<void>
}
/**
 * Reviewer runs each review of a ticket's result in its own Session, beside the workers and outside their slots, and records
 * its verdict through the Engine: a pass delivers the result, a return sends the findings to the worker for the next round,
 * and a review that cannot run or gives no verdict leaves its result for a person.
 */
export class Reviewers implements ReviewerPort, ReviewerSessions {
  private readonly running = new Map<string, Agent>()
  /** What each running review's Session was told to review, by its Session id, for a test's `reviewed`. */
  private readonly told = new Map<string, { ticketId: string; round: number }>()
  answer: ReviewerSessions['answer']
  constructor(private readonly host: ReviewerHost) {
    host.effects.handle('review', request => this.runQueued(request), { limit: () => host.paused() ? 0 : REVIEW_LIMIT, retry: [5000, 300_000] })
    // A Reviewer Session's verdict ends its turn, and with it the run; one that ends its turn without a verdict leaves the
    // result to a person, which is how this phase knows the review is over.
    host.effects.handle('review-verdict', request => this.finishQueued(request), { limit: () => 16, retry: [1000, 30_000] })
  }
  review(request: ReviewRequest): void {
    this.host.effects.enqueue('review', `${request.ticketId}:${request.round}`, request)
  }
  /** Ends the review running on `ticket`, whose result is gone once the ticket ended or a person restarted its worker. */
  stopReview(ticket: Ticket, _reason: string): void {
    const review = pendingReview(ticket)
    if (!review) return
    const sessionId = reviewerSessionId(ticket.id, review.round)
    this.host.store.afterCommit(() => { this.running.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: false }) })
  }
  agent(ticketId: string, round: number): Agent | undefined { return this.running.get(reviewerSessionId(ticketId, round)) }
  /** The review still waiting in the store, as `current` reads it around a delivery. */
  private current(ticketId: string, round: number): boolean {
    const ticket = this.host.store.tickets.get(ticketId)
    const review = ticket && liveTicket(ticket) ? ticket.reviews?.at(-1) : undefined
    return !!ticket && !!review && review.round === round && !review.ended
  }
  private async runQueued(request: ReviewRequest): Promise<void> {
    if (this.host.closing()) throw new Error('dsh-superagent is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    if (!this.current(request.ticketId, request.round)) return
    // The review's turn goes on by itself: what holds it back, such as a deploy command or the model's answer, must not keep
    // a stop from ending the turn, so the effect is complete once the verdict exists rather than once the turn ends.
    void this.run(request.ticketId, request.round).catch((error: unknown) => {
      if (!this.host.closing()) this.unfinished(request.ticketId, request.round, `the review failed: ${String(error)}`)
    })
  }
  /** Opens (or reopens) the review's Session, tells it what to review, and waits for its turn to end. */
  async run(ticketId: string, round: number): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) return
    const sessionId = reviewerSessionId(ticketId, round)
    const directory = ticket.execution?.directory ?? ''
    let agent: Agent
    try {
      agent = await this.host.sessions.ensure(sessionId, directory, reviewTitle(ticket, round), 'reviewer')
      this.running.set(sessionId, agent); this.told.set(sessionId, { ticketId, round })
      const text = JSON.stringify({ ticket_id: ticketId, round, of_rounds: ROUNDS, title: ticket.title, directory,
        topic: `ticket/${ticketId}`, transcript: `ticket/${ticketId}/transcript`,
        ...round > 1 ? { note: 'This round judges whether the findings of the last review were fixed; the worker was sent them.' } : {} })
      // Where the host stands in for the model's verdict, a test answers before the Session's turn can end without one.
      const answered = this.answer?.(ticketId, round)
      if (answered) { await this.apply(sessionId, answered); this.running.delete(sessionId); return }
      await this.host.sessions.prompt(sessionId, `review:${ticketId}:${round}`, text, 'queue')
      // Everything that holds the verdict back goes on beside the review's own turn rather than before it: a review waiting on
      // a deploy, a model call or a check still ends with its turn, so the host can stop.
      const deploy = this.host.deploy()
      if (deploy) void (async () => {
        // The deploy phase runs before the verdict, in the ticket's own directory; a failure is the review's finding.
        const failure = await this.ran(ticketId, deploy)
        if (failure) return this.apply(sessionId, failure)
      })().finally(() => { this.host.effects.enqueue('review-verdict', sessionId, { sessionId }) })
    } catch (error) {
      this.running.delete(reviewerSessionId(ticketId, round))
      if (this.host.closing() || error instanceof Later) throw error
      this.unfinished(ticketId, round, `the review's Session could not start: ${String(error)}`)
      return
    }
    await agent.whenIdle()
    this.running.delete(sessionId)
    // A turn that ends without a verdict cannot pass the result: it waits for a person, as an unfinished review does.
    this.unfinished(ticketId, round, 'the Reviewer ended its turn without a verdict')
  }
  /**
   * Deploys the ticket's branch with `command`, then runs its end-to-end checks with `e2e`, in the ticket directory with the
   * ticket's execution environment. A run that fails, or that a person stopped, goes back as the review's finding, with the
   * command's output as its evidence; a run whose checks pass is noted on the ticket and the review goes on.
   */
  private async ran(ticketId: string, deploy: { command: string; e2e: string }): Promise<ReviewReport | undefined> {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) return { outcome: 'returned', summary: 'The ticket went away before its result could be deployed.', unfinished: true }
    const commands: { name: string; script: string }[] = [
      ...deploy.command ? [{ name: 'deploy', script: deploy.command }] : [],
      ...deploy.e2e ? [{ name: 'end-to-end checks', script: deploy.e2e }] : [],
    ]
    // A deploy phase with nothing to run cannot check the result: it waits for a person, with what to configure.
    if (!commands.length) return { outcome: 'passed', unfinished: true,
      summary: 'The deploy phase is on but names no deploy or end-to-end command, so the result cannot be checked on a test environment.' }
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const directory = this.host.directory(ticket)
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(DEPLOY_LIMIT_MS)])
    const notes: string[] = []
    for (const step of commands) {
      try {
        const output = await runAsWorker(this.host.subprocess, ['sh', '-c', step.script], directory, signal, env)
        notes.push(`${step.name}: passed\n${output.slice(-4000)}`)
      } catch (error) {
        return { outcome: 'returned', summary: `The ${step.name} failed, so the result is not on the test environment working.`,
          findings: [`The ${step.name} command \`${step.script}\` failed: ${String(error).slice(-3000)}`] }
      }
    }
    this.host.note(ticketId, `The deploy phase ran for review ${reviewRound(ticket)}:\n${notes.join('\n\n')}`.slice(0, DEPLOY_NOTE_CHARS))
    return undefined
  }
  async reviewed(sessionId: string, report: ReviewReport): Promise<void> {
    // The verdict is recorded now, in the transaction of the tool call that gave it, and the review's turn ends afterwards.
    await this.apply(sessionId, report)
    this.host.effects.enqueue('review-verdict', sessionId, { sessionId })
  }
  /** Ends the Reviewer Session's turn once its verdict is recorded, as the end of the tool call would. */
  private finishQueued({ sessionId }: { sessionId: string }): Promise<void> {
    this.running.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
    return Promise.resolve()
  }
  /** Re-opens the reviews a restart left running, in a Session of the same id, so no result waits on a review nobody runs. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open()) {
      const review = pendingReview(ticket)
      if (review) this.review({ ticketId: ticket.id, assignmentId: review.assignmentId, round: review.round })
    }
  }
  /** Tell the main Session that the winner of the review is ready for a person, as a ready report would have. */
  private relayResult(ticket: Ticket, summary: string): void {
    const relay = resultRelay(ticket, 'ready', summary)
    if (relay) this.host.sessions.relay(relay.id, relay.text)
  }
  /** Records `report` as the verdict of the review `sessionId` runs, unless that review already ended. */
  private async apply(sessionId: string, report: ReviewReport): Promise<void> {
    const told = this.told.get(sessionId)
    if (!told || !this.current(told.ticketId, told.round)) return
    const updated = this.host.store.atomic(() => this.host.engine.reviewEnded(told.ticketId, report))
    // A result that passes its review goes to the person who asked, in the main Session, as a ready report would.
    if (report.outcome === 'passed' && !report.unfinished && !liveTicket(updated)) {
      const summary = updated.assignments.findLast(assignment => assignment.report)?.report?.summary ?? report.summary
      this.relayResult(updated, summary)
    }
  }
  /** Leaves the result under an unfinished review for a person, unless the review ended meanwhile. */
  private unfinished(ticketId: string, round: number, why: string): void {
    if (!this.current(ticketId, round)) return
    this.host.store.atomic(() => {
      const updated = this.host.engine.reviewEnded(ticketId, { outcome: 'passed', summary: `Review ${round} did not finish: ${why}; a person must look at the result.`, unfinished: true })
      this.relayResult(updated, updated.assignments.findLast(assignment => assignment.report)?.report?.summary ?? '')
    })
  }
}
