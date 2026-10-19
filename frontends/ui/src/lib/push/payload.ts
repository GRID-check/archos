/**
 * What a notification carries, and nothing more (ADR-0112).
 *
 * The payload is encrypted for the one browser (RFC 8291), so the push service
 * never reads it, but it does sit on the person's lock screen and in the
 * browser's notification centre. So it holds what the person chose to show: the
 * words the inbox row shows (`inboxItemCopy`, one line each) and the item's own
 * address, or, with the preview off, one generic line. Never the excerpt: a
 * quoted message can be revoked from the inbox, a notification already shown
 * cannot, so the notification carries less than the row.
 *
 * The same shape is read by `public/sw.js`, which has no build step; the
 * `version` field is how the two stay compatible across a deploy.
 */

import { createHash } from 'node:crypto'
import { getDictionary } from '@/i18n/dictionaries'
import type { Locale } from '@/i18n/config'
import { createTranslator, getByPath } from '@/i18n/translate'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import type { PushPreferences } from '@/lib/inbox/push-categories'
import type { InboxPushFold } from '@/lib/inbox/registry'
import { INBOX_TYPE_PRESENTATION, UNKNOWN_TYPE_PRESENTATION, type InboxItemView } from '@/lib/inbox/types'
// Only a path on this origin may be a notification's destination.
import { isSameOriginPath } from '@/lib/utils/same-origin-path'

export const PUSH_PAYLOAD_VERSION = 1
const MAX_TITLE = 120
const MAX_BODY = 140

export interface PushMessage {
  version: typeof PUSH_PAYLOAD_VERSION
  title: string
  /** One short line, or null with the preview off. */
  body: string | null
  /** A path on this origin: where a tap on the notification lands. */
  url: string
  /** Replaces an earlier notification for the same group on the device. */
  tag: string
  /** The inbox item, so the page can tell which notification a read item closes. */
  itemId: string
}

/**
 * The tag and the Topic header for a group: a hash of the group key, 32 URL-safe
 * characters. A Topic may be at most 32 characters of URL-safe base64, and the
 * push service sees it in the clear, so it is a digest, not the key (which names
 * a resource id).
 */
export function pushTagFor(groupKey: string): string {
  return createHash('sha256').update(groupKey).digest('base64url').slice(0, 32)
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single
}

/** Where a notification about several items lands: the inbox, which lists them all. */
export const INBOX_PATH = '/app/inbox'

/**
 * Word a burst of one type's items for one person as ONE notification
 * (`./fold.ts`): the count in the title, and how many of each part in the
 * line under it („4 Anmerkungen für Sie“ / „3 heute oder morgen fällig, 1
 * überfällig“), from the type's `pushFold` copy and its push policy's parts.
 * It opens the inbox, and names no item, so a tap marks none of them read.
 * Its tag is the burst's own (`fold:<type>:<newest item>`): a later burst's
 * notification stands beside this one rather than replacing its count, and a
 * retry of the same burst replaces it. Null when the type has no words for
 * it: each item is then told on its own.
 *
 * `items` are views the recipient's own session produced (`viewInboxItemAs`),
 * newest first; only those with an address count.
 */
export function buildFoldedPushMessage(
  items: readonly InboxItemView[],
  fold: InboxPushFold,
  preferences: PushPreferences,
  locale: Locale
): PushMessage | null {
  const told = items.filter((item) => item.href && isSameOriginPath(item.href))
  const type = told[0]?.type
  if (!type || told.length < 2) return null
  const dictionary = getDictionary(locale)
  const tag = pushTagFor(`fold:${type}:${told[0]?.id}`)
  const base = { version: PUSH_PAYLOAD_VERSION, url: INBOX_PATH, tag, itemId: '' } as const
  if (!preferences.showContent) {
    return { ...base, title: createTranslator(dictionary, 'notifications')('push.genericTitle'), body: null }
  }
  const presentation = INBOX_TYPE_PRESENTATION[type] ?? UNKNOWN_TYPE_PRESENTATION
  const root = `inbox.types.${presentation.i18nKey}.pushFold`
  const t = createTranslator(dictionary, 'collaboration')
  const words = getByPath(dictionary, `collaboration.${root}`) as { parts?: Record<string, unknown> } | undefined
  if (!words?.parts) return null
  const counts = new Map<string, number>()
  for (const item of told) {
    const part = (item.variant && fold.parts[item.variant]) || 'other'
    counts.set(part, (counts.get(part) ?? 0) + 1)
  }
  // In the order the copy lists the parts, so the most pressing comes first.
  const line = Object.keys(words.parts)
    .filter((part) => counts.has(part))
    .map((part) => t(`${root}.parts.${part}`, { count: counts.get(part) ?? 0 }))
    .join(', ')
  return { ...base, title: clip(t(`${root}.title`, { count: told.length }), MAX_TITLE), body: clip(line, MAX_BODY) }
}

/**
 * Word one visible item for one person.
 *
 * `item` must be the view the recipient's own session produced
 * (`viewInboxItemAs`): redaction already happened there, and a view without an
 * address is not notified at all.
 */
export function buildPushMessage(
  item: InboxItemView,
  groupKey: string,
  preferences: PushPreferences,
  locale: Locale
): PushMessage | null {
  if (!item.href || !isSameOriginPath(item.href)) return null
  const dictionary = getDictionary(locale)
  const base = { version: PUSH_PAYLOAD_VERSION, url: item.href, tag: pushTagFor(groupKey), itemId: item.id } as const
  if (!preferences.showContent) {
    const t = createTranslator(dictionary, 'notifications')
    return { ...base, title: t('push.genericTitle'), body: null }
  }
  const { title, body } = inboxItemCopy(item, createTranslator(dictionary, 'collaboration'), dictionary, locale)
  return { ...base, title: clip(title, MAX_TITLE), body: body ? clip(body, MAX_BODY) : null }
}
