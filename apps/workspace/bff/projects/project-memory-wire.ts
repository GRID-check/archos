/**
 * The query and bodies of the project memory routes, kept out of the route
 * files so the routes and the MCP catalog (`lib/agent-api/catalog/projects.ts`)
 * parse against one schema.
 */

import { z } from 'zod'
import { pageQueryShape } from '@/lib/api/offset-page'
import type { ProjectMemoryItem } from '@/lib/db/schema/project-memory'
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
  ...pageQueryShape,
})

/** `GET /api/organization/memory`. */
export const listOrganizationMemoryQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional().describe('"true" also returns archived items.'),
  ...pageQueryShape,
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

/**
 * A memory item as it leaves the server: the row without its embedding. The
 * vector (about 6 KB per item) is for recall and dedup on the server; no client
 * reads it, and an MCP list of one project was 3.5 MB with it.
 */
export type ProjectMemoryWireItem = Omit<ProjectMemoryItem, 'embedding' | 'embeddingModel' | 'embeddedAt'>

export function toMemoryWireItem(item: ProjectMemoryItem): ProjectMemoryWireItem {
  const { embedding: _embedding, embeddingModel: _model, embeddedAt: _at, ...wire } = item
  return wire
}
