/**
 * The hook that keeps a turn open when the thing the role owes has not happened.
 *
 * `agent/turn-stopping` fires when the model has nothing left to say: no live tool calls, no fresh steering. A listener that
 * objects calls `agent.steer(...)`, and the machine re-reads its inbox, so the turn runs another step. That is the one place a
 * rule about meaning can be enforced: a schema can refuse a shape, but only the turn boundary knows whether a worker has
 * reported at all.
 *
 * Each role gets one obligation, asked once: a worker must report, a reviewer must give a verdict, and an orchestrator must
 * route every trigger its card delivered. A second attempt is accepted as it stands, because a Session that cannot satisfy the
 * rule must still be able to close — the host records what was missing instead of holding the turn forever.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'

/** What a role owes before its turn may close, as the hook sees the Session. */
export interface Obligation {
  /** The one line asking for what is missing, or undefined when the turn may close. */
  missing(agent: Agent): string | undefined
  /** The request id the forcing message is delivered under, so a second attempt is not forced twice. */
  once: (agent: Agent) => string
}

/**
 * Registers `obligation` on `agent`, and returns its disposer. The message id is derived from the request id, so the same
 * objection steers once per assignment: a model that ends a second turn the same way is taken at its word.
 */
export function holdTurn(agent: Agent, obligation: Obligation, onForced?: (reason: string) => void): () => void {
  return agent.ctx.on('agent/turn-stopping', ({ agent: stopping }) => {
    if (stopping !== agent) return
    const reason = obligation.missing(stopping)
    if (!reason) return
    const id = MessageId(`dsh-superagent:${obligation.once(stopping)}`)
    // A steering message already asking this closes nothing further: the model has been told once.
    if ([...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.id === id)) return
    if (agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === id)) {
      onForced?.(reason)
      return
    }
    agent.steer(freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text: reason }],
      source: { kind: 'dsh-superagent' as const, form: 'relay' as const } }))
  })
}
