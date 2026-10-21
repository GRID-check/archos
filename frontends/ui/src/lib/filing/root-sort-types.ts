/**
 * Sorting a shelf's root: the wire contract between the root-sort routes, their
 * typed client (`./root-sort-client`) and the dialog that shows a run.
 *
 * A person who built a folder tree for a root full of loose files asks Piloti
 * to place every one of them. The run is the SERVER'S (ADR-0121): a row in
 * `root_sort_runs`, worked a bounded slice at a time by the BFF job
 * `root_sort` (`./root-sort-run`). The browser starts it, reads it, and asks
 * for the next step; it never drives the work, so closing the tab, a deploy or
 * a dead worker loses nothing, and the person comes back to where it got to.
 *
 * 1. **judging**: `ROOT_SORT_CHUNK` root documents at a time through the
 *    filing judgement with the sort purpose, each placement scored by the
 *    decision model. Nothing moves.
 * 2. **grouping**: the documents no folder fits (at most
 *    `MAX_NEW_FOLDER_DOCUMENTS`) are grouped into proposed new folders, in one
 *    call over all of them so the names agree. Nothing is created.
 * 3. **ready**: the person reviews the run as a tree and sends what they kept.
 * 4. **applying**: kept new folders are created, then the kept moves run
 *    `MAX_MOVES_PER_SLICE` at a time through `moveDocumentToFolder`.
 * 5. **undoing**, on request: what the run moved goes back to the root.
 *
 * No `server-only`: the browser, the specs, the schema and the preview import it.
 */

import { z } from 'zod'
import { MAX_JUDGED_DOCUMENTS } from './types'

/** Most documents one judgement reads: one filing judgement. */
export const ROOT_SORT_CHUNK = MAX_JUDGED_DOCUMENTS
/** Judgements one job slice runs side by side; a slice must end well inside the runner's five minutes. */
export const CHUNKS_PER_SLICE = 3
/** Most root documents one run reads; the rest wait for the next run. */
export const MAX_ROOT_SORT_DOCUMENTS = 5000
/** Moves one job slice applies (or undoes). */
export const MAX_MOVES_PER_SLICE = 100
/**
 * The decision model's agreement at which a placement reads as sure. Below it
 * the placement is still proposed, marked for a look.
 *
 * Measured by `task be:eval:root-sort` on 150 labelled documents of a
 * synthetic Austrian project shelf (`tests/fixtures/root_sort/`), two runs:
 * at 0.8 the sure placements were right 0.972 and 0.972 of the time (106 and
 * 108 sure), at 0.6 only 0.930 and 0.939. Most wrong ones were filed one level
 * too high, in the parent of the right folder, and scored at most 0.8, so they
 * land in the look. The rule is the lowest cut whose sure placements are right
 * at least 0.95 of the time in every run: 0.75 cleared it in one run (0.955)
 * and missed in the other (0.946), 0.8 cleared both. Re-run the eval before
 * moving it.
 */
export const SURE_CONFIDENCE = 0.8

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

/** One judgement's answer, inside the job. */
export interface RootSortPlan {
  placements: RootSortPlacement[]
  /** Why this chunk was not judged (`llm_not_configured`, `backend_502`, …); null when it was. */
  error: string | null
  traceId: string | null
}

/**
 * Most documents one new-folder proposal reads: the leftovers of a whole run.
 * The backend groups them a hundred at a time and merges the groups in one
 * more call, so the names agree across the run (`/v1/folder-proposals`).
 */
export const MAX_NEW_FOLDER_DOCUMENTS = 1000
/** Most new folders one proposal answers. */
export const MAX_NEW_FOLDERS = 12

export const newFolderProposalSchema = z.object({
  /** The full path, under an existing folder or at the root; never one the shelf already has. */
  path: z.string(),
  description: z.string().nullable(),
  documentIds: z.array(z.string()),
  /** The decision model's agreement per document (id → probability); empty when it was not reachable. */
  confidences: z.record(z.string(), z.number().min(0).max(1)),
})
export type NewFolderProposal = z.infer<typeof newFolderProposalSchema>

/** The grouping's answer, inside the job. */
export interface NewFolders {
  proposals: NewFolderProposal[]
  error: string | null
  traceId: string | null
}

/** What the person sends to apply a run: `./root-sort-wire`, the contract the route and the agent door share. */
export type { ApplyRootSortRequest, KeptMove } from './root-sort-wire'

export const ROOT_SORT_RUN_STATUSES = [
  'judging',
  'grouping',
  'ready',
  'applying',
  'applied',
  'undoing',
  'undone',
  'cancelled',
  'failed',
] as const
export type RootSortRunStatus = (typeof ROOT_SORT_RUN_STATUSES)[number]

/** The statuses a job is working; the dialog follows a run in one of these. */
export const ROOT_SORT_WORKING_STATUSES: readonly RootSortRunStatus[] = ['judging', 'grouping', 'applying', 'undoing']

export const rootSortRunSchema = z.object({
  id: z.string(),
  status: z.enum(ROOT_SORT_RUN_STATUSES),
  /** Of the current step: documents judged, moves applied or undone. */
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  /** Root documents ingestion has not read yet; they stay where they are. */
  unreadable: z.number().int().nonnegative(),
  /** The root held more than `MAX_ROOT_SORT_DOCUMENTS`. */
  truncated: z.boolean(),
  /** What the person reviews; present once the run is ready, and after. */
  review: z
    .object({
      folders: z.array(rootSortFolderSchema),
      documents: z.array(rootSortDocumentSchema),
      placements: z.array(rootSortPlacementSchema),
      newFolders: z.array(newFolderProposalSchema),
      /** Documents whose judgement failed; they stay in the root. */
      failedDocumentIds: z.array(z.string()),
    })
    .nullable(),
  moved: z.number().int().nonnegative(),
  moveFailures: z.array(z.object({ documentId: z.string(), error: z.string() })),
  /** What the undo could not send back to the root; those files stay where the run put them. */
  undoFailures: z.array(z.object({ documentId: z.string(), error: z.string() })),
  error: z.string().nullable(),
  /** Why no new folders were proposed for the leftovers; the run is still ready, those files stay in the root. */
  groupingError: z.string().nullable(),
  createdAt: z.string(),
})
export type RootSortRunView = z.infer<typeof rootSortRunSchema>

/** What a shelf's root holds now, and the person's latest run on it (`GET …/root-sort`). */
export const rootSortSummarySchema = z.object({
  files: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  unreadable: z.number().int().nonnegative(),
  truncated: z.boolean(),
  run: rootSortRunSchema.nullable(),
})
export type RootSortSummary = z.infer<typeof rootSortSummarySchema>

export type PlacementCertainty = 'sure' | 'unsure'

/**
 * How a placement reads. One the decision model did not score (too many
 * folders to ask about, or it was not reachable) reads unsure: a sort places
 * every document it can, so nothing else vouches for it.
 */
export function certaintyOf(confidence: number | null): PlacementCertainty {
  return confidence !== null && confidence >= SURE_CONFIDENCE ? 'sure' : 'unsure'
}
