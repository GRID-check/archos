/**
 * The SQL of `root_sort_runs` (migration 0173). No authorization here;
 * `./root-sort-run` owns it. Every write states the status it expects, so a
 * slice the queue retried, or a click that raced the job, changes nothing it
 * did not mean to.
 */

import 'server-only'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { rootSortRuns, type RootSortRun } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import type { DocumentShelf } from '@/lib/documents/shelf'
import { ROOT_SORT_WORKING_STATUSES, type RootSortRunStatus } from './root-sort-types'

export type NewRootSortRun = Pick<
  typeof rootSortRuns.$inferInsert,
  'organizationId' | 'scope' | 'projectId' | 'requestedBy' | 'status' | 'documentIds' | 'unreadable' | 'truncated'
>

export type RootSortRunPatch = Partial<
  Pick<
    RootSortRun,
    | 'status'
    | 'cursor'
    | 'placements'
    | 'failedDocumentIds'
    | 'newFolders'
    | 'keptMoves'
    | 'movedDocumentIds'
    | 'moveFailures'
    | 'undoFailures'
    | 'error'
    | 'groupingError'
    | 'finishedAt'
  >
>

export async function insertRootSortRun(run: NewRootSortRun): Promise<RootSortRun> {
  const [row] = await withTenant({ organizationId: run.organizationId }, () =>
    getDb().insert(rootSortRuns).values(run).returning()
  )
  return row
}

export async function findRootSortRun(organizationId: string, runId: string): Promise<RootSortRun | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(rootSortRuns)
      .where(and(eq(rootSortRuns.organizationId, organizationId), eq(rootSortRuns.id, runId)))
      .limit(1)
  )
  return row ?? null
}

/** This person's most recent run on this shelf. */
export async function findLatestRootSortRun(
  organizationId: string,
  shelf: DocumentShelf,
  requestedBy: string
): Promise<RootSortRun | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(rootSortRuns)
      .where(
        and(
          eq(rootSortRuns.organizationId, organizationId),
          eq(rootSortRuns.scope, shelf.kind),
          shelf.kind === 'project' ? eq(rootSortRuns.projectId, shelf.projectId) : isNull(rootSortRuns.projectId),
          eq(rootSortRuns.requestedBy, requestedBy)
        )
      )
      .orderBy(desc(rootSortRuns.createdAt))
      .limit(1)
  )
  return row ?? null
}

/** Write `patch` when the run is still in one of `from`; null when it was not (another step moved it on). */
export async function updateRootSortRun(
  organizationId: string,
  runId: string,
  from: readonly RootSortRunStatus[],
  patch: RootSortRunPatch
): Promise<RootSortRun | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .update(rootSortRuns)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(
        and(
          eq(rootSortRuns.organizationId, organizationId),
          eq(rootSortRuns.id, runId),
          inArray(rootSortRuns.status, [...from])
        )
      )
      .returning()
  )
  return row ?? null
}

/**
 * End every run of the shelf that says it is working but has not moved since
 * `before`: its job died (out of attempts, or never queued), and nothing else
 * will ever finish it. Without this the shelf's one-in-work index would refuse
 * every later run. Answers the runs it ended.
 */
export async function failStalledRootSortRuns(
  organizationId: string,
  shelf: DocumentShelf,
  before: Date
): Promise<RootSortRun[]> {
  return withTenant({ organizationId }, () =>
    getDb()
      .update(rootSortRuns)
      .set({ status: 'failed', error: 'stalled', finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(rootSortRuns.organizationId, organizationId),
          eq(rootSortRuns.scope, shelf.kind),
          shelf.kind === 'project' ? eq(rootSortRuns.projectId, shelf.projectId) : isNull(rootSortRuns.projectId),
          inArray(rootSortRuns.status, [...ROOT_SORT_WORKING_STATUSES]),
          lt(rootSortRuns.updatedAt, before)
        )
      )
      .returning()
  )
}
