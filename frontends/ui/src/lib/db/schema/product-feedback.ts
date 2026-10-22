import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Product feedback — a bug report, an idea, praise or a question about Piloti
 * itself, sent by any signed-in member to the people who run the platform.
 *
 * Not `answer_feedback`. That table holds the thumbs on ONE answer and feeds the
 * platform-lessons ratchet; this one holds what somebody wants to tell us about
 * the product as a whole, from wherever they are in it. The two are read by the
 * same people and must not be confused: a lesson distilled from "the upload
 * button does nothing in Safari" would be injected into every agent turn.
 *
 * Tenant data: the report belongs to the organization it was written from, so
 * a tenant sees its own and only the platform tier (under the audited bypass)
 * reads across tenants. `user_name` and `user_email` are snapshots taken at
 * submission, because the platform page lists reports from every organization
 * and resolving each author through WorkOS per row would make it O(reports).
 * They are display and reply data, never identity: `user_id` is.
 *
 * Triage is not here. It lives on the PostHog Support ticket every report
 * opens (`posthog_ticket_id`, ADR-0118); this table is the intake log the
 * platform page joins to the tickets and falls back to while PostHog cannot be
 * read.
 *
 * The CHECK constraints in migration 0100 are the layer that holds the bounds;
 * the constants below are what the form and the zod schema count against.
 */

/** What kind of feedback this is — the form's first question. */
export const PRODUCT_FEEDBACK_KINDS = ['bug', 'idea', 'praise', 'question'] as const
export type ProductFeedbackKind = (typeof PRODUCT_FEEDBACK_KINDS)[number]

/** Upper bound of the message, in characters. Mirrored by a CHECK. */
export const PRODUCT_FEEDBACK_MESSAGE_MAX = 5000
/** Upper bound of the captured page path. Mirrored by a CHECK. */
export const PRODUCT_FEEDBACK_PAGE_MAX = 500

/**
 * What the browser knew when the form was sent. Captured automatically so a bug
 * report does not depend on the reporter knowing what a user agent is. Every
 * field is optional and none is trusted: it is display data for triage.
 */
export interface ProductFeedbackContext {
  userAgent?: string
  viewport?: string
  locale?: string
  timeZone?: string
  /** The build the browser was running, when the client knows it. */
  appVersion?: string
}

export const productFeedback = pgTable(
  'product_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    userId: text('user_id').notNull(),
    userName: text('user_name'),
    userEmail: text('user_email'),
    kind: text('kind').$type<ProductFeedbackKind>().notNull(),
    message: text('message').notNull(),
    /** The app path the reporter was on (no query string, no host). */
    pagePath: text('page_path'),
    context: jsonb('context').$type<ProductFeedbackContext>().notNull().default({}),
    /** Whether the reporter is happy to be contacted about this report. */
    allowContact: boolean('allow_contact').notNull().default(true),
    /** The PostHog Support ticket this report opened (migration 0155). NULL: none opened. */
    posthogTicketId: text('posthog_ticket_id'),
    /**
     * The conversations session the server opened the ticket in (migration
     * 0183), so the reporter's replies land on the same ticket. A bearer secret
     * for that ticket on PostHog's public endpoint: server-side only, never in a
     * response. NULL for reports filed before 0183, which cannot be answered.
     */
    posthogWidgetSessionId: text('posthog_widget_session_id'),
    /** When the reporter last opened the thread; a ticket updated after it reads as new. */
    reporterSeenAt: timestamp('reporter_seen_at', { withTimezone: true }),
    /** Milliseconds, so the keyset cursor (a JS Date) is exact — see migration 0100. */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The local fallback list, newest first across organizations. */
    createdIdx: index('product_feedback_created_idx').on(table.createdAt, table.id),
    /** The join from a page of PostHog tickets to their reports. */
    ticketIdx: index('product_feedback_posthog_ticket_idx')
      .on(table.posthogTicketId)
      .where(sql`${table.posthogTicketId} IS NOT NULL`),
    /** One tenant's own reports, and the per-user submission count. */
    orgUserCreatedIdx: index('product_feedback_org_user_created_idx').on(
      table.organizationId,
      table.userId,
      table.createdAt
    ),
  })
)

export type ProductFeedback = typeof productFeedback.$inferSelect
export type NewProductFeedback = typeof productFeedback.$inferInsert
