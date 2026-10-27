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
import {
  ACTIVE_SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_STATUSES,
  type SupportTicketStatus,
} from '@/lib/posthog-support/types'

export {
  ACTIVE_SUPPORT_TICKET_STATUSES,
  PRODUCT_FEEDBACK_KINDS,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_PAGE_MAX,
  SUPPORT_TICKET_STATUSES,
}
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
 * A PostHog id the browser hands over (a replay session):
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
   * The reporter's PostHog replay session, so the ticket the SERVER opens links
   * their recording. Absent while PostHog is off or blocked in that browser.
   * Older clients also sent a widget session; it is stripped, because the
   * server opens every ticket in a conversations session of its own.
   */
  posthog: z
    .object({ sessionId: posthogBrowserId })
    .strip()
    .nullish()
    .transform((value) => value ?? { sessionId: null }),
})

export type SubmitProductFeedbackInput = z.infer<typeof submitProductFeedbackSchema>

/** What the reporter gets back: enough to say "thank you". */
export interface SubmittedProductFeedbackView {
  id: string
  kind: ProductFeedbackKind
  createdAt: string
}

/** The longest page of the platform triage list (the repository's `PRODUCT_FEEDBACK_LIST_LIMIT`). */
export const PLATFORM_FEEDBACK_PAGE_MAX = 50

/** `active`: every ticket that is not resolved, the open support cases. */
export const PRODUCT_FEEDBACK_STATUS_FILTERS = [...SUPPORT_TICKET_STATUSES, 'active'] as const
export type ProductFeedbackStatusFilter = (typeof PRODUCT_FEEDBACK_STATUS_FILTERS)[number]

/** `mine`: assigned to the caller (their PostHog login has their email). `unassigned`: nobody has it. */
export const PRODUCT_FEEDBACK_ASSIGNEE_FILTERS = ['mine', 'unassigned'] as const
export type ProductFeedbackAssigneeFilter = (typeof PRODUCT_FEEDBACK_ASSIGNEE_FILTERS)[number]

/** GET /api/platform/feedback */
export const listProductFeedbackQuerySchema = z.object({
  /** A PostHog ticket status, or `active`. Ignored while the page reads the local log. */
  status: z
    .enum(PRODUCT_FEEDBACK_STATUS_FILTERS)
    .optional()
    .describe('A PostHog ticket status, or `active` for every ticket that is not resolved. Absent lists every status.'),
  kind: z.enum(PRODUCT_FEEDBACK_KINDS).optional(),
  assignee: z
    .enum(PRODUCT_FEEDBACK_ASSIGNEE_FILTERS)
    .optional()
    .describe('`mine`: tickets assigned to the person. `unassigned`: tickets nobody has. Absent lists everyone’s.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PLATFORM_FEEDBACK_PAGE_MAX)
    .optional()
    .describe(`Reports per page (1 to ${PLATFORM_FEEDBACK_PAGE_MAX}, the default).`),
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional().describe('`nextCursor` of the previous page.'),
})

export type ListProductFeedbackQuery = z.infer<typeof listProductFeedbackQuerySchema>

/** PATCH /api/platform/feedback/[id] — moves the report's PostHog ticket. */
export const triageProductFeedbackSchema = z.object({
  status: z.enum(SUPPORT_TICKET_STATUSES),
})

/**
 * POST /api/platform/feedback/claim — a platform owner takes a report's ticket:
 * it is assigned to them in PostHog. The ticket id is what the Slack alert's
 * „Übernehmen" button carries (the PostHog workflow knows no report id).
 */
export const claimProductFeedbackSchema = z.object({
  ticketId: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .describe('The PostHog Support ticket id (a UUID), as the Slack alert or platform-feedback-list names it.'),
})

/** Who has a ticket. */
export interface ProductFeedbackAssigneeView {
  /** A PostHog user, or a PostHog role (a team). */
  type: 'user' | 'role'
  /** The member's name in PostHog, or the role's; `null` when PostHog names none. */
  name: string | null
  /** The PostHog login of a user; `null` for a role. */
  email: string | null
  /** The ticket is the reader's own: its assignee's email is the reader's. */
  isViewer: boolean
}

/**
 * Whose move it is on an open ticket: `team` when the reporter wrote last (or
 * nobody has answered yet), `reporter` when the team did. `null` for a
 * resolved ticket, and when the thread could not be read.
 */
export type ProductFeedbackAwaiting = 'team' | 'reporter'

/** The report's PostHog Support ticket, read live from PostHog. */
export interface ProductFeedbackTicketView {
  id: string
  number: number | null
  status: SupportTicketStatus
  url: string
  /** `null` while nobody has the ticket. */
  assignee: ProductFeedbackAssigneeView | null
  /** When the last message on the ticket was written. */
  lastActivityAt: string
  awaiting: ProductFeedbackAwaiting | null
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
  /**
   * `assignee=mine` was asked, and nobody in PostHog has the reader's email:
   * nothing can be theirs, and the page says why the list is empty.
   */
  viewerNotInPosthog: boolean
}

// ---------------------------------------------------------------------------
// The reporter's own threads
// ---------------------------------------------------------------------------

/** POST /api/feedback/reports/[id]/messages — the reporter answers on their thread. */
export const replyToProductFeedbackSchema = z.object({
  message: z.string().trim().min(1).max(PRODUCT_FEEDBACK_MESSAGE_MAX),
})

export type ReplyToProductFeedbackInput = z.infer<typeof replyToProductFeedbackSchema>

/** GET /api/feedback/reports — one page of the person's own reports, newest first. */
export const listOwnProductFeedbackQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(20).describe('Reports per page, newest first (1 to 20).'),
  cursor: z.string().max(200).optional().describe('`nextCursor` of the previous page.'),
})

export type ListOwnProductFeedbackQuery = z.infer<typeof listOwnProductFeedbackQuerySchema>

/** GET /api/feedback/office-reports — one page of every report filed in the caller's organization. */
export const listOfficeProductFeedbackQuerySchema = listOwnProductFeedbackQuerySchema

export type ListOfficeProductFeedbackQuery = ListOwnProductFeedbackQuery

/**
 * Whether a case still needs somebody: every PostHog status but `resolved`. A
 * report without a readable ticket counts as active, because nobody closed it.
 */
export function isActiveFeedbackCase(status: SupportTicketStatus | null): boolean {
  return status !== 'resolved'
}

/** One report in a list of cases: the reporter's own, or (office view) a colleague's. */
export interface OwnProductFeedbackSummary {
  id: string
  kind: ProductFeedbackKind
  /** The start of what was written, so the list says which report is which. */
  excerpt: string
  createdAt: string
  /** The ticket's PostHog status; `null` without a ticket or while PostHog cannot be read. */
  status: SupportTicketStatus | null
  /** The number PostHog shows for the ticket (`#42`); `null` without one. */
  ticketNumber: number | null
  /** When anything last happened on the case: the ticket's last update, else when it was sent. */
  lastActivityAt: string
  /** The team did something on the ticket (a reply, a status change) since the reporter last looked. Always `false` on a colleague's case. */
  hasUpdate: boolean
  /** Whether the CALLER can answer: their own report, with a ticket opened in a stored session. */
  canReply: boolean
  /** The caller filed it. `false` only in the office view, on a colleague's report. */
  mine: boolean
  /** Who filed it, as Piloti knows their name; `null` when it does not. */
  reporterName: string | null
}

/** GET /api/feedback/reports and GET /api/feedback/office-reports */
export interface OwnProductFeedbackListResponse {
  reports: OwnProductFeedbackSummary[]
  /** How many on this page have news for the caller; on the first page of their own, the shell's unread count. */
  updatedCount: number
  /** `false` while PostHog cannot be read: statuses and news are unknown. */
  live: boolean
  /** The next, older page; `null` on the last. */
  nextCursor: string | null
  /** The caller may open the office view (`org:settings:manage`). */
  canViewOffice: boolean
}

/** One message of a thread. */
export interface OwnProductFeedbackMessage {
  id: string
  /** `reporter`: whoever filed the report. `team`: a reply the Piloti team sent from PostHog Support. */
  author: 'reporter' | 'team'
  /** The team member's name, when PostHog names one; `null` on the reporter's messages. */
  authorName: string | null
  content: string
  createdAt: string
}

/** GET /api/feedback/reports/[id]/messages */
export interface OwnProductFeedbackThread {
  report: OwnProductFeedbackSummary
  /** Oldest first. The first is always the report as the reporter typed it. */
  messages: OwnProductFeedbackMessage[]
  /** `false` while the ticket cannot be read: only the report itself is shown. */
  live: boolean
}

/**
 * The query parameter that opens „Mein Feedback" on one thread from any page
 * of the shell (`FeedbackProvider` reads it and takes it off the address). The
 * inbox row for a team reply links here, so a click, a push and a mail all land
 * on the conversation.
 */
export const FEEDBACK_THREAD_PARAM = 'feedback'

/** Where a member reads their thread on report `reportId`. */
export function feedbackThreadHref(reportId: string): string {
  return `/app/projects?${FEEDBACK_THREAD_PARAM}=${encodeURIComponent(reportId)}`
}

/**
 * `POST /api/webhooks/posthog-support`: PostHog's poke that a ticket has a new
 * message. The id is the only thing read from it: the thread itself is read
 * back from PostHog with the server's own key, so a forged poke can at most
 * make the server look at a real ticket again.
 */
export const posthogSupportPokeSchema = z.object({
  ticketId: z.string().trim().guid(),
})
export type PosthogSupportPoke = z.infer<typeof posthogSupportPokeSchema>
