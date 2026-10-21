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
import { randomUUID } from 'node:crypto'
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
import { announceRootSortRun } from './root-sort-announce'
import { planRootChunk, proposeRootFolders, requireSortable, scanRoot, sortContextFor } from './root-sort'
import {
  cancelReadyRootSortRuns,
  failStalledRootSortRuns,
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

/**
 * How long an apply or undo slice starts moves: well inside the runner's five
 * minutes, so the slow tail of the last move (a backend mirror, a purge) still
 * lands before the runner gives the slice up. The moves not reached are the
 * next slice's.
 */
export const MOVE_SLICE_BUDGET_MS = 180_000

/** End the shelf's runs no job is working any more, and tell their requesters. Run before anything reads or starts a run. */
async function settleStalledRuns(organizationId: string, shelf: DocumentShelf): Promise<void> {
  const ended = await failStalledRootSortRuns(organizationId, shelf)
  for (const run of ended) await announceRootSortRun(run)
}

export function shelfOfRun(run: Pick<RootSortRun, 'scope' | 'projectId'>): DocumentShelf {
  return run.scope === 'project' && run.projectId ? projectShelf(run.projectId) : OFFICE_SHELF
}

/** What the shelf's root holds now, and this person's latest run on it. */
export async function describeRootSort(session: AuthorizedSession, shelf: DocumentShelf) {
  const scan = await scanRoot(session, shelf)
  await settleStalledRuns(session.organizationId, shelf)
  const latest = await findLatestRootSortRun(session.organizationId, shelf, session.userId)
  return {
    files: scan.documents.length,
    folders: scan.folders.length,
    unreadable: scan.unreadable,
    truncated: scan.truncated,
    run: latest ? await viewOf(session, latest) : null,
  }
}


/** Start a run over the root as it is now. One run in work per shelf. */
export async function startRootSort(session: AuthorizedSession, shelf: DocumentShelf): Promise<RootSortRunView> {
  const scan = await scanRoot(session, shelf)
  if (scan.folders.length === 0) throw new BadRequestError('The shelf has no folder to sort into.')
  if (scan.documents.length === 0) throw new BadRequestError('The root holds no file to sort.')
  await settleStalledRuns(session.organizationId, shelf)
  // A new run replaces this person's runs still waiting for review: an older review must not be applied over it.
  await cancelReadyRootSortRuns(session.organizationId, shelf, session.userId)
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
  const queued = await enqueueOrRevert(session, run, ['judging'], {
    status: 'failed',
    error: 'not_queued',
    finishedAt: new Date(),
  })
  return viewOf(session, queued)
}

/**
 * Queue the job that works the run, after naming it on the run (`job_id`), so
 * a run whose job is gone is told from one whose job is waiting
 * (`failStalledRootSortRuns`). A run whose job could not be queued would say
 * it is working with nothing working on it, so the step that moved it is
 * taken back (or a new run ended) before the failure surfaces.
 */
async function enqueueOrRevert(
  session: AuthorizedSession,
  run: RootSortRun,
  from: readonly RootSortRunStatus[],
  revert: RootSortRunPatch
): Promise<RootSortRun> {
  const jobId = randomUUID()
  const named = (await updateRootSortRun(session.organizationId, run.id, from, { jobId })) ?? run
  const payload: RootSortPayload = { runId: run.id, requester: requesterOf(session) }
  try {
    await enqueueJob({
      kind: 'root_sort',
      organizationId: session.organizationId,
      payload,
      priority: BFF_JOB_PRIORITY.interactive,
      jobId,
    })
  } catch (error) {
    await updateRootSortRun(session.organizationId, run.id, from, { ...revert, jobId: null })
    throw error
  }
  return named
}

/** The run, when it is this person's and they may still sort its shelf. */
async function ownRun(session: AuthorizedSession, runId: string): Promise<RootSortRun> {
  const found = await findRootSortRun(session.organizationId, runId)
  if (!found || found.requestedBy !== session.userId) throw new NotFoundError('Run not found.')
  await requireSortable(session, shelfOfRun(found))
  await settleStalledRuns(session.organizationId, shelfOfRun(found))
  return (await findRootSortRun(session.organizationId, runId)) ?? found
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
 * What the person kept, checked against the run and the shelf as it is now: a
 * document the run read, into a folder the review offered (open to every
 * member) or into a new folder the run proposed, never both. A placement back
 * to the root is not a move and is dropped. Each move is checked again when it
 * runs, and only moves a document still at the root.
 */
export function keptMovesOf(
  run: Pick<RootSortRun, 'documentIds' | 'placements' | 'newFolders'>,
  keep: readonly KeptMove[],
  openFolderIds: ReadonlySet<string>
): KeptMove[] {
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
    if (Boolean(move.folderId) === Boolean(move.newFolderPath)) return false
    if (move.folderId && !openFolderIds.has(move.folderId)) return false
    if (move.newFolderPath && !proposed.has(folderPathKey(move.newFolderPath))) return false
    seen.add(move.documentId)
    return true
  })
}

export async function applyRootSort(session: AuthorizedSession, runId: string, keep: readonly KeptMove[]): Promise<RootSortRunView> {
  const run = await ownRun(session, runId)
  const scan = await scanRoot(session, shelfOfRun(run))
  const keptMoves = keptMovesOf(run, keep, new Set(scan.folders.map((folder) => folder.id)))
  if (keptMoves.length === 0) throw new BadRequestError('Nothing to move.')
  const updated = await transition(session, run, ['ready'], { status: 'applying', keptMoves, cursor: 0 })
  const queued = await enqueueOrRevert(session, updated, ['applying'], { status: 'ready', keptMoves: [], cursor: 0 })
  return viewOf(session, queued)
}

/** Send back what the run moved: after it applied, or after it failed part of the way through applying. */
export async function undoRootSort(session: AuthorizedSession, runId: string): Promise<RootSortRunView> {
  const run = await ownRun(session, runId)
  if (run.movedDocuments.length === 0) throw new BadRequestError('The run moved nothing to undo.')
  const updated = await transition(session, run, ['applied', 'failed'], { status: 'undoing', cursor: 0 })
  const queued = await enqueueOrRevert(session, updated, ['undoing'], { status: run.status, cursor: 0 })
  return viewOf(session, queued)
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
      return { done: run.cursor, total: run.movedDocuments.length }
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
    moved: run.movedDocuments.length,
    moveFailures: run.moveFailures.slice(0, 50),
    undoFailures: run.undoFailures.slice(0, 50),
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
  const context = await sortContextFor(session, shelf)
  const plans = await Promise.all(chunks.map((ids) => planRootChunk(session, shelf, ids, context)))
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

/**
 * How many of `step` a slice got through: the moves before the first one the
 * deadline kept from starting. A move with no folder (its new folder could not
 * be created) needs no time and is always got through.
 */
function reached(step: readonly KeptMove[], started: number): number {
  let sent = 0
  let count = 0
  for (const move of step) {
    if (move.folderId && sent === started) break
    if (move.folderId) sent += 1
    count += 1
  }
  return count
}

/**
 * Apply the next moves the person kept, for as long as the slice's budget
 * lasts. Each moves a document only from the root, where the run found it; one
 * filed since stays where it is. A move into a folder that could not be
 * created fails, and the rest go on. Only a move that wrote something is
 * recorded, with its folder, for an undo.
 */
async function applySlice(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunPatch> {
  const keptMoves = run.cursor === 0 ? await createKeptFolders(session, run) : run.keptMoves
  const step = keptMoves.slice(run.cursor, run.cursor + MAX_MOVES_PER_SLICE)
  const outcomes = await moveDocumentsToFolders(
    step.flatMap((move) =>
      move.folderId ? [{ documentId: move.documentId, folderId: move.folderId, expectedFolderId: null }] : []
    ),
    session,
    { deadline: Date.now() + MOVE_SLICE_BUDGET_MS }
  )
  const done = reached(step, outcomes.length)
  const handled = step.slice(0, done)
  const folderOf = new Map(handled.map((move) => [move.documentId, move.folderId]))
  const cursor = run.cursor + done
  const finished = cursor >= keptMoves.length
  return {
    keptMoves,
    cursor,
    movedDocuments: [
      ...run.movedDocuments,
      ...outcomes.flatMap((o) => {
        const folderId = folderOf.get(o.documentId)
        return o.ok && o.changed !== false && folderId ? [{ documentId: o.documentId, folderId }] : []
      }),
    ],
    moveFailures: [
      ...run.moveFailures,
      ...handled.flatMap((move) =>
        move.folderId ? [] : [{ documentId: move.documentId, error: 'The new folder could not be created.' }]
      ),
      ...outcomes.flatMap((o) => (o.ok ? [] : [{ documentId: o.documentId, error: o.error ?? 'Move failed.' }])),
    ],
    status: finished ? 'applied' : 'applying',
    finishedAt: finished ? new Date() : null,
  }
}

/**
 * Move the next of what the run moved back to the root, for as long as the
 * slice's budget lasts, and only where it is still in the folder the run put
 * it in: a document somebody filed since stays where they put it.
 */
async function undoSlice(session: AuthorizedSession, run: RootSortRun): Promise<RootSortRunPatch> {
  const step = run.movedDocuments.slice(run.cursor, run.cursor + MAX_MOVES_PER_SLICE)
  const outcomes = await moveDocumentsToFolders(
    step.map((moved) => ({ documentId: moved.documentId, folderId: null, expectedFolderId: moved.folderId })),
    session,
    { deadline: Date.now() + MOVE_SLICE_BUDGET_MS }
  )
  const cursor = run.cursor + outcomes.length
  const finished = cursor >= run.movedDocuments.length
  return {
    cursor,
    undoFailures: [
      ...run.undoFailures,
      ...outcomes.flatMap((o) => (o.ok ? [] : [{ documentId: o.documentId, error: o.error ?? 'Undo failed.' }])),
    ],
    status: finished ? 'undone' : 'undoing',
    finishedAt: finished ? new Date() : null,
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
    const failed = await updateRootSortRun(
      session.organizationId,
      run.id,
      [run.status],
      { status: 'failed', error: error.message, finishedAt: new Date() },
      { cursor: run.cursor }
    )
    if (failed) await announceRootSortRun(failed)
    return { done: true, payload }
  }
  // Conditioned on the cursor too: a slice the runner gave up on that finished late must not overwrite the one after it.
  const updated = await updateRootSortRun(session.organizationId, run.id, [run.status], patch, { cursor: run.cursor })
  // The person may have closed the dialog: a run that now waits on them, or ended badly, tells them in the Eingang.
  if (updated && updated.status !== run.status) await announceRootSortRun(updated)
  const working = updated !== null && STEPS[updated.status] !== undefined
  return { done: !working, payload }
}

/**
 * End the run of a requester who is no longer a member of the organization:
 * nothing more can be done in their name, and the shelf must not stay locked
 * behind their run. Called by the job's handler, which has no session for them.
 */
export async function endRunOfDepartedRequester(organizationId: string, runId: string): Promise<void> {
  await updateRootSortRun(organizationId, runId, ['judging', 'grouping', 'applying', 'undoing'], {
    status: 'failed',
    error: 'requester_left',
    finishedAt: new Date(),
  })
}
