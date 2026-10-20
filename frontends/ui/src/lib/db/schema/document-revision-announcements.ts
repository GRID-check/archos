import { foreignKey, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { documents } from './documents'

/**
 * `document_revision_announcements` — a new Fassung that `document.new_revision`
 * has been announced for (migration 0130, renamed from `document_fassung_announcements`
 * by 0165; CONTEXT.md „Fassung", ADR-0099).
 *
 * Keyed by the newer document and the anchor the inbox item uses: the new
 * version for a same-name Fassung, the older document for a link.
 * `notifyNewRevision` claims the row before it writes any item and writes only
 * when its claim took, so a re-read that settles the document again tells
 * nobody again, not even a person assigned since. A failed announcement gives
 * the row back. Cascades with the newer document.
 */
export const documentRevisionAnnouncements = pgTable(
  'document_revision_announcements',
  {
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    anchorId: uuid('anchor_id').notNull(),
    announcedAt: timestamp('announced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: 'document_revision_announcements_pk', columns: [table.documentId, table.anchorId] }),
    document: foreignKey({
      name: 'document_revision_announcements_document_fkey',
      columns: [table.documentId],
      foreignColumns: [documents.id],
    }).onDelete('cascade'),
  })
)

export type DocumentRevisionAnnouncement = typeof documentRevisionAnnouncements.$inferSelect
