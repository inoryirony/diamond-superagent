import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { pollGitlab } from '../src/sources/gitlab.ts'
import { mrEndNotices, observeMr, type Mr } from '../src/sources/gitlab-mr.ts'
import { sourceHost, GITLAB } from './fixtures/source-host.ts'

function openTicket(id: string, name: string, overrides: Partial<Ticket> = {}): Ticket {
  return { id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
    actor: { source: 'jira', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', execution: { name, directory: `/w/${name}`, assignment: '' },
  origin: { triggerId: 't', triggerIds: [] }, ...overrides }
}
const mr = (overrides: Partial<Mr> = {}): Mr => ({ iid: 7, project_id: 42, state: 'opened', source_branch: 'agent/fix-export',
  web_url: 'https://git.youshu.com.cn/xk/product/zk-ai/-/merge_requests/7', updated_at: '2026-10-02T00:00:00.000Z',
  author: { username: GITLAB.username }, ...overrides })

describe('gitlab merge requests', () => {
  it('claims an open MR whose branch ends in the ticket name, and closes the thread and the ticket when it merges', () => {
    const h = sourceHost()
    h.store.tickets.save(openTicket('t1', 'fix-export', { channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } }] }))
    observeMr(h.gitlab, mr(), GITLAB.username)
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:42!7', own: true }])
    expect(h.store.threads.get('gitlab:42!7')!.meta).toMatchObject({ iid: 7, projectId: 42 })
    observeMr(h.gitlab, mr({ state: 'merged', merged_at: '2026-10-03T00:00:00.000Z', updated_at: '2026-10-03T00:00:00.000Z' }), GITLAB.username)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged', at: '2026-10-03T00:00:00.000Z' } })
    // The notice goes to the ticket's other conversations, not to GitLab, which shows the merge itself.
    const notices = h.store.receipts.waiting().filter(receipt => receipt.kind === 'notice')
    expect(notices).toMatchObject([{ channel: { source: 'feishu' }, text: expect.stringContaining('MR !7') }])
    expect(mrEndNotices(h.store.tickets.get('t1')!, '请修复导出')).toMatchObject([{ text: 'MR !7 已合并。' }])
    h.store.close()
  })
  it('does not claim an MR that another author opened, or one on another ticket\'s branch', () => {
    const h = sourceHost()
    h.store.tickets.save(openTicket('t1', 'fix-export'))
    observeMr(h.gitlab, mr({ author: { username: 'someone-else' } }), GITLAB.username)
    observeMr(h.gitlab, mr({ source_branch: 'agent/other-work' }), GITLAB.username)
    expect(h.store.tickets.get('t1')!.follows).toBeUndefined()
    h.store.close()
  })
  it('polls the group\'s merge requests of the agent account and advances its cursor', async () => {
    const h = sourceHost()
    h.store.tickets.save(openTicket('t1', 'fix-export'))
    const glab = vi.spyOn(h.commands, 'glab').mockResolvedValue([mr()] as never)
    await pollGitlab(h.gitlab)
    expect(glab).toHaveBeenCalledWith([ 'api', expect.stringContaining('groups/xk%2Fproduct%2Fzk-ai/merge_requests?author_username=agent') ])
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:42!7', own: true }])
    expect(h.store.get(KV.gitlab.cursor)).toBeTruthy()
    h.store.close()
  })
})
