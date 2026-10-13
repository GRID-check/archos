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
 */

import 'server-only'
import type { DbExecutor } from '@/lib/db/executor'
import { getDb } from '@/lib/db'
import type { PilotiWakeRow } from '@/lib/db/schema'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, type PilotiWakeStopPayload } from '@/lib/jobs-queue/types'
import { withTenant } from '@/lib/db/tenant-context'
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
  queuedWakeId: string | null
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
  if (!wake) return { queuedWakeId: null }
  if (wake.status === 'queued') return { queuedWakeId: wake.id }
  if (stopTurn) await enqueueStop(tx, organizationId, wake)
  return { queuedWakeId: null }
}

/**
 * After the take-back committed: keep a queued wake from starting. When the
 * job got there first (the wake started between the read and now), the turn
 * runs and is stopped like any started one.
 */
export async function settleTakenBack(
  delegation: EndedDelegation,
  takeBack: TakeBack,
  { stopTurn }: { stopTurn: boolean }
): Promise<void> {
  if (!takeBack.queuedWakeId) return
  const { organizationId, annotationId } = delegation
  if (await settleWake(organizationId, takeBack.queuedWakeId, { status: 'suppressed', reason: TAKEN_BACK })) return
  if (!stopTurn) return
  await withTenant({ organizationId }, async () => {
    const db = getDb()
    const wake = await findLiveDelegationWake(
      db,
      organizationId,
      annotationId,
      delegationEventId(annotationId, delegation.delegatedAt)
    )
    if (wake?.status === 'started') await enqueueStop(db, organizationId, wake)
  })
}
