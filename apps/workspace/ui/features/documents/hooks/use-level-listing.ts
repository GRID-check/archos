'use client'

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  fetchLevelPage,
  levelPageUrl,
  withQueryParam,
  type LevelPageRequest,
} from '@/lib/documents/level-client'
import { toFileItem, type DocumentWireRow } from '../lib/file-item'
import type { FileItem } from '../file-types'
import { useSettlingRefresh } from './use-settling-refresh'
import { useSettlingStatusReads } from './use-settling-status-reads'

/** Rows a level page carries: a screenful of cards and the next, not a shelf. */
export const LEVEL_PAGE_SIZE = 100

/** The most rows one quiet reload re-reads in one request: the server's page cap. */
const RELOAD_LIMIT_MAX = 500

export interface LevelListingOptions {
  /**
   * The level to read, without its page size (the hook owns it), or `null`
   * while the level view is not what is on screen: nothing is read then, and
   * an answer still in flight is dropped.
   */
  request: Omit<LevelPageRequest, 'limit'> | null
  /**
   * The rows are dropped, and the skeleton shown, when this changes: another
   * folder is another level. Any other change of the request (the order, the
   * search, a filter) keeps the rows on screen until the new answer replaces
   * them, so typing in the search does not flash a skeleton per keystroke.
   */
  resetKey: string
  pageSize?: number
  /**
   * The first page of the FIRST request, as the server already read it, and
   * where it continues. Used once, and only while the request is still the one
   * it answers; the next page is read from its cursor, never the page again.
   */
  initialPage?: { rows: readonly DocumentWireRow[]; nextCursor: string | null }
  fetcher?: typeof fetch
}

export interface LevelListing {
  /** The rows of the pages read so far, in the server's order. */
  files: FileItem[]
  setFiles: Dispatch<SetStateAction<FileItem[]>>
  /** The first page of a new level is on its way and nothing is shown. */
  isLoading: boolean
  isLoadingMore: boolean
  /** Whether a further page exists. */
  hasMore: boolean
  /** The first page failed (a foreground load only). */
  error: boolean
  /** The last further page failed; the rows read so far stay. */
  moreError: boolean
  /** The Archiv's collection, when its listing said it. */
  collectionName: string | undefined
  /** Read the next page. A no-op while one is being read or none is left. */
  loadMore: () => void
  /**
   * Read the level again from its top, as many rows as are on screen (up to
   * the page cap) and swap them in whole: an upload landed, a folder was
   * deleted, access changed. `quiet` (the default) keeps the rows and the
   * error state as they are while it runs.
   */
  reload: (quiet?: boolean) => Promise<void>
}

/** Append a page, leaving out any row the list already holds (an upload can shift a row across a page boundary). */
function appendPage(previous: FileItem[], page: FileItem[]): FileItem[] {
  if (page.length === 0) return previous
  const held = new Set(previous.map((file) => file.id))
  const fresh = page.filter((file) => !held.has(file.id))
  return fresh.length === 0 ? previous : [...previous, ...fresh]
}

/**
 * One folder level of a shelf, read page by page from the server (ADR-0102).
 *
 * The Files workspace used to drain the whole shelf (`useFileListing`) and
 * filter it to the level in the browser: a Büroablage with 2 000 documents at
 * its root downloaded and hydrated all of them before a folder could be
 * opened. This reads the first page of the level the reader stands on, and
 * the next one when they reach the end of it (`loadMore`, driven by the
 * `LoadMore` sentinel).
 *
 * ## Only the latest request may commit its answer
 *
 * Each first-page read aborts the one before it and is stamped with a
 * generation; a page that lands for an older generation is dropped, and so is
 * a further page read under a cursor that is no longer the current one. A
 * folder change, a new search and a quiet reload can therefore cross in any
 * order and the screen ends on the newest answer.
 *
 * ## Badges settle without re-reading the level
 *
 * Like the drain, the rows on screen that are still being read are re-asked
 * by id (`useSettlingStatusReads`), and a page read while such a tick was in
 * flight takes the tick's newer answer.
 */
export function useLevelListing({
  request,
  resetKey,
  pageSize = LEVEL_PAGE_SIZE,
  initialPage,
  fetcher,
}: LevelListingOptions): LevelListing {
  const url = request ? levelPageUrl({ ...request, limit: pageSize }) : null

  const [files, setFiles] = useState<FileItem[]>(() => (initialPage?.rows ?? []).map(toFileItem))
  const [isLoading, setIsLoading] = useState(url !== null && initialPage === undefined)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [nextCursor, setNextCursorState] = useState<string | null>(initialPage?.nextCursor ?? null)
  const [error, setError] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [collectionName, setCollectionName] = useState<string | undefined>(undefined)

  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const currentUrl = useRef<string | null>(null)
  const cursor = useRef<string | null>(initialPage?.nextCursor ?? null)
  const loadingMore = useRef(false)
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  }, [files])

  const setNextCursor = useCallback((next: string | null) => {
    cursor.current = next
    setNextCursorState(next)
  }, [])

  const settlingReads = useSettlingStatusReads(files, setFiles, { fetcher })
  const { beginLoad } = settlingReads
  useSettlingRefresh(files, settlingReads.tick)

  const loadFirst = useCallback(
    async (target: string, { clear, quiet, limit }: { clear: boolean; quiet: boolean; limit?: number }) => {
      controller.current?.abort()
      const own = new AbortController()
      controller.current = own
      currentUrl.current = target
      const stamp = ++generation.current
      loadingMore.current = false
      setIsLoadingMore(false)
      setMoreError(false)
      const withNewerReads = beginLoad()
      if (clear) {
        setFiles([])
        setNextCursor(null)
      }
      if (!quiet) {
        setIsLoading(true)
        setError(false)
      }
      try {
        const page = await fetchLevelPage(limit ? withQueryParam(target, 'limit', String(limit)) : target, {
          signal: own.signal,
          fetcher,
        })
        if (stamp !== generation.current) return
        setFiles(withNewerReads(page.documents.map(toFileItem)))
        setNextCursor(page.nextCursor)
        if (page.collectionName) setCollectionName(page.collectionName)
        setError(false)
        // A quiet read that lands also ends a foreground one it replaced.
        setIsLoading(false)
      } catch {
        if (own.signal.aborted || stamp !== generation.current) return
        // A failed quiet reload must not empty a level being read.
        if (quiet) return
        setFiles([])
        setNextCursor(null)
        setError(true)
      } finally {
        if (!quiet && stamp === generation.current) setIsLoading(false)
      }
    },
    [beginLoad, fetcher, setNextCursor]
  )

  // A new level: read its first page. The seeded first render is the answer
  // to the first request, so that one read is skipped, once.
  const seededUrl = useRef<string | null>(initialPage !== undefined ? url : null)
  const lastResetKey = useRef<string | null>(null)
  useEffect(() => {
    const seeded = seededUrl.current
    seededUrl.current = null
    const reset = lastResetKey.current !== resetKey
    lastResetKey.current = resetKey
    if (url === null) {
      controller.current?.abort()
      currentUrl.current = null
      generation.current += 1
      setIsLoading(false)
      return
    }
    if (seeded !== null && seeded === url) {
      currentUrl.current = url
      return
    }
    void loadFirst(url, { clear: reset, quiet: false })
  }, [url, resetKey, loadFirst])

  // Nothing in flight outlives the workspace.
  useEffect(() => () => controller.current?.abort(), [])

  const loadMore = useCallback(() => {
    const after = cursor.current
    const target = currentUrl.current
    if (!after || !target || loadingMore.current) return
    loadingMore.current = true
    setIsLoadingMore(true)
    setMoreError(false)
    const stamp = generation.current
    const signal = controller.current?.signal
    const withNewerReads = beginLoad()
    fetchLevelPage(withQueryParam(target, 'cursor', after), { signal, fetcher })
      .then((page) => {
        if (stamp !== generation.current || cursor.current !== after) return
        setFiles((previous) => appendPage(previous, withNewerReads(page.documents.map(toFileItem))))
        setNextCursor(page.nextCursor)
      })
      .catch(() => {
        if (signal?.aborted || stamp !== generation.current) return
        setMoreError(true)
      })
      .finally(() => {
        if (stamp !== generation.current) return
        loadingMore.current = false
        setIsLoadingMore(false)
      })
  }, [beginLoad, fetcher, setNextCursor])

  const reload = useCallback(
    (quiet = true): Promise<void> => {
      const target = currentUrl.current
      if (!target) return Promise.resolve()
      const limit = Math.min(RELOAD_LIMIT_MAX, Math.max(pageSize, filesRef.current.length))
      return loadFirst(target, { clear: false, quiet, limit })
    },
    [loadFirst, pageSize]
  )

  return {
    files,
    setFiles,
    isLoading,
    isLoadingMore,
    hasMore: nextCursor !== null,
    error,
    moreError,
    collectionName,
    loadMore,
    reload,
  }
}
