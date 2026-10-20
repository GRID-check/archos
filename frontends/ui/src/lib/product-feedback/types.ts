/**
 * Product feedback — request schemas and wire shapes.
 *
 * No `'server-only'`: the form and the platform triage list import the wire
 * types and the bounds. The value sets live beside the table
 * (`@/lib/db/schema/product-feedback`) so schema, CHECK and validation cannot
 * drift apart.
 */

import { z } from 'zod'
import {
  PRODUCT_FEEDBACK_KINDS,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_PAGE_MAX,
  type ProductFeedbackContext,
  type ProductFeedbackKind,
} from '@/lib/db/schema/product-feedback'
import { SUPPORT_TICKET_STATUSES, type SupportTicketStatus } from '@/lib/posthog-support/types'

export { PRODUCT_FEEDBACK_KINDS, PRODUCT_FEEDBACK_MESSAGE_MAX, PRODUCT_FEEDBACK_PAGE_MAX, SUPPORT_TICKET_STATUSES }
export type { ProductFeedbackContext, ProductFeedbackKind, SupportTicketStatus }

/** The shortest message worth sending: "Bug" says nothing a platform owner can act on. */
export const PRODUCT_FEEDBACK_MESSAGE_MIN = 10

const contextString = (max: number) => z.string().trim().max(max).optional()

/**
 * An app path, never a URL. Anything that is not a plain `/path` is dropped
 * rather than refused: the path is a convenience for triage and a malformed one
 * must not cost the reporter their report.
 */
const pagePathSchema = z
  .string()
  .trim()
  .max(PRODUCT_FEEDBACK_PAGE_MAX)
  .nullish()
  .transform((value) => (value && /^\/[^\s?#]*$/.test(value) ? value : null))

/**
 * A PostHog id the browser hands over (a widget session, a replay session):
 * UUID-shaped or dropped. Browser input, so a malformed one costs the ticket
 * its replay link, never the report.
 */
const posthogBrowserId = z
  .string()
  .max(64)
  .nullish()
  .transform((value) => (value && /^[0-9a-f-]{8,64}$/i.test(value) ? value : null))

/** POST /api/feedback/reports */
export const submitProductFeedbackSchema = z.object({
  kind: z.enum(PRODUCT_FEEDBACK_KINDS),
  message: z.string().trim().min(PRODUCT_FEEDBACK_MESSAGE_MIN).max(PRODUCT_FEEDBACK_MESSAGE_MAX),
  pagePath: pagePathSchema,
  allowContact: z.boolean().default(true),
  context: z
    .object({
      userAgent: contextString(500),
      viewport: contextString(40),
      locale: contextString(40),
      timeZone: contextString(80),
      appVersion: contextString(80),
    })
    .strip()
    .default({}),
  /**
   * The reporter's PostHog browser state, so the ticket the SERVER opens lands
   * in their widget (replies) and links their replay. Absent while PostHog is
   * off or blocked in that browser.
   */
  posthog: z
    .object({ widgetSessionId: posthogBrowserId, sessionId: posthogBrowserId })
    .strip()
    .nullish()
    .transform((value) => value ?? { widgetSessionId: null, sessionId: null }),
})

export type SubmitProductFeedbackInput = z.infer<typeof submitProductFeedbackSchema>

/** What the reporter gets back: enough to say "thank you". */
export interface SubmittedProductFeedbackView {
  id: string
  kind: ProductFeedbackKind
  createdAt: string
}

/** GET /api/platform/feedback */
export const listProductFeedbackQuerySchema = z.object({
  /** A PostHog ticket status. Ignored while the page reads the local log. */
  status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
  kind: z.enum(PRODUCT_FEEDBACK_KINDS).optional(),
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
})

export type ListProductFeedbackQuery = z.infer<typeof listProductFeedbackQuerySchema>

/** PATCH /api/platform/feedback/[id] — moves the report's PostHog ticket. */
export const triageProductFeedbackSchema = z.object({
  status: z.enum(SUPPORT_TICKET_STATUSES),
})

/** The report's PostHog Support ticket, read live from PostHog. */
export interface ProductFeedbackTicketView {
  id: string
  number: number | null
  status: SupportTicketStatus
  url: string
}

/**
 * One report as the platform triage page receives it. The report itself
 * (words, reporter, page) is the local intake record; its triage state is the
 * PostHog ticket's and nothing else.
 */
export interface ProductFeedbackReportView {
  id: string
  kind: ProductFeedbackKind
  /**
   * The ticket, `null` when none opened (PostHog off, or it failed) or when
   * PostHog could not be read just now (`ProductFeedbackListResponse.source`).
   */
  ticket: ProductFeedbackTicketView | null
  /** The reporter's PostHog person page (their recordings); `null` while PostHog is off. */
  posthogPersonUrl: string | null
  message: string
  pagePath: string | null
  context: ProductFeedbackContext
  allowContact: boolean
  organizationId: string
  organizationName: string | null
  reporter: { userId: string; name: string | null; email: string | null }
  createdAt: string
  updatedAt: string
}

/**
 * The triage list. `source: 'posthog'` lists the PostHog tickets tagged
 * `piloti-feedback`, joined to their local reports. `source: 'local'` is the
 * fallback while Support is not configured or PostHog cannot be read: the
 * local log, newest first, with no triage state and no status control.
 */
export interface ProductFeedbackListResponse {
  source: 'posthog' | 'local'
  reports: ProductFeedbackReportView[]
  /** Per ticket status; `null` in the local fallback. */
  counts: Record<SupportTicketStatus, number> | null
  /**
   * Recent reports that have no ticket (its opening failed), listed beside the
   * tickets so nothing a member sent is out of sight. Always empty in `local`,
   * where every report is in `reports` already.
   */
  unticketed: ProductFeedbackReportView[]
  nextCursor: string | null
}
