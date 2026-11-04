/**
 * A loopback listener of its own for the management API, so an agent in another tool (an editor, a CLI, a chat) can read and
 * change the orchestrator without the DSH window being open. The panel keeps using the route on DSH's web server; both call
 * `dispatchApi`, so the operations, their guards and their shapes are the same.
 *
 * Off unless configured: a port that any process on the machine can reach must be asked for. Loopback only, and every request
 * still needs the `x-orchestrator-request: 1` header, which a browser cannot add cross-origin without a preflight this listener
 * never allows.
 */
import { createServer, type Server } from 'node:http'
import { dispatchApi, type HttpHost } from './http.ts'

/** The port to listen on: 0 disables the listener, and the default keeps one address across restarts. */
export const EXTERNAL_PORT = 7788
export const EXTERNAL_HOST = '127.0.0.1'

/** Start the listener and return its disposer; a port already taken is reported instead of crashing the plugin. */
export function startExternalApi(host: HttpHost, port: number, log: (message: string) => void): () => Promise<void> {
  if (!port) return async () => { /* Disabled. */ }
  const server: Server = createServer((req, res) => { void dispatchApi(req, res, host, port) })
  server.on('error', error => { log(`dsh-superagent external API could not listen on ${EXTERNAL_HOST}:${port}: ${String(error)}`) })
  server.listen(port, EXTERNAL_HOST, () => { log(`dsh-superagent external API listening on http://${EXTERNAL_HOST}:${port}/orchestrator/api`) })
  return () => new Promise<void>(resolve => {
    if (!server.listening) { resolve(); return }
    server.close(() => resolve())
    // A keep-alive connection from a caller would hold close() open; the listener is one the plugin owns, so end them all.
    server.closeAllConnections?.()
  })
}
