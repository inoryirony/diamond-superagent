/** The orchestrator's desk: a compact view of every open ticket, for the `desk` resource and for the main Session's prompt. */
import { latestAssignment, reportHistory, runningAssignment, stallAnchor, stalledSince, ticketStage, type Ticket } from '../core/index.ts'

/** The most characters the prompt's desk summary takes; tickets that do not fit are counted and left to the `desk` resource. */
export const DESK_CHARS = 600
const HEADER = 'Open tickets (id | state | minutes since a sign of life | unreviewed)'

/** A ticket's stage as `stage/action`, the form its card shows. */
function stateOf(ticket: Ticket, reviewing: boolean): string {
  const stage = ticketStage(ticket, reviewing)
  return 'action' in stage && stage.action ? `${stage.stage}/${stage.action}` : stage.stage
}
/** Where a ticket's silence is counted from: the anchor of its newest Assignment (see `stallAnchor`). */
function anchorOf(ticket: Ticket): string {
  const latest = latestAssignment(ticket)
  return latest ? stallAnchor(latest) : ticket.createdAt
}

/** One open ticket as the `desk` resource lists it. `overdue` is the watchdog's own test (see `stalledSince`). */
export function deskLine(ticket: Ticket, now: string, reviewing: boolean) {
  const running = runningAssignment(ticket)
  const reporter = ticket.assignments.findLast(assignment => assignment.report)
  const last = reporter && reportHistory(reporter).at(-1)
  return { ticket_id: ticket.id, title: ticket.title, state: stateOf(ticket, reviewing), since: anchorOf(ticket),
    overdue: !!running && !!stalledSince(running, now), unreviewed: !!ticket.unreviewed,
    last_report: last ? { by: last.by, state: last.state, at: last.at, preview: last.summary.replace(/\s+/g, ' ').slice(0, 100) } : null }
}

/** One line per open ticket, longest silent first, within `DESK_CHARS`; empty when no ticket is open. */
export function deskSummary(tickets: readonly Ticket[], now: string, reviewing: boolean): string {
  const lines = tickets.map(ticket => ({ ticket, anchor: anchorOf(ticket) })).sort((a, b) => a.anchor.localeCompare(b.anchor))
    .map(({ ticket, anchor }) => {
      const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(anchor)) / 60_000))
      return [ticket.id, stateOf(ticket, reviewing), `已过 ${minutes} 分钟`, ...ticket.unreviewed ? ['unreviewed'] : []].join(' | ')
    })
  if (!lines.length) return ''
  const kept: string[] = []
  let size = HEADER.length
  for (const line of lines) {
    if (size + line.length + 1 > DESK_CHARS - 50) break
    kept.push(line); size += line.length + 1
  }
  const more = lines.length - kept.length
  return [HEADER, ...kept, ...more ? [`+${more} more in orchestrator_read desk`] : []].join('\n')
}
