/**
 * Telling a member that the team answered their feedback (ADR-0118, second
 * amendment).
 *
 * The team answers in PostHog Support. When a message is sent there, a PostHog
 * workflow pokes the deployment that opened the ticket (its `origin:<host>`
 * tag) with `POST /api/webhooks/posthog-support` and the ticket id. That poke
 * is all this module trusts, and only as a hint: it finds the report the
 * ticket belongs to, reads the ticket's customer-visible thread back from
 * PostHog with the server's own key, and announces the team replies the
 * reporter has neither read nor been told about, as one `feedback.replied`
 * inbox row for them. The inbox's own delivery then pushes it (the type is
 * never mailed, `INBOX_TYPE_DEFINITIONS`).
 *
 * ## Why no shared secret
 *
 * The body carries no fact Piloti uses: the replies, their authors and their
 * times come from PostHog, read with our key. A forged poke can therefore only
 * make the server re-read a real ticket, which announces nothing new, and the
 * route's rate limit bounds how often. A secret would guard nothing that
 * reading the source does not.
 *
 * ## Idempotent
 *
 * `product_feedback.reporter_notified_at` is the newest reply already
 * announced. A poke announces replies after it (and after `reporter_seen_at`:
 * one the reporter already read needs no notice) and moves it in a
 * compare-and-set, so a replayed or concurrent poke writes no second notice.
 * The row itself folds per report (`collapse`), counting the replies.
 *
 * ## Tenancy
 *
 * The poke has no session. The one cross-tenant read, finding the report by
 * its ticket id, runs under the audited platform bypass; everything after it
 * runs as the report's own organization (`withTenant`), so RLS holds for the
 * watermark and for the inbox row.
 */

import 'server-only'
import { UpstreamError } from '@/lib/api/errors'
import type { ProductFeedback } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { listCustomerVisibleMessages } from '@/lib/posthog-support/client'
import { posthogSupportConfigFromEnv } from '@/lib/posthog-support/config'
import { PosthogSupportUnavailableError, type SupportMessage } from '@/lib/posthog-support/types'
import {
  advanceReporterNotifiedAt,
  findProductFeedbackByTicketId,
  rewindReporterNotifiedAt,
} from './repository'

/** The inbox type this module emits. */
export const FEEDBACK_REPLY_INBOX_TYPE = 'feedback.replied' as const

/** How much of the report names it on the row, and how much of the reply is quoted. */
const SUBJECT_MAX = 80
const EXCERPT_MAX = 500

export type FeedbackReplyNotice =
  | { status: 'not-configured' }
  | { status: 'unknown-ticket' }
  | { status: 'nothing-new' }
  | { status: 'notified'; replies: number }

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const timeOf = (message: SupportMessage): number => new Date(message.createdAt).getTime()

/**
 * The team replies newer than everything the reporter saw or was told about,
 * oldest first. Pure; exported for tests.
 */
export function unannouncedReplies(
  report: Pick<ProductFeedback, 'createdAt' | 'reporterSeenAt' | 'reporterNotifiedAt'>,
  messages: readonly SupportMessage[]
): SupportMessage[] {
  const since = Math.max(
    new Date(report.createdAt).getTime(),
    report.reporterSeenAt ? new Date(report.reporterSeenAt).getTime() : 0,
    report.reporterNotifiedAt ? new Date(report.reporterNotifiedAt).getTime() : 0
  )
  return messages
    .filter((message) => message.author === 'team' && Number.isFinite(timeOf(message)) && timeOf(message) > since)
    .sort((a, b) => timeOf(a) - timeOf(b))
}

/** The one inbox row for these replies. Pure; exported for tests. */
export function replyEmission(
  report: Pick<ProductFeedback, 'id' | 'organizationId' | 'userId' | 'kind' | 'message'>,
  replies: readonly SupportMessage[]
): InboxEmission {
  const latest = replies.at(-1)
  return {
    organizationId: report.organizationId,
    recipientUserId: report.userId,
    type: FEEDBACK_REPLY_INBOX_TYPE,
    resourceType: 'product_feedback',
    resourceId: report.id,
    groupKey: inboxGroupKey(FEEDBACK_REPLY_INBOX_TYPE, 'product_feedback', report.id),
    occurrences: replies.length,
    payload: {
      // Which of their reports was answered, in their own words.
      subject: clip(report.message, SUBJECT_MAX),
      excerpt: latest ? clip(latest.content, EXCERPT_MAX) : undefined,
      // The team member who answered last, when PostHog names one. Not an
      // actor: they are no user of this organization.
      related: latest?.authorName ?? undefined,
      kind: report.kind,
    },
  }
}

/** The report a ticket was opened for, found across organizations. */
async function reportForTicket(ticketId: string): Promise<ProductFeedback | null> {
  return withPlatformAccess('product feedback: find the report a PostHog poke names', () =>
    findProductFeedbackByTicketId(ticketId)
  )
}

/**
 * Handle one poke for `ticketId`. Resolves to what happened; throws
 * `UpstreamError` when PostHog cannot be read, so the caller answers 502 and
 * PostHog's workflow records the failure (and the next message pokes again).
 */
export async function notifyFeedbackReplies(ticketId: string): Promise<FeedbackReplyNotice> {
  const config = posthogSupportConfigFromEnv(process.env)
  if (!config) return { status: 'not-configured' }

  const report = await reportForTicket(ticketId)
  if (!report) return { status: 'unknown-ticket' }

  let messages: SupportMessage[]
  try {
    messages = await listCustomerVisibleMessages(config, ticketId)
  } catch (error) {
    if (!(error instanceof PosthogSupportUnavailableError)) throw error
    console.warn(`[product-feedback] reply poke for report ${report.id}: thread unreadable:`, error.message)
    throw new UpstreamError('PostHog Support could not be read.')
  }

  const replies = unannouncedReplies(report, messages)
  const latest = replies.at(-1)
  if (!latest) return { status: 'nothing-new' }

  const newest = new Date(latest.createdAt)
  return withTenant({ organizationId: report.organizationId }, async () => {
    // Only the poke that moves the watermark announces; a replay moves nothing.
    if (!(await advanceReporterNotifiedAt(report.organizationId, report.id, newest))) {
      return { status: 'nothing-new' } as const
    }
    try {
      await emitInboxItems([replyEmission(report, replies)])
    } catch (error) {
      // The notice was not written: put the watermark back so the next poke tries again.
      await rewindReporterNotifiedAt(report.organizationId, report.id, newest, report.reporterNotifiedAt).catch(
        () => undefined
      )
      throw error
    }
    return { status: 'notified', replies: replies.length } as const
  })
}
