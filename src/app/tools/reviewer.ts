/** Reviewer Session tools: reading the ticket's context and its code, and handing its verdict back to the Engine. */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EngineForReviewer } from '../../core/index.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { audited, toolCalls } from '../session-actions.ts'
import { readTool, tool, type Tool } from './tool.ts'

export interface ReviewerToolsHost {
  readonly engine: Pick<EngineForReviewer, 'reviewEnded'>
  readonly store: Pick<Store, 'tickets' | 'atomic'>
  readonly resources: ResourceHost
}

/**
 * The reviewer's tools: `orchestrator_read` scoped to the ticket it reviews, which pages through the ticket's card, its
 * inputs, its assignment and the transcript of the worker that did the work, and `orchestrator_review` for the verdict.
 */
export function reviewerTools(host: ReviewerToolsHost, ticketId: string, agent: Pick<Agent, 'session'>): Tool[] {
  return [
    readTool('Read one page of a resource of the ticket under review that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, { ticketId }, signal)),
    tool({
      name: 'orchestrator_review',
      description: 'Finish the review of this ticket with exactly one verdict, as the review section says: passed, or returned with the findings the worker must fix.',
      schema: z.object({
        outcome: z.enum(['passed', 'returned']).describe('passed: the result answers the request and its checks hold, so the ticket delivers it. returned: the worker must fix something first.'),
        summary: z.string().trim().min(1).max(2000).describe('What you checked and what you found, with the files and commands that show it.'),
        findings: z.array(z.string().trim().min(1).max(600)).max(20).optional()
          .describe('With outcome returned: each finding as one concrete fix the worker must make, naming the file and what is wrong.'),
      }).strict(),
      execute: async args => {
        // A Session that changed the code it judged gives no verdict on it: the verdict is recorded void, for a person to look at.
        const report = audited({ outcome: args.outcome, summary: args.summary, ...args.findings?.length ? { findings: args.findings } : {} }, toolCalls(agent))
        const updated = host.engine.reviewEnded(ticketId, report)
        return { reviewed: true, outcome: report.outcome, stage: updated.reviews?.at(-1)?.ended?.outcome ?? report.outcome, reported: true,
          ...report.unfinished ? { void: 'You changed the code you judged, so the verdict is void and a person must look at the result.' } : {} }
      },
    }),
  ]
}
