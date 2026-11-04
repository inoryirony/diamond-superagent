/** Proactive candidate assessment for the main Session: relays candidate cards, serves bounded context reads, and records outcomes. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { reasonText, threadKey, type Assessor, type AssessmentOutcome, type Candidate, type EngineForMainSession,
  type Trigger } from '../core/index.ts'
import { AdmissionDirectionSchema, RuleAssessmentSchema, assessmentOutcome, directionAllowed, type Settings } from '../policy.ts'
import { checkedImText } from '../infra/text.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import { admissionContext } from '../sources/admission-context.ts'
import { readRepositoryPath } from '../sources/github-read.ts'
import type { TriggerContext } from '../sources/kind.ts'
import { relatedTickets } from './cards.ts'
import { textPage } from './context.ts'
import { AcknowledgementSchema } from './tools/tool.ts'
import type { Effects } from './effects.ts'

/** Schema for a short lowercase kebab-case English ticket worktree name (1–4 words, at most 32 characters). */
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters').describe('Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** Schema for the main Session's proactive candidate assessment decision (`orchestrator_eval_decide`). */
export const AssessmentSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema)
    .refine(assessments => new Set(assessments.map(assessment => assessment.rule_id)).size === assessments.length,
      'Duplicate rule assessment IDs').describe('One per enabled rule.'),
  direction: AdmissionDirectionSchema.describe('Required for every decision.'),
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  intent_evidence: z.string().trim().min(1).max(700).nullish().describe('For acceptance: the quotes that establish the three facts.'),
  acknowledgement: AcknowledgementSchema.nullish().describe('For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence.'),
  reason: z.string().min(1).max(500),
  ack_seq: z.number().int().nonnegative().nullish()
    .describe('The board_seq a conflict returned, once you have read its changes and this decision is still right. Omit it otherwise.'),
}).strict().refine(value => value.decision !== 'accept' || !directionAllowed(value.direction) || !value.rule_assessments.some(rule => rule.matched)
  || !!value.worktree_name, { message: 'Accepted work requires a short English worktree_name', path: ['worktree_name'] })

/** Character limits in the initial thread window: for the trigger itself, its two nearest neighbours, other window messages, and stub previews. */
const TRIGGER_CHARS = 4000, NEAR_CHARS = 1200, WINDOW_CHARS = 400, STUB_CHARS = 50
const FINISHED = 'This assessment has finished: it was decided, timed out or restarted'
const EXPLICIT = 'This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
type AssessmentContext = Awaited<ReturnType<typeof admissionContext>>
type ReadCache = {
  snapshots: Map<string, string>; images: Map<string, { id: string; text: string }>; messages: Map<string, string>; cursors: Set<string>
}
/** Per-evaluation state kept while an Eval runs: served reads cache, loaded thread context (or error), and any in-flight initial load. */
interface EvalReads { cache: ReadCache; context?: AssessmentContext; error?: string; loading?: Promise<void> }
/** Message returned when assessing a Trigger whose Source provides no thread context. */
const NO_CONTEXT = 'This Source gives no Thread context; assess the Trigger\'s own text and the batch.'
/** Host dependencies used by `MasterAssessor`. */
export interface AssessorHost {
  /** Active evaluations in `Engine` that the assessor reads and decides. */
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide' | 'changedSince' | 'boardSeq'>
  readonly commands: Commands
  readonly deployment: Deployment
  /** Durable effect queue through which candidate assessments are delivered. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  settings(): Settings
  /** Whether processing is paused, which holds candidate deliveries. */
  paused(): boolean
  /** Thread context reader for `trigger`'s Source, or `undefined` when the Source has none. */
  threadContext(trigger: Trigger): TriggerContext | undefined
  /** Delivers a candidate card to the Session that assesses `evalId` once per request ID, resolving after the Session receives it. */
  deliver(evalId: string, requestId: string, text: string): Promise<void>
  candidateCard(candidate: Candidate): Promise<Record<string, unknown>>
}

/** Schema for a bounded read of a candidate's thread or repository, kept for the reads a card's window points at. */
export const EvalReadSchema = z.object({
  trigger_id: z.string().min(1).describe('Original candidate ID returned by orchestrator_eval; every reference is scoped to this trigger.'),
  resource: z.enum(['message', 'root', 'parent', 'thread', 'file', 'directory', 'image']),
  path: z.string().optional().describe('Repository-relative path, only for file/directory.'),
  message_id: z.string().optional().describe('Only for message: omit for the trigger, or the id of a window message or stub.'),
  cursor: z.string().optional().describe('Only for thread: omit on the first page, then the next_cursor of the window or the cursor of next_read. Never a thread or message ID.'),
  image_id: z.string().optional().describe('Only for image: an image id the window or a read lists.'),
  offset: z.number().int().min(0).default(0).describe('Text pagination: copy next_offset; keep the other arguments unchanged. Images use 0.'),
}).strict().superRefine((read, ctx) => {
  if ((read.resource === 'file' || read.resource === 'directory') !== (read.path !== undefined)) ctx.addIssue({ code: 'custom', message: 'path is required only for file/directory. To read the source/root/parent, use resource=message/root/parent without a path.' })
  if (read.message_id !== undefined && read.resource !== 'message') ctx.addIssue({ code: 'custom', message: 'message_id is only for message; use returned image_id for images.' })
  if (read.cursor !== undefined && read.resource !== 'thread') ctx.addIssue({ code: 'custom', message: 'cursor is only for thread. First page: {resource:"thread"}.' })
  if ((read.resource === 'image') !== (read.image_id !== undefined)) ctx.addIssue({ code: 'custom', message: 'Images require image_id from a returned read reference. Read the thread or root first to discover their images.' })
})
/** Validated arguments for `MasterAssessor.read`. */
export type EvalRead = z.infer<typeof EvalReadSchema>

/**
 * Implements the `Engine` `Assessor` port for proactive candidate evaluation, one orchestrator Session per Eval.
 * Relays each evaluation's candidate card to its Eval Session through the durable `assessment` effect, serves bounded `TriggerContext` and repository reads while the evaluation runs, and converts the Session's assessment into an `AssessmentOutcome` for `Engine.decide`.
 * Depends on `SourceRegistry` (via `AssessorHost`) for source-specific thread context and on `Sessions` for deduplicated candidate delivery; the Eval Session's `orchestrator_eval*` tools call `context`, `read`, and `decide`.
 */
export class MasterAssessor implements Assessor {
  /** Per-evaluation read caches and thread contexts, keyed by `evalId`. */
  private readonly evals = new Map<string, EvalReads>()
  private readonly controller = new AbortController()
  /** Registers the handler that relays each Eval's candidate card, which a link lookup may delay for seconds. */
  constructor(private readonly host: AssessorHost) {
    // Start the evaluation deadline only after the Eval's Session receives the candidate card, so creating a busy Session does not consume evaluation time.
    host.effects.handle('assessment', async ({ triggerId }, evalId) => {
      const candidate = this.host.engine.candidate(triggerId)
      if (candidate?.evalId !== evalId) return
      // The card carries the Eval's whole tuple, so the window is read before the delivery rather than on a later call the
      // Session could skip: `docs/001` enumerates the input, and one delivery is what makes a per-Eval Session work.
      await this.window(evalId, candidate.triggers.at(-1)!)
      await this.host.deliver(evalId, `candidate:${evalId}`, JSON.stringify({ kind: 'candidate', ...await this.host.candidateCard(candidate) }))
      this.host.engine.candidateDelivered(evalId)
    }, { limit: () => host.paused() ? 0 : 4 })
  }
  /** Enqueues an `assessment` effect to deliver `candidate`'s card to the main Session. */
  request(candidate: Candidate): void { this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }
  /** Whether `evalId` is still the active evaluation for `trigger`. */
  private live(evalId: string, trigger: Trigger): boolean { return this.host.engine.candidate(trigger.id)?.evalId === evalId }
  /** Drop an Eval's context and reads once it finishes; any running load for it discards its result. */
  release(evalId: string): void { this.evals.delete(evalId) }
  /** Resolve the active evaluation for a trigger; historical triggers have none, and explicit requests are routed instead. */
  private evalFor(triggerId: string): { candidate: Candidate; trigger: Trigger } {
    const candidate = this.host.engine.candidate(triggerId)
    if (!candidate) throw new Error('No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment')
    if (candidate.strength === 'explicit') throw new Error(EXPLICIT)
    const trigger = candidate.triggers.find(item => item.id === triggerId)!
    return { candidate, trigger }
  }
  /** Returns or initializes the read cache for `evalId`, seeded with the trigger's own message and image references; throws if `evalId` has finished. */
  private reads(evalId: string, trigger: Trigger): EvalReads {
    let reads = this.evals.get(evalId)
    if (!reads) {
      // Reject reads after the evaluation ends so completed evaluations do not retain cached state.
      if (!this.live(evalId, trigger)) throw new Error(FINISHED)
      const context = this.host.threadContext(trigger)
      const messages = new Map([[context?.messageId ?? '', trigger.text]])
      reads = { cache: { snapshots: new Map(), images: new Map(), messages, cursors: new Set() } }
      this.evals.set(evalId, reads)
      this.imageReferences(context, trigger, trigger.text, context?.messageId ?? '', reads.cache)
    }
    return reads
  }
  private imageReferences(context: TriggerContext | undefined, trigger: Trigger, text: string, messageId: string, cache: ReadCache) {
    return (context?.images(text) ?? []).map(imageKey => {
      const imageId = `${messageId}/${imageKey}`
      cache.images.set(imageId, { id: messageId, text })
      return { message_id: messageId, image_key: imageKey, read: { trigger_id: trigger.id, resource: 'image', image_id: imageId } }
    })
  }
  /** Loads and caches the initial bounded thread window once per evaluation (including after a host restart). */
  private async seed(evalId: string, trigger: Trigger, caller?: AbortSignal): Promise<void> {
    caller?.throwIfAborted()
    const reads = this.reads(evalId, trigger)
    if (reads.context || reads.error !== undefined) return
    const thread = this.host.threadContext(trigger)
    if (!thread) { reads.error = NO_CONTEXT; return }
    let loading = reads.loading
    if (!loading) {
      // Guard against concurrent completion or replacement while async context loading is running.
      const current = () => this.evals.get(evalId)?.loading === loading
      // Defer start until `reads.loading` is assigned below so `current()` holds from the first step.
      loading = Promise.resolve().then(async () => {
        try {
          const timeout = AbortSignal.timeout(this.host.deployment.admissionContextTimeoutMs.get())
          const signal = AbortSignal.any([this.controller.signal, ...(caller ? [caller] : []), timeout])
          const commands = this.host.commands.withSignal(signal)
          const context = await admissionContext(thread, commands, this.host.deployment.admissionContextMaxPages.get())
          if (!current()) return
          reads.context = context
          // Allow pagination to continue from the end of the initial window.
          if (context.next) reads.cache.cursors.add(context.next)
          for (const message of context.messages) if (!message.deleted) {
            reads.cache.messages.set(message.id, message.text)
            this.imageReferences(thread, trigger, message.text, message.id, reads.cache)
          }
        } catch (error) {
          caller?.throwIfAborted()
          if (current()) reads.error = `Thread context unavailable: ${String(error).slice(0, 300)}. Read the thread with orchestrator_read before deciding based on missing context.`
        }
      }).finally(() => { if (current()) delete reads.loading })
      reads.loading = loading
    }
    await loading
    caller?.throwIfAborted()
    if (!this.live(evalId, trigger)) throw new Error(FINISHED)
  }
  /**
   * The thread snapshot of the Eval `evalId` assesses, for its card. `docs/001` enumerates an Eval's input, so the whole tuple
   * arrives with the delivery: nothing is left for the Session to fetch, and two Evals cannot be judged on different windows.
   * `trigger` names the message the Eval is about, whose own text the card already carries at its top level.
   */
  async window(evalId: string, trigger: Trigger): Promise<unknown> {
    await this.seed(evalId, trigger).catch(() => {})
    const { context, error } = this.evals.get(evalId) ?? {}
    if (!context) return { complete: false, error: error ?? 'The thread could not be read' }
    const source = this.host.threadContext(trigger)
    const at = context.messages.findIndex(message => message.id === source?.messageId)
    return { complete: context.complete, loaded_messages: context.messages.length, source_found: context.window.source_found,
      ...context.next ? { next_cursor: context.next } : {}, messages: context.messages.map((message, index) => {
        // The trigger's own text is at the top level of the card; long neighbours are cut with their full length, and the rest of
        // the thread is read through `orchestrator_read trigger/<id>`.
        const shown = index === at ? { trigger: true } : message.text.length <= WINDOW_CHARS ? { text: message.text }
          : { text: `${message.text.slice(0, WINDOW_CHARS)}…`, chars: message.text.length }
        return { id: message.id, from: message.from, at: message.at, ...message.bot ? { bot: true } : {},
          ...message.deleted ? { deleted: true } : {}, ...shown }
      }) }
  }
  /**
   * Returns the `orchestrator_eval` payload: the trigger's text once (up to `TRIGGER_CHARS`), batch peers, related tickets
   * on the thread, the Policy version its Eval was built from, and the initial thread window (first five messages and five
   * on either side of the trigger, truncated to `WINDOW_CHARS` or `NEAR_CHARS` for its two nearest neighbours with total
   * length and image IDs, plus other loaded messages as `STUB_CHARS` previews; `orchestrator_read trigger/<id>` reads any message
   * in full by ID).
   * Assessment instructions live in the main Session's prompt (`prompts/admission.md`), not in this payload.
   */
  async context(triggerId: string, signal?: AbortSignal) {
    const { candidate, trigger } = this.evalFor(triggerId)
    await this.seed(candidate.evalId, trigger, signal)
    const { context, error } = this.evals.get(candidate.evalId) ?? {}
    const source = this.host.threadContext(trigger)
    const images = (text: string) => source?.images(text) ?? []
    const imageIds = (id: string, text: string) => { const keys = images(text); return keys.length
      ? { images: keys.map(key => `${id}/${key}`) } : {} }
    const cut = (text: string, limit: number) => text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length }
    const thread = context ? (() => {
      const shown = new Map(context.window.entries.map(entry => [entry.message.id, entry]))
      const at = context.messages.findIndex(message => message.id === source?.messageId)
      const messages = context.messages.map((message, index) => {
        const author = { id: message.id, from: message.from, ...message.bot ? { bot: true } : {} }
        if (message.deleted) return { ...author, deleted: true }
        if (!shown.has(message.id)) return { ...author, preview: message.text.replace(/\s+/g, ' ').slice(0, STUB_CHARS) }
        // The trigger's own text is already included once at the top level.
        if (index === at) return { ...author, at: message.at, trigger: true }
        const near = at >= 0 && Math.abs(index - at) <= 2
        return { ...author, at: message.at, ...cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS), ...imageIds(message.id, message.text) }
      })
      return { complete: context.complete, loaded_messages: context.messages.length, source_found: context.window.source_found,
        ...context.next ? { next_cursor: context.next } : {}, messages }
    })() : { error: error ?? 'Call orchestrator_eval to load initial context', complete: false }
    const settings = this.host.settings()
    const others = candidate.triggers.filter(item => item.id !== trigger.id)
    return { trigger_id: trigger.id, strength: candidate.strength, mode: settings.eval.mode,
      source: { kind: trigger.source, actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), ...(trigger.url
        ? { url: trigger.url } : {}) },
      ...cut(trigger.text, TRIGGER_CHARS), ...imageIds(source?.messageId ?? '', trigger.text),
      ...others.length ? { batch: others.map(item => {
        const text = cut(item.text, WINDOW_CHARS)
        return { trigger_id: item.id, actor: item.actor.id, at: item.at, ...text, ...'chars' in text ? { read: `trigger/${item.id}` } : {} }
      }) } : {},
      // The rules are in the main Session's Policy section, which names the version the candidate's Eval was built from.
      ...relatedTickets(candidate.tickets), policy_version: candidate.policyVersion,
      thread }
  }
  /**
   * Serves bounded paginated text or image attachments from the evaluation's thread context or repository for
   * `orchestrator_read`; `agent` is the main Session, which receives images as attachments.
   */
  async read(agent: Agent, read: EvalRead, signal: AbortSignal) {
      const { candidate, trigger } = this.evalFor(read.trigger_id)
      await this.seed(candidate.evalId, trigger, signal)
      const { cache } = this.reads(candidate.evalId, trigger)
      const { snapshots, images, messages, cursors } = cache
      const commands = this.host.commands.withSignal(AbortSignal.any([this.controller.signal, signal]))
      if (read.resource === 'image') {
        if (read.offset !== 0) throw new Error('Images are not paginated; use offset 0')
        const image = images.get(read.image_id!)
        if (!image) throw new Error('Unknown image reference. Read the source/root/thread for this trigger first and copy its image read arguments.')
        const source = this.host.threadContext(trigger)
        if (!source) throw new Error(NO_CONTEXT)
        const key = read.image_id!.slice(read.image_id!.indexOf('/') + 1)
        return source.image(agent, commands, image, key, this.host.deployment.stateDir, signal)
      }
      const cacheKey = JSON.stringify([read.resource, read.path, read.cursor, read.message_id])
      if (read.offset > 0) {
        const cached = snapshots.get(cacheKey)
        if (cached === undefined) throw new Error('Read this resource at offset 0 first')
        return textPage(read.resource, cached, read.offset, 4000)
      }
      let body: string
      const source = this.host.threadContext(trigger)
      if (read.resource === 'message') {
        const message = messages.get(read.message_id ?? source?.messageId ?? '')
        if (message === undefined) throw new Error('Unknown message reference. Use resource=root/parent or read the thread first; copy a returned message read call.')
        body = message
      }
      else if (read.resource === 'thread' || read.resource === 'root' || read.resource === 'parent') {
        if (!source) throw new Error(NO_CONTEXT)
        if (read.cursor !== undefined && !cursors.has(read.cursor)) throw new Error('Unknown thread cursor. First call {resource:"thread"}; then copy the returned next_read exactly.')
        const result = await source.read(commands, read.resource, read.cursor)
        const references = result.messages.filter(message => !message.deleted).flatMap(message => {
          messages.set(message.id, message.text)
          return this.imageReferences(source, trigger, message.text, message.id, cache)
        })
        if (result.next) cursors.add(result.next)
        const next = result.next ? { trigger_id: trigger.id, resource: 'thread', cursor: result.next } : null
        body = JSON.stringify({ images: references, next_read: next, ...result.body })
      }
      else {
        body = await readRepositoryPath(commands, read.path!, read.resource === 'directory' ? 'directory' : 'file')
      }
      snapshots.set(cacheKey, body)
      return textPage(read.resource, body, read.offset, 4000)
  }
  /**
   * Converts the assessment into an outcome under current settings and passes it to `Engine.decide` for policy verification.
   * An accept holds to the board the Session assessed: an open ticket that changed after `candidate.boardSeq`, and was not in
   * the candidate, is returned as `conflict` instead of deciding, so two lanes do not open the same work twice.
   */
  async decide(triggerId: string, result: z.infer<typeof AssessmentSchema>, signal?: AbortSignal):
    Promise<{ state: string; ticket_id?: string; reason: string; conflict?: { board_seq: number; changed: unknown[] } }> {
    const { candidate } = this.evalFor(triggerId)
    signal?.throwIfAborted()
    let outcome: AssessmentOutcome = assessmentOutcome(result, this.host.settings(), candidate.strength)
    if (outcome.kind === 'accept') {
      const known = new Set(candidate.tickets.map(ticket => ticket.id))
      const since = result.ack_seq ?? candidate.boardSeq
      const changed = this.host.engine.changedSince(since).filter(ticket => !known.has(ticket.id))
      if (changed.length) return { state: 'conflict', reason: 'The board changed after this assessment; read these and decide again with ack_seq',
        conflict: { board_seq: this.host.engine.boardSeq(), changed } }
    }
    if (outcome.kind === 'accept' && outcome.acknowledgement) outcome = { ...outcome, acknowledgement: checkedImText(outcome.acknowledgement) }
    const decision = this.host.engine.decide(triggerId, { ...outcome, evalId: candidate.evalId })
    return { state: decision.kind, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), reason: reasonText(decision.reason) }
  }
  /** Aborts any in-flight thread context or repository read commands when the runtime stops. */
  stop(): void { this.controller.abort() }
}
