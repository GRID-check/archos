'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchShelfSummary } from '@/lib/documents/level-client'
import type { ShelfSummary } from '@/lib/documents/shelf-summary-types'

export interface ShelfSummaryState {
  /** The latest answer; the previous one stays while a new one is read. `null` until the first arrives. */
  summary: ShelfSummary | null
  /** The last read failed. The workspace then folds what it has loaded instead. */
  error: boolean
  /** Read it again, quietly: a document was uploaded, moved, deleted or re-read. */
  reload: () => Promise<void>
}

/**
 * A shelf's summary (`GET {list}/summary`, ADR-0102): the per-folder counts
 * the folder tiles and the folder brief are folded from, now that the
 * workspace reads a folder level page by page and does not hold the corpus.
 *
 * One read per shelf and filter, not per folder: the browser folds the rows up
 * its own tree (`talliesFromSummary`), so walking the tree asks nothing. The
 * newest read wins; an older one still in flight is aborted.
 */
export function useShelfSummary({ url, fetcher }: { url: string | null; fetcher?: typeof fetch }): ShelfSummaryState {
  const [summary, setSummary] = useState<ShelfSummary | null>(null)
  const [error, setError] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const currentUrl = useRef<string | null>(null)

  const read = useCallback(
    async (target: string) => {
      controller.current?.abort()
      const own = new AbortController()
      controller.current = own
      try {
        const next = await fetchShelfSummary(target, { signal: own.signal, fetcher })
        if (controller.current !== own) return
        setSummary(next)
        setError(false)
      } catch {
        if (own.signal.aborted || controller.current !== own) return
        setError(true)
      }
    },
    [fetcher]
  )

  useEffect(() => {
    currentUrl.current = url
    if (url === null) {
      controller.current?.abort()
      return
    }
    void read(url)
  }, [url, read])

  useEffect(() => () => controller.current?.abort(), [])

  const reload = useCallback((): Promise<void> => {
    const target = currentUrl.current
    return target ? read(target) : Promise.resolve()
  }, [read])

  return { summary, error, reload }
}
