/** Browser entry of the standalone panel preview: mounts `App` with the zh dictionary, a fake host config form, and no DSH workspace. */
import { createRoot } from 'react-dom/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { App } from '../src/client/app.tsx'
import { usePageForm } from '../src/client/deployment.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

const dictionary = new URLSearchParams(location.search).get('lang') === 'en' ? en : zh
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key as keyof typeof dictionary] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T

// Same shape as `fakeForm` in tests/fixtures/panel-server.ts, kept browser-only (the fixture pulls Node modules).
const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }
function fakeForm(): ConfigForm<Record<string, unknown>> {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable: true, mode: 'host' }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      if (revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      for (const listener of listeners) listener()
      return true
    },
    set: async () => false, unset: async () => false,
  }
}
const form = fakeForm()

function Demo() {
  return <App t={t} deploymentForm={usePageForm(form)}
    openSession={async id => { alert(`在真实部署里这里会在 DSH 工作区打开 Session：${id}`) }} />
}
createRoot(document.getElementById('root')!).render(<Demo />)
