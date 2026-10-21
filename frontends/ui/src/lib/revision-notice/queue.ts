/**
 * Queue a notice of a new Fassung (ADR-0130), when one was just announced.
 *
 * Called by `notifyNewRevision` (`lib/documents/revision-notify.ts`) once it
 * has claimed the announcement of a Fassung under another name, so a Fassung
 * is noticed at most once however often its document settles again. Only a
 * link between two documents is noticed: a same-name version replaces the
 * older bytes in the index, so there is nothing left to compare it with.
 *
 * Gated per organization (`piloti-notices`, read from WorkOS for the
 * organization, since nobody's session is at hand) and held for
 * `GRID_REVISION_NOTICE_DELAY_SECONDS`, so a burst of re-reads and relinks has
 * settled before a model looks. The job's id is the pair's, so a second
 * enqueue while one waits is no second job. Never throws: the announcement it
 * rides on must not fail because of it.
 */

import 'server-only'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { withTenant } from '@/lib/db/tenant-context'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { noticeDelaySeconds, revisionNoticeId } from './notice'

export interface RevisionNoticeRequest {
  organizationId: string
  /** The person whose upload or link made the Fassung. No person, no notice: it would act for nobody. */
  actorUserId: string | null
  actorEmail?: string | null
  newerId: string
  olderId: string
}

/** Whether a notice was queued now. */
export async function queueRevisionNotice(request: RevisionNoticeRequest, now = new Date()): Promise<boolean> {
  const { organizationId, actorUserId, newerId, olderId } = request
  if (!actorUserId || newerId === olderId) return false
  try {
    if (!(await isOrgFeatureEnabled(FEATURE_FLAGS.pilotiNotices, organizationId))) return false
    const noticeId = revisionNoticeId(newerId, olderId)
    return await withTenant({ organizationId }, () =>
      insertJobIfAbsent({
        kind: 'revision_notice',
        organizationId,
        priority: BFF_JOB_PRIORITY.bulk,
        jobId: noticeId,
        notBefore: new Date(now.getTime() + noticeDelaySeconds() * 1000),
        payload: {
          noticeId,
          newerId,
          olderId,
          actor: { userId: actorUserId, email: request.actorEmail ?? null },
        },
      }),
    )
  } catch (error) {
    console.warn(`[revision-notice] could not queue the notice of ${newerId}:`, error)
    return false
  }
}
