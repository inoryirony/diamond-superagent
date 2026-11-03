/** Report ledger, review budget, unreviewed endings, the liveness watchdog and the desk summary. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, reportHistory, reviewRequired, reviewsInAttempt } from '../src/core/index.ts'
import type { Assignment, DomainEvent, Executor, Policy, Ticket, TicketReview } from '../src/core/index.ts'
import { deskSummary } from '../src/app/desk.ts'

const BASE = Date.UTC(2026, 8, 23)
const iso = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString()

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return { id: 'a1', state: 'running', createdAt: iso(0), startedAt: iso(0), ...overrides }
}
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return { id: 't1', title: 'Fix', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'chat', id: 'alice' }, scope: 'small' },
    channels: [], assignments: [assignment()], inputs: [], undelivered: [], createdAt: iso(0), updatedAt: iso(0),
    origin: { triggerId: '1', triggerIds: ['1'] }, ...overrides }
}
const review = (round: number, ended?: TicketReview['ended']): TicketReview => ({ assignmentId: 'a1', round, at: iso(round), ...ended ? { ended } : {} })
const returned = (round: number) => review(round, { at: iso(round), outcome: 'returned', summary: 'No.', findings: ['Fix it.'] })
const passed = (round: number) => review(round, { at: iso(round), outcome: 'passed', summary: 'Fine.' })
const unfinished = (round: number) => review(round, { at: iso(round), outcome: 'passed', summary: 'Could not judge.', unfinished: true })

/** An Engine over memory repositories whose clock the test sets in minutes after BASE; it starts at minute 60. */
function harness({ reviews = false } = {}) {
  const repo = new MemoryRepositories()
  const events: DomainEvent[] = []
  let minutes = 60
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), reviews: () => reviews }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: false, reason: 'none' }),
    revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request: vi.fn() }, executor, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    emit: event => { events.push(event) }, now: () => iso(minutes) })
  return { repo, engine, executor, events, at: (value: number) => { minutes = value },
    stalled: () => events.filter(event => event.type === 'ticket.stalled') }
}

describe('report ledger', () => {
  it('appends every report with its author, and keeps `report` as the mirror of the last', () => {
    const h = harness()
    h.repo.tickets.save(ticket())
    h.engine.report('t1', { state: 'progress', summary: 'working' })
    h.engine.report('t1', { state: 'waiting', summary: 'idle' }, { by: 'host' })
    const stored = h.repo.tickets.get('t1')!.assignments[0]!
    expect(reportHistory(stored)).toEqual([{ by: 'worker', state: 'progress', summary: 'working', at: iso(60) },
      { by: 'host', state: 'waiting', summary: 'idle', at: iso(60) }])
    expect(stored.report).toEqual({ state: 'waiting', summary: 'idle', at: iso(60) })
  })
  it('reads an Assignment written before the ledger as one worker report', () => {
    const legacy = assignment({ report: { state: 'ready', summary: 'Done.', at: iso(1) } })
    expect(reportHistory(legacy)).toEqual([{ by: 'worker', state: 'ready', summary: 'Done.', at: iso(1) }])
    expect(reportHistory(assignment())).toEqual([])
  })
})

describe('review budget', () => {
  const result = { assignments: [assignment({ report: { state: 'ready' as const, summary: 'Done.', at: iso(50) } })] }
  it('spends no round on reviews that ended unfinished, or have not ended', () => {
    const none = ticket({ ...result, reviews: [unfinished(1), unfinished(2), unfinished(3)] })
    expect(reviewsInAttempt(none)).toBe(0)
    expect(reviewRequired(none, true, 3)).toBe(true)
    expect(reviewsInAttempt(ticket({ ...result, reviews: [review(1)] }))).toBe(0)
  })
  it('counts a passed review and leaves two rounds when two more ended unfinished', () => {
    const one = ticket({ ...result, reviews: [passed(1), unfinished(2), unfinished(3)] })
    expect(reviewsInAttempt(one)).toBe(1)
    expect(reviewRequired(one, true, 3)).toBe(true)
    expect(reviewRequired(one, true, 1)).toBe(false)
  })
  it('counts returned reviews, so three of them spend the rounds', () => {
    const spent = ticket({ ...result, reviews: [returned(1), returned(2), returned(3)] })
    expect(reviewsInAttempt(spent)).toBe(3)
    expect(reviewRequired(spent, true, 3)).toBe(false)
  })
})

describe('a ready result after the review rounds are spent', () => {
  it('ends the ticket marked unreviewed and says the rounds are spent', () => {
    const h = harness({ reviews: true })
    h.repo.tickets.save(ticket({ reviews: [returned(1), returned(2), returned(3)] }))
    h.engine.report('t1', { state: 'ready', summary: 'Done anyway.' })
    const stored = h.repo.tickets.get('t1')!
    expect(stored.ended).toMatchObject({ outcome: 'completed', by: 'executor' })
    expect(stored.unreviewed).toBe(true)
    expect(h.events.filter(event => event.type === 'ticket.reviewRoundsSpent')).toHaveLength(1)
  })
  it('leaves a ticket unmarked when reviews are off', () => {
    const h = harness({ reviews: false })
    h.repo.tickets.save(ticket({ reviews: [returned(1), returned(2), returned(3)] }))
    h.engine.report('t1', { state: 'ready', summary: 'Done.' })
    const stored = h.repo.tickets.get('t1')!
    expect(stored.ended).toMatchObject({ outcome: 'completed' })
    expect(stored.unreviewed).toBeUndefined()
    expect(h.events.some(event => event.type === 'ticket.reviewRoundsSpent')).toBe(false)
  })
})

describe('liveness watchdog', () => {
  const waiting = () => ticket({ assignments: [assignment({ report: { state: 'waiting', summary: 'idle', at: iso(35) } })] })
  it('probes a worker that waited past the limit once, without telling the main Session yet', () => {
    const h = harness()
    h.repo.tickets.save(waiting())
    h.engine.evaluateDue()
    const stored = h.repo.tickets.get('t1')!
    expect(stored.assignments[0]!.probedAt).toBe(iso(60))
    expect(stored.inputs.some(input => input.kind === 'text' && input.id.startsWith('status:'))).toBe(true)
    expect(h.stalled()).toHaveLength(0)
    h.engine.evaluateDue()
    expect(h.repo.tickets.get('t1')!.inputs.filter(input => input.id.startsWith('status:'))).toHaveLength(1)
  })
  it('tells the main Session once when the worker stays silent after the probe, and changes nothing else', () => {
    const h = harness()
    const stored = waiting()
    stored.assignments[0]!.probedAt = iso(35)
    h.repo.tickets.save(stored)
    h.engine.evaluateDue()
    expect(h.stalled()).toHaveLength(1)
    expect(h.stalled()[0]!.data).toEqual({ ticketId: 't1', assignmentId: 'a1', idleForMs: 25 * 60_000 })
    expect(h.repo.tickets.get('t1')).toMatchObject({ updatedAt: iso(60) })
    expect(h.repo.tickets.get('t1')!.assignments[0]).toMatchObject({ state: 'running' })
    expect(h.repo.tickets.get('t1')!.ended).toBeUndefined()
    h.engine.evaluateDue()
    expect(h.stalled()).toHaveLength(1)
  })
  it('probes a worker that never reported once its anchor is old, and leaves one that is making progress alone', () => {
    const silent = harness()
    silent.repo.tickets.save(ticket())
    silent.engine.evaluateDue()
    expect(silent.repo.tickets.get('t1')!.assignments[0]!.probedAt).toBe(iso(60))
    const busy = harness()
    busy.repo.tickets.save(ticket({ assignments: [assignment({ report: { state: 'progress', summary: 'working', at: iso(10) } })] }))
    busy.engine.evaluateDue()
    expect(busy.repo.tickets.get('t1')!.assignments[0]!.probedAt).toBeUndefined()
    expect(busy.stalled()).toHaveLength(0)
  })
})

describe('desk summary', () => {
  it('lists open tickets with state, minutes and the unreviewed mark', () => {
    const text = deskSummary([ticket({ unreviewed: true }), ticket({ id: 't2', createdAt: iso(30), assignments: [assignment({ id: 'a2', createdAt: iso(30), startedAt: iso(30) })] })], iso(60), false)
    expect(text).toContain('t1 | working | 已过 60 分钟 | unreviewed')
    expect(text).toContain('t2 | working | 已过 30 分钟')
  })
  it('stays within 600 characters and counts the tickets it leaves out', () => {
    const many = Array.from({ length: 60 }, (_, index) => ticket({ id: `ticket-${index}` }))
    const text = deskSummary(many, iso(60), false)
    expect(text.length).toBeLessThanOrEqual(600)
    expect(text).toMatch(/\+\d+ more/)
    expect(deskSummary([], iso(60), false)).toBe('')
  })
})
