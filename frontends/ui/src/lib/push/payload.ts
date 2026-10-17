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
import { createTranslator } from '@/i18n/translate'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import type { PushPreferences } from '@/lib/inbox/push-categories'
import type { InboxItemView } from '@/lib/inbox/types'

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

/** Only a path on this origin may be a notification's destination. */
export function isSameOriginPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
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
