/**
 * Which new Fassungen have been announced (migration 0130). The one writer is
 * `notifyNewFassung` (`./fassung-notify`): it claims a Fassung before it writes
 * any inbox item and gives the claim back when the announcement fails.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentFassungAnnouncements } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'

/** One announced Fassung: the newer document, and the anchor its inbox item uses. */
export interface FassungAnnouncementKey {
  organizationId: string
  documentId: string
  anchorId: string
}

/**
 * Record that this Fassung is being announced. True when this call took it;
 * false when it was announced before (or a concurrent settle is announcing it).
 */
export async function claimFassungAnnouncement(key: FassungAnnouncementKey): Promise<boolean> {
  const db = getDb()
  const claimed = await withTenant({ organizationId: key.organizationId }, () =>
    db
      .insert(documentFassungAnnouncements)
      .values({ organizationId: key.organizationId, documentId: key.documentId, anchorId: key.anchorId })
      .onConflictDoNothing({ target: [documentFassungAnnouncements.documentId, documentFassungAnnouncements.anchorId] })
      .returning({ documentId: documentFassungAnnouncements.documentId }),
  )
  return claimed.length > 0
}

/** Give a claim back, after the announcement it was taken for failed: the next settle tries again. */
export async function releaseFassungAnnouncement(key: FassungAnnouncementKey): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: key.organizationId }, () =>
    db
      .delete(documentFassungAnnouncements)
      .where(
        and(
          eq(documentFassungAnnouncements.organizationId, key.organizationId),
          eq(documentFassungAnnouncements.documentId, key.documentId),
          eq(documentFassungAnnouncements.anchorId, key.anchorId),
        ),
      ),
  )
}
