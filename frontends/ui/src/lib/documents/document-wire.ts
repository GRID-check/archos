/**
 * The bodies and query of the document routes that used to declare them inline
 * (a Next route exports handlers only), kept here so the route and the agent
 * catalog (`lib/agent-api/catalog/documents.ts`, `review.ts`) parse against one
 * schema (ADR-0055, ADR-0121).
 */

import { z } from 'zod'
import { MAX_DOCUMENT_NAME_LENGTH } from './display-name'
import { documentSummaryFilterSchema } from './list-query'
import { MAX_TAGS, MAX_TOPICS, MAX_TOPIC_LENGTH } from './tag-vocabulary'

/** `PATCH /api/documents/[id]` */
export const renameDocumentSchema = z.object({
  displayName: z.string().max(MAX_DOCUMENT_NAME_LENGTH).nullable(),
})

/** `PATCH /api/documents/[id]/folder` */
export const moveDocumentSchema = z.object({
  // Explicit `null` files the document at its shelf's root, which is a real
  // destination — so this is nullable, not optional.
  folderId: z.string().uuid().nullable(),
})

/** `PATCH /api/documents/[id]/tags` */
export const updateTagsSchema = z.object({
  // Empty list is allowed (clears tags). Vocabulary membership is enforced in
  // the service against the mirrored ALLOWED_TAGS and, authoritatively, the
  // backend — the schema only bounds shape and count.
  tags: z.array(z.string().min(1).max(128)).max(MAX_TAGS),
  // Optional: a tag-only edit omits it and the model's topics are left alone.
  topics: z.array(z.string().min(1).max(MAX_TOPIC_LENGTH)).max(MAX_TOPICS).optional(),
})

/** `PUT /api/documents/[id]/revision` */
export const revisionLinkSchema = z.object({
  /** The document being replaced. */
  older: z.string().uuid(),
  /** `true` confirms the link, `false` takes it back. */
  linked: z.boolean(),
})

/** `POST /api/documents/search` */
export const searchDocumentsSchema = z.object({
  projectId: z.string().min(1),
  q: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(100).optional(),
})

/** `GET /api/documents/summary` */
export const documentSummaryQuerySchema = documentSummaryFilterSchema.extend({ projectId: z.string().min(1) })
