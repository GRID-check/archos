/**
 * Read a paged document listing to its end.
 *
 * `GET /api/documents` and `GET /api/archiv/documents` answer one bounded
 * keyset page at a time and say where the next one starts (`nextCursor`). The
 * surfaces that read them — the Files pane, the Archiv — filter, search, count
 * folders and plan folder uploads over the corpus IN THE BROWSER, so for them
 * "the listing" has to be every row, not the newest page. They used to get the
 * newest 500 with nothing saying so: the oldest plans of a big project were not
 * findable, and the upload planner labelled files that were already there
 * „Neu".
 *
 * Every request stays bounded by the server. This bounds the total too: past
 * {@link MAX_LISTING_PAGES} pages it stops and reports `truncated`, so a
 * corpus far beyond anything the browser can sensibly hold degrades to a
 * visible notice rather than an unbounded loop.
 *
 * Two things keep a big corpus from reading as a blank pane while this runs.
 * `onPage` hands each page over as it arrives, so a caller can draw the first
 * 500 rows while the rest are still on their way. `from` resumes after a page
 * somebody else already read: the Files page reads the first one on the server
 * for its first paint and passes its `nextCursor` down, and starting over from
 * the top would read that page twice.
 */

/** Page ceiling for one drain — 20 pages of the server's 500 rows. */
export const MAX_LISTING_PAGES = 20

/** A listing response body: the rows of one page and where the next starts. */
export interface ListingPage<Row> {
  documents?: Row[]
  nextCursor?: string | null
}

/** A failed page read, carrying the status so a caller can treat 403/404 as "absent". */
export class ListingFetchError extends Error {
  constructor(readonly status: number) {
    super(`Failed to load listing (${status})`)
    this.name = 'ListingFetchError'
  }
}

export interface DrainedListing<Row, Body extends ListingPage<Row>> {
  /**
   * The first body THIS read received — for the fields beside the rows
   * (`collectionName`, `canManage`). After `from`, that is the page after the
   * one already read; an empty object when the ceiling left nothing to read.
   */
  first: Body
  /** Every row of every page read here, in the server's order. */
  documents: Row[]
  /** True when the ceiling stopped the read before the last page. */
  truncated: boolean
}

/** One page as it arrives: its rows, its body, and its position in the whole listing (0 is the first page). */
export interface ListingPageArrival<Row, Body> {
  rows: Row[]
  body: Body
  index: number
}

export interface ListingReadOptions<Row, Body> {
  /** Page ceiling for the whole listing, counting pages read before `from`. */
  maxPages?: number
  fetcher?: typeof fetch
  /**
   * Resume after pages somebody else already read: the `nextCursor` of the
   * last of them, and how many there were (they count toward `maxPages`).
   */
  from?: { cursor: string; pagesRead: number }
  /** Called with each page before the next is asked for. */
  onPage?: (page: ListingPageArrival<Row, Body>) => void
}

function withCursor(url: string, cursor: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
}

export async function fetchListingPages<Row, Body extends ListingPage<Row> = ListingPage<Row>>(
  url: string,
  { maxPages = MAX_LISTING_PAGES, fetcher = fetch, from, onPage }: ListingReadOptions<Row, Body> = {},
): Promise<DrainedListing<Row, Body>> {
  let first: Body | null = null
  const documents: Row[] = []
  let cursor: string | null = from?.cursor ?? null
  for (let page = from?.pagesRead ?? 0; page < Math.max(1, maxPages); page++) {
    const response = await fetcher(cursor ? withCursor(url, cursor) : url)
    if (!response.ok) throw new ListingFetchError(response.status)
    const body = (await response.json()) as Body
    first ??= body
    const rows = body.documents ?? []
    documents.push(...rows)
    onPage?.({ rows, body, index: page })
    cursor = body.nextCursor ?? null
    if (!cursor) return { first, documents, truncated: false }
  }
  return { first: first ?? ({} as Body), documents, truncated: true }
}
