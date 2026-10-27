'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { parseSearchParams, writeSearchParams, type SearchUrlState } from '../lib/search-url'

/** How long the field waits for the reader to stop typing before the URL, and so the search, follows. */
export const SEARCH_TEXT_DEBOUNCE_MS = 300

export interface SearchUrlStateHandle {
  state: SearchUrlState
  /** Write a new search to the URL. A filter is a history entry (`push`); the words typed replace theirs. */
  setState: (next: SearchUrlState, options?: { history?: 'push' | 'replace' }) => void
  /** What the field shows: the reader's typing, ahead of the URL by the debounce. */
  fieldValue: string
  setFieldValue: (value: string) => void
}

/**
 * The search the URL holds, and a way to change it. Every other parameter of
 * the page (`folder`, `mode`) is left as it is.
 */
export function useSearchUrlState(): SearchUrlStateHandle {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const query = searchParams?.toString() ?? ''
  const state = useMemo(() => parseSearchParams(new URLSearchParams(query)), [query])

  const setState = useCallback(
    (next: SearchUrlState, options?: { history?: 'push' | 'replace' }) => {
      const params = writeSearchParams(next, new URLSearchParams(query)).toString()
      if (params === query) return
      const href = params ? `${pathname}?${params}` : pathname
      if (options?.history === 'replace') router.replace(href, { scroll: false })
      else router.push(href, { scroll: false })
    },
    [pathname, query, router]
  )

  const [fieldValue, setFieldValue] = useState(state.text)
  const settled = useDebouncedValue(fieldValue, SEARCH_TEXT_DEBOUNCE_MS)

  // The words this field last wrote to the URL. When the URL's words are
  // anything else, it moved on its own (Back, a saved search applied) and the
  // field follows it; when they are these, the reader may already be typing on.
  const written = useRef(state.text)
  const [seenText, setSeenText] = useState(state.text)
  if (seenText !== state.text) {
    setSeenText(state.text)
    if (state.text !== written.current) setFieldValue(state.text)
  }

  useEffect(() => {
    if (settled === state.text || settled !== fieldValue) return
    written.current = settled
    setState({ ...state, text: settled }, { history: 'replace' })
  }, [settled, fieldValue, state, setState])

  return { state, setState, fieldValue, setFieldValue }
}
