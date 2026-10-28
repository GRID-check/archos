'use client'

/**
 * The feedback case's own atoms: what one case IS, drawn the same in the list
 * row and in the thread's header. Shape is the kit's (`Badge`); the words and
 * which state gets the ink are the domain's.
 */

import type { JSX } from 'react'

import { Badge } from '@/components/ui/badge'
import { useTranslations } from '@/i18n'
import { feedbackCopy } from '@/i18n/namespaces/feedback'
import type { SupportTicketStatus } from '@/lib/product-feedback/types'

/**
 * How one case reads, from where the reader stands.
 *
 * - `awaiting`: the team is waiting on the reporter. PostHog's `pending`, or
 *   (in a thread, where the messages are known) the team spoke last on a case
 *   nobody closed: the status alone stays `new` after a reply.
 * - `done`: resolved.
 * - `unknown`: no readable ticket, so sent and nothing more is known.
 * - otherwise the PostHog status itself.
 */
export type FeedbackCaseState = 'awaiting' | 'done' | 'unknown' | Exclude<SupportTicketStatus, 'pending' | 'resolved'>

export function feedbackCaseState(status: SupportTicketStatus | null, teamSpokeLast = false): FeedbackCaseState {
  if (status === 'resolved') return 'done'
  if (status === 'pending' || teamSpokeLast) return 'awaiting'
  return status ?? 'unknown'
}

/**
 * The state as a chip in plain words. The ink plate only for „Wartet auf Sie"
 * on the reader's own case: it is the one state that asks them to act. A
 * colleague's waiting case is a fact for an office admin, not a call; done is
 * the quietest.
 */
export function FeedbackCaseStatus({
  state,
  mine,
}: {
  state: FeedbackCaseState
  /** The reader filed it; `false` in the office view on a colleague's case. */
  mine: boolean
}): JSX.Element {
  const t = useTranslations(feedbackCopy)
  const label =
    state === 'awaiting'
      ? mine
        ? t('threads.statuses.pending')
        : t('threads.officeStatuses.pending')
      : state === 'done'
        ? t('threads.statuses.resolved')
        : t(`threads.statuses.${state}`)
  const variant = state === 'awaiting' && mine ? 'default' : state === 'done' ? 'secondary' : 'outline'
  return (
    <Badge variant={variant} className="rounded-full px-2 py-0 leading-5" data-testid="feedback-case-status" data-state={state}>
      {label}
    </Badge>
  )
}
