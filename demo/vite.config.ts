/**
 * Standalone preview of the dsh-superagent management panel outside DSH: serves the React panel from `src/client` and answers
 * `/orchestrator/api/*` from the test fixtures' fake server (`tests/fixtures/panel-server.ts`), loaded through Vite SSR with `vitest`
 * replaced by `demo/vitest-shim.ts`. Run: `pnpm vite --config demo/vite.config.ts`.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

function fakeApi(): Plugin {
  let handler: ((url: string, init?: RequestInit) => Promise<Response>) | undefined
  const load = async (server: ViteDevServer) => {
    const shim = await server.ssrLoadModule(here('./vitest-shim.ts')) as { stubs: Record<string, unknown> }
    const fixtures = await server.ssrLoadModule(here('../tests/fixtures/panel-server.ts')) as { usePanelServer: (cleanup: () => void) => void }
    fixtures.usePanelServer(() => {})
    handler = shim.stubs.fetch as typeof handler
    if (!handler) throw new Error('panel-server did not stub fetch')
  }
  return {
    name: 'dsh-superagent-fake-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/orchestrator/api/')) return next()
        try {
          if (!handler) await load(server)
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
          const answer = await handler!(req.url, { method: req.method ?? 'GET', ...body ? { body } : {} })
          res.statusCode = answer.status
          res.setHeader('content-type', 'application/json')
          res.end(await answer.text())
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: error instanceof Error ? error.stack ?? error.message : String(error) }))
        }
      })
    },
  }
}

export default defineConfig({
  root: here('.'),
  plugins: [fakeApi()],
  resolve: { alias: { vitest: here('./vitest-shim.ts') }, dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 3083, strictPort: true },
})
