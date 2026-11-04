/** The turn-stopping hook: one objection per turn, naming what a role still owes, and never twice. */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { holdTurn } from '../src/app/turn.ts'

/**
 * A Session that records what the hook did: the listener it registered, the steering it received, and the history it reports.
 * Only the three things `holdTurn` touches are modelled.
 */
function session(history: { type: string; data: { id?: string } }[] = []) {
  const listeners: ((payload: { agent: Agent }) => void)[] = []
  const steered: { id: string; text: string }[] = []
  const agent = {
    id: 'worker-t1',
    ctx: { on: (name: string, listener: (payload: { agent: Agent }) => void) => { if (name === 'agent/turn-stopping') listeners.push(listener); return () => {} } },
    inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => history },
    steer: (message: { id: string; content: { type: string; text?: string }[] }) => {
      steered.push({ id: message.id, text: message.content.map(block => block.text ?? '').join('') })
    },
  } as unknown as Agent
  /** Fire the stop boundary, as the machine does when the model has nothing left to say. */
  const stop = () => { for (const listener of listeners) listener({ agent }) }
  return { agent, stop, steered }
}

describe('the turn-stopping hook', () => {
  it('steers once with the reason when the role still owes something', () => {
    const { agent, stop, steered } = session()
    holdTurn(agent, { missing: () => 'report first', once: () => 'report:worker-t1' })
    stop()
    expect(steered).toEqual([{ id: 'dsh-superagent:report:worker-t1', text: 'report first' }])
  })

  it('says nothing when the obligation is met', () => {
    const { agent, stop, steered } = session()
    holdTurn(agent, { missing: () => undefined, once: () => 'report:worker-t1' })
    stop()
    expect(steered).toEqual([])
  })

  it('does not steer the same objection twice, so a Session that cannot satisfy it still closes', () => {
    const delivered: { type: string; data: { id: string } }[] = []
    const { agent, stop, steered } = session(delivered)
    holdTurn(agent, { missing: () => 'report first', once: () => 'report:worker-t1' })
    stop()
    // The machine took the steering into the history and the model ended the turn the same way again.
    delivered.push({ type: 'user/message', data: { id: 'dsh-superagent:report:worker-t1' } })
    const forced = vi.fn()
    holdTurn(agent, { missing: () => 'report first', once: () => 'report:worker-t1' }, forced)
    stop()
    stop()
    expect(steered).toHaveLength(1)
    expect(forced).toHaveBeenCalled()
  })

  it('leaves a boundary alone when its payload names another Session', () => {
    const first = session(), second = session()
    holdTurn(first.agent, { missing: () => 'first owes', once: () => 'first' })
    holdTurn(second.agent, { missing: () => 'second owes', once: () => 'second' })
    // Both listeners are registered on their own contexts; firing one Session's boundary must steer only that Session.
    first.stop()
    expect(first.steered.map(item => item.text)).toEqual(['first owes'])
    expect(second.steered).toEqual([])
  })
})
