/**
 * A `SourceContext` on a temporary Store for the Jira and GitLab Source tests: the built-in Sources, the settings their
 * kinds read, and a deployment that holds both accounts. Nothing here reaches the network.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Trigger } from '../../src/core/index.ts'
import { Store } from '../../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { gitlabKind } from '../../src/sources/gitlab.ts'
import { jiraKind } from '../../src/sources/jira.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { testDeployment } from './deployment.ts'

const JIRA = { baseUrl: 'https://issue.example.com', patEnv: 'JIRA_PAT', name: 'agent', displayName: 'Agent' }
const GITLAB = { cli: '/bin/false', group: 'xk/product/zk-ai', username: 'agent' }

export function sourceHost(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'jira-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { jira: { allowed: [{ id: 'alice' }], bots: [{ id: 'ci-bot' }] } } },
    sources: { jira: { enabled: true, config: { projects: ['ZKAI'], pollSeconds: 60 } },
      gitlab: { enabled: true, config: { cli: '/bin/false', group: 'xk/product/zk-ai' } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(jiraKind); sources.register(gitlabKind)
  const deployment = testDeployment({ jira: JIRA, gitlab: GITLAB })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine,
    outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment, ready: Promise.resolve(),
    configured: () => true, problems: [], receive, ...overrides }
  const policy = settingsPolicy(store.settings(), sources)
  return { ...parts, policy, jira: sourceContextOf(parts, { kind: 'jira', health: ['jira'] }),
    gitlab: sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] }), board, store, engine, commands, receive, sources }
}
export { JIRA, GITLAB }
