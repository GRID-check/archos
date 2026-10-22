/**
 * The bin's wire contract (ADR-0088, ADR-0131 rules 3 and 7): the listing's
 * query and rows, and what binning and restoring a single document answer.
 * The routes, the browser's client and the agent catalog share it.
 *
 * A document goes to the bin the way the clean-out sends it there (ADR-0092):
 * filed into a folder of its own inside its folder, and that folder binned
 * (`document-bin.ts`). The listing names such an entry's document, so a reader
 * restores the document rather than a folder it never made.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { decodeDocumentListCursor } from '@/lib/documents/list-cursor'

/** Entries one page carries when the request does not say. */
export const BIN_PAGE_SIZE = 50
/** The most entries one page carries. */
export const BIN_PAGE_MAX = 200

export const binListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BIN_PAGE_MAX)
    .optional(),
  cursor: z
    .string()
    .max(200)
    .refine((value) => decodeDocumentListCursor(value) !== null, { message: 'Invalid cursor' })
    .optional(),
})
export type BinListQuery = z.infer<typeof binListQuerySchema>

export const binEntrySchema = z.object({
  folderId: z.string(),
  name: z.string(),
  path: z.string(),
  deletedAt: z.string(),
  deletedBy: z.object({ userId: z.string().nullable(), name: z.string().nullable() }),
  purgeAfter: z.string(),
  status: z.string(),
  documents: z.number(),
  folders: z.number(),
  canRestore: z.boolean(),
  /** The document this entry holds when one document was sent to the bin on its own; `null` for a deleted folder. */
  document: z.object({ id: z.string(), name: z.string() }).nullable(),
})
export type BinEntryWire = z.infer<typeof binEntrySchema>

export const binListingSchema = z.object({
  entries: z.array(binEntrySchema),
  canPurge: z.boolean(),
  nextCursor: z.string().nullable(),
})
export type BinListingWire = z.infer<typeof binListingSchema>

export const documentBinResultSchema = z.object({
  documentId: z.string(),
  /** The bin entry the document went to: a `folderId` of project-folder-bin-list. */
  binEntryId: z.string(),
  purgeAfter: z.string(),
})
export type DocumentBinResult = z.infer<typeof documentBinResultSchema>

export const documentRestoreResultSchema = z.object({
  documentId: z.string(),
  /** The folder it is filed in again; `null` is the project root. */
  folderId: z.string().nullable(),
  /** `root` when the folder it came from no longer exists. */
  restoredTo: z.enum(['original', 'root']),
})
export type DocumentRestoreResult = z.infer<typeof documentRestoreResultSchema>

/** The reason a restore is refused because the document went to the bin with a folder, not on its own. */
export const BINNED_WITH_FOLDER_REASON = 'binned-with-folder'
/** The reason a bin is refused for a document that has none (the office shelf, a chat attachment). */
export const DOCUMENT_HAS_NO_BIN_REASON = 'document-has-no-bin'
