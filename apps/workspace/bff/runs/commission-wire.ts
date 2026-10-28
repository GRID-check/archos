/**
 * The body of `POST /api/projects/[id]/runs`, kept out of the route file so the
 * route and the MCP catalog (`lib/agent-api/catalog/tasks.ts`) parse against
 * one schema.
 */

import { z } from 'zod'
import { TASK_GOAL_MAX_CHARS } from '@/lib/tasks/wire'
import { planDocumentsSchema } from './plan-documents'

export const commissionRunSchema = z.object({
  conversationId: z.string().min(1),
  question: z.string().trim().min(1).max(TASK_GOAL_MAX_CHARS),
  context: z.string().trim().max(20_000).optional(),
  /** The Unterlagen a continuation carries forward: the last report's sources as its Grundlage. */
  documents: planDocumentsSchema.optional(),
})
