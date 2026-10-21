import 'server-only'
/**
 * Tells a root sort's requester that its run is ready to review, or has
 * stopped on an error (ADR-0121, `root_sort.ready` / `root_sort.failed`).
 *
 * The person may have closed the dialog: the row is how they find out. One row
 * per run and kind, addressed to the requester alone, and told once: a run
 * announced again (a retried slice) leaves the row it has, read or not. Best
 * effort: it never throws into the job that called it, because the run it
 * reports is already stored.
 */

import type { RootSortRun } from '@/lib/db/schema'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { recipientsHoldingGroup } from '@/lib/inbox/repository'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { RootSortPlacement } from './root-sort-types'

/** A run that is ready, or has stopped, gets a row; every other status is no news. */
export async function announceRootSortRun(run: RootSortRun): Promise<void> {
  if (run.status !== 'ready' && run.status !== 'failed') return
  const type = run.status === 'ready' ? 'root_sort.ready' : 'root_sort.failed'
  const moves = run.status === 'ready' ? proposedMoves(run.placements) : 1
  // A sort that proposes nothing to move has nothing to review: no row says so.
  if (moves === 0) return
  await bestEffortInbox(`${type} for run ${run.id}`, run.organizationId, async () => {
    const emission = await emissionOf(run, type, moves)
    if (!emission) return
    const told = await recipientsHoldingGroup(run.organizationId, emission.groupKey, [emission.recipientUserId])
    if (told.has(emission.recipientUserId)) return
    await emitInboxItems([emission])
  })
}

/** The files a ready run proposes to move: every placement into a folder that exists or is to be made. */
function proposedMoves(placements: readonly RootSortPlacement[]): number {
  return placements.filter((placement) => placement.folderId !== null || placement.newFolderPath !== null).length
}

/**
 * The row for the run's shelf: a project's row names the project and points at
 * its Dateien; the office filing names no place (a place name in the payload is
 * rendered verbatim in every language), so its copy says so by variant and it
 * points at the office shelf. Null when the project is gone: nothing to tell.
 */
async function emissionOf(
  run: RootSortRun,
  type: 'root_sort.ready' | 'root_sort.failed',
  moves: number
): Promise<InboxEmission | null> {
  const common = {
    organizationId: run.organizationId,
    recipientUserId: run.requestedBy,
    type,
    anchorId: run.id,
    // Piloti did the work; an actor equal to the recipient would drop the row.
    actorUserId: null,
    // `occurrences` is the file count the copy reads (`{count}`); a failed run is one notice.
    occurrences: moves,
  }
  if (run.scope === 'project' && run.projectId) {
    const project = await findProjectInOrg(run.projectId, run.organizationId)
    if (!project) return null
    return {
      ...common,
      resourceType: 'project',
      resourceId: run.projectId,
      groupKey: inboxGroupKey(type, 'project', run.projectId, run.id),
      payload: { subject: project.name },
    }
  }
  return {
    ...common,
    resourceType: 'organization',
    resourceId: run.organizationId,
    groupKey: inboxGroupKey(type, 'organization', run.organizationId, run.id),
    payload: { variant: 'office' },
  }
}
