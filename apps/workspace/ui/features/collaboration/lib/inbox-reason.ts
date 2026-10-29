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
import type { InboxItemType, InboxItemView } from '@/lib/inbox/types'

/** The short form per type, and whether it names who asked. */
const REASONS: Partial<Record<InboxItemType, { key: string; actor: boolean }>> = {
  'annotation.assigned_to_you': { key: 'assigned', actor: true },
  'annotation.mentioned': { key: 'mentioned', actor: true },
  'piloti.asks_you': { key: 'asks', actor: false },
  'mention.requested': { key: 'input', actor: true },
  'document.review_requested': { key: 'approval', actor: true },
}

export function inboxReason(item: InboxItemView, t: Translator): string | null {
  const reason = REASONS[item.type]
  if (!reason) return null
  // A reminder of a date, or a request whose asker is gone, says it without a name.
  const who =
    reason.actor && !item.actorName
      ? t(`inbox.reason.${reason.key}NoActor`)
      : t(`inbox.reason.${reason.key}`, { actor: item.actorName ?? '' })
  const markNumber = item.resourceType === 'document' && item.type !== 'document.review_requested' ? item.related : null
  return markNumber ? `${who} · ${t('inbox.reason.mark', { number: markNumber })}` : who
}
