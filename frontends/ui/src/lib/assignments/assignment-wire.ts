/**
 * The assignment routes' request shapes, shared by the routes and the MCP
 * catalog (`lib/agent-api/catalog/collaboration.ts`, ADR-0121).
 */

import { z } from 'zod'

export const assignmentBodySchema = z.object({
  userId: z.string().min(1),
})

export const assignmentDeleteQuerySchema = z.object({
  userId: z.string().min(1),
})

/** `?access=write` lists who may change a document rather than open it; the default is who may open it. */
export const assignmentCandidatesQuerySchema = z.object({
  access: z.enum(['read', 'write']).optional(),
})
