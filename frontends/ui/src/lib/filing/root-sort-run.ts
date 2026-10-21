/**
 * A run of sorting a shelf's root, owned by the server (ADR-0121).
 *
 * The person starts a run, reads it, and asks for its next step; the BFF job
 * `root_sort` does the work, a bounded slice at a time, and keeps everything
 * it learns on the run's `root_sort_runs` row. Nothing here runs because a
 * browser tab is open, so closing it, a deploy or a dead worker loses nothing:
 * the queue resumes the run where its row says it got to.
 *
 * The steps and what each may read are `./root-sort-types` and `./root-sort`.
 * A run is its requester's: only they see it and act on it, and the job runs as
 * them, with their rights as the identity provider states them at each slice.
 */

import 'server-only'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { RootSortRun } from '@/lib/db/schema'
import { isUniqueViolation } from '@/lib/db/errors'
import { memberReader } from '@/lib/documents/document-reader'
import { moveDocumentsToFolders } from '@/lib/documents/move-to-folder'
import { OFFICE_SHELF, projectShelf, type DocumentShelf } from '@/lib/documents/shelf'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, requesterOf, type JobSliceResult, type RootSortPayload } from '@/lib/jobs-queue/types'
import { ensureOfficeShelfFolderPaths } from '@/lib/office-shelf/folder-service'
import { folderPathKey } from '@/lib/projects/folders'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { findRootDocuments } from './repository'
import { planRootChunk, proposeRootFolders, requireSortable, scanRoot } from './root-sort'
import {
  findLatestRootSortRun,
  findRootSortRun,
  insertRootSortRun,
  updateRootSortRun,
  type RootSortRunPatch,
} from './root-sort-run-repository'
import {
  CHUNKS_PER_SLICE,
  MAX_MOVES_PER_SLICE,
  MAX_NEW_FOLDER_DOCUMENTS,
  ROOT_SORT_CHUNK,
  type KeptMove,
  type RootSortRunStatus,
  type RootSortRunView,
} from './root-sort-types'

const ONE_IN_WORK_INDEX = 'root_sort_runs_one_in_work_per_shelf'

export function shelfOfRun(run: Pick<RootSortRun, 'scope' | 'projectId'>): DocumentShelf {
  return run.scope === 'project' && run.projectId ? projectShelf(run.projectId) : OFFICE_SHELF
}

/** What the shelf's root holds now, and this person's latest run on it. */
export async function describeRootSort(session: AuthorizedSession, shelf: DocumentShelf) {
  const scan = await scanRoot(session, shelf)
  const latest = await findLatestRootSortRun(session.organizationId, shelf, session.userId)
  return {
    files: scan.documents.length,
    folders: scan.folders.length,
    unreadable: scan.unreadable,
    truncated: scan.truncated,
    run: latest ? await viewOf(session, latest) : null,
  }
}

async function enqueueSlice(session: AuthorizedSession, runId: string): Promise<void> {
  const payload: RootSortPayload = { runId, requester: requesterOf(session) }
  await enqueueJob({
    kind: 'root_sort',
    organizationId: session.organizationId,
    payload,
    priority: BFF_JOB_PRIORITY.interactive,
  })
}

/** Start a run over the root as it is now. One run in work per shelf. */
export async function startRootSort(session: AuthorizedSession, shelf: DocumentShelf): Promise<RootSortRunView> {
  const scan = await scanRoot(session, shelf)
  if (scan.folders.length === 0) throw new BadRequestError('The shelf has no folder to sort into.')
  if (scan.documents.length === 0) throw new BadRequestError('The root holds no file to sort.')
  let run: RootSortRun
  try {
    run = await insertRootSortRun({
      organizationId: session.organizationId,
      scope: shelf.kind,
      projectId: shelf.kind === 'project' ? shelf.projectId : null,
      requestedBy: session.userId,
      status: 'judging',
      documentIds: scan.documents.map((document) => document.id),
      unreadable: scan.unreadable,
      truncated: scan.truncated,
    })
  } catch (error) {
    if (isUniqueViolation(error, ONE_IN_WORK_INDEX)) throw new ConflictError('A sort of this shelf is already running.')
    throw error
  }
  await enqueueSlice(session, run.id)
  return viewOf(session, run)
}

/** The run, when it is this person's and they may still sort its shelf. */
async function ownRun(session: AuthorizedSession, runId: string): Promise<RootSortRun> {
  const run = await findRootSortRun(session.organizationId, runId)
  if (!run || run.requestedBy !== session.userId) throw new NotFoundError('Run not found.')
  await requireSortable(session, shelfOfRun(run))
  return run
}

export async function getRootSortRun(session: AuthorizedSession, runId: string): Promise<RootSortRunView> {
  return viewOf(session, await ownRun(session, runId))
}

/** Change a run's status, or refuse: the run moved on (or was never) in a status that allows it. */
async function transition(
  session: AuthorizedSession,
  run: RootSortRun,
  from: readonly RootSortRunStatus[],
  patch: RootSortRunPatch
): Promise<RootSortRun> {
  const updated = await updateRootSortRun(session.organizationId, run.id, from, patch)
  if (!updated) throw new ConflictError(`The run is ${run.status}; it cannot do that now.`)
  return updated
}

/**
 * What the person kept, checked against the run: a document the run read, into
 * a folder (the move re-checks it) or a new folder the run proposed. A
 * placement back to the root is not a move and is dropped.
 */
export function keptMovesOf(run: Pick<RootSortRun, 'documentIds' | 'placements' | 'newFolders'>, keep: readonly KeptMove[]): KeptMove[] {
  const known = new Set(run.documentIds)
  const proposed = new Set(
    [
      ...run.newFolders.map((folder) => folder.path),
      ...run.placements.flatMap((placement) => (placement.newFolderPath ? [placement.newFolderPath] : [])),
    ].map(folderPathKey)
  )
  const seen = new Set<string>()
  return keep.filter((move) => {
    if (!known.has(move.documentId) || seen.has(move.documentId)) return false
    if (!move.folderId && !move.newFolderPath) return false
    if (!move.folderId && move.newFolderPath && !proposed.has(folderPathKey(move.newFolderPath))) return false
    seen.add(move.documentId)
    return true
  })
}

export async function applyRootSort(session: AuthorizedSession, runId: string, keep: readonly KeptMove[]): Promise<RootSortRunView> {
  const run = await ownRun(session, runId)
  const keptMoves = keptMovesOf(run, keep)
  if (keptMoves.length === 0) throw new BadRequestError('Nothing to move.')
  const updated = await transition(session, run, ['ready'], { status: 'applying', keptMoves, cursor: 0 })
  await enqueueSlice(session, run.id)
  return viewOf(session, updated)
}

export async function undoRootSort(session: AuthorizedSession, runId: string): Promise<RootSortRunView> {
  const run = await ownRun(session, runId)
  const updated = await transition(session, run, ['applied'], { status: 'undoing', cursor: 0 })
  await enqueueSlice(session, run.id)
  return viewOf(session, updated)
}

/** Stop a run before anything moved. A run that is applying finishes what it started. */
export async function cancelRootSort(session: AuthorizedSession, runId: string): Promise<RootSortRunView> {
  const run = await ownRun(session, runId)
  const updated = await transition(session, run, ['judging', 'grouping', 'ready'], {
    status: 'cancelled',
    finishedAt: new Date(),
  })
  return viewOf(session, updated)
}

function progressOf(run: RootSortRun): RootSortRunView['progress'] {
  switch (run.status) {
    case 'judging':
      return { done: run.cursor, total: run.documentIds.length }
    case 'grouping':
    case 'ready':
      return { done: run.documentIds.length, total: run.documentIds.length }
    case 'applying':
      return { done: run.cursor, total: run.keptMoves.length }
    case 'undoing':
      return { done: run.cursor, total: run.movedDocumentIds.length }
    default:
      return { done: 0, total: 0 }
  }
}

/** The run as its dialog reads it. The review (folders and names) is read only while it waits on the person. */
export async function viewOf(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunView> {
  let review: RootSortRunView['review'] = null
  if (run.status === 'ready') {
    const shelf = shelfOfRun(run)
    const [scan, rows] = await Promise.all([
      scanRoot(session, shelf),
      findRootDocuments(session.organizationId, shelf, memberReader(session.userId), run.documentIds),
    ])
    review = {
      folders: scan.folders,
      // A file moved or deleted since the run read it drops out of the review.
      documents: rows.map((row) => ({ id: row.id, name: row.displayName || row.filename })),
      placements: run.placements,
      newFolders: run.newFolders,
      failedDocumentIds: run.failedDocumentIds,
    }
  }
  return {
    id: run.id,
    status: run.status,
    progress: progressOf(run),
    unreadable: run.unreadable,
    truncated: run.truncated,
    review,
    moved: run.movedDocumentIds.length,
    moveFailures: run.moveFailures.slice(0, 50),
    error: run.error,
    groupingError: run.groupingError,
    createdAt: new Date(run.createdAt).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

type Slice = JobSliceResult<RootSortPayload>

/** Judge the next chunks side by side. A chunk that fails is recorded; its documents stay in the root. */
async function judgeSlice(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunPatch> {
  const shelf = shelfOfRun(run)
  const step = run.documentIds.slice(run.cursor, run.cursor + ROOT_SORT_CHUNK * CHUNKS_PER_SLICE)
  const chunks = Array.from({ length: Math.ceil(step.length / ROOT_SORT_CHUNK) }, (_, index) =>
    step.slice(index * ROOT_SORT_CHUNK, (index + 1) * ROOT_SORT_CHUNK)
  )
  const plans = await Promise.all(chunks.map((ids) => planRootChunk(session, shelf, ids)))
  const cursor = run.cursor + step.length
  return {
    placements: [...run.placements, ...plans.flatMap((plan) => plan.placements)],
    failedDocumentIds: [...run.failedDocumentIds, ...chunks.flatMap((ids, index) => (plans[index].error ? ids : []))],
    cursor,
    status: cursor >= run.documentIds.length ? 'grouping' : 'judging',
  }
}

/** Group what no folder fits into proposed new folders. A grouping that fails leaves those files in the root. */
async function groupSlice(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunPatch> {
  const settled = new Set([...run.placements.map((placement) => placement.documentId), ...run.failedDocumentIds])
  const leftovers = run.documentIds.filter((id) => !settled.has(id)).slice(0, MAX_NEW_FOLDER_DOCUMENTS)
  const grouped = leftovers.length >= 2 ? await proposeRootFolders(session, shelfOfRun(run), leftovers) : null
  if (grouped?.error) console.warn(`[root-sort] run ${run.id} was not grouped: ${grouped.error}`)
  return { newFolders: grouped?.proposals ?? [], groupingError: grouped?.error ?? null, status: 'ready' }
}

/** Create the new folders the person kept, and point their moves at them. Runs once, before the first move. */
async function createKeptFolders(session: AuthorizedSession, run: RootSortRun): Promise<KeptMove[]> {
  const paths = [...new Set(run.keptMoves.flatMap((move) => (move.newFolderPath ? [move.newFolderPath] : [])))]
  if (paths.length === 0) return run.keptMoves
  const shelf = shelfOfRun(run)
  const input = { parentId: null, paths }
  const outcome =
    shelf.kind === 'project'
      ? await ensureProjectFolderPaths({ projectId: shelf.projectId, ...input }, session)
      : await ensureOfficeShelfFolderPaths(session, input)
  const idByKey = new Map(
    outcome.ok ? Object.entries(outcome.folderIdByPath).map(([path, id]) => [folderPathKey(path), id]) : []
  )
  if (!outcome.ok) console.warn(`[root-sort] run ${run.id} could not create its folders: ${outcome.error}`)
  return run.keptMoves.map((move) =>
    move.newFolderPath ? { ...move, folderId: idByKey.get(folderPathKey(move.newFolderPath)) ?? null } : move
  )
}

/** Apply the next moves the person kept. A move into a folder that could not be created fails, and the rest go on. */
async function applySlice(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunPatch> {
  const keptMoves = run.cursor === 0 ? await createKeptFolders(session, run) : run.keptMoves
  const step = keptMoves.slice(run.cursor, run.cursor + MAX_MOVES_PER_SLICE)
  const unplaceable = step.filter((move) => !move.folderId)
  const outcomes = await moveDocumentsToFolders(
    step.flatMap((move) => (move.folderId ? [{ documentId: move.documentId, folderId: move.folderId }] : [])),
    session
  )
  const cursor = run.cursor + step.length
  const done = cursor >= keptMoves.length
  return {
    keptMoves,
    cursor,
    movedDocumentIds: [...run.movedDocumentIds, ...outcomes.filter((o) => o.ok).map((o) => o.documentId)],
    moveFailures: [
      ...run.moveFailures,
      ...unplaceable.map((move) => ({ documentId: move.documentId, error: 'The new folder could not be created.' })),
      ...outcomes.flatMap((o) => (o.ok ? [] : [{ documentId: o.documentId, error: o.error ?? 'Move failed.' }])),
    ],
    status: done ? 'applied' : 'applying',
    finishedAt: done ? new Date() : null,
  }
}

/** Move the next of what the run moved back to the root. */
async function undoSlice(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunPatch> {
  const step = run.movedDocumentIds.slice(run.cursor, run.cursor + MAX_MOVES_PER_SLICE)
  const outcomes = await moveDocumentsToFolders(
    step.map((documentId) => ({ documentId, folderId: null })),
    session
  )
  const cursor = run.cursor + step.length
  const done = cursor >= run.movedDocumentIds.length
  return {
    cursor,
    moveFailures: [
      ...run.moveFailures,
      ...outcomes.flatMap((o) => (o.ok ? [] : [{ documentId: o.documentId, error: o.error ?? 'Undo failed.' }])),
    ],
    status: done ? 'undone' : 'undoing',
    finishedAt: done ? new Date() : null,
  }
}

const STEPS: Partial<Record<RootSortRunStatus, (session: AuthorizedSession, run: RootSortRun) => Promise<RootSortRunPatch>>> = {
  judging: judgeSlice,
  grouping: groupSlice,
  applying: applySlice,
  undoing: undoSlice,
}

/**
 * One slice of the `root_sort` job: read where the run got to, do one bounded
 * step, write it back conditioned on the status it read. A run that is not
 * working (ready, finished, cancelled) ends the job; the person's next request
 * queues the next one.
 */
export async function runRootSortSlice(session: AuthorizedSession, payload: RootSortPayload): Promise<Slice> {
  const run = await findRootSortRun(session.organizationId, payload.runId)
  const step = run && run.requestedBy === session.userId ? STEPS[run.status] : undefined
  if (!run || !step) return { done: true, payload }
  let patch: RootSortRunPatch
  try {
    await requireSortable(session, shelfOfRun(run))
    patch = await step(session, run)
  } catch (error) {
    // A refusal (the person lost the shelf, the project closed) ends the run with its reason; anything else is retried.
    if (!(error instanceof BadRequestError || error instanceof NotFoundError || error instanceof ForbiddenError)) throw error
    await updateRootSortRun(session.organizationId, run.id, [run.status], {
      status: 'failed',
      error: error.message,
      finishedAt: new Date(),
    })
    return { done: true, payload }
  }
  const updated = await updateRootSortRun(session.organizationId, run.id, [run.status], patch)
  const working = updated !== null && STEPS[updated.status] !== undefined
  return { done: !working, payload }
}
