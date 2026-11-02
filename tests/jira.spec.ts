import { describe, expect, it, vi } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { CliError } from '../src/infra/commands.ts'
import { pollJira } from '../src/sources/jira-loops.ts'
import { jiraKind } from '../src/sources/jira.ts'
import { sendJira } from '../src/sources/jira-channel.ts'
import { commentTrigger, issueTrigger, jiraChannel, type JiraComment, type JiraIssue } from '../src/sources/jira-trigger.ts'
import { hasMarker, jiraMarker, toWiki } from '../src/sources/jira-text.ts'
import { jiraThreadContext } from '../src/sources/jira-read.ts'
import { sourceHost, JIRA } from './fixtures/source-host.ts'

const CATEGORY = { name: 'In Progress', statusCategory: { key: 'indeterminate' } }
function issue(fields: Partial<JiraIssue['fields']> = {}, issueKey = 'ZKAI-1'): JiraIssue {
  return { key: issueKey, fields: { summary: 'Broken export', description: 'The export fails.',
    created: '2026-10-01T08:00:00.000+0800', updated: '2026-10-01T09:00:00.000+0800', status: CATEGORY,
    assignee: { name: 'agent' }, reporter: { name: 'alice', displayName: 'Alice' }, comment: { comments: [], total: 0 }, ...fields } }
}
const comment = (fields: Partial<JiraComment> = {}): JiraComment => ({ id: '1000', body: '[~agent] please look',
  author: { name: 'alice' }, created: '2026-10-01T09:10:00.000+0800', updated: '2026-10-01T09:10:00.000+0800', ...fields })

describe('jira triggers', () => {
  it('makes an issue assigned to the agent a direct Trigger on its thread, with the browse URL', () => {
    expect(issueTrigger(issue(), JIRA)).toMatchObject({
      id: key('jira-issue', 'ZKAI-1', '2026-10-01T08:00:00.000+0800'), source: 'jira', threads: [{ source: 'jira', id: 'ZKAI-1' }],
      actor: { source: 'jira', id: 'alice' }, human: true, addressed: 'direct', text: 'Broken export\n\nThe export fails.',
      url: 'https://issue.example.com/browse/ZKAI-1', channel: { source: 'jira', thread: 'jira:ZKAI-1', address: { issue: 'ZKAI-1' } },
      meta: { issueKey: 'ZKAI-1', kind: 'issue', status: 'In Progress', project: 'ZKAI' } })
  })
  it('treats a mention in an unassigned issue as a mention, and a listed bot as no person', () => {
    expect(issueTrigger(issue({ assignee: null, description: 'ping [~agent]', reporter: { name: 'ci-bot' } }), JIRA, ['ci-bot']))
      .toMatchObject({ addressed: 'mention', human: false })
    expect(issueTrigger(issue({ assignee: null, description: 'nothing here' }), JIRA)).not.toHaveProperty('addressed')
  })
  it('keys a comment by its id and updated time, so an edit is new and a repeat is not', () => {
    const first = commentTrigger(issue({ assignee: null }), comment(), JIRA)
    expect(first).toMatchObject({ id: key('jira-comment', 'ZKAI-1', '1000', '2026-10-01T09:10:00.000+0800'), addressed: 'mention',
      meta: { issueKey: 'ZKAI-1', commentId: '1000', kind: 'comment' } })
    expect(commentTrigger(issue({ assignee: null }), comment(), JIRA).id).toBe(first.id)
    expect(commentTrigger(issue({ assignee: null }), comment({ updated: '2026-10-02T09:10:00.000+0800' }), JIRA).id).not.toBe(first.id)
  })
})

describe('jira polling', () => {
  it('receives a new assigned issue once, and closes its thread once the status is done', async () => {
    const h = sourceHost()
    const received: Trigger[] = []
    h.receive.mockImplementation((trigger: Trigger) => { received.push(trigger); return 'stored' as const })
    const current = issue()
    vi.spyOn(h.commands, 'jira').mockImplementation(async () => ({ issues: [current], total: 1 }) as never)
    // The first round only places the cursor, so switching the Source on never replays history.
    await pollJira(h.jira)
    expect(received).toEqual([])
    expect(h.store.get(KV.jira.cursor)).toBeTruthy()
    await pollJira(h.jira)
    expect(received.filter(trigger => trigger.meta.kind === 'issue')).toHaveLength(1)
    expect(received[0]).toMatchObject({ addressed: 'direct', threads: [{ source: 'jira', id: 'ZKAI-1' }] })
    await pollJira(h.jira)
    expect(received.filter(trigger => trigger.meta.kind === 'issue')).toHaveLength(1)
    // A done status closes the thread, which ends the ticket that follows it.
    current.fields.status = { name: 'Done', statusCategory: { key: 'done' } }
    current.fields.resolutiondate = '2026-10-03T10:00:00.000+0800'
    current.fields.updated = '2026-10-03T10:00:00.000+0800'
    const closed = vi.spyOn(h.engine, 'threadClosed')
    await pollJira(h.jira)
    expect(closed).toHaveBeenCalledWith({ source: 'jira', id: 'ZKAI-1' }, 'closed', '2026-10-03T10:00:00.000+0800')
  })
  it('receives a comment that mentions the agent once, and gates another author as not explicit', async () => {
    const h = sourceHost()
    const received: Trigger[] = []
    h.receive.mockImplementation((trigger: Trigger) => { received.push(trigger); return 'stored' as const })
    vi.spyOn(h.commands, 'jira').mockImplementation(async () => ({ issues: [issue({ assignee: null, comment: { comments: [comment()], total: 1 } })], total: 1 }) as never)
    for (let round = 0; round < 3; round++) await pollJira(h.jira)
    expect(received.filter(trigger => trigger.meta.kind === 'comment')).toHaveLength(1)
    expect(received.find(trigger => trigger.meta.kind === 'comment')).toMatchObject({ addressed: 'mention', human: true })
    // The Source marks an unassigned issue's mention, but the Policy decides: the author is not on the list, so the
    // comment is received and assessed only as an inferred candidate, never as an explicit request.
    const thread = { key: 'jira:ZKAI-1', ref: { source: 'jira', id: 'ZKAI-1' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
    const outsider = commentTrigger(issue({ assignee: null }), comment({ id: '1001', author: { name: 'mallory' } }), JIRA)
    expect(outsider.addressed).toBe('mention')
    expect(h.policy.gate(outsider, thread, [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(h.policy.gate(commentTrigger(issue({ assignee: null }), comment(), JIRA), thread, [])).toMatchObject({ strength: 'explicit' })
  })
  it('reads an issue and its comments as one conversation', async () => {
    const h = sourceHost()
    vi.spyOn(h.commands, 'jira').mockImplementation((async (path: string) => path.includes('/comment')
      ? { comments: [comment()], total: 1 }
      : issue({ comment: { comments: [comment()], total: 1 } })) as never)
    const trigger = issueTrigger(issue(), JIRA)
    const read = await jiraThreadContext.read(h.commands, trigger, 'thread', undefined, {}) as { messages: unknown[] }
    expect(read.messages).toMatchObject([{ id: 'issue:ZKAI-1', from: 'alice' }, { id: '1000', from: 'alice', text: '[~agent] please look' }])
    expect(jiraThreadContext.messageId(commentTrigger(issue({ assignee: null }), comment(), JIRA))).toBe('1000')
  })
})

describe('jira channel', () => {
  const message = (id: string, issueKey = 'ZKAI-1') =>
    ({ id, channel: jiraChannel(issueKey), text: 'hello', kind: 'reply', ticketId: 't1' }) as never
  it('does not post twice when the marker of the message is already on the issue', async () => {
    const h = sourceHost()
    const post = vi.fn()
    vi.spyOn(h.commands, 'jira').mockImplementation((async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') { post(); return {} }
      return { comments: [{ body: `hello\n\n${jiraMarker('m1')}` }] }
    }) as never)
    expect(await sendJira(h.jira, message('m1'))).toBe('sent')
    expect(post).not.toHaveBeenCalled()
  })
  it('posts a wiki comment once, and answers gone when the issue is missing', async () => {
    const h = sourceHost()
    const jira = vi.spyOn(h.commands, 'jira').mockImplementation((async (path: string, init?: { method?: string }) => {
      if (init?.method !== 'POST') return { comments: [] }
      return {}
    }) as never)
    expect(await sendJira(h.jira, message('m2'))).toBe('sent')
    expect(jira.mock.calls.at(-1)).toMatchObject([`/rest/api/2/issue/ZKAI-1/comment`, { method: 'POST' }])
    jira.mockImplementation((async () => { throw new CliError('Jira answered HTTP 404: Not Found', 404) }) as never)
    expect(await sendJira(h.jira, message('m3'))).toBe('gone')
  })
})

describe('jira text', () => {
  it('converts headings, code, bold, links and lists to wiki markup', () => {
    expect(toWiki('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n[t](https://x/y)\n\n```\nline\n```'))
      .toBe('h1. Title\n\n*bold* and {{code}}\n\n* one\n* two\n\n[t|https://x/y]\n\n{code}\nline\n{code}')
  })
  it('writes and finds its own hidden marker', () => {
    expect(hasMarker(`x ${jiraMarker('m9')}`)).toBe(true)
    expect(hasMarker('plain')).toBe(false)
  })
})

describe('jira kind', () => {
  it('declares its health, find, scope and policy rows', () => {
    expect(jiraKind.health).toEqual(['jira'])
    expect(jiraKind.find!('over ZKAI-123 now').threads).toEqual(['jira:ZKAI-123'])
    expect(jiraKind.scope!({ meta: { kind: 'comment' } }, jiraKind.schema.parse({ observeComments: true })))
      .toEqual({ listened: true, observed: true, row: 'comments' })
    expect(jiraKind.policy!.rows!({ observeIssues: true })).toMatchObject([{ id: 'issues', note: { zh: '全部' } }, { id: 'comments', note: { zh: '仅 @' } }])
  })
})
