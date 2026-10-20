import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * How far each export to PostHog has got (migration
 * `0154_analytics_export_cursors.sql`, `lib/analytics/usage-export.ts`).
 *
 * One row per stream. `exportedThrough` is the end of the last hour handed to
 * PostHog, so the next run starts there and no hour is sent twice;
 * `leaseUntil` is set while a run holds the stream. Platform bookkeeping, no
 * tenant data.
 */
export const ANALYTICS_EXPORT_STREAMS = ['posthog_usage_hourly', 'posthog_budget_snapshot'] as const
export type AnalyticsExportStream = (typeof ANALYTICS_EXPORT_STREAMS)[number]

export const analyticsExportCursors = pgTable('analytics_export_cursors', {
  stream: text('stream').$type<AnalyticsExportStream>().primaryKey(),
  exportedThrough: timestamp('exported_through', { withTimezone: true }).notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AnalyticsExportCursor = typeof analyticsExportCursors.$inferSelect
