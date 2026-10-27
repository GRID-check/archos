/**
 * What of a held mail's evidence is said up front, and what waits behind the
 * header's „Details“ (the owner's review of 2026-10-27, WOW §3): the detail
 * opens on the mail, so the facts a person needs only now and then (when it
 * was sent, every recipient, the original `.eml`, the date it stops waiting)
 * fold away, and come forward only when they matter.
 *
 * Pure, so the rule is tested once.
 */

import type { InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'

const DAY_MS = 24 * 60 * 60 * 1000

/** Fewer days than this left and „Wartet nur noch bis …“ stands in the header, not only in „Details“. */
export const EXPIRY_INLINE_DAYS = 7

/**
 * Whether the date a waiting mail expires is said in the header itself: only
 * while it waits and fewer than {@link EXPIRY_INLINE_DAYS} days are left. Every
 * other mail says it on the „Details“ line, and the `expiring` notice of the
 * Postfach covers the last five days anyway.
 */
export function expiryShownInline(view: Pick<InboundMailView, 'status' | 'expiresAt'>, now: number): boolean {
  if (view.status !== 'waiting') return false
  return new Date(view.expiresAt).getTime() - now < EXPIRY_INLINE_DAYS * DAY_MS
}
