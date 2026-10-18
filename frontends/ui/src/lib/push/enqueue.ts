/**
 * Hand an inbox write to the push job (ADR-0112).
 *
 * Called by `emitInboxItems` after the rows are stored, in the same tenant
 * scope. It decides only what can be decided without knowing the person's
 * choices or reading the item as them: push is on in this deployment, the type
 * has a push policy, and the recipient holds a device at all. The job decides
 * the rest at the moment it sends (`./inbox-push-job.ts`).
 *
 * It never throws: the item is stored, the badge nudged, and a failure to queue
 * a notification costs a notification, not the event that caused it.
 */

import 'server-only'
import type { InboxItem } from '@/lib/db/schema'
import { isPushStillDue, pushPolicyFor } from '@/lib/inbox/push-policy'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import { webPushConfig } from './config'
import { userIdsWithSubscription } from './repository'

/**
 * A row folded into an unread group a moment ago is part of a burst. Its job
 * waits this long, so the burst's last occurrence is the one that sends. A
 * type that folds across rows (`fold` in its push policy, `./fold.ts`) waits
 * this long on every row, the first included, so the burst is there before
 * anything is told.
 */
export const BURST_HOLD_MS = 5_000

/** Whether this row's job waits for the rest of its burst. */
const held = (row: InboxItem) => row.count > 1 || Boolean(pushPolicyFor(row.type)?.fold)

export async function enqueueInboxPushes(rows: readonly InboxItem[], now: Date = new Date()): Promise<number> {
  try {
    if (!webPushConfig()) return 0
    const due = rows.filter(isPushStillDue)
    if (due.length === 0) return 0
    const byOrganization = new Map<string, InboxItem[]>()
    for (const row of due) byOrganization.set(row.organizationId, [...(byOrganization.get(row.organizationId) ?? []), row])

    let queued = 0
    for (const [organizationId, group] of byOrganization) {
      const withDevice = await userIdsWithSubscription(organizationId, [...new Set(group.map((r) => r.recipientUserId))])
      for (const row of group.filter((r) => withDevice.has(r.recipientUserId))) {
        await enqueueJob({
          kind: 'inbox_push',
          organizationId,
          priority: BFF_JOB_PRIORITY.interactive,
          payload: { itemId: row.id, recipientUserId: row.recipientUserId, stamp: row.updatedAt.toISOString() },
          ...(held(row) ? { notBefore: new Date(now.getTime() + BURST_HOLD_MS) } : {}),
        })
        queued += 1
      }
    }
    return queued
  } catch (cause) {
    console.error('[push] could not queue notifications for inbox items:', cause)
    return 0
  }
}
