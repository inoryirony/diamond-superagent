/** Eval Session retention: a Decision that created a ticket stays readable, and every other Eval Session is archived. */
import { describe, expect, it, vi } from 'vitest'
import type { Decision } from '../src/core/index.ts'
import { EvalRetention, KEEP_PER_LANE, retain } from '../src/app/eval-retention.ts'
import { evalSessionId } from '../src/app/sessions.ts'
import { KV } from '../src/kv.ts'

let clock = 0
/** One Decision of `lane`, at a time later than the one before, with a ticket only when `ticket` is given. */
const decision = (lane: string, options: { ticket?: string; kind?: Decision['kind']; eval?: string } = {}): Decision => ({
  id: `decision-${lane}-${++clock}`, evalId: options.eval ?? `${lane}-${clock}`, threadKey: lane, triggerIds: [],
  policyVersion: 'v1', at: new Date(Date.parse('2026-11-04T00:00:00Z') + clock * 1000).toISOString(),
  kind: options.kind ?? (options.ticket ? 'accept' : 'ignore'), reason: [], strength: 'explicit',
  ...options.ticket ? { ticketId: options.ticket } : {} })

describe('eval retention', () => {
  it('keeps the Eval Sessions that decided a ticket and archives the ones that decided nothing', () => {
    const decisions = [decision('lane-a', { ticket: 't1' }), decision('lane-a'), decision('lane-a', { ticket: 't2' }),
      decision('lane-a', { kind: 'unavailable' }), decision('lane-b', { ticket: 't3' })]
    const { keep, archive } = retain(decisions)
    const ticketDecisions = decisions.filter(item => item.ticketId !== undefined)
    expect(new Set(keep)).toEqual(new Set(ticketDecisions.map(item => evalSessionId(item.evalId))))
    expect(new Set(archive)).toEqual(new Set(decisions.filter(item => item.ticketId === undefined).map(item => evalSessionId(item.evalId))))
  })
  it('keeps only the newest Eval Session of a ticket several Evals reached', () => {
    // Two Evals accepted the same ticket: the later one read what the earlier did, so only it is worth reading back.
    const earlier = decision('lane-a', { ticket: 't1' })
    const later = decision('lane-a', { ticket: 't1' })
    const { keep, archive } = retain([earlier, later])
    expect(keep).toEqual([evalSessionId(later.evalId)])
    expect(archive).toEqual([evalSessionId(earlier.evalId)])
  })
  it('bounds a lane by its newest ticket Evals, pushing the older ones aside', () => {
    const decisions = Array.from({ length: KEEP_PER_LANE + 3 }, (_, index) => decision('lane-a', { ticket: `t${index}` }))
    const { keep, archive } = retain(decisions)
    expect(keep).toHaveLength(KEEP_PER_LANE)
    expect(archive).toHaveLength(3)
    // The newest are the ones kept: the three oldest tickets give way.
    expect(keep).toEqual(decisions.slice(3).reverse().map(item => evalSessionId(item.evalId)))
  })
  it('leaves a lane with room alone while another lane is over its budget', () => {
    const decisions = [...Array.from({ length: KEEP_PER_LANE }, (_, index) => decision('busy', { ticket: `busy-${index}` })),
      decision('quiet', { ticket: 'quiet-1' }), decision('busy', { ticket: 'busy-extra' })]
    const { keep } = retain(decisions)
    expect(keep).toContain(evalSessionId(decisions.at(-1)!.evalId))
    expect(keep).toContain(evalSessionId(decisions.at(-2)!.evalId))
  })
})

describe('eval retention sweep', () => {
  const host = (decisions: Decision[], overrides: { live?: (id: string) => boolean; archive?: () => Promise<void>;
    sessions?: string[]; active?: string[] } = {}) => {
    const kept = new Map<string, unknown>()
    const archive = vi.fn(async (_ids: readonly string[]) => { await overrides.archive?.() })
    return {
      kept, archive,
      retention: new EvalRetention({ decisions: () => decisions,
        sessions: () => overrides.sessions ?? decisions.map(decision => evalSessionId(decision.evalId)),
        active: () => overrides.active ?? [],
        store: { get: <V>(name: string) => kept.get(name) as V | undefined,
          set: <V>(name: string, value: V | undefined) => { if (value === undefined) kept.delete(name); else kept.set(name, value) } },
        archive: async ids => { await archive(ids) },
        live: overrides.live ?? (() => false), log: () => {} }),
    }
  }
  it('archives only what retention drops, and records it so the next sweep asks nothing', async () => {
    const kept = decision('lane-a', { ticket: 't1' })
    const dropped = decision('lane-a')
    const { retention, archive, kept: store } = host([kept, dropped])
    expect(await retention.sweep()).toEqual([evalSessionId(dropped.evalId)])
    expect(archive).toHaveBeenCalledWith([evalSessionId(dropped.evalId)])
    expect(store.get(KV.runtime.archivedEvals)).toEqual([evalSessionId(dropped.evalId)])
    // The second sweep has nothing left to do, and the kept one is never asked about.
    expect(await retention.sweep()).toEqual([])
    expect(archive).toHaveBeenCalledTimes(1)
  })
  it('leaves a Session with a running turn to the next sweep', async () => {
    const dropped = decision('lane-a')
    const { retention, archive } = host([dropped], { live: () => true })
    expect(await retention.sweep()).toEqual([])
    expect(archive).not.toHaveBeenCalled()
  })
  it('retries a Session whose archive failed, rather than forgetting it', async () => {
    const dropped = decision('lane-a')
    const { retention, archive } = host([dropped], { archive: async () => { throw new Error('archive refused') } })
    expect(await retention.sweep()).toEqual([])
    expect(archive).toHaveBeenCalledTimes(1)
    // The failure is not recorded as archived, so the next sweep tries it again.
    expect(await retention.sweep()).toEqual([])
    expect(archive).toHaveBeenCalledTimes(2)
  })
  it('archives a Session that was abandoned before it decided anything', async () => {
    // An Eval whose Session exists but whose Decision never came: nothing can be read back from it, and no ticket names it.
    const { retention, archive } = host([], { sessions: ['eval-abandoned'] })
    expect(await retention.sweep()).toEqual(['eval-abandoned'])
    expect(archive).toHaveBeenCalledWith(['eval-abandoned'])
  })
  it('leaves a Session that is still deciding alone', async () => {
    const { retention, archive } = host([], { sessions: ['eval-deciding'], active: ['eval-deciding'] })
    expect(await retention.sweep()).toEqual([])
    expect(archive).not.toHaveBeenCalled()
  })
})
