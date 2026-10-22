/**
 * Product-feedback repository — the only module that queries `product_feedback`
 * (ADR-0017).
 *
 * Two audiences, and the split is the security story of this file:
 *
 *   - the REPORTER writes one row into their own organization; the row carries
 *     the session's `organizationId`, and RLS's WITH CHECK refuses any other.
 *   - the PLATFORM reads and triages across every organization. Those
 *     functions are deliberately not organization-scoped, because the platform
 *     owner's job is the cross-org view; the guard lives in the service
 *     (`requirePlatformPermission`) and the queries run under the audited
 *     platform bypass that `platformApiRoute` opens. Do not reach them from a
 *     tenant route.
 *
 * Every list is bounded.
 */

import 'server-only'
import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  organizations,
  productFeedback,
  type NewProductFeedback,
  type ProductFeedback,
  type ProductFeedbackKind,
} from '@/lib/db/schema'

/** Hard cap for one page of the platform triage list. */
export const PRODUCT_FEEDBACK_LIST_LIMIT = 50

/** Insert one report, in the reporter's own organization. */
export async function insertProductFeedback(values: NewProductFeedback): Promise<ProductFeedback> {
  const db = getDb()
  const [row] = await db.insert(productFeedback).values(values).returning()
  return row
}

/**
 * Record the Support ticket the server opened for a report, and the
 * conversations session it was opened in, in the reporter's tenant context
 * right after the insert. Written once: a row that already names a ticket
 * keeps it. The reporter counts as having seen their thread now: their own
 * first message is no news to them.
 */
export async function setProductFeedbackTicket(
  id: string,
  ticketId: string,
  widgetSessionId: string
): Promise<void> {
  const db = getDb()
  await db
    .update(productFeedback)
    .set({
      posthogTicketId: ticketId,
      posthogWidgetSessionId: widgetSessionId,
      reporterSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(productFeedback.id, id), isNull(productFeedback.posthogTicketId)))
}

// ---------------------------------------------------------------------------
// Reporter side — one person's own reports, in their tenant context
// ---------------------------------------------------------------------------

/** The most of their own reports one page of a person's feedback threads holds. */
export const OWN_PRODUCT_FEEDBACK_LIMIT = 20

/**
 * One page of the reporter's own reports, newest first. RLS already narrows
 * to the organization; the user filter is what keeps a colleague's reports out.
 */
export async function listOwnProductFeedback(
  organizationId: string,
  userId: string,
  page: { limit: number; before?: { createdAt: Date; id: string } }
): Promise<ProductFeedback[]> {
  const db = getDb()
  const clauses: SQL[] = [eq(productFeedback.organizationId, organizationId), eq(productFeedback.userId, userId)]
  if (page.before) {
    const { createdAt, id } = page.before
    const older = or(
      lt(productFeedback.createdAt, createdAt),
      and(eq(productFeedback.createdAt, createdAt), lt(productFeedback.id, id))
    )
    if (older) clauses.push(older)
  }
  return db
    .select()
    .from(productFeedback)
    .where(and(...clauses))
    .orderBy(desc(productFeedback.createdAt), desc(productFeedback.id))
    .limit(Math.min(page.limit, OWN_PRODUCT_FEEDBACK_LIMIT))
}

/** One of the reporter's own reports, or `null` when it is not theirs. */
export async function getOwnProductFeedback(
  organizationId: string,
  userId: string,
  id: string
): Promise<ProductFeedback | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(productFeedback)
    .where(
      and(
        eq(productFeedback.id, id),
        eq(productFeedback.organizationId, organizationId),
        eq(productFeedback.userId, userId)
      )
    )
    .limit(1)
  return row ?? null
}

/** The reporter opened (or answered) the thread at `at`. */
export async function markOwnProductFeedbackSeen(
  organizationId: string,
  userId: string,
  id: string,
  at: Date
): Promise<void> {
  const db = getDb()
  await db
    .update(productFeedback)
    .set({ reporterSeenAt: at })
    .where(
      and(
        eq(productFeedback.id, id),
        eq(productFeedback.organizationId, organizationId),
        eq(productFeedback.userId, userId)
      )
    )
}

// ---------------------------------------------------------------------------
// Platform side — cross-tenant, guarded by the service
// ---------------------------------------------------------------------------

/** One report with the name of the organization it came from. */
export interface ProductFeedbackRow extends ProductFeedback {
  organizationName: string | null
}

export interface ListProductFeedbackOptions {
  kind?: ProductFeedbackKind
  /** Only reports that opened no Support ticket. */
  unticketed?: boolean
  /** Only reports at or after this moment. */
  since?: Date
  /** Keyset cursor: rows strictly older than this report. */
  before?: { createdAt: Date; id: string }
  limit?: number
}

function listFilters(options: ListProductFeedbackOptions): SQL | undefined {
  const clauses: SQL[] = []
  if (options.kind) clauses.push(eq(productFeedback.kind, options.kind))
  if (options.unticketed) clauses.push(isNull(productFeedback.posthogTicketId))
  if (options.since) clauses.push(gte(productFeedback.createdAt, options.since))
  if (options.before) {
    const { createdAt, id } = options.before
    const older = or(
      lt(productFeedback.createdAt, createdAt),
      and(eq(productFeedback.createdAt, createdAt), lt(productFeedback.id, id))
    )
    if (older) clauses.push(older)
  }
  return clauses.length > 0 ? and(...clauses) : undefined
}

/** One page of reports across every organization, newest first. */
export async function listProductFeedback(
  options: ListProductFeedbackOptions = {}
): Promise<ProductFeedbackRow[]> {
  const db = getDb()
  const limit = Math.min(options.limit ?? PRODUCT_FEEDBACK_LIST_LIMIT, PRODUCT_FEEDBACK_LIST_LIMIT)
  const rows = await db
    .select({ report: productFeedback, organizationName: organizations.displayName })
    .from(productFeedback)
    .leftJoin(organizations, eq(organizations.workosOrganizationId, productFeedback.organizationId))
    .where(listFilters(options))
    .orderBy(desc(productFeedback.createdAt), desc(productFeedback.id))
    .limit(limit)
  return rows.map((row) => ({ ...row.report, organizationName: row.organizationName ?? null }))
}

/** One report by id, across organizations. */
export async function getProductFeedback(id: string): Promise<ProductFeedbackRow | null> {
  const db = getDb()
  const [row] = await db
    .select({ report: productFeedback, organizationName: organizations.displayName })
    .from(productFeedback)
    .leftJoin(organizations, eq(organizations.workosOrganizationId, productFeedback.organizationId))
    .where(eq(productFeedback.id, id))
    .limit(1)
  return row ? { ...row.report, organizationName: row.organizationName ?? null } : null
}

/**
 * The reports behind one page of PostHog tickets, keyed by ticket id. Bounded
 * by the page: never more ids than one list call returns.
 */
export async function getProductFeedbackByTicketIds(
  ticketIds: readonly string[]
): Promise<Map<string, ProductFeedbackRow>> {
  const ids = [...new Set(ticketIds)].slice(0, PRODUCT_FEEDBACK_LIST_LIMIT)
  if (ids.length === 0) return new Map()
  const db = getDb()
  const rows = await db
    .select({ report: productFeedback, organizationName: organizations.displayName })
    .from(productFeedback)
    .leftJoin(organizations, eq(organizations.workosOrganizationId, productFeedback.organizationId))
    .where(inArray(productFeedback.posthogTicketId, ids))
    .limit(ids.length)
  return new Map(
    rows.map((row) => [
      row.report.posthogTicketId as string,
      { ...row.report, organizationName: row.organizationName ?? null },
    ])
  )
}
