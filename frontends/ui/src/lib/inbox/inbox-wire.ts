/**
 * The inbox routes' request shapes, shared by the routes and the MCP catalog
 * (`lib/agent-api/catalog/collaboration.ts`, ADR-0122).
 */

import { z } from 'zod'
import { INBOX_LIST_FILTERS, INBOX_LIST_LIMIT } from '@/lib/inbox/types'

export const inboxListQuerySchema = z.object({
  filter: z.enum(INBOX_LIST_FILTERS).optional(),
  cursor: z.string().min(1).max(200).optional(),
})

export const unreadAnchorsQuerySchema = z.object({
  // Only a document has marks today; a second anchored resource joins here, as on `/read`.
  resourceType: z.literal('document'),
  resourceId: z.string().min(1).max(200),
})

/**
 * `itemIds` is bounded by the page size — a mark-read request can only ever be
 * about rows the client was actually shown, and an unbounded `IN (…)` is not
 * something a user-facing endpoint should accept.
 */
export const markReadSchema = z.union([
  z.object({ itemIds: z.array(z.string().uuid()).min(1).max(INBOX_LIST_LIMIT) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
  z
    .object({
      // Only a document has marks today; a second anchored resource joins here.
      resourceType: z.literal('document'),
      resourceId: z.string().min(1).max(200),
      anchorId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      resourceType: z.literal('document'),
      resourceId: z.string().min(1).max(200),
      marksSet: z.literal(true),
    })
    .strict(),
])

export const markUnreadSchema = z.object({ itemIds: z.array(z.string().uuid()).min(1).max(INBOX_LIST_LIMIT) }).strict()
