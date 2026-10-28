/**
 * `POST /api/platform/feedback/claim` — a platform owner takes a feedback
 * ticket: PostHog Support assigns it to their PostHog account (the one with
 * their email). The Slack alert's „Übernehmen" button opens Platform →
 * Feedback with `?claim=<ticket id>`, and the page posts here. Thin adapter
 * (ADR-0017); the service re-asks the permission.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { claimProductFeedbackTicket } from '@/lib/product-feedback/service'
import { claimProductFeedbackSchema } from '@/lib/product-feedback/types'

export const POST = platformApiRoute(
  async ({ session, request }) => {
    const { ticketId } = await parseJsonBody(request, claimProductFeedbackSchema)
    return claimProductFeedbackTicket(session, ticketId)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
