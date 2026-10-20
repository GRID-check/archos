import { sql } from 'drizzle-orm'
import { check, foreignKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { projects } from './projects'

/**
 * What one project changes about the office's sensitive-data NAME terms
 * (migration 0157, ADR-0086 amendment of 2026-10-20): terms it adds, and office
 * terms it sets aside. One row per project that changed anything; no row is
 * the office's list unchanged. The office's list itself stays in
 * `organizations.settings.uploadScreening`.
 *
 * The terms are what the office considers sensitive, which is itself
 * sensitive: the audit trail carries their counts, never the terms.
 */
export const projectUploadScreening = pgTable(
  'project_upload_screening',
  {
    projectId: uuid('project_id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    addedNameTerms: text('added_name_terms').array().notNull().default(sql`'{}'`),
    removedNameTerms: text('removed_name_terms').array().notNull().default(sql`'{}'`),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectFk: foreignKey({
      name: 'project_upload_screening_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    bounded: check(
      'project_upload_screening_terms_bounded',
      sql`cardinality(${table.addedNameTerms}) <= 50 AND cardinality(${table.removedNameTerms}) <= 200 AND char_length(array_to_string(${table.addedNameTerms}, '')) <= 4000 AND char_length(array_to_string(${table.removedNameTerms}, '')) <= 16000`
    ),
  })
)

export type ProjectUploadScreeningRow = typeof projectUploadScreening.$inferSelect
