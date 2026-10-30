'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SearchBody, SearchKind, SearchResponse, SearchScopeQuery } from '@/lib/search/search-wire'
import { postSearch } from '@/adapters/api/search-client'
import type { SectionView } from '../lib/sections'

/** One question's answer as it landed: how long the browser waited, and the route's `Server-Timing`. */
export interface AnsweredSearch {
  scope: SearchScopeQuery
  body: SearchBody
  response: SearchResponse
  durationMs: number
  serverTiming: string | null
}

interface MorePage {
  hits: SectionView['hits']
  nextCursor: string | null
  loading: boolean
  failed: boolean
}

export interface SearchResults {
  response: SearchResponse | null
  sections: Partial<Record<SearchKind, SectionView>>
  loading: boolean
  failed: boolean
  retry: () => void
  loadMore: (kind: SearchKind) => void
}

/** `earlier` and then the hits of `later` it does not already hold: a document is one row, once. */
export function appendUnique<T extends { id: string }>(earlier: readonly T[], later: readonly T[]): T[] {
  const seen = new Set(earlier.map((hit) => hit.id))
  const out = [...earlier]
  for (const hit of later) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    out.push(hit)
  }
  return out
}

/**
 * The answer to one question, and its sections' further pages.
 *
 * A new question aborts the one in flight, so a slow answer to the words typed
 * a moment ago never lands over the answer to the words typed now. A section's
 * next page asks the same question for that kind alone, from the cursor the
 * last page gave (`nextCursor`, ADR-0131).
 *
 * Each cursor is asked once per question. The end of a list can be reached
 * twice before a re-render (the observer and a click in one frame), and both
 * read the same `more`; the cursors asked live in a ref, which they share. A
 * page that hands back a cursor already asked has not moved on, so the
 * section ends there instead of asking it again, and a document a later page
 * repeats is dropped (`appendUnique`): React keys rows by id.
 */
export function useSearchResults(scope: SearchScopeQuery, body: SearchBody, onAnswered?: (answer: AnsweredSearch) => void): SearchResults {
  const key = JSON.stringify([scope, body])
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [more, setMore] = useState<Partial<Record<SearchKind, MorePage>>>({})
  const current = useRef(key)
  const asked = useRef<Partial<Record<SearchKind, Set<string>>>>({})
  // Heard for the question's own answer, not a section's further page (telemetry: `search_issued`).
  const answeredRef = useRef(onAnswered)
  useEffect(() => {
    answeredRef.current = onAnswered
  }, [onAnswered])

  useEffect(() => {
    const [askedScope, askedBody] = JSON.parse(key) as [SearchScopeQuery, SearchBody]
    const controller = new AbortController()
    current.current = key
    asked.current = {}
    setLoading(true)
    setFailed(false)
    const started = performance.now()
    let serverTiming: string | null = null
    postSearch(askedScope, askedBody, controller.signal, (header) => {
      serverTiming = header
    })
      .then((answer) => {
        answeredRef.current?.({ scope: askedScope, body: askedBody, response: answer, durationMs: performance.now() - started, serverTiming })
        setResponse(answer)
        setMore({})
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setFailed(true)
        setLoading(false)
      })
    return () => controller.abort()
  }, [key, attempt])

  const loadMore = useCallback(
    (kind: SearchKind) => {
      const section = response?.sections[kind]
      const page = more[kind]
      const cursor = page ? page.nextCursor : section?.nextCursor
      if (!cursor || page?.loading) return
      const cursors = (asked.current[kind] ??= new Set())
      if (cursors.has(cursor)) return
      cursors.add(cursor)
      const question = key
      setMore((pages) => ({ ...pages, [kind]: { hits: page?.hits ?? [], nextCursor: cursor, loading: true, failed: false } }))
      postSearch(scope, { ...body, kinds: [kind], cursor, facets: false })
        .then((answer) => {
          if (current.current !== question) return
          const next = answer.sections[kind]
          const nextCursor = next?.nextCursor ?? null
          const stalled = nextCursor !== null && cursors.has(nextCursor)
          setMore((pages) => ({
            ...pages,
            [kind]: { hits: [...(pages[kind]?.hits ?? []), ...(next?.hits ?? [])], nextCursor: stalled ? null : nextCursor, loading: false, failed: false },
          }))
        })
        .catch(() => {
          if (current.current !== question) return
          // A failed page may be asked again, by the reader's click.
          cursors.delete(cursor)
          setMore((pages) => ({ ...pages, [kind]: { hits: pages[kind]?.hits ?? [], nextCursor: cursor, loading: false, failed: true } }))
        })
    },
    [body, key, more, response, scope]
  )

  const sections = useMemo(() => {
    const out: Partial<Record<SearchKind, SectionView>> = {}
    for (const [kind, section] of Object.entries(response?.sections ?? {}) as [SearchKind, SearchResponse['sections'][SearchKind]][]) {
      if (!section) continue
      const page = more[kind]
      out[kind] = {
        hits: appendUnique(section.hits, page?.hits ?? []),
        total: section.total,
        totalIsLowerBound: section.totalIsLowerBound,
        nextCursor: page ? page.nextCursor : section.nextCursor,
        loadingMore: page?.loading ?? false,
        loadMoreFailed: page?.failed ?? false,
      }
    }
    return out
  }, [response, more])

  return { response, sections, loading, failed, retry: () => setAttempt((n) => n + 1), loadMore }
}
