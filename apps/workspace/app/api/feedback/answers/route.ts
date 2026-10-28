/**
 * Answer-feedback API — per-answer thumbs feedback (WS-7).
 * Thin transport adapters (ADR-0017); logic + authorization live in
 * `@/lib/feedback/service`.
 *
 * Voting model: POST = upsert (re-vote updates in place), DELETE = retract
 * (toggle-off removes the row), GET = the caller's own votes for one
 * conversation (client hydration).
 */

import { after } from 'next/server'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import {
  getOwnConversationFeedback,
  retractAnswerFeedback,
  submitAnswerFeedback,
} from '@/lib/feedback/service'
import { kickLessonDistillation } from '@/lib/platform-lessons/service'
import {
  conversationFeedbackQuerySchema,
  retractAnswerFeedbackQuerySchema,
  upsertAnswerFeedbackSchema,
} from '@/lib/feedback/types'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { conversationId } = parseQuery(request, conversationFeedbackQuerySchema)
    return { feedback: await getOwnConversationFeedback(session, conversationId) }
  },
  { authz: { enforcedBy: 'getOwnConversationFeedback (keyed to session.userId)' } }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, upsertAnswerFeedbackSchema)
    const view = await submitAnswerFeedback(session, input)
    if (input.verdict === 'down') {
      // The platform-lessons pipeline (docs/architecture/platform-failure-
      // learning.md): a down-vote is the failure signal, so it triggers
      // distillation the moment it lands — after the response, off the request
      // path, and fail-open (the kick never throws; anything it misses is
      // picked up by the next kick or the dashboard's manual sweep).
      try {
        after(() => kickLessonDistillation())
      } catch {
        // `after` throws outside a Next request lifecycle (unit tests). The
        // report is not lost — it stays unprocessed for the next sweep.
      }
    }
    return view
  },
  { authz: { enforcedBy: 'submitAnswerFeedback (requireProjectAccess project:view)' } }
)

export const DELETE = apiRoute(
  async ({ session, request }) => {
    const { messageId } = parseQuery(request, retractAnswerFeedbackQuerySchema)
    await retractAnswerFeedback(session, messageId)
    return null // 204 — retraction is idempotent
  },
  { authz: { enforcedBy: 'retractAnswerFeedback (keyed to session.userId)' } }
)
