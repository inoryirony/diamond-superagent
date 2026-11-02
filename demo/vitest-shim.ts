/**
 * Minimal stand-in for the `vitest` API surface used by `tests/fixtures/panel-server.ts`, so the typed fake management API
 * server can run inside the Vite dev server (Node, SSR) without a test runner. Hooks run immediately; stubbed globals are
 * captured in `stubs` instead of replacing Node's own globals.
 */
export const stubs: Record<string, unknown> = {}
export function beforeEach(fn: () => void | Promise<void>) { void fn() }
export function afterEach(_fn: () => void) { /* never torn down in the demo */ }
export function expect(_value: unknown) { return new Proxy({}, { get: () => () => undefined }) as never }
export const vi = {
  fn: <F>(implementation: F) => implementation,
  stubGlobal: (name: string, value: unknown) => { stubs[name] = value },
  unstubAllGlobals: () => { for (const key of Object.keys(stubs)) delete stubs[key] },
}
// `usePanelServer` clears sessionStorage in its hook; Node has none.
;(globalThis as { sessionStorage?: { clear(): void } }).sessionStorage ??= { clear() {} }
