/** What a Session did with its tools, read from the `tool/call` events of its log: what a review or a ready report is checked against. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ReviewReport } from '../core/index.ts'

/** The tools that change files: a Reviewer Session that used one judged code it had changed. */
const CHANGING = ['write', 'edit']
/** The tools that run something and show what it printed, which a ready report's evidence comes from. */
const RUNNING = ['bash', 'pwsh', 'web_search', 'web_fetch']

/**
 * The names of the tools a Session called, in order, from `since` (Unix epoch milliseconds; its whole log by default). DSH records
 * a `tool/call` event as each call starts, with the tool's `name`.
 */
export function toolCalls(agent: Pick<Agent, 'session'>, since = 0): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'tool/call' && event.time >= since ? [event.data.name] : [])
}

/**
 * The tools a Session called with the arguments each was given, in order, from `since`. `arguments` is the raw JSON string the
 * model produced, unparsed, as DSH logs it.
 */
export function toolCallsWithArguments(agent: Pick<Agent, 'session'>, since = 0): { name: string; arguments: string }[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'tool/call' && event.time >= since
    ? [{ name: event.data.name, arguments: event.data.arguments }]
    : [])
}

/** The arguments of a call as an object, or undefined when they are not a JSON object. */
function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/**
 * Whether a Session read the conversation `trigger` was written in: it read the trigger's own resource, which carries the live
 * history, or an Eval's read of it, or listed that conversation's messages itself with `dws`. Reading some other trigger or some
 * other conversation does not count.
 */
export function readConversation(calls: readonly { name: string; arguments: string }[],
  trigger: { id: string; conversationId?: string | undefined; peerOpenId?: string | undefined }): boolean {
  return calls.some(call => {
    const args = parsed(call.arguments)
    if (call.name === 'orchestrator_read') return typeof args?.resource === 'string' && args.resource.replace(/^event\//, 'trigger/') === `trigger/${trigger.id}`
    // An Eval's read names its trigger in `trigger_id`; unparsable arguments still count when they quote the ID.
    if (call.name === 'orchestrator_eval_read') return args ? args.trigger_id === trigger.id : call.arguments.includes(JSON.stringify(trigger.id))
    if (call.name === 'bash') {
      const command = typeof args?.command === 'string' ? args.command : ''
      const names = (id: string | undefined) => !!id && command.includes(id)
      return command.includes('dws chat message list') && (names(trigger.conversationId) || names(trigger.peerOpenId))
    }
    return false
  })
}

/**
 * The verdict a Reviewer Session may give: its own, unless its calls include a change to a file. A review that changed the code it
 * judged gave no judgement, so its verdict is void and recorded as unfinished, which leaves the result to a person.
 */
export function audited(report: ReviewReport, calls: readonly string[]): ReviewReport {
  if (report.unfinished || !calls.some(name => CHANGING.includes(name))) return report
  return { outcome: 'passed', unfinished: true,
    summary: `The Reviewer Session changed the code it judged, so its verdict is void and a person must look at the result. It had given ${report.outcome}: ${report.summary}` }
}

/**
 * Why a ready report is refused, or undefined when it may stand. After a change to a file it needs evidence and a run after the
 * last change; without a change it needs a run or evidence. Only the order of calls is compared, never what the evidence says.
 */
export function missingEvidence(calls: readonly string[], evidence: readonly unknown[] | undefined): string | undefined {
  const shown = !!evidence?.length
  const runs = (names: readonly string[]) => names.some(name => RUNNING.includes(name))
  const changed = calls.findLastIndex(name => CHANGING.includes(name))
  if (changed >= 0) {
    if (!shown) return 'You changed files, so ready needs evidence: the commands you actually ran and what they printed, not an estimate.'
    if (!runs(calls.slice(changed + 1))) return 'Nothing ran after your last change to a file: run the check again and report what it printed, or report blocked.'
    return undefined
  }
  return runs(calls) || shown ? undefined : 'Ready needs evidence, and nothing has run in this assignment: report what you checked and what it showed, or blocked if there is nothing to run.'
}

/** The kinds of result that changed nothing a Reviewer could read a diff of, so they reach the person without a review round. */
const UNREVIEWED = ['data', 'verify', 'docs']
/**
 * Why a ready report's declared `work` cannot stand, or undefined when it can. A report that changed a file through this Session
 * is a code change whatever it calls itself: claiming `data`, `verify` or `docs` is the one way a result escapes review, so the
 * Session's own calls decide, never the claim. Nothing is checked against the diff, only that a change happened at all.
 */
export function unclaimedWork(work: string | undefined, calls: readonly string[]): string | undefined {
  if (!work || !UNREVIEWED.includes(work)) return undefined
  if (!calls.some(name => CHANGING.includes(name))) return undefined
  return `You edited a file in this assignment, so work=${work} cannot stand: the result has a diff a Reviewer judges. Report it as `
    + 'work=code, or drop the change and report what the run itself showed.'
}
