/**
 * The office's conventions as Piloti counted them (ADR-0129, migration 0181):
 * one row per organization, holding the extractor's output
 * (`lib/office-conventions/extract.ts`) and the fingerprint of the documents
 * and folders it was counted from.
 *
 * Derived, not authored: every field is recomputed by
 * `refreshOfficeConventions` (`lib/office-conventions/service.ts`) and replaced whole. A convention a person
 * confirms or declines is a row of `office_convention_decisions`, never an
 * edit here, so nothing on this row is anybody's word.
 *
 * `conventions` is null until the first refresh has run; the row exists before
 * that because the refresh request is claimed on it (`refresh_requested_at`),
 * so two turns that find the office changed start one refresh, not two.
 */

import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { OfficeConventions } from '@/lib/office-conventions/extract'
import type { ConventionDecision, ConventionLine } from '@/lib/office-conventions/office-conventions-wire'

export const officeConventions = pgTable(
  'office_conventions',
  {
    /** WorkOS organization id: one record per office, so it is the key. */
    organizationId: text('organization_id').primaryKey(),
    /** The extractor's output; null until the first refresh. */
    conventions: jsonb('conventions').$type<OfficeConventions>(),
    /** `EXTRACTOR_VERSION` the stored JSON was written by; a newer extractor recomputes. */
    extractorVersion: integer('extractor_version'),
    /** What the counts were taken over (`officeSourceFingerprint`); a different one means stale. */
    sourceFingerprint: text('source_fingerprint'),
    computedAt: timestamp('computed_at', { withTimezone: true }),
    /** When a refresh was last queued; at most one per interval (`REFRESH_MIN_INTERVAL_MS`). */
    refreshRequestedAt: timestamp('refresh_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    computedTogether: check(
      'office_conventions_computed_together',
      sql`(${table.conventions} IS NULL) = (${table.computedAt} IS NULL) AND (${table.conventions} IS NULL) = (${table.sourceFingerprint} IS NULL) AND (${table.conventions} IS NULL) = (${table.extractorVersion} IS NULL)`
    ),
  })
)

export type OfficeConventionsRow = typeof officeConventions.$inferSelect

/**
 * `office_convention_decisions` (migration 0182): a person's confirm or decline
 * of one line, keyed by the line's stable key (`lib/office-conventions/lines.ts`).
 * `line` is the line as decided, so a confirmed line outlives a recount that
 * no longer shows it. Authored, so unlike the row above it is never replaced.
 */
export const officeConventionDecisions = pgTable(
  'office_convention_decisions',
  {
    organizationId: text('organization_id').notNull(),
    lineKey: text('line_key').notNull(),
    decision: text('decision').$type<ConventionDecision>().notNull(),
    line: jsonb('line').$type<ConventionLine>().notNull(),
    decidedBy: text('decided_by').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: 'office_convention_decisions_pkey', columns: [table.organizationId, table.lineKey] }),
    decisionKnown: check('office_convention_decisions_decision_known', sql`${table.decision} IN ('confirmed', 'declined')`),
    keyBounded: check('office_convention_decisions_key_bounded', sql`char_length(${table.lineKey}) BETWEEN 1 AND 300`),
    lineObject: check('office_convention_decisions_line_object', sql`jsonb_typeof(${table.line}) = 'object'`),
  })
)

export type OfficeConventionDecisionRow = typeof officeConventionDecisions.$inferSelect
