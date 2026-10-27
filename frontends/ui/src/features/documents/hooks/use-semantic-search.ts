'use client'

import { useCallback, useRef, useState } from 'react'
import type { DocumentHit, SearchResponse } from '@/lib/search/search-wire'
import type { FileItem } from '../components/project-file-workspace'

/**
 * A file browser result carrying its match evidence: the base {@link FileItem}
 * plus WHY it matched (the passage and its page) and its place in the ranking.
 * The search (`POST /api/search`, ADR-0133) ranks and never shows a score, so
 * the rank is the order the answer came in.
 */
export interface SemanticHit extends FileItem {
  /** The matched passage; empty when the name or the reading matched, not the text. */
  snippet: string
  page: number | null
  /** 1 is the best match. */
  rank: number
}

interface UseSemanticSearchOptions {
  /** The search route with the shelf as its query (`/api/search?projectId=…`). */
  endpoint: string
  /** Body fields merged into every request (`kinds: ['document']`). */
  extraBody?: Record<string, unknown>
}

export interface SemanticSearchState {
  /** The committed query while semantic mode is active; `null` in the normal list. */
  query: string | null
  /** Whether semantic mode is showing (a query has been committed). */
  active: boolean
  hits: SemanticHit[]
  isSearching: boolean
  /** True when the last run failed/timed out — treated as an empty result set. */
  error: boolean
  /** Run the semantic search for `query` (fires on Enter/button, not per keystroke). */
  run: (query: string) => void
  /** Clear semantic mode and return to the normal list. */
  reset: () => void
}

/** A document result of the search as a row of the file browser, with its match evidence. */
export function toSemanticHit(hit: DocumentHit, index: number): SemanticHit {
  return {
    id: hit.id,
    filename: hit.filename,
    displayName: hit.name === hit.filename ? null : hit.name,
    fileSize: null,
    contentType: hit.contentType,
    status: hit.status,
    folderId: hit.folderId,
    createdAt: hit.uploadedAt,
    errorMessage: null,
    summary: null,
    pageCount: hit.pageCount,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
    snippet: hit.passage?.text ?? '',
    page: hit.passage?.page ?? null,
    rank: index + 1,
  }
}

/**
 * Explicit-run semantic search for a file browser. Keeps the committed query,
 * the joined hits, and the loading/error flags; a stale in-flight response is
 * ignored (request-id guard) so a fast reset or re-run always wins. The fetch
 * fires only from {@link SemanticSearchState.run} — never per keystroke.
 */
export function useSemanticSearch({ endpoint, extraBody }: UseSemanticSearchOptions): SemanticSearchState {
  const [query, setQuery] = useState<string | null>(null)
  const [hits, setHits] = useState<SemanticHit[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState(false)
  const requestId = useRef(0)

  const run = useCallback(
    (raw: string) => {
      const q = raw.trim()
      if (!q) return
      const id = ++requestId.current
      setQuery(q)
      setIsSearching(true)
      setError(false)

      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: q, ...extraBody }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`Search failed (${r.status})`)
          return r.json() as Promise<Pick<SearchResponse, 'sections'>>
        })
        .then((data) => {
          if (requestId.current !== id) return
          setHits((data.sections?.document?.hits ?? []).map(toSemanticHit))
        })
        .catch(() => {
          if (requestId.current !== id) return
          // Fail-open: surface as an empty result set, never a crash.
          setHits([])
          setError(true)
        })
        .finally(() => {
          if (requestId.current === id) setIsSearching(false)
        })
    },
    [endpoint, extraBody],
  )

  const reset = useCallback(() => {
    // Invalidate any in-flight response and drop back to the normal list.
    requestId.current++
    setQuery(null)
    setHits([])
    setIsSearching(false)
    setError(false)
  }, [])

  return { query, active: query !== null, hits, isSearching, error, run, reset }
}
