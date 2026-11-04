#!/usr/bin/env node
/**
 * Read and change the running dsh-superagent from outside the DSH window.
 *
 * It speaks the same management API the panel uses, against the loopback listener the plugin opens when
 * `externalApiPort` names a port. Nothing here reaches into the database: every command is one HTTP request,
 * so an external operator sees exactly the state the panel sees and goes through the same guards.
 *
 *   superagent status                     what needs a person, what is running, what broke
 *   superagent tickets [--state open]     every ticket with its stage
 *   superagent ticket <id>                one ticket in full
 *   superagent logs [--lines 20]          the latest decisions and their reasons
 *   superagent stop|retry <id>            stop or retry a ticket
 *   superagent note <id> <text>           give a ticket's worker a fact
 *   superagent attach <id> <triggerId>    send a message to a ticket
 *   superagent retitle <id> <title>       correct a mislabelled ticket
 *   superagent reply <id> <text>          reply in the ticket's own conversation
 *   superagent pause|resume               hold or resume evaluation and dispatch
 *   superagent watch                      poll status every few seconds
 *
 * The port and the base URL come from `DSH_SUPERAGENT_API` (default `http://127.0.0.1:7788`).
 */
import { request } from 'node:http'

const BASE = (process.env.DSH_SUPERAGENT_API ?? 'http://127.0.0.1:7788').replace(/\/+$/, '')
/** Every request carries this the way the panel does: it tells the orchestrator the call was made on purpose. */
const HEADERS = { 'x-orchestrator-request': '1', accept: 'application/json' }

function call(method, path, body) {
  const url = new URL(path, BASE)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({ method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {
      ...HEADERS, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
    res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
        if (res.statusCode >= 400) {
          const detail = parsed && typeof parsed === 'object' ? parsed.error ?? JSON.stringify(parsed) : String(parsed)
          reject(new Error(`${res.statusCode} ${detail}`))
          return
        }
        resolve(parsed)
      })
    })
    req.on('error', error => reject(new Error(`${BASE} unreachable: ${error.message}. Is dsh-superagent running with externalApiPort set?`)))
    if (payload) req.write(payload)
    req.end()
  })
}

/** One line per ticket, marking the ones that wait on a person. */
const ticketLine = ticket => `${ticket.id.slice(0, 8)}  ${String(ticket.state).padEnd(16)} ${ticket.title}`

/**
 * Turns a short id into the full one: a human reads the 8-character prefix the lists print, and typing 32 characters for
 * every command is a tax on the thing this CLI exists for. An ambiguous prefix is refused rather than guessed.
 */
async function resolveTicket(given) {
  if (given.length >= 32) return given
  const seen = new Set()
  for (const state of ['open', 'person', 'working', 'idle', 'ended']) {
    const page = await call('GET', `/orchestrator/api/tickets?state=${state}&limit=1000`)
    for (const ticket of page.items) seen.add(ticket.id)
  }
  const matches = [...seen].filter(id => id.startsWith(given))
  if (matches.length === 1) return matches[0]
  if (!matches.length) throw new Error(`no ticket starts with ${given}`)
  throw new Error(`${given} matches ${matches.length} tickets: ${matches.map(id => id.slice(0, 8)).join(', ')}`)
}

async function status() {
  const [overview, tickets] = await Promise.all([call('GET', '/orchestrator/api/overview'), call('GET', '/orchestrator/api/tickets?state=open')])
  const { executor, flow, problems, needsYou } = overview
  console.log(`executor  running ${executor.running}/${executor.maxWorkers}  queued ${executor.queued}`)
  console.log(`flow      accepted ${flow.accepted}  evaluating ${flow.evaluating}  judged ${flow.judged}`)
  console.log(`needs you ${needsYou}`)
  for (const problem of problems) console.log(`problem   ${problem.kind}${problem.name ? ` ${problem.name}` : ''} ${problem.detail ?? ''}`.trimEnd())
  if (tickets.items.length) {
    console.log('')
    for (const ticket of tickets.items) console.log(ticketLine(ticket), retryNote(ticket))
  }
}

async function tickets(state = 'open') {
  const page = await call('GET', `/orchestrator/api/tickets?state=${encodeURIComponent(state)}`)
  for (const ticket of page.items) console.log(ticketLine(ticket), retryNote(ticket))
  if (!page.items.length) console.log('(none)')
}

/**
 * Says an upstream outage is what holds a ticket, with the attempt and when it tries again: without it the list reads as an
 * ordinary slow ticket and the provider's failure stays invisible.
 */
const retryNote = ticket => ticket.retrying ? `  [retrying #${ticket.retrying.attempts}, next ${ticket.retrying.next_at}]` : ''

async function ticket(id) {
  console.log(JSON.stringify(await call('GET', `/orchestrator/api/tickets/${encodeURIComponent(id)}`), null, 2))
}

async function logs(lines = '20') {
  const page = await call('GET', `/orchestrator/api/decisions?limit=${encodeURIComponent(lines)}`)
  for (const decision of page.items) {
    const reason = (decision.reason ?? []).map(item => item.code).join(',')
    console.log(`${decision.at}  ${String(decision.kind).padEnd(12)} ${reason}  ${decision.thread ?? ''}`)
  }
  if (!page.items.length) console.log('(none)')
}

/** Every ticket whose worker is waiting out an upstream failure: the attempt, the backoff and the provider's own words. */
async function retries() {
  let shown = 0
  for (const state of ['open', 'person', 'working', 'idle']) {
    const page = await call('GET', `/orchestrator/api/tickets?state=${state}&limit=1000`)
    for (const listed of page.items) {
      if (!listed.retrying) continue
      const detail = await call('GET', `/orchestrator/api/tickets/${encodeURIComponent(listed.id)}`)
      const assignment = (detail.assignments ?? []).at(-1)
      const retry = detail.retrying ?? assignment?.retry
      console.log(`${listed.id.slice(0, 8)}  attempt ${retry?.attempts ?? listed.retrying.attempts}  next ${retry?.next_at ?? listed.retrying.next_at}`)
      console.log(`  ${listed.title}`)
      if (retry?.error) console.log(`  ${String(retry.error).slice(0, 400)}`)
      shown += 1
    }
  }
  if (!shown) console.log('(no ticket is retrying an upstream failure)')
}

async function watch(interval = '5') {
  for (;;) {
    process.stdout.write('\u001b[2J\u001b[H')
    await status()
    await new Promise(resolve => setTimeout(resolve, Number(interval) * 1000))
  }
}

const [command, ...args] = process.argv.slice(2)
const need = (index, name) => {
  if (args[index] === undefined) usage(`missing ${name}`)
  return args[index]
}
function usage(problem) {
  if (problem) console.error(`superagent: ${problem}`)
  console.error('usage: superagent <status|tickets|ticket|logs|retries|watch|stop|retry|note|attach|retitle|reply|pause|resume> [args]')
  process.exit(problem ? 2 : 0)
}

try {
  switch (command) {
    case 'status': await status(); break
    case 'tickets': await tickets(args[0] === '--state' ? args[1] : (args[0] ?? 'open')); break
    case 'ticket': await ticket(await resolveTicket(need(0, 'ticket id'))); break
    case 'logs': await logs(args[0] === '--lines' ? args[1] : args[0]); break
    case 'retries': await retries(); break
    case 'watch': await watch(args[0]); break
    case 'stop': console.log(await call('POST', `/orchestrator/api/tickets/${encodeURIComponent(await resolveTicket(need(0, 'ticket id')))}/stop`, {})); break
    case 'retry': console.log(await call('POST', `/orchestrator/api/tickets/${encodeURIComponent(await resolveTicket(need(0, 'ticket id')))}/retry`, {})); break
    case 'note': console.log(await call('POST', `/orchestrator/api/tickets/${encodeURIComponent(await resolveTicket(need(0, 'ticket id')))}/note`, { text: need(1, 'text') })); break
    case 'attach': console.log(await call('POST', `/orchestrator/api/tickets/${encodeURIComponent(await resolveTicket(need(0, 'ticket id')))}/attach`, { trigger_id: need(1, 'trigger id') })); break
    case 'retitle': console.log(await call('PATCH', `/orchestrator/api/tickets/${encodeURIComponent(await resolveTicket(need(0, 'ticket id')))}`, { title: need(1, 'title') })); break
    case 'reply': console.log(await call('POST', `/orchestrator/api/tickets/${encodeURIComponent(await resolveTicket(need(0, 'ticket id')))}/reply`, { text: need(1, 'text') })); break
    case 'pause': console.log(await call('POST', '/orchestrator/api/executor/pause', { paused: true })); break
    case 'resume': console.log(await call('POST', '/orchestrator/api/executor/pause', { paused: false })); break
    default: usage(command ? `unknown command ${command}` : undefined)
  }
} catch (error) {
  console.error(`superagent: ${error.message}`)
  process.exit(1)
}
