/**
 * A link that opens a document's preview WITH the visual comparison against an
 * older Fassung already open: `?doc=<newer>&compare=<older>`.
 *
 * The inbox row „Sabine Gruber hat eine neue Fassung von … hochgeladen" has one
 * natural next move, seeing what changed, and the comparison needs both files'
 * names to pick a renderer, which the inbox does not hold. The files workspace
 * does, so the row links there and the workspace opens the comparison
 * (`use-compare-param.ts`). `?doc=` keeps its one writer
 * (`useDocParamSync`); `?compare=` is read once and dropped.
 *
 * Pure: no React, no I/O.
 */

/** The query parameter naming the older Fassung to compare the open document with. */
export const COMPARE_PARAM = 'compare'

/**
 * `href` (a document link, `…?doc=<id>`) with the comparison against `olderId`
 * asked for. Keeps every other parameter and any hash; null for no link.
 */
export function compareRevisionHref(href: string | null, olderId: string): string | null {
  if (!href) return null
  const hashAt = href.indexOf('#')
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  const withoutHash = hashAt === -1 ? href : href.slice(0, hashAt)
  const queryAt = withoutHash.indexOf('?')
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt)
  const params = new URLSearchParams(queryAt === -1 ? '' : withoutHash.slice(queryAt + 1))
  params.set(COMPARE_PARAM, olderId)
  return `${path}?${params.toString()}${hash}`
}
