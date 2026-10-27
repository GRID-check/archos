/**
 * A link into a document AT a place: its Fundstelle, a page and the passage on
 * it (`CONTEXT.md`, „Fundstelle“).
 *
 * The shelf's preview answers `?doc=<id>&page=7&highlight=<passage>` the way the
 * citation viewer answers a citation: `page` and `highlight` are the two props
 * `PdfDocumentView` already takes from a citation, so a search hit lands where a
 * citation does, at the page and with the passage lit up (`passage-highlight.ts`
 * does the fuzzy matching, and widens to the neighbouring pages when the page
 * number is off by a cover sheet). No second mechanism: the URL only carries
 * what the viewer was always handed.
 *
 * The URL is the single source: the pane reads the place off its own address
 * for the document `doc` names, and a different document (or none) starts
 * without it, which is why the `?doc=` sync takes these off with the review's.
 */

export const PAGE_PARAM = 'page'
export const HIGHLIGHT_PARAM = 'highlight'

/**
 * The most passage characters a link carries. A content hit's passage is up to
 * 400 characters (`lib/search/document-search.ts`); its first sentence or two
 * is as distinctive to the matcher as the whole, and a link stays a link one
 * can read and paste.
 */
export const HIGHLIGHT_LINK_CHARS = 200

export interface DocumentLocus {
  /** 1-based page to open at, or null. */
  page: number | null
  /** The passage to find on that page and light up, or null. */
  highlight: string | null
}

const NO_LOCUS: DocumentLocus = { page: null, highlight: null }

/** A page number as a link writes it: a positive whole number, or nothing. */
export function parsePage(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null
  const page = Number(value.trim())
  return Number.isSafeInteger(page) && page >= 1 ? page : null
}

/** `text` cut to at most `max` characters on a word boundary, whitespace collapsed; null when nothing is left. */
export function clipHighlight(text: string | null | undefined, max = HIGHLIGHT_LINK_CHARS): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * The place a page's params name in `documentId`. Only for the document `doc`
 * names: a `page` left on the address of another document opens nothing.
 * A passage without a page is kept, and the viewer then opens at the start.
 */
export function readDocumentLocus(
  params: Pick<URLSearchParams, 'get'> | null | undefined,
  documentId: string
): DocumentLocus {
  if (!params || params.get('doc') !== documentId) return NO_LOCUS
  return { page: parsePage(params.get(PAGE_PARAM)), highlight: clipHighlight(params.get(HIGHLIGHT_PARAM)) }
}

/** Put the place on `params` (mutates it); a missing part is taken off. */
export function setDocumentLocus(params: URLSearchParams, locus: Partial<DocumentLocus>): URLSearchParams {
  if (locus.page && locus.page >= 1) params.set(PAGE_PARAM, String(Math.trunc(locus.page)))
  else params.delete(PAGE_PARAM)
  const highlight = clipHighlight(locus.highlight)
  if (highlight) params.set(HIGHLIGHT_PARAM, highlight)
  else params.delete(HIGHLIGHT_PARAM)
  return params
}

/** Take the place off `params` (mutates it): it belongs to the document that was open. */
export function clearDocumentLocus(params: URLSearchParams): URLSearchParams {
  params.delete(PAGE_PARAM)
  params.delete(HIGHLIGHT_PARAM)
  return params
}

/** `href` (a shelf link with `?doc=`) at `locus`; the href unchanged when the locus names nothing. */
export function withDocumentLocus(href: string, locus: Partial<DocumentLocus>): string {
  const [base, hash = ''] = href.split('#')
  const [pathname, search = ''] = base.split('?')
  const params = setDocumentLocus(new URLSearchParams(search), locus)
  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`
}
