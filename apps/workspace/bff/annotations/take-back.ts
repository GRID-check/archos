/**
 * Taking a mark back from Piloti ends the work the delegation started
 * (ADR-0106): the wake of the delegation that has not ended yet is either
 * still waiting for its job, or its turn runs.
 *
 * - `queued`: settled `suppressed` (`taken back`), so the job never starts a
 *   turn. That is a write of its own, after the take-back committed
 *   ({@link settleTakenBack}); a wake that started in between is stopped
 *   instead.
 * - `started`: a `piloti_wake_stop` job, enqueued in the take-back's own
 *   transaction ({@link readTakeBack}), so a crash after the commit loses no
 *   stop. The turn then ends `stopped` and reports that itself; nothing here
 *   ends the wake.
 *
 * Piloti taking a mark back (resolving it in the asker's name) never stops a
 * turn: the turn that resolves it is usually the delegation's own, finishing.
 *
 * Each wake a take-back stops is one `piloti.wake.stopped` in the audit trail
 * (`./wake-audit.ts`), after the commit, with the person who took the mark
 * back as its actor: a queued wake once this call settled it, a started one
 * once its stop is enqueued. Deleting the mark stops its wakes the same way
 * ({@link auditDeletedWithMark}).
 */

import 'server-only'
import type { DbExecutor } from '@/lib/db/executor'
import { getDb } from '@/lib/db'
import type { PilotiWakeRow } from '@/lib/db/schema/document-annotations'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, type PilotiWakeStopPayload } from '@/lib/jobs-queue/types'
import { withTenant } from '@/lib/db/tenant-context'
import { auditWakeStopped, type WakeStopper } from './wake-audit'
import { delegationEventId } from './wake-ids'
import { findLiveDelegationWake, settleWake } from './wake-repository'

/** The job kind a stop runs as. */
export const PILOTI_WAKE_STOP_JOB = 'piloti_wake_stop'

/** The reason recorded on a wake a take-back kept from starting. */
export const TAKEN_BACK = 'taken back'

/** A delegation that is being ended. */
export interface EndedDelegation {
  organizationId: string
  documentId: string
  annotationId: string
  /** When it was delegated: with the mark, the id of the event its wake is. */
  delegatedAt: Date
}

/** What the take-back found, to act on once it committed. */
export interface TakeBack {
  /** The wake still waiting for its job, to settle after the commit. */
  queuedWake: PilotiWakeRow | null
  /** The started wake whose stop was enqueued in the take-back's transaction. */
  stoppingWake: PilotiWakeRow | null
}

/** Who took the mark back, and what the trail says about the mark. */
export interface TakeBackAudit extends WakeStopper {
  projectId: string | null
  markNumber: number | null
}

const NOTHING: TakeBack = { queuedWake: null, stoppingWake: null }

/** One stopped wake into the trail. */
function auditStopped(wake: PilotiWakeRow, status: 'queued' | 'started', by: TakeBackAudit): void {
  auditWakeStopped(
    {
      organizationId: wake.organizationId,
      wakeId: wake.id,
      documentId: wake.documentId,
      annotationId: wake.annotationId,
      trigger: wake.triggerKind,
      wokenBy: { userId: wake.actorUserId, email: null },
      projectId: by.projectId,
      markNumber: by.markNumber,
    },
    status,
    by
  )
}

const stopPayload = (wake: PilotiWakeRow): PilotiWakeStopPayload => ({
  wakeId: wake.id,
  documentId: wake.documentId,
  annotationId: wake.annotationId,
  actorUserId: wake.actorUserId,
})

function enqueueStop(executor: DbExecutor, organizationId: string, wake: PilotiWakeRow): Promise<unknown> {
  return enqueueJob(
    {
      kind: PILOTI_WAKE_STOP_JOB,
      organizationId,
      payload: { ...stopPayload(wake) },
      // A person pressed the button: ahead of the lane's bulk walks.
      priority: BFF_JOB_PRIORITY.interactive,
    },
    executor
  )
}

/**
 * In the take-back's transaction: look at the delegation's live wake, enqueue
 * the stop of a started one (unless `stopTurn` is false), and name a queued
 * one for {@link settleTakenBack}.
 */
export async function readTakeBack(
  tx: DbExecutor,
  delegation: EndedDelegation,
  { stopTurn }: { stopTurn: boolean }
): Promise<TakeBack> {
  const { organizationId, annotationId } = delegation
  const wake = await findLiveDelegationWake(
    tx,
    organizationId,
    annotationId,
    delegationEventId(annotationId, delegation.delegatedAt)
  )
  if (!wake) return NOTHING
  if (wake.status === 'queued') return { queuedWake: wake, stoppingWake: null }
  if (!stopTurn) return NOTHING
  await enqueueStop(tx, organizationId, wake)
  return { queuedWake: null, stoppingWake: wake }
}

/**
 * After the take-back committed: keep a queued wake from starting. When the
 * job got there first (the wake started between the read and now), the turn
 * runs and is stopped like any started one.
 */
export async function settleTakenBack(
  delegation: EndedDelegation,
  takeBack: TakeBack,
  { stopTurn }: { stopTurn: boolean },
  by: TakeBackAudit
): Promise<void> {
  if (takeBack.stoppingWake) auditStopped(takeBack.stoppingWake, 'started', by)
  const queued = takeBack.queuedWake
  if (!queued) return
  const { organizationId, annotationId } = delegation
  if (await settleWake(organizationId, queued.id, { status: 'suppressed', reason: TAKEN_BACK })) {
    auditStopped(queued, 'queued', by)
    return
  }
  if (!stopTurn) return
  await withTenant({ organizationId }, async () => {
    const db = getDb()
    const wake = await findLiveDelegationWake(
      db,
      organizationId,
      annotationId,
      delegationEventId(annotationId, delegation.delegatedAt)
    )
    if (wake?.status !== 'started') return
    await enqueueStop(db, organizationId, wake)
    auditStopped(wake, 'started', by)
  })
}

/**
 * After a delete committed: the mark took its wakes with it. A queued one's
 * row is gone, so its job finds nothing and starts no turn; a started one's
 * stop was enqueued in the delete's transaction (`readTakeBack`).
 */
export function auditDeletedWithMark(takeBack: TakeBack, by: TakeBackAudit): void {
  if (takeBack.queuedWake) auditStopped(takeBack.queuedWake, 'queued', by)
  if (takeBack.stoppingWake) auditStopped(takeBack.stoppingWake, 'started', by)
}
