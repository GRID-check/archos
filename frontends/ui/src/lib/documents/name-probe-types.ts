/**
 * The name probe's wire contract: "which of these filenames does this shelf
 * already hold?" (ADR-0055 — the routes, the client and the tests share it).
 *
 * The upload planner used to answer that from the listing the browser had
 * loaded. A listing is paged, can be narrowed by a filter, and leaves archived
 * documents out — while the server's upload replaces by filename across all of
 * them (`findLiveDocumentByFilename`, `uniq_documents_live_name_per_collection`).
 * A same-name document the browser had not loaded was then silently given a
 * new version. The probe asks the database the question the upload will ask.
 *
 * A match is returned when the name is the SAME document to the server (the
 * filename, in either Unicode form) or to a person (the filename or the rename,
 * case-folded — the planner's `duplicate`). Only person-uploaded rows: the
 * unique index is partial on `authored_by = 'user'`, and a machine-authored row
 * coexists with a person's file of the same name. Archived rows ARE included,
 * because the upload versions them too; `lifecycle` says which they are.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { DOCUMENT_AUTHORS } from './document-authors'
import { DOCUMENT_LIFECYCLES } from './lifecycle-types'

/**
 * Most names one probe carries — the folder-drop walker's own ceiling
 * (`dropped-entries.ts` stops at 2000 files).
 */
export const NAME_PROBE_MAX_NAMES = 2000

const names = z.array(z.string().min(1).max(1024)).min(1).max(NAME_PROBE_MAX_NAMES)

export const officeShelfNameProbeRequestSchema = z.object({ names })
export const projectNameProbeRequestSchema = z.object({ projectId: z.string().min(1), names })

/**
 * The project's Fassung probe also says where each dropped name lands: the
 * existing folder it is filed in, or, for a folder the upload creates, the
 * nearest existing one above it (a new folder inherits its access). `null` is
 * the project root. A restricted folder is a collection of its own (ADR-0087)
 * and a Fassung link lives in one collection, so only documents of the
 * collection the file goes to are offered. A name it does not mention lands at
 * the root.
 */
export const projectRevisionCandidatesRequestSchema = projectNameProbeRequestSchema.extend({
  folders: z
    .record(z.string().min(1).max(1024), z.string().min(1).max(64).nullable())
    .refine((folders) => Object.keys(folders).length <= NAME_PROBE_MAX_NAMES, 'Too many names')
    .optional(),
})
export type ProjectRevisionCandidatesRequest = z.infer<typeof projectRevisionCandidatesRequestSchema>

export const documentNameMatchSchema = z.object({
  id: z.string(),
  filename: z.string(),
  displayName: z.string().nullable(),
  fileSize: z.number().nullable(),
  contentHash: z.string().nullable(),
  /** The reading status, so the planner skips identical bytes only when they were read (`documentReadFamily`). */
  status: z.string(),
  folderId: z.string().nullable(),
  authoredBy: z.enum(DOCUMENT_AUTHORS),
  lifecycle: z.enum(DOCUMENT_LIFECYCLES),
})
export type DocumentNameMatch = z.infer<typeof documentNameMatchSchema>

export const nameProbeResponseSchema = z.object({ documents: z.array(documentNameMatchSchema) })
export type NameProbeResponse = z.infer<typeof nameProbeResponseSchema>

/**
 * What a dropped name continues: the document of its revision series (the name
 * grammar, `revision-series.ts`) that a new file of this name would replace as
 * a Fassung (CONTEXT.md, „Fassung"; ADR-0099). The upload dialog offers „Als
 * neue Fassung von X ablegen" from it. Asked with the same bodies as the name
 * probe, answered for the names that continue something only.
 */
export const revisionCandidateSchema = z.object({
  /** The dropped file name this answers for, exactly as it was asked. */
  name: z.string(),
  /** The current documents of its series, newest first. */
  candidates: z
    .array(
      z.object({
        id: z.string(),
        filename: z.string(),
        displayName: z.string().nullable(),
        /** How the candidate's own name reads („Index B · 02.07.2026"); empty when it has no index or date. */
        label: z.string(),
      }),
    )
    .min(1),
  /** The dropped file is newer than the newest candidate. */
  newer: z.boolean(),
  /** Exactly one candidate and the file is newer than it: the offer is made ticked. */
  unambiguous: z.boolean(),
})
export type RevisionCandidateMatch = z.infer<typeof revisionCandidateSchema>

export const revisionCandidatesResponseSchema = z.object({ candidates: z.array(revisionCandidateSchema) })
export type RevisionCandidatesResponse = z.infer<typeof revisionCandidatesResponseSchema>
