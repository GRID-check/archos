/**
 * `GET /api/feedback/office-reports` — the office view of „Mein Feedback": one
 * page of every product-feedback report filed in the caller's organization,
 * newest first, each with its PostHog ticket's status, the reporter's name and
 * when anything last happened on it. A colleague's thread is then read through
 * `./../reports/[reportId]/messages`, read-only.
 *
 * Thin adapter (ADR-0017): the service checks `org:settings:manage` and
 * answers 403 to everybody else; every row is the caller's organization's.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listOfficeProductFeedbackThreads } from '@/lib/product-feedback/service'
import { listOfficeProductFeedbackQuerySchema } from '@/lib/product-feedback/types'

export const GET = apiRoute(
  async ({ session, request }) =>
    listOfficeProductFeedbackThreads(session, parseQuery(request, listOfficeProductFeedbackQuerySchema)),
  {
    authz: { enforcedBy: 'listOfficeProductFeedbackThreads (org:settings:manage; rows of session.organizationId only)' },
  }
)
