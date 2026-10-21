/**
 * One root sort, run from the browser: judge the root, propose folders for
 * what no folder fits, then apply what the person kept. The contract's client
 * (`@/lib/filing/root-sort-client`) makes every request; this only sequences
 * them and reads their answers.
 *
 * Nothing here moves a file until `applyKeptMoves`. The dialog owns the
 * person's choices and calls these in order.
 */

import {
  ensureFolders,
  applyFolderMoves,
  planRootSort,
  proposeNewFolders,
  type RootSortRun,
  type RootSortRunProgress,
} from '@/lib/filing/root-sort-client'
import {
  MAX_NEW_FOLDER_DOCUMENTS,
  type FolderMove,
  type NewFolderProposal,
  type RootSortScan,
  type RootSortShelf,
} from '@/lib/filing/root-sort-types'
import { folderIdFor, type KeptMoves } from './placement-tree'

export interface JudgedRoot {
  run: RootSortRun
  proposals: NewFolderProposal[]
  /** Leftover files the new-folder proposal did not read: they stay in the root. */
  overflow: number
  /** Why the new-folder proposal failed, when it did; its files then stay in the root. */
  proposalError: string | null
}

/** Documents no folder fits: neither placed nor failed. */
export function leftoverIds(documentIds: readonly string[], run: RootSortRun): string[] {
  const placed = new Set(
    run.placements
      .filter((placement) => placement.folderId || placement.newFolderPath)
      .map((p) => p.documentId)
  )
  const failed = new Set(run.failedDocumentIds)
  return documentIds.filter((id) => !placed.has(id) && !failed.has(id))
}

export async function judgeRoot(
  shelf: RootSortShelf,
  scan: RootSortScan,
  onProgress: (progress: RootSortRunProgress) => void,
  onGrouping: (count: number) => void
): Promise<JudgedRoot> {
  const run = await planRootSort(
    shelf,
    scan.documents.map((document) => document.id),
    onProgress
  )
  const leftovers = leftoverIds(
    scan.documents.map((document) => document.id),
    run
  )
  const sent = leftovers.slice(0, MAX_NEW_FOLDER_DOCUMENTS)
  if (sent.length === 0) return { run, proposals: [], overflow: 0, proposalError: null }
  onGrouping(sent.length)
  const answer = await proposeNewFolders(shelf, sent)
  return {
    run,
    proposals: answer.proposals,
    overflow: leftovers.length - sent.length,
    proposalError: answer.error,
  }
}

export interface AppliedRun {
  moved: string[]
  failed: Array<{ documentId: string; error: string }>
}

/**
 * Create the kept new folders once, then move every kept file: to its folder,
 * or to the id the ensure route answered for its new folder's path. A file
 * whose folder did not come back is reported as failed, not moved to nowhere.
 * Throws only when the folders cannot be created: then nothing has moved.
 */
export async function applyKeptMoves(
  shelf: RootSortShelf,
  kept: KeptMoves,
  onProgress: (progress: RootSortRunProgress) => void
): Promise<AppliedRun> {
  const folderIdByPath =
    kept.newFolderPaths.length > 0 ? await ensureFolders(shelf, kept.newFolderPaths) : {}
  const moves: FolderMove[] = []
  const failed: AppliedRun['failed'] = []
  for (const move of kept.moves) {
    const folderId =
      move.folderId ?? (move.newFolderPath ? folderIdFor(move.newFolderPath, folderIdByPath) : null)
    if (folderId) moves.push({ documentId: move.documentId, folderId })
    else failed.push({ documentId: move.documentId, error: 'missingFolder' })
  }
  if (moves.length === 0) return { moved: [], failed }
  const result = await applyFolderMoves(moves, onProgress)
  return { moved: result.moved, failed: [...failed, ...result.failed] }
}

/** Set every moved file back in the root. Folders created by the run stay. */
export async function undoMoves(
  documentIds: readonly string[],
  onProgress: (progress: RootSortRunProgress) => void
): Promise<AppliedRun> {
  if (documentIds.length === 0) return { moved: [], failed: [] }
  const result = await applyFolderMoves(
    documentIds.map((documentId) => ({ documentId, folderId: null })),
    onProgress
  )
  return { moved: result.moved, failed: result.failed }
}
