/**
 * The SQL of `root_sort_runs` (migrations 0173, 0174). No authorization here;
 * `./root-sort-run` owns it. Every write states the status it expects, so a
 * slice the queue retried, or a click that raced the job, changes nothing it
 * did not mean to.
 */

import 'server-only'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { bffJobQueue, rootSortRuns, type RootSortRun } from '@/lib/db/schema'
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
    | 'progressDone'
    | 'placements'
    | 'failedDocumentIds'
    | 'newFolders'
    | 'keptMoves'
    | 'movedDocuments'
    | 'jobId'
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

/**
 * Write `patch` when the run is still in one of `from` (and, given `cursor`,
 * still at it); null when it was not: another step moved it on, or a slice
 * the runner gave up on finished late and must not overwrite the one after it.
 */
export async function updateRootSortRun(
  organizationId: string,
  runId: string,
  from: readonly RootSortRunStatus[],
  patch: RootSortRunPatch,
  expected: { cursor?: number } = {}
): Promise<RootSortRun | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .update(rootSortRuns)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(
        and(
          eq(rootSortRuns.organizationId, organizationId),
          eq(rootSortRuns.id, runId),
          inArray(rootSortRuns.status, [...from]),
          expected.cursor === undefined ? undefined : eq(rootSortRuns.cursor, expected.cursor)
        )
      )
      .returning()
  )
  return row ?? null
}

/**
 * Raise what the run shows as done in its current step, while the slice that
 * does it is still running (migration 0174). Display only, so it never moves a
 * cursor: it writes only while the run is still in `status` at `cursor` (a
 * slice the runner gave up on cannot reach the step after it), and it takes the
 * GREATEST, so chunks finishing out of order cannot pull it back.
 */
export async function recordRootSortProgress(
  organizationId: string,
  runId: string,
  expected: { status: RootSortRunStatus; cursor: number },
  done: number
): Promise<void> {
  await withTenant({ organizationId }, () =>
    getDb()
      .update(rootSortRuns)
      .set({ progressDone: sql`GREATEST(${rootSortRuns.progressDone}, ${done})`, updatedAt: sql`now()` })
      .where(
        and(
          eq(rootSortRuns.organizationId, organizationId),
          eq(rootSortRuns.id, runId),
          eq(rootSortRuns.status, expected.status),
          eq(rootSortRuns.cursor, expected.cursor)
        )
      )
  )
}

/**
 * Whether the run's job is queued and no worker holds it yet: the run waits for
 * a free slot in the BFF's job pool rather than being worked. False once a
 * worker claims it, and for a run without a job.
 */
export async function isRootSortJobWaiting(organizationId: string, jobId: string | null): Promise<boolean> {
  if (jobId === null) return false
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select({ status: bffJobQueue.status })
      .from(bffJobQueue)
      .where(and(eq(bffJobQueue.jobId, jobId), eq(bffJobQueue.lane, organizationId)))
      .limit(1)
  )
  return row?.status === 'queued'
}

/** How long a run may say it is working before its job row exists: the step that moved it queues the job just after. */
export const STALL_GRACE_MS = 2 * 60 * 1000

/**
 * End every run of the shelf that says it is working while no job works it:
 * its `bff_job_queue` row is gone (the job finished without moving the run on)
 * or dead (out of attempts), or it never got one. Without this the shelf's
 * one-in-work index would refuse every later run. A run younger than
 * {@link STALL_GRACE_MS} is left alone: its job is being queued. Answers the
 * runs it ended.
 */
export async function failStalledRootSortRuns(organizationId: string, shelf: DocumentShelf): Promise<RootSortRun[]> {
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
          lt(rootSortRuns.updatedAt, sql`now() - make_interval(secs => ${STALL_GRACE_MS / 1000})`),
          sql`NOT EXISTS (
            SELECT 1 FROM ${bffJobQueue}
            WHERE ${bffJobQueue.jobId} = ${rootSortRuns.jobId}
              AND ${bffJobQueue.lane} = ${organizationId}
              AND ${bffJobQueue.status} IN ('queued', 'claimed')
          )`
        )
      )
      .returning()
  )
}

/** Cancel this person's runs of the shelf that still wait for review: a new run replaces them. Answers the runs it cancelled. */
export async function cancelReadyRootSortRuns(
  organizationId: string,
  shelf: DocumentShelf,
  requestedBy: string
): Promise<RootSortRun[]> {
  return withTenant({ organizationId }, () =>
    getDb()
      .update(rootSortRuns)
      .set({ status: 'cancelled', finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(rootSortRuns.organizationId, organizationId),
          eq(rootSortRuns.scope, shelf.kind),
          shelf.kind === 'project' ? eq(rootSortRuns.projectId, shelf.projectId) : isNull(rootSortRuns.projectId),
          eq(rootSortRuns.requestedBy, requestedBy),
          eq(rootSortRuns.status, 'ready')
        )
      )
      .returning()
  )
}
