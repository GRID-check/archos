/**
 * Links a review gives to another Fassung under another name: the replaced
 * document's mark a carried mark came from (its thread), the replacing
 * document's mark it went on as, and the visual comparison of the two
 * documents (`compareFassungHref`).
 *
 * Only where the page addresses its document by `?doc=` (Dateien, the
 * Büroablage): there a link with another `doc` opens that document's preview,
 * and `review`/`mark` open its review at the mark (`open-review.ts`). Over the
 * chat `?doc=` is the subject of an ask, so a link there would start a chat
 * about the file; the review names the other document without a link.
 *
 * Pure: the caller hands in where the page is.
 */

import { compareFassungHref } from './fassung-compare-link'
import {
  clearReviewParams,
  DOC_PARAM,
  hrefWithParams,
  setReviewParams,
  type ReviewLocation,
  type ReviewTarget,
} from './open-review'

/** Whether the page addresses `documentId` by `?doc=`, so a link may name another one the same way. */
const addresses = (location: Pick<ReviewLocation, 'search'>, documentId: string): boolean =>
  new URLSearchParams(location.search).get(DOC_PARAM) === documentId

/** The review of another document, at a mark; null where the page does not address documents by `doc`. */
export function otherReviewHref(
  location: Pick<ReviewLocation, 'pathname' | 'search'>,
  shownDocumentId: string,
  target: ReviewTarget
): string | null {
  if (!addresses(location, shownDocumentId)) return null
  return hrefWithParams(location.pathname, setReviewParams(new URLSearchParams(location.search), target, { withDocument: true }))
}

/** The shown document's preview, out of its review, with the comparison against `olderId` asked for. */
export function compareFromReviewHref(
  location: Pick<ReviewLocation, 'pathname' | 'search'>,
  shownDocumentId: string,
  olderId: string
): string | null {
  if (!addresses(location, shownDocumentId)) return null
  return compareFassungHref(hrefWithParams(location.pathname, clearReviewParams(new URLSearchParams(location.search))), olderId)
}
