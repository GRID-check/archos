/**
 * The bodies and query of the upload-batch routes (ADR-0086), kept out of the
 * route files so the routes and the MCP catalog (`lib/agent-api/catalog/folders.ts`)
 * parse against one schema.
 *
 * `excluded` carries what the office's screening kept on the uploader's
 * machine as terms and counts only, never file names.
 */

import { z } from 'zod'
import { UPLOAD_BATCH_SCOPES } from '@/lib/db/schema/upload-batches'
import { documentListCursorParam } from '@/lib/documents/list-cursor'

/** Most files one batch may announce. Mirrors the CHECK in migration 0110. */
export const UPLOAD_BATCH_MAX_FILES = 10_000

/** What an upload's name check kept back: one schema for the open and the seal, so both bound it alike. */
export const uploadBatchExclusionsSchema = z
  .array(
    z.object({ term: z.string().trim().min(1).max(80), count: z.number().int().min(1).max(UPLOAD_BATCH_MAX_FILES) }).strict()
  )
  .max(200)
  .default([])

/** `POST /api/upload-batches`. */
export const openUploadBatchSchema = z
  .object({
    id: z.guid(),
    // `archiv` is what an open tab still sends. Remove after one release.
    scope: z.preprocess((value) => (value === 'archiv' ? 'office_shelf' : value), z.enum(UPLOAD_BATCH_SCOPES)),
    projectId: z.guid().nullable().default(null),
    conversationId: z.string().min(1).max(200).nullable().default(null),
    expectedCount: z.number().int().min(0).max(UPLOAD_BATCH_MAX_FILES),
    excluded: uploadBatchExclusionsSchema,
  })
  .strict()

/** `POST /api/upload-batches/[id]/seal`. */
export const sealUploadBatchSchema = z
  .object({
    unchanged: z.number().int().min(0).max(UPLOAD_BATCH_MAX_FILES),
    failed: z.number().int().min(0).max(UPLOAD_BATCH_MAX_FILES),
    excluded: uploadBatchExclusionsSchema,
  })
  .strict()

/** `GET /api/projects/[id]/uploads`. */
export const uploadHistoryQuerySchema = z.object({ cursor: documentListCursorParam })
