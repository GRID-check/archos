/**
 * The reads and the bookkeeping behind the PostHog usage export
 * (`usage-export.ts`): the cursor per stream, the ledger summed per hour, and
 * the organizations worth a budget snapshot. Raw data access only (ADR-0017).
 *
 * Every function here reads across tenants or writes a platform table, so each
 * runs inside the caller's `withPlatformAccess` scope; the exporter is the only
 * caller.
 */

import 'server-only'
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { analyticsExportCursors, type AnalyticsExportStream } from '@/lib/db/schema/analytics-export-cursors'
import { budgetPolicies, llmUsageEvents, llmUsageRollups, type UsageActivity } from '@/lib/db/schema/budgets'

/**
 * Take the stream for `leaseMs`, or `null` when another run holds it. A stream
 * with no row yet is created at `initialThrough`, which is where its first run
 * starts (the backfill horizon). Returns where this run starts.
 */
export async function claimCursor(
  stream: AnalyticsExportStream,
  initialThrough: Date,
  leaseMs: number,
  now: Date,
): Promise<Date | null> {
  const db = getDb()
  const leaseUntil = new Date(now.getTime() + leaseMs)
  await db
    .insert(analyticsExportCursors)
    .values({ stream, exportedThrough: initialThrough })
    .onConflictDoNothing({ target: analyticsExportCursors.stream })
  const [claimed] = await db
    .update(analyticsExportCursors)
    .set({ leaseUntil, updatedAt: now })
    .where(
      and(
        eq(analyticsExportCursors.stream, stream),
        or(isNull(analyticsExportCursors.leaseUntil), lt(analyticsExportCursors.leaseUntil, now)),
      ),
    )
    .returning({ exportedThrough: analyticsExportCursors.exportedThrough })
  return claimed ? new Date(claimed.exportedThrough) : null
}

/** Move the stream on to `through` and let it go. */
export async function advanceCursor(stream: AnalyticsExportStream, through: Date, now: Date): Promise<void> {
  await getDb()
    .update(analyticsExportCursors)
    .set({ exportedThrough: through, leaseUntil: null, updatedAt: now })
    .where(eq(analyticsExportCursors.stream, stream))
}

/** Let the stream go without moving it: the next run sends the same hours again. */
export async function releaseCursor(stream: AnalyticsExportStream, now: Date): Promise<void> {
  await getDb()
    .update(analyticsExportCursors)
    .set({ leaseUntil: null, updatedAt: now })
    .where(eq(analyticsExportCursors.stream, stream))
}

/** One organization's spend in one hour on one model, for one person, project and purpose. */
export interface UsageHourRow {
  organizationId: string
  /** Start of the UTC hour. */
  hour: Date
  model: string
  activity: UsageActivity | null
  agentGroup: string | null
  userId: string | null
  projectId: string | null
  ownKey: boolean
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
  priceUsd: number
  credits: number
  audioSeconds: number
}

const num = (value: unknown): number => Number.parseFloat(String(value ?? '0')) || 0

/**
 * The ledger in `[from, to)`, summed per organization, UTC hour, model,
 * activity, purpose, person, project and key. Bounded by the window the
 * exporter passes, never by a row limit: a cut-off group would send a wrong
 * hour that the cursor then marks as sent.
 */
export async function sumUsageByHour(from: Date, to: Date): Promise<UsageHourRow[]> {
  const db = getDb()
  const hour = sql<string>`date_trunc('hour', ${llmUsageEvents.createdAt})`
  const model = sql<string>`coalesce(${llmUsageEvents.model}, 'unknown')`
  const ownKey = sql<boolean>`coalesce(${llmUsageEvents.isByok}, false)`
  const rows = await db
    .select({
      organizationId: llmUsageEvents.organizationId,
      hour,
      model,
      activity: llmUsageEvents.activity,
      agentGroup: llmUsageEvents.agentGroup,
      userId: llmUsageEvents.userId,
      projectId: llmUsageEvents.projectId,
      ownKey,
      calls: sql<string>`count(*)`,
      promptTokens: sql<string>`coalesce(sum(${llmUsageEvents.promptTokens}), 0)`,
      completionTokens: sql<string>`coalesce(sum(${llmUsageEvents.completionTokens}), 0)`,
      cachedTokens: sql<string>`coalesce(sum(${llmUsageEvents.cachedTokens}), 0)`,
      reasoningTokens: sql<string>`coalesce(sum(${llmUsageEvents.reasoningTokens}), 0)`,
      totalTokens: sql<string>`coalesce(sum(${llmUsageEvents.totalTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
      priceUsd: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}), 0)`,
      credits: sql<string>`coalesce(sum(${llmUsageEvents.credits}), 0)`,
      audioSeconds: sql<string>`coalesce(sum(${llmUsageEvents.audioSeconds}), 0)`,
    })
    .from(llmUsageEvents)
    .where(and(gte(llmUsageEvents.createdAt, from), lt(llmUsageEvents.createdAt, to)))
    .groupBy(
      llmUsageEvents.organizationId,
      hour,
      model,
      llmUsageEvents.activity,
      llmUsageEvents.agentGroup,
      llmUsageEvents.userId,
      llmUsageEvents.projectId,
      ownKey,
    )

  // Coerce at the boundary: raw `sql<T>` columns arrive as strings.
  return rows.map((row) => ({
    organizationId: row.organizationId,
    hour: new Date(row.hour),
    model: row.model,
    activity: row.activity ?? null,
    agentGroup: row.agentGroup ?? null,
    userId: row.userId ?? null,
    projectId: row.projectId ?? null,
    ownKey: row.ownKey === true || String(row.ownKey) === 'true',
    calls: num(row.calls),
    promptTokens: num(row.promptTokens),
    completionTokens: num(row.completionTokens),
    cachedTokens: num(row.cachedTokens),
    reasoningTokens: num(row.reasoningTokens),
    totalTokens: num(row.totalTokens),
    costUsd: num(row.costUsd),
    priceUsd: num(row.priceUsd),
    credits: num(row.credits),
    audioSeconds: num(row.audioSeconds),
  }))
}

/**
 * The organizations a budget snapshot is worth sending for: every one that
 * spent since `since`, and every one with an explicit organization limit. An
 * organization that never spent and never set a limit runs on the seeded
 * allowance, which the snapshot of any other organization already shows.
 */
export async function listSnapshotOrganizations(since: Date): Promise<string[]> {
  const db = getDb()
  const sinceDay = since.toISOString().slice(0, 10)
  const [spent, limited] = await Promise.all([
    db
      .selectDistinct({ organizationId: llmUsageRollups.organizationId })
      .from(llmUsageRollups)
      .where(gte(llmUsageRollups.day, sinceDay)),
    db
      .selectDistinct({ organizationId: budgetPolicies.organizationId })
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.scope, 'organization'), eq(budgetPolicies.status, 'active'))),
  ])
  return [...new Set([...spent, ...limited].map((row) => row.organizationId))].sort()
}
