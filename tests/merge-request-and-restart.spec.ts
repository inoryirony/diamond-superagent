/** Reporting a merge request, and what the orchestrator may do once a review's rounds are spent. */
import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { parseMergeRequest } from '../src/app/tools/executor.ts'

let h: Host | undefined
const ticketOf = (host: Host, id: string) => host.runtime.store.tickets.get(id)!
afterEach(async () => { await h?.stop(); h = undefined })

it('reads a merge request from its web URL or its short form, and refuses anything else', () => {
  expect(parseMergeRequest('https://git.youshu.com.cn/xk/product/zk-ai/zkai-opportunity-engine/-/merge_requests/4'))
    .toEqual({ project: 'xk/product/zk-ai/zkai-opportunity-engine', iid: 4 })
  expect(parseMergeRequest('https://git.example.com/group/project/-/merge_requests/7#note_1'))
    .toEqual({ project: 'group/project', iid: 7 })
  expect(parseMergeRequest('xk/product/zk-ai/zkai-opportunity-engine!4'))
    .toEqual({ project: 'xk/product/zk-ai/zkai-opportunity-engine', iid: 4 })
  // A bare number is what the GitHub parameter takes; it cannot identify a GitLab project, so it is refused rather than guessed.
  expect(parseMergeRequest('4')).toBeUndefined()
  expect(parseMergeRequest('project')).toBeUndefined()
})

it('tells the main Session that a review\'s rounds are spent, and lets it restart the worker with an instruction', async () => {
  h = await startRuntime()
  const host = h
  // Notices go to the main Session through `notify`; recording them here pins what the orchestrator is told.
  const notices: { name: string; value: Record<string, unknown> }[] = []
  const real = host.runtime.sessions.notify.bind(host.runtime.sessions)
  vi.spyOn(host.runtime.sessions, 'notify').mockImplementation((name, value, summary) => {
    notices.push({ name, value }); return real(name, value, summary)
  })
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  host.review({ outcome: 'returned', summary: 'Still cut off at 320px.', findings: ['src/app.css: the header still does not wrap.'] })
  for (const round of [1, 2, 3]) {
    await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: `Round ${round}.` })
    await vi.waitFor(() => expect(host.runtime.reviewers.agent(ticket.id, round)).toBeDefined(), { timeout: 5000 })
    await host.finishReview(ticket.id)
    await host.runtime.idle()
    if (round < 3) { host.step(sessionId); await host.runtime.idle() }
  }
  // The last round leaves the result returned, so nothing runs on its own; the orchestrator is told, with the findings.
  expect(ticketOf(host, ticket.id).reviews!.map(review => [review.round, review.ended?.outcome])).toEqual([[1, 'returned'], [2, 'returned'], [3, 'returned']])
  const notice = notices.find(item => 'ticket_review_rounds_spent' in item.value)
  expect(notice?.value.ticket_review_rounds_spent).toMatchObject({ ticket_id: ticket.id, round: 3,
    findings: ['src/app.css: the header still does not wrap.'] })
  // Acting on it starts a fresh assignment whose first input is the instruction, so the next worker starts from that decision.
  const before = ticketOf(host, ticket.id).assignments.length
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket', { action: 'restart',
    ticket_id: ticket.id, instruction: 'Only change src/app.css; do not touch the layout module.' })
  await host.runtime.idle()
  const after = ticketOf(host, ticket.id)
  expect(after.assignments.length).toBe(before + 1)
  expect(after.inputs.some(input => 'text' in input && input.text.includes('Only change src/app.css'))).toBe(true)
})

it('reviews the result of an assignment the orchestrator restarted, even after an earlier attempt spent its rounds', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  // Spend the three rounds of the first attempt: every review returns the result.
  host.review({ outcome: 'returned', summary: 'Still wrong.', findings: ['src/app.css: still does not wrap.'] })
  for (const round of [1, 2, 3]) {
    await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: `Attempt 1 round ${round}.` })
    await vi.waitFor(() => expect(host.runtime.reviewers.agent(ticket.id, round)).toBeDefined(), { timeout: 5000 })
    await host.finishReview(ticket.id)
    await host.runtime.idle()
    if (round < 3) { host.step(sessionId); await host.runtime.idle() }
  }
  expect(ticketOf(host, ticket.id).reviews!.map(review => review.ended?.outcome)).toEqual(['returned', 'returned', 'returned'])
  // The rounds are spent, so nothing runs on its own. The orchestrator restarts the worker with an instruction; that is a new
  // attempt, so its result asks for a review again instead of being delivered unreviewed.
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket', { action: 'restart',
    ticket_id: ticket.id, instruction: 'Only change src/app.css.' })
  await host.runtime.idle()
  const restarted = ticketOf(host, ticket.id).assignments.at(-1)!
  expect(restarted.revises).toBeUndefined()
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Attempt 2 done.' })
  // Round 1 of the new attempt, in a Session of its own, rather than no review at all.
  await vi.waitFor(() => expect(ticketOf(host, ticket.id).reviews).toHaveLength(4), { timeout: 5000 })
  // The round number stays unique across attempts, because the Reviewer Session id is built from it.
  expect(ticketOf(host, ticket.id).reviews!.at(-1)!.round).toBe(4)
  // The new attempt's review waits for its verdict; the host finishes it with one.
  await host.runtime.idle()
  await host.finishReview(ticket.id, { outcome: 'passed', summary: 'Attempt 2 checked: wraps.' })
  await vi.waitFor(() => expect(ticketOf(host, ticket.id).ended).toMatchObject({ outcome: 'completed' }), { timeout: 5000 })
})

/**
 * DSH refuses a tool result that is not lossless JSON, and the model reads that refusal as a failed call, so it calls again —
 * each retry recording a real report. One ready result reopened the review seven times that way and burned every round, because
 * `orchestrator_report` returned a Promise: `bindMergeRequest` is async and the call forgot `await`.
 *
 * The check below is the same shape DSH applies: no value in the result may be a thenable or otherwise unserialisable. It runs
 * against the built result, not the tool, so it fails whenever any branch returns a Promise again.
 */
function lossless(value: unknown, path = 'result'): string[] {
  if (value === null) return []
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return []
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint' || kind === 'undefined') return [`${path} is ${kind}`]
  if (Array.isArray(value)) return value.flatMap((item, index) => lossless(item, `${path}[${index}]`))
  // A Promise is the shape that broke this: it is an object whose `then` is a function, and nothing in it survives JSON.
  if (typeof (value as { then?: unknown }).then === 'function') return [`${path} is a thenable (a Promise left unawaited)`]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => lossless(item, `${path}.${key}`))
}
it('keeps the report tool\'s result lossless JSON, so a merge-request report is not read as a failure', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const result = await host.runTool(sessionId, 'orchestrator_report', {
    state: 'ready', summary: 'Fixed and merged.', evidence: [{ what: 'uv run pytest -q', result: '251 passed' }],
    mr: 'https://git.example.com/group/project/-/merge_requests/7' })
  expect(lossless(result)).toEqual([])
  // The report itself stands: a refusal would have made the worker send it again.
  expect(ticketOf(host, ticket.id).assignments.at(-1)?.report?.state).toBe('ready')
})

/**
 * The branch the bug lived in, exercised directly: `bindMergeRequest` is async, and a call that forgets `await` puts a Promise
 * in the object the tool returns. This pins both shapes so a regression is caught even where the test host has no GitLab
 * account and the branch cannot run end to end.
 */
it('detects an unawaited async result as the lossless-JSON violation DSH refuses', async () => {
  const asyncBinding = async () => ({ bound: 'gitlab:1!7' })
  // What the tool returned when it forgot `await`: the Promise itself, which is what DSH called "not lossless JSON".
  expect(lossless({ reported: true, merge_request: asyncBinding() })).toEqual(['result.merge_request is a thenable (a Promise left unawaited)'])
  // With `await`, the resolved object passes.
  expect(lossless({ reported: true, merge_request: await asyncBinding() })).toEqual([])
})

/**
 * A Reviewer judges a diff. A result that only read data, ran existing checks or edited prose has no diff, so a review can only
 * restate the report; the worker names the kind and the result goes to the person, spending no review round.
 */
it('skips the review for a result the worker says changed no code, and reviews one it says did', async () => {
  h = await startRuntime()
  const host = h
  const data = await host.acceptedTicket(feishu('1', '@bot 统计一下', { root_id: undefined }))
  await host.runTool(data.sessionId, 'orchestrator_report', { state: 'ready', work: 'data',
    summary: '近 7 天人均 3.2 次情报查询。', evidence: [{ what: 'SQL 统计，见库 zk_home', result: '10 个用户，32 次调用' }] })
  await host.runtime.idle()
  // No review was opened for it: a round would only restate a report about data.
  expect(ticketOf(host, data.ticket.id).reviews ?? []).toEqual([])
  const code = await host.acceptedTicket(feishu('2', '@bot 修一下', { root_id: undefined }))
  await host.runTool(code.sessionId, 'orchestrator_report', { state: 'ready',
    summary: '修好了。', evidence: [{ what: 'uv run pytest -q', result: '12 passed' }] })
  await host.runtime.idle()
  // A code change does get its review.
  expect((ticketOf(host, code.ticket.id).reviews ?? []).length).toBeGreaterThan(0)
})

/**
 * The one way a result escapes review: a worker that edited a file calls the result `data`, `verify` or `docs`, so no diff is
 * judged. The Session's own log decides, never the claim, so the report is refused and the worker reports again.
 */
it('refuses a non-code work kind from a Session that edited a file', async () => {
  h = await startRuntime()
  const host = h
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
  // The model's own edit, logged as DSH logs a call when it starts.
  host.ran(sessionId, 'edit')
  // The refusal is the call's own answer, given before the report is written.
  expect(await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', work: 'docs',
    summary: '改了注释。', evidence: [{ what: 'git diff', result: '1 file changed' }] }))
    .toMatchObject({ refused: expect.stringMatching(/work=docs cannot stand/) })
  // The refused report left nothing behind on the ticket.
  expect(ticketOf(host, ticket.id).assignments.at(-1)?.report?.state).not.toBe('ready')
  // Reporting it as the code change it was is accepted, and asks for the review it needs.
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', work: 'code',
    summary: '改了注释。', evidence: [{ what: 'git diff', result: '1 file changed' }] })
  await host.runtime.idle()
  expect((ticketOf(host, ticket.id).reviews ?? []).length).toBeGreaterThan(0)
})
