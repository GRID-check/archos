'use client'

import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useFassungCompare } from '../components/fassung-compare'
import type { FileItem } from '../file-types'
import { COMPARE_PARAM } from '../lib/fassung-compare-link'

/**
 * Open the visual comparison a link asks for: `?doc=<newer>&compare=<older>`
 * (`fassung-compare-link.ts`), the way the inbox row „… hat eine neue Fassung
 * hochgeladen" says „Fassungen vergleichen".
 *
 * The comparison needs each file's name to pick a renderer (PDF, office
 * rendition, image), and the listing is what holds the names, so it waits for
 * both rows to arrive. Once it opened, or once the newer row is there and the
 * older is not (a folder the reader may not open, the listing's page ceiling),
 * `?compare=` is dropped from the URL: a reload or a Back must not reopen it.
 * `?doc=` is left to its one writer (`useDocParamSync`), which opens the
 * preview behind the comparison.
 *
 * `listingComplete` is what makes "the older is not there" a conclusion: the
 * listing arrives page by page, and an older Fassung is usually further down
 * it than the newer one. Until the last page is in, a missing older row is a
 * row still on its way.
 *
 * Returns the element to render once, anywhere in the workspace.
 */
export function useCompareParam(files: readonly FileItem[], listingComplete = true): JSX.Element | null {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const olderId = searchParams?.get(COMPARE_PARAM) ?? null
  const newerId = searchParams?.get('doc') ?? null
  const { openFassungCompare, compareElement } = useFassungCompare()
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!olderId) return
    const key = `${newerId ?? ''}:${olderId}`
    if (handled.current === key) return
    const newer = newerId ? files.find((file) => file.id === newerId) : undefined
    // Rows still loading: the render that has them asks again.
    if (!newer) return
    const older = files.find((file) => file.id === olderId)
    if (!older && !listingComplete) return
    handled.current = key
    if (older && older.id !== newer.id) {
      openFassungCompare(
        { id: older.id, filename: older.filename },
        { id: newer.id, filename: newer.filename }
      )
    }
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    params.delete(COMPARE_PARAM)
    const query = params.toString()
    const path = pathname ?? ''
    router.replace(query ? `${path}?${query}` : path, { scroll: false })
  }, [files, listingComplete, newerId, olderId, openFassungCompare, pathname, router, searchParams])

  return compareElement
}
