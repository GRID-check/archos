/**
 * The request shape of `GET /api/session/documents`, shared by the route and the
 * MCP catalog (ADR-0121).
 */

import { z } from 'zod'
import { conversationIdSchema } from './conversation-id'

export const listSessionDocumentsQuerySchema = z.object({
  // Not `z.string().min(1)`: a non-empty string is not a conversation id, and
  // this one reaches a database comparison and a collection name. Not
  // `z.string().uuid()` either — see `./conversation-id` for why that would
  // break the feature rather than tighten it.
  conversationId: conversationIdSchema,
})
