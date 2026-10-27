/**
 * Which new Fassungen have been announced (migration 0130). The one writer is
 * `notifyNewRevision` (`./revision-notify`): it claims a Fassung before it writes
 * any inbox item and gives the claim back when the announcement fails.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentRevisionAnnouncements } from '@/lib/db/schema/document-revision-announcements'
import { withTenant } from '@/lib/db/tenant-context'

/** One announced Fassung: the newer document, and the anchor its inbox item uses. */
export interface RevisionAnnouncementKey {
  organizationId: string
  documentId: string
  anchorId: string
}

/**
 * Record that this Fassung is being announced. True when this call took it;
 * false when it was announced before (or a concurrent settle is announcing it).
 */
export async function claimRevisionAnnouncement(key: RevisionAnnouncementKey): Promise<boolean> {
  const db = getDb()
  const claimed = await withTenant({ organizationId: key.organizationId }, () =>
    db
      .insert(documentRevisionAnnouncements)
      .values({ organizationId: key.organizationId, documentId: key.documentId, anchorId: key.anchorId })
      .onConflictDoNothing({ target: [documentRevisionAnnouncements.documentId, documentRevisionAnnouncements.anchorId] })
      .returning({ documentId: documentRevisionAnnouncements.documentId }),
  )
  return claimed.length > 0
}

/** Give a claim back, after the announcement it was taken for failed: the next settle tries again. */
export async function releaseRevisionAnnouncement(key: RevisionAnnouncementKey): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: key.organizationId }, () =>
    db
      .delete(documentRevisionAnnouncements)
      .where(
        and(
          eq(documentRevisionAnnouncements.organizationId, key.organizationId),
          eq(documentRevisionAnnouncements.documentId, key.documentId),
          eq(documentRevisionAnnouncements.anchorId, key.anchorId),
        ),
      ),
  )
}
