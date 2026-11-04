import { createServer } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { startExternalApi } from '../src/app/external.ts'
import type { HttpHost } from '../src/app/http.ts'

/** A port the kernel just freed, so the test does not collide with a developer's own listener. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
const logs: string[] = []
const host = { ready: Promise.resolve() } as unknown as HttpHost

afterEach(() => { logs.length = 0; vi.restoreAllMocks() })

it('serves nothing when the port is 0, and stopping it is a no-op', async () => {
  const stop = startExternalApi(host, 0, message => logs.push(message))
  expect(logs).toEqual([])
  await stop()
})

it('answers its own port, and refuses a request without the management header', async () => {
  const port = await freePort()
  const stop = startExternalApi(host, port, message => logs.push(message))
  const base = `http://127.0.0.1:${port}/orchestrator/api/overview`
  await vi.waitFor(() => expect(logs.join(' ')).toContain(`listening on http://127.0.0.1:${port}`))
  // The unknown route path is irrelevant here: the header guard answers before routing, which is what a caller must satisfy.
  const forbidden = await fetch(base, { headers: { 'x-orchestrator-request': '0' } })
  expect(forbidden.status).toBe(403)
  await stop()
})

it('reports a port already taken instead of throwing out of the plugin', async () => {
  const port = await freePort()
  const first = startExternalApi(host, port, message => logs.push(message))
  await vi.waitFor(() => expect(logs.join(' ')).toContain('listening'))
  const second = startExternalApi(host, port, message => logs.push(message))
  await vi.waitFor(() => expect(logs.join(' ')).toContain('could not listen'))
  await second()
  await first()
})
