'use client'

import { useEffect, useState } from 'react'
import {
  NotComparableError,
  type CompareFile,
  type PageSize,
  type PageSource,
  type SourceLoader,
} from './types'

export type SideState =
  | { status: 'loading' }
  | { status: 'ready'; source: PageSource }
  | { status: 'not-comparable' }
  | { status: 'failed' }

/**
 * Open one Fassung for drawing, and release it when the comparison closes or
 * the file changes. A load that resolves after the cleanup ran destroys its
 * own result, or a closed dialog would keep a pdf.js worker and its page cache.
 *
 * `attempt` is how a reader's „Erneut versuchen" reaches here: a new number
 * opens the file again.
 */
export function usePageSource(file: CompareFile, loadSource: SourceLoader, attempt = 0): SideState {
  const { id, filename } = file
  const [state, setState] = useState<SideState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let opened: PageSource | null = null
    setState({ status: 'loading' })
    loadSource({ id, filename })
      .then((source) => {
        if (cancelled) {
          source.destroy()
          return
        }
        opened = source
        setState({ status: 'ready', source })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({ status: error instanceof NotComparableError ? 'not-comparable' : 'failed' })
      })
    return () => {
      cancelled = true
      opened?.destroy()
    }
  }, [id, filename, loadSource, attempt])

  return state
}

/** The natural size of `page` in `source`, or null while unknown or when the source has no such page. */
export function usePageSize(source: PageSource | null, page: number): PageSize | null {
  const [sized, setSized] = useState<{ source: PageSource; page: number; size: PageSize } | null>(
    null,
  )

  useEffect(() => {
    if (!source || page < 1 || page > source.pageCount) return
    let cancelled = false
    source
      .pageSize(page)
      .then((size) => {
        if (!cancelled) setSized({ source, page, size })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [source, page])

  return sized && sized.source === source && sized.page === page ? sized.size : null
}
