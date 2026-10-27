'use client'

import { useEffect, useRef, useState } from 'react'

import type { SearchHit, SearchKind } from '@/lib/search/search-wire'
import { hitHref } from '../lib/search-hrefs'
import { findHitByHref, SearchTracker, type SearchTelemetrySurface } from '../lib/search-telemetry'

/**
 * One search surface's {@link SearchTracker}, alive as long as the surface: a
 * question still held when the surface goes away (the palette closes, the
 * page is left) is sent then, because the reader saw its answer.
 */
export function useSearchTracker(surface: SearchTelemetrySurface): SearchTracker {
  const [tracker] = useState(() => new SearchTracker(surface))
  useEffect(() => () => tracker.flush(), [tracker])
  return tracker
}

const linkHref = (element: Element | null): string | null => {
  if (!element) return null
  const link = element.closest('a[href]') ?? element.querySelector('a[href]')
  return link?.getAttribute('href') ?? null
}

/**
 * `search_result_opened` for the hits a surface shows, wherever they are drawn.
 *
 * A hit is a link to where the workspace shows it (`search-hrefs.ts`), so the
 * hit opened is the one whose href the link carries: a click (or a middle
 * click) on it, or Enter in a field whose `aria-activedescendant` names its row
 * (the search field's own walk). Listening on the document keeps the rows,
 * the list and the register free of telemetry props.
 */
export function useOpenedHitCapture(
  tracker: SearchTracker,
  sections: Partial<Record<SearchKind, { hits: readonly SearchHit[] }>>
): void {
  const current = useRef(sections)
  useEffect(() => {
    current.current = sections
  }, [sections])

  useEffect(() => {
    const report = (href: string | null): void => {
      if (!href) return
      const found = findHitByHref(current.current, href, hitHref)
      if (found) tracker.opened(found.hit, found.rank)
    }
    const onClick = (event: MouseEvent): void => {
      if (event.button > 1 || !(event.target instanceof Element)) return
      report(event.target.closest('a[href]')?.getAttribute('href') ?? null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !(event.target instanceof Element)) return
      const active = event.target.getAttribute('aria-activedescendant')
      if (active) report(linkHref(document.getElementById(active)))
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('auxclick', onClick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('auxclick', onClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [tracker])
}
