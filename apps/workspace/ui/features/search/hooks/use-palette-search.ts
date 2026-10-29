'use client'

import { useCallback, useEffect, useState } from 'react'

import { listSavedSearches, type SavedSearchView } from '@/lib/search/saved-search-client'
import type { SearchBody, SearchKind, SearchResponse, SearchScopeQuery } from '@/lib/search/search-wire'
import { readRecentSearches, rememberSearch } from '../lib/recent-searches'
import { postSearch } from '../lib/search-client'
import { hitHref } from '../lib/search-hrefs'
import { findHitByHref, parseServerTiming } from '../lib/search-telemetry'
import { useSearchTracker } from './use-search-tracker'

/** How long the palette waits after the last key before it asks: about one keystroke's gap. */
export const PALETTE_SEARCH_DEBOUNCE_MS = 150
/** Hits of each kind the palette shows; the rest are one row away („Alle Treffer“). */
export const PALETTE_HITS_PER_KIND = 3

export interface PaletteSearch {
  /** The words `response` answers; lags the field while a newer question is on its way. */
  answered: string
  response: SearchResponse | null
  loading: boolean
  failed: boolean
}

export interface PaletteSearchHandle extends PaletteSearch {
  /** The reader is about to go to `href`: when it is one of the answer's hits, `search_result_opened` says which. */
  opening: (href: string) => void
  /** Ask the same question again, after an answer that failed. */
  retry: () => void
}

const IDLE: PaletteSearch = { answered: '', response: null, loading: false, failed: false }

/**
 * The ⌘K palette's live search: what was typed, asked of `POST /api/search`
 * at the palette's scope once typing pauses, three hits of each kind, no facet
 * counts. A newer question cancels the one in flight, and the last answer stays
 * up (marked stale) until the next arrives, so the list does not blink per key.
 */
export function usePaletteSearch(
  text: string,
  scope: SearchScopeQuery,
  enabled: boolean,
  /** The composer's `#` asks for documents alone, more of them. */
  options: { kinds?: readonly SearchKind[]; limit?: number } = {}
): PaletteSearchHandle {
  const [state, setState] = useState<PaletteSearch>(IDLE)
  const words = text.trim()
  const scopeKey = JSON.stringify(scope)
  const kindsKey = options.kinds ? options.kinds.join(',') : ''
  const limit = options.limit ?? PALETTE_HITS_PER_KIND
  const tracker = useSearchTracker('palette')
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  useEffect(() => {
    if (!enabled) tracker.flush()
  }, [enabled, tracker])

  useEffect(() => {
    if (!enabled || words === '') {
      setState(IDLE)
      return
    }
    setState((current) => ({ ...current, loading: true, failed: false }))
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const asked = JSON.parse(scopeKey) as SearchScopeQuery
      const kinds = kindsKey ? (kindsKey.split(',') as SearchKind[]) : undefined
      const body: SearchBody = { text: words, limit, facets: false, ...(kinds ? { kinds } : {}) }
      const started = performance.now()
      let serverTiming: string | null = null
      postSearch(asked, body, controller.signal, (header) => {
        serverTiming = header
      })
        .then((response) => {
          tracker.answered({
            scope: asked,
            body,
            response,
            durationMs: performance.now() - started,
            serverTiming: parseServerTiming(serverTiming),
            view: 'list',
          })
          setState({ answered: words, response, loading: false, failed: false })
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setState((current) => ({ ...current, loading: false, failed: true }))
        })
    }, PALETTE_SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // `attempt` asks again: a retry is the same question, so nothing else changes.
  }, [words, scopeKey, enabled, tracker, kindsKey, limit, attempt])

  const { response } = state
  const opening = useCallback(
    (href: string) => {
      const found = response ? findHitByHref(response.sections, href, hitHref) : null
      if (found) tracker.opened(found.hit, found.rank)
      else tracker.flush()
    },
    [response, tracker]
  )
  return { ...state, opening, retry }
}

export interface PaletteShortcuts {
  recent: string[]
  /** null until read; an empty list when the read failed (the palette then just offers none). */
  saved: SavedSearchView[] | null
  /** Remember `text` as the latest search. */
  remember: (text: string) => void
}

/**
 * What the palette offers before anything is typed: the recent searches of
 * this browser, read each time it opens, and the saved searches, read the
 * first time it opens (not on every page load: the palette is always mounted).
 */
export function usePaletteShortcuts(open: boolean): PaletteShortcuts {
  const [recent, setRecent] = useState<string[]>([])
  const [saved, setSaved] = useState<SavedSearchView[] | null>(null)

  useEffect(() => {
    if (open) setRecent(readRecentSearches())
  }, [open])

  useEffect(() => {
    if (!open || saved !== null) return
    let cancelled = false
    listSavedSearches()
      .then((list) => {
        if (!cancelled) setSaved(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!cancelled) setSaved([])
      })
    return () => {
      cancelled = true
    }
  }, [open, saved])

  const remember = useCallback((text: string) => setRecent(rememberSearch(text)), [])
  return { recent, saved, remember }
}
