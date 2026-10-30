/**
 * Which documents a Skizze has ever been traced over (S6, ADR-0150, migration
 * 0193): one row per (Skizze, base), never cleared while both exist, because
 * every Fassung of the Skizze keeps the page it was drawn on. A move of the
 * Skizze, of its PDF or of a base asks these rows (`lib/diagrams/sketch-underlay-register.ts`).
 * Both ends are documents of the row's organization (composite foreign keys in
 * the migration); RLS on `organization_id`.
 */

import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { documents } from './documents'

export const sketchUnderlayBases = pgTable(
  'sketch_underlay_bases',
  {
    organizationId: text('organization_id').notNull(),
    sketchDocumentId: uuid('sketch_document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    baseDocumentId: uuid('base_document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    firstTracedAt: timestamp('first_traced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sketchDocumentId, table.baseDocumentId] }),
    byBase: index('sketch_underlay_bases_org_base_idx').on(table.organizationId, table.baseDocumentId),
  })
)

export type SketchUnderlayBaseRow = typeof sketchUnderlayBases.$inferSelect
