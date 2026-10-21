/**
 * Sorting a shelf's root: the wire contract between the root-sort routes, their
 * typed client (`./root-sort-client`) and the dialog that drives them.
 *
 * A person who built a folder tree for a root full of loose files asks Piloti
 * to place every one of them. The run is three steps, each its own request so
 * a thousand files never hang on one HTTP call:
 *
 * 1. **scan**: `GET …/root-sort` lists the shelf's folders and the root
 *    documents the judgement may read.
 * 2. **plan**: `POST …/root-sort` judges one chunk of at most
 *    `ROOT_SORT_CHUNK` documents (the filing judgement's own bound) and answers
 *    a placement per document it could place, each with the decision model's
 *    confidence. Nothing moves.
 * 3. **new folders**: `POST …/root-sort/new-folders` takes the documents no
 *    folder fits and proposes a few new folders to group them, over all of
 *    them at once so the names agree across chunks. Nothing is created.
 * 4. **apply**: new folders the person kept are created through the shelf's
 *    `…/folders/ensure`, then `POST /api/documents/folder-moves` moves what the person kept,
 *    at most `MAX_FOLDER_MOVES` per request, through the same
 *    `moveDocumentToFolder` every other move uses. Undo is the same request
 *    with every folder set back to the root.
 *
 * No `server-only`: the browser, the specs and the preview import it.
 */

import { z } from 'zod'
import { MAX_JUDGED_DOCUMENTS } from './types'

/** Most documents one plan request judges: one filing judgement. */
export const ROOT_SORT_CHUNK = MAX_JUDGED_DOCUMENTS
/** Most root documents one scan lists; the rest wait for the next run. */
export const MAX_ROOT_SORT_DOCUMENTS = 5000
/** Most moves one folder-moves request applies. */
export const MAX_FOLDER_MOVES = 100
/**
 * The decision model's agreement at which a placement reads as sure. Below it
 * the placement is still proposed, marked for a look. Unmeasured: the first
 * eval over real roots sets it.
 */
export const SURE_CONFIDENCE = 0.6

/** Which shelf a run sorts: a project's Dateien or the office Archiv. */
export type RootSortShelf = { kind: 'project'; projectId: string } | { kind: 'office_shelf' }

export const rootSortFolderSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
})
export type RootSortFolder = z.infer<typeof rootSortFolderSchema>

export const rootSortDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type RootSortDocument = z.infer<typeof rootSortDocumentSchema>

export const rootSortScanSchema = z.object({
  /** Every folder the judgement may file into, open to every reader of the shelf. */
  folders: z.array(rootSortFolderSchema),
  /** The root's documents the judgement may read: screened and read by ingestion. */
  documents: z.array(rootSortDocumentSchema),
  /** Root documents left out because ingestion has not read them yet, or they are held. */
  unreadable: z.number().int().nonnegative(),
  /** The root holds more than `MAX_ROOT_SORT_DOCUMENTS`. */
  truncated: z.boolean(),
})
export type RootSortScan = z.infer<typeof rootSortScanSchema>

export const rootSortPlanRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(ROOT_SORT_CHUNK),
})
export type RootSortPlanRequest = z.infer<typeof rootSortPlanRequestSchema>

export const rootSortPlacementSchema = z.object({
  documentId: z.string(),
  /** An existing folder; null when the placement is a new folder. */
  folderId: z.string().nullable(),
  /** A folder the office uses in its other projects that this shelf lacks: applying creates it. */
  newFolderPath: z.string().nullable(),
  reason: z.string(),
  /** The decision model's probability for this folder; null when it was not asked or not reachable. */
  confidence: z.number().min(0).max(1).nullable(),
})
export type RootSortPlacement = z.infer<typeof rootSortPlacementSchema>

export const rootSortPlanSchema = z.object({
  placements: z.array(rootSortPlacementSchema),
  /** Why this chunk was not judged (`llm_not_configured`, `backend_502`, …); null when it was. */
  error: z.string().nullable(),
  traceId: z.string().nullable(),
})
export type RootSortPlan = z.infer<typeof rootSortPlanSchema>

/**
 * Most documents one new-folder proposal reads: the leftovers of a whole run.
 * The backend groups them a hundred at a time and merges the groups in one
 * more call, so the names agree across the run (`/v1/folder-proposals`).
 */
export const MAX_NEW_FOLDER_DOCUMENTS = 1000
/** Most new folders one proposal answers. */
export const MAX_NEW_FOLDERS = 12

export const newFoldersRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(MAX_NEW_FOLDER_DOCUMENTS),
})
export type NewFoldersRequest = z.infer<typeof newFoldersRequestSchema>

export const newFolderProposalSchema = z.object({
  /** The full path, under an existing folder or at the root; never one the shelf already has. */
  path: z.string(),
  description: z.string().nullable(),
  documentIds: z.array(z.string()),
  /** The decision model's agreement per document (id → probability); empty when it was not reachable. */
  confidences: z.record(z.string(), z.number().min(0).max(1)),
})
export type NewFolderProposal = z.infer<typeof newFolderProposalSchema>

export const newFoldersSchema = z.object({
  proposals: z.array(newFolderProposalSchema),
  error: z.string().nullable(),
  traceId: z.string().nullable(),
})
export type NewFolders = z.infer<typeof newFoldersSchema>

/** The shelf's `…/folders/ensure` answer, as far as the run reads it. */
export const ensuredFoldersSchema = z.object({
  folderIdByPath: z.record(z.string(), z.string()),
})

export const folderMovesRequestSchema = z.object({
  moves: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        /** `null` is the shelf root: undo sends every document back there. */
        folderId: z.string().uuid().nullable(),
      })
    )
    .min(1)
    .max(MAX_FOLDER_MOVES),
})
export type FolderMovesRequest = z.infer<typeof folderMovesRequestSchema>
export type FolderMove = FolderMovesRequest['moves'][number]

export const folderMovesResponseSchema = z.object({
  results: z.array(
    z.object({
      documentId: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
    })
  ),
})
export type FolderMovesResponse = z.infer<typeof folderMovesResponseSchema>

export type PlacementCertainty = 'sure' | 'unsure'

/** How a placement reads: unscored placements are the filing judgement's own, which proposes only when confident. */
export function certaintyOf(confidence: number | null): PlacementCertainty {
  return confidence === null || confidence >= SURE_CONFIDENCE ? 'sure' : 'unsure'
}
