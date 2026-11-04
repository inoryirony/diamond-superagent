/**
 * Eval Session retention: an Eval that decided a ticket stays readable, because the ticket may be read back to it; every other
 * Eval is archived. `docs/007` promises an Eval Session "stays readable after the Decision", and the per-Eval Session of
 * `docs/001` means the count grows with every message, so the set has to be bounded rather than kept whole.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Decision } from '../core/index.ts'
import { KV } from '../kv.ts'
import { evalSessionId } from './sessions.ts'
import type { Store } from './store.ts'

/**
 * How many Eval Sessions are kept readable per lane. A lane is one conversation, and the ones worth reading back are the Evals
 * that opened or reached a ticket there; a busier lane pushes its own oldest aside rather than growing without bound.
 */
export const KEEP_PER_LANE = 10
/** The sessions a sweep keeps, and those it archives, from the decisions recorded so far. */
export interface Retention { keep: string[]; archive: string[] }
/**
 * Splits decided Evals into the Sessions to keep and those to archive. Newest first, an Eval that decided a ticket is kept while
 * its lane has room; an Eval that decided no ticket, such as an ignore, is archived, because no ticket carries work it could be
 * read back for. Several Evals can reach one ticket, so that ticket keeps only the newest of them.
 * @param decisions every Decision, in any order; the newest of a lane decide that lane's budget.
 */
export function retain(decisions: readonly Decision[], perLane = KEEP_PER_LANE): Retention {
  const keep: string[] = [], archive: string[] = []
  const newestFirst = [...decisions].sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
  const lanes = new Map<string, number>()
  const tickets = new Set<string>()
  for (const decision of newestFirst) {
    const session = evalSessionId(decision.evalId)
    const ticket = decision.ticketId
    const room = (lanes.get(decision.threadKey) ?? 0) < perLane
    if (ticket === undefined || !room || tickets.has(ticket)) { archive.push(session); continue }
    keep.push(session)
    tickets.add(ticket)
    lanes.set(decision.threadKey, (lanes.get(decision.threadKey) ?? 0) + 1)
  }
  return { keep, archive }
}
/** What retention needs from its host: the decisions recorded, a way to archive, and whether a Session is still live. */
export interface RetentionHost {
  /** Every Decision, newest first; a lane's budget is spent on its newest ones. */
  decisions(): readonly Decision[]
  /** Every Eval Session that exists, which includes the ones abandoned before they decided anything. */
  sessions(): readonly string[]
  /** The Eval Sessions still deciding, which no sweep may touch. */
  active(): readonly string[]
  readonly store: Pick<Store, 'get' | 'set'>
  /** Archives Sessions durably. */
  archive(sessionIds: readonly string[]): Promise<void>
  /** Whether the Session still runs, whose turn a sweep should not take away. */
  live(sessionId: string): boolean
  log(message: string): void
}
/**
 * Applies `retain` to what is on disk, remembering what it already archived so a settled Session is not asked about again. A
 * refusal, such as a turn still running, leaves the Session for the next sweep.
 */
export class EvalRetention {
  private readonly asked = new Set<string>()
  constructor(private readonly host: RetentionHost) {}
  /**
   * Archives every Eval Session retention no longer keeps, and returns the ones this sweep archived. An Eval Session with no
   * Decision is archived too: it was abandoned before deciding, so nothing can be read back from it and no ticket names it.
   */
  async sweep(): Promise<string[]> {
    const decisions = this.host.decisions()
    const decided = new Set(decisions.map(decision => evalSessionId(decision.evalId)))
    const archive = decisions.length ? retain(decisions).archive : []
    // A Session on disk with no Decision at all: abandoned, or still deciding, which `active` tells apart.
    const undecided = this.host.sessions().filter(session => !decided.has(session))
    const active = new Set(this.host.active())
    const done = new Set(this.host.store.get(KV.runtime.archivedEvals) ?? [])
    const pending = [...archive, ...undecided].filter(session => !active.has(session) && !this.asked.has(session)
      && !done.has(session) && !this.host.live(session))
    if (!pending.length) return []
    const archived: string[] = []
    for (const session of pending) {
      this.asked.add(session)
      try {
        await this.host.archive([session])
        archived.push(session)
      } catch (error) {
        // A Session that is running, or already archived, is asked about again only when it is neither.
        this.asked.delete(session)
        this.host.log(`dsh-superagent could not archive Eval Session ${session}: ${String(error)}`)
      }
    }
    if (archived.length) {
      const kept = [...done, ...archived]
      // Keep the record bounded: an archived Session needs remembering only while a sweep could see its Decision again.
      this.host.store.set(KV.runtime.archivedEvals, kept.slice(-500))
      this.host.log(`dsh-superagent archived ${archived.length} Eval Session(s): ${archived.join(', ')}`)
    }
    return archived
  }
}
