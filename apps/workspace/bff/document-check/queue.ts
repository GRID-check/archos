/**
 * Queue the check of a new document (ADR-0130, second slice), when its upload
 * has finished indexing.
 *
 * Called by `announceSettledVersions` (`lib/documents/revision-notify.ts`) for
 * every user document that came to rest, so a FIRST upload is checked too, not
 * only a Fassung of an older document. Gated per organization (`piloti-notices`,
 * read from WorkOS for the organization, since nobody's session is at hand) and
 * held for `REVISION_NOTICE_DELAY_SECONDS`, so a burst of re-reads has
 * settled before a model looks.
 *
 * Once per document version: the check's id (uuid5 of the version) is claimed
 * in `document_revision_announcements` as the row's anchor, so a re-read that
 * settles the document again checks nothing again, and the claim outlives the
 * job (a finished job's row is deleted). A claim that could not be followed by
 * a job is given back. Per organization at most `DOCUMENT_CHECK_DAILY_LIMIT`
 * checks start per day (0: none); a version over the cap stays claimed, so it is
 * skipped, not queued later. Never throws: the settle hook must not fail because of it.
 */

import 'server-only'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { withTenant } from '@/lib/db/tenant-context'
import { claimRevisionAnnouncement, releaseRevisionAnnouncement } from '@/lib/documents/revision-announcement-repository'
import { consumeLimit } from '@/lib/limits'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import { noticeDelaySeconds } from '@/lib/revision-notice/notice'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { documentCheckDailyLimit, documentCheckId } from './check'

const DAY_MS = 24 * 60 * 60 * 1000

export interface DocumentCheckRequest {
  organizationId: string
  /** The uploader. No person, no check: it would act for nobody. */
  actorUserId: string | null
  actorEmail?: string | null
  documentId: string
  /** The published version being checked; a document without one is checked once as `first`. */
  versionId: string | null
}

/** Whether a check was queued now. */
export async function queueDocumentCheck(request: DocumentCheckRequest, now = new Date()): Promise<boolean> {
  const { organizationId, actorUserId, documentId } = request
  if (!actorUserId) return false
  const dailyLimit = documentCheckDailyLimit()
  if (dailyLimit === 0) return false
  const checkId = documentCheckId(documentId, request.versionId ?? 'first')
  const claim = { organizationId, documentId, anchorId: checkId }
  let claimed = false
  try {
    if (!(await isOrgFeatureEnabled(FEATURE_FLAGS.agentNotices, organizationId))) return false
    claimed = await claimRevisionAnnouncement(claim)
    if (!claimed) return false
    // Over the day's cap the version stays claimed: it is skipped for good, never queued later in a burst.
    // Fail-open like every limit (ADR-0040): a counter that cannot be read does not stop checks.
    const spent = await consumeLimit({ name: 'document-check-daily', limit: dailyLimit, windowMs: DAY_MS }, organizationId)
    if (!spent.allowed) {
      console.warn(`[document-check] the daily cap of ${dailyLimit} is reached for ${organizationId}; skipping ${documentId}`)
      return false
    }
    const queued = await withTenant({ organizationId }, () =>
      insertJobIfAbsent({
        kind: 'document_check',
        organizationId,
        priority: BFF_JOB_PRIORITY.bulk,
        jobId: checkId,
        notBefore: new Date(now.getTime() + noticeDelaySeconds() * 1000),
        payload: {
          checkId,
          documentId,
          actor: { userId: actorUserId, email: request.actorEmail ?? null },
          conversationId: null,
          waits: 0,
        },
      }),
    )
    if (!queued) await releaseRevisionAnnouncement(claim)
    return queued
  } catch (error) {
    console.warn(`[document-check] could not queue the check of ${documentId}:`, error)
    if (claimed) await releaseRevisionAnnouncement(claim).catch(() => undefined)
    return false
  }
}
