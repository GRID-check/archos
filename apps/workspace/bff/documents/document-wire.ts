/**
 * The bodies and query of the document routes that used to declare them inline
 * (a Next route exports handlers only), kept here so the route and the agent
 * catalog (`lib/agent-api/catalog/documents.ts`, `review.ts`) parse against one
 * schema (ADR-0055, ADR-0122).
 */

import { z } from 'zod'
import { MAX_DOCUMENT_NAME_LENGTH } from './display-name'
import { documentSummaryFilterSchema } from './list-query'
import { shelfSelectorFields } from './shelf-scope'
import { MAX_TAGS, MAX_TOPICS, MAX_TOPIC_LENGTH } from './tag-vocabulary'

/** `PATCH /api/documents/[id]` */
export const renameDocumentSchema = z.object({
  displayName: z.string().max(MAX_DOCUMENT_NAME_LENGTH).nullable(),
})

/** `PATCH /api/documents/[id]/folder` */
export const moveDocumentSchema = z.object({
  // Explicit `null` files the document at its shelf's root, which is a real
  // destination — so this is nullable, not optional.
  folderId: z.guid().nullable(),
  withTracedSketches: z
    .boolean()
    .optional()
    .describe('Also move the sketches a `traced_sketches_wider` refusal named.'),
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
  older: z.guid(),
  /** `true` confirms the link, `false` takes it back. */
  linked: z.boolean(),
})

/** `GET /api/documents/[id]/file`: the current PDF, or with `versionId` that version's own bytes. */
export const documentFileQuerySchema = z.object({
  versionId: z
    .string()
    .optional()
    .describe('A published or superseded version, from document-version-list.'),
  download: z.string().max(8).optional(),
})

/** `GET /api/documents/summary` */
export const documentSummaryQuerySchema = documentSummaryFilterSchema.extend(shelfSelectorFields)
