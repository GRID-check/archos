'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { SEARCH_PARAMS, withoutSearchParams } from '../lib/search-url'

/** `?mode=search` on a shelf (a project's Dateien, the office shelf) shows the search in place of the listing. */
export const SHELF_SEARCH_MODE_PARAM = 'mode'
export const SHELF_SEARCH_MODE = 'search'

export interface ShelfSearchMode {
  active: boolean
  /** The folder open on the shelf (`?folder=`), which the search is scoped to. */
  folderId: string | null
  /** Show the search, asking `text` when there is any (what the shelf's field held). */
  open: (text?: string) => void
  close: () => void
}

/**
 * Whether a shelf shows its search, in the URL so the scoped search is a link
 * and Back returns to the listing. Leaving keeps the open folder and drops the
 * search's own parameters.
 */
export function useShelfSearchMode(): ShelfSearchMode {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const query = searchParams?.toString() ?? ''
  const params = new URLSearchParams(query)
  const active = params.get(SHELF_SEARCH_MODE_PARAM) === SHELF_SEARCH_MODE
  const folderId = params.get('folder')?.trim() || null

  const open = useCallback(
    (text?: string) => {
      const next = new URLSearchParams(query)
      next.delete('doc')
      next.set(SHELF_SEARCH_MODE_PARAM, SHELF_SEARCH_MODE)
      if (text) next.set(SEARCH_PARAMS.text, text)
      router.push(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [pathname, query, router]
  )

  const close = useCallback(() => {
    const next = withoutSearchParams(new URLSearchParams(query))
    next.delete(SHELF_SEARCH_MODE_PARAM)
    const rest = next.toString()
    router.push(rest ? `${pathname}?${rest}` : pathname, { scroll: false })
  }, [pathname, query, router])

  return { active, folderId, open, close }
}
