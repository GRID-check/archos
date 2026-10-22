/**
 * The query and bodies of the project memory routes, kept out of the route
 * files so the routes and the MCP catalog (`lib/agent-api/catalog/projects.ts`)
 * parse against one schema.
 */

import { z } from 'zod'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_MEMORY_VERIFICATIONS,
} from './memory-vocabulary'

export const listMemoryQuerySchema = z.object({
  includeArchived: z.string().optional(),
  // Optional: scope to a single conversation (the chat "Piloti noted N" chip).
  conversationId: z.string().optional(),
})

export const createMemorySchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
  pinned: z.boolean().optional(),
})

export const patchMemorySchema = z
  .object({
    kind: z.enum(PROJECT_MEMORY_KINDS).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    status: z.enum(PROJECT_MEMORY_STATUSES).optional(),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
    verification: z.enum(PROJECT_MEMORY_VERIFICATIONS).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Empty patch' })
