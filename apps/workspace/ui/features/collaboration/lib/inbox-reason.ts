/**
 * Why a waiting row is the reader's, in a few words: „Von Anna Weber
 * zugewiesen · Anmerkung 9“, „Piloti fragt Sie“. The queue gathers rows under
 * their document, so the row's own title („Anna Weber hat Ihnen Anmerkung 9 in
 * „Grundriss EG“ zugewiesen“) would say the document again under its own
 * name; this is the part of it that is left.
 *
 * Null for a type with no short form: the queue then shows the row's title.
 */

import type { Translator } from '@/i18n/translate'
import { INBOX_TYPE_PRESENTATION, type InboxItemView } from '@/lib/inbox/types'

/** The short form per type (by its registry key), and whether it names who asked. */
const REASONS: Record<string, { key: string; actor: boolean }> = {
  annotationAssigned: { key: 'assigned', actor: true },
  annotationMentioned: { key: 'mentioned', actor: true },
  agentAsksYou: { key: 'asks', actor: false },
  mentionRequested: { key: 'input', actor: true },
  documentReviewRequested: { key: 'approval', actor: true },
}

export function inboxReason(item: InboxItemView, t: Translator): string | null {
  const i18nKey = INBOX_TYPE_PRESENTATION[item.type]?.i18nKey
  const reason = i18nKey ? REASONS[i18nKey] : undefined
  if (!reason) return null
  // A reminder of a date, or a request whose asker is gone, says it without a name.
  const who =
    reason.actor && !item.actorName
      ? t(`inbox.reason.${reason.key}NoActor`)
      : t(`inbox.reason.${reason.key}`, { actor: item.actorName ?? '' })
  const markNumber = item.resourceType === 'document' && item.type !== 'document.review_requested' ? item.related : null
  return markNumber ? `${who} · ${t('inbox.reason.mark', { number: markNumber })}` : who
}
