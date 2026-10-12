'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toFileItem, type DocumentWireRow } from '../lib/file-item'
import { fetchListingPages, type ListingPage } from '../lib/fetch-listing-pages'
import type { FileItem } from '../file-types'
import type { ShelfEndpoints } from '../lib/file-shelf'
import { useSettlingRefresh } from './use-settling-refresh'
import { useSettlingStatusReads } from './use-settling-status-reads'

interface ListingBody extends ListingPage<DocumentWireRow> {
  collectionName?: string
}

export interface FileListingOptions {
  endpoints: Pick<ShelfEndpoints, 'list' | 'listParams'>
  /** The two filters the SERVER answers; each is a refetch, not a predicate. */
  agentAuthoredOnly: boolean
  includeArchived: boolean
  /** The first paint as the server already read it. Absent means "ask". */
  initialFiles?: readonly DocumentWireRow[]
  /**
   * Where the listing continues after `initialFiles`: the server's `nextCursor`
   * for the page it read. `null` (the default) means the seed is the whole
   * shelf; a cursor means the rest is read from there, quietly, without asking
   * for the seeded page again.
   */
  initialNextCursor?: string | null
}

/** What a foreground load does with the rows it reads. */
type Commit = 'per-page' | 'at-end'

/** Append the rows of a later page, leaving out any the list already holds. */
function appendPage(previous: FileItem[], page: FileItem[]): FileItem[] {
  if (page.length === 0) return previous
  const held = new Set(previous.map((file) => file.id))
  const fresh = page.filter((file) => !held.has(file.id))
  return fresh.length === 0 ? previous : [...previous, ...fresh]
}

/**
 * One shelf's documents: the paged drain, and the guarantees around it.
 *
 * This is the loader that used to exist twice — once in the project workspace,
 * once (copied, with a comment saying so) in the Archiv's. Both are this now.
 *
 * ## A new listing streams in; a reload of the one on screen does not flicker
 *
 * A listing the pane does not hold yet (the first read, a filter flip, a retry
 * after an error) commits page by page: the first 500 rows are drawn the moment
 * they arrive and later pages are appended behind them, instead of a skeleton
 * for as long as twenty sequential requests take. `isLoading` is true only
 * until that first page is in.
 *
 * A reload of the listing already on screen (an upload landed, a folder was
 * deleted) keeps every row where it is and swaps the new answer in whole at
 * the end, with no skeleton. Committing it page by page would shrink a
 * 5,000-row corpus to 500 and grow it back under the reader.
 *
 * `complete` says whether the rows in hand are the whole listing (or as much
 * of it as the page ceiling allows). A deep link to a document that is not on
 * the first page waits for it rather than concluding it is not there.
 *
 * ## Only the LATEST request may commit its answer
 *
 * `useSettlingRefresh` serialises its OWN polls, but nothing coordinated a poll
 * already in flight with a FOREGROUND load (mount, upload settled, retry). A
 * slow poll carrying `processing` could land after a newer load carrying
 * `ready` and overwrite it, regressing a badge the user was just told had
 * flipped — and, because the row went back to unsettled, restarting the poll.
 * A monotonic generation stamped when the request goes out and re-checked
 * before every state write makes the newest request the only one that can win.
 */
export function useFileListing({
  endpoints,
  agentAuthoredOnly,
  includeArchived,
  initialFiles,
  initialNextCursor = null,
}: FileListingOptions) {
  const seededWith = initialFiles !== undefined
  const [files, setFiles] = useState<FileItem[]>(() => (initialFiles ?? []).map(toFileItem))
  // Seeded means loaded: starting at `true` with the answer in state would draw
  // the skeleton over a listing this render could paint.
  const [isLoading, setIsLoading] = useState(!seededWith)
  const [complete, setComplete] = useState(seededWith && initialNextCursor === null)
  const [error, setError] = useState(false)
  /** The drain stopped at its page ceiling: older documents are not loaded. */
  const [truncated, setTruncated] = useState(false)
  const [collectionName, setCollectionName] = useState<string | undefined>(undefined)
  const loadGeneration = useRef(0)

  const settlingReads = useSettlingStatusReads(files, setFiles)
  const { beginLoad } = settlingReads
  // Re-ask while anything is still being read, and stop once all is terminal.
  useSettlingRefresh(files, settlingReads.tick)

  const { list, listParams } = endpoints
  const paramsKey = JSON.stringify(listParams ?? {})
  const url = listingUrl(list, paramsKey, agentAuthoredOnly, includeArchived)
  /** The listing whose rows `files` holds; a load of the same one is a reload. */
  const shownUrl = useRef<string | null>(seededWith ? url : null)

  const drain = useCallback(
    ({ quiet, from }: { quiet: boolean; from?: { cursor: string } }) => {
      const generation = ++loadGeneration.current
      const withNewerReads = beginLoad()
      const isStale = () => generation !== loadGeneration.current
      const commit: Commit = from || shownUrl.current !== url ? 'per-page' : 'at-end'
      // A resumed seed is already on screen, and so is the listing a reload
      // re-reads: only a listing the pane does not hold yet shows a skeleton.
      const showsSkeleton = !quiet && commit === 'per-page' && !from
      if (showsSkeleton) setIsLoading(true)
      if (commit === 'per-page') setComplete(false)
      setError(false)
      // Every page: search, filters, folder counts and the upload plan all read
      // `files` as the shelf's corpus (fetch-listing-pages.ts).
      return fetchListingPages<DocumentWireRow, ListingBody>(url, {
        from: from ? { cursor: from.cursor, pagesRead: 1 } : undefined,
        onPage: ({ rows, body, index }) => {
          if (commit === 'at-end' || isStale()) return
          const page = withNewerReads(rows.map(toFileItem))
          // The first page of a new listing replaces whatever was there;
          // every later page, and every page after a seed, is appended.
          const replaces = index === 0 && !from
          if (replaces) setCollectionName(body.collectionName)
          setFiles((previous) => (replaces ? page : appendPage(previous, page)))
          shownUrl.current = url
          if (showsSkeleton) setIsLoading(false)
        },
      })
        .then(({ first, documents, truncated: stoppedEarly }) => {
          if (isStale()) return
          if (commit === 'at-end') {
            setCollectionName(first.collectionName)
            setFiles(withNewerReads(documents.map(toFileItem)))
          }
          shownUrl.current = url
          setTruncated(stoppedEarly)
          setComplete(true)
        })
        .catch(() => {
          if (isStale()) return
          // Nothing more is coming: a deep link waiting for its row stops waiting.
          if (commit === 'per-page') setComplete(true)
          // A failed POLL must not empty a list being read; only a foreground
          // load owns the error state, and only while it is still the latest.
          if (quiet) return
          shownUrl.current = null
          setFiles([])
          setError(true)
          setComplete(true)
        })
        .finally(() => {
          // Deliberately NOT generation-guarded: the spinner belongs to the
          // foreground loads, and a quiet poll starting mid-load would
          // otherwise leave it spinning with nobody left to clear it.
          if (showsSkeleton) setIsLoading(false)
        })
    },
    [url, beginLoad]
  )

  /** @param quiet Refresh without the skeleton or the error state — a reload behind a grid being read. */
  const load = useCallback((quiet = false) => drain({ quiet }), [drain])

  // Through a ref so the orchestrator subscription is made once, and quiet
  // because the grid is already on screen.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  /*
   * Quiet reloads coalesce. An upload landing asks twice (its bytes arrived,
   * then its reading finished) and a batch asks once per file; each was a full
   * drain of the shelf. While one is in flight the next waits for it, and any
   * number of asks in that window become one more drain after it — which is
   * still needed, because the one in flight may have been sent before the
   * change it was asked about.
   */
  const quietInFlight = useRef(false)
  const quietQueued = useRef(false)
  const reloadQuietly = useCallback(() => {
    if (quietInFlight.current) {
      quietQueued.current = true
      return
    }
    const run = (): void => {
      quietInFlight.current = true
      void loadRef.current(true).finally(() => {
        quietInFlight.current = false
        if (!quietQueued.current) return
        quietQueued.current = false
        run()
      })
    }
    run()
  }, [])

  // The seeded first render is the answer, so the mount load is skipped once —
  // by the first run of this effect, not by a condition still true when `drain`
  // changes identity (a filter flip is a request for another listing). A seed
  // that is one page of more continues from the server's cursor.
  const seed = useRef<{ next: string | null } | null>(seededWith ? { next: initialNextCursor } : null)
  useEffect(() => {
    const seeded = seed.current
    seed.current = null
    if (!seeded) {
      void drain({ quiet: false })
      return
    }
    if (seeded.next !== null) void drain({ quiet: true, from: { cursor: seeded.next } })
  }, [drain])

  return { files, setFiles, isLoading, complete, error, truncated, collectionName, load, reloadQuietly }
}

/** The listing's request URL: the shelf's fixed parameters plus the two the server filters on. */
function listingUrl(list: string, paramsKey: string, agentAuthoredOnly: boolean, includeArchived: boolean): string {
  const params = new URLSearchParams(JSON.parse(paramsKey) as Record<string, string>)
  if (agentAuthoredOnly) params.set('authoredBy', 'agent')
  if (includeArchived) params.set('includeArchived', 'true')
  const query = params.toString()
  return query ? `${list}?${query}` : list
}
