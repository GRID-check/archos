'use client'

/**
 * Completions for a free-text filter of the search, as it is typed: the values
 * the office's documents hold, with counts (`POST /api/search/suggest`). The
 * source is the surface's: the connected search asks the route at its scope
 * and under its other filters, the `/dev/search` preview answers from its
 * fixture. Without a source a field is a plain text field.
 *
 * Asked only while the field has focus, 150 ms after the last key (the
 * palette's pace); a newer question aborts the one in flight, so a slow
 * answer for „At“ never lands over the one for „Atelier“. A failed answer is
 * no suggestions: what was typed still applies.
 */

import { createContext, useContext, useEffect, useState } from 'react'

import { useDebouncedValue } from '@/hooks/use-debounced-value'
import type { FacetCount, SuggestBody } from '@/lib/search/search-wire'

/** One completion's question, without the filters the source adds. */
export type SuggestQuestion = Pick<SuggestBody, 'dimension' | 'prefix' | 'role' | 'factKey'>

export type SuggestSource = (
  question: SuggestQuestion,
  signal: AbortSignal
) => Promise<FacetCount[]>

const SuggestSourceContext = createContext<SuggestSource | null>(null)

/** Where a surface's filter fields get their completions. */
export const SuggestSourceProvider = SuggestSourceContext.Provider

/** Quiet time before a keystroke becomes a question. */
export const SUGGEST_DEBOUNCE_MS = 150

const NONE: FacetCount[] = []

export function useFilterSuggestions(
  question: Omit<SuggestQuestion, 'prefix'> | null,
  draft: string,
  focused: boolean
): FacetCount[] {
  const source = useContext(SuggestSourceContext)
  const prefix = useDebouncedValue(draft.trim(), SUGGEST_DEBOUNCE_MS)
  const [values, setValues] = useState<FacetCount[]>(NONE)
  const dimension = question?.dimension
  const role = question?.role
  const factKey = question?.factKey
  const asking = Boolean(source && dimension && focused)

  useEffect(() => {
    if (!asking || !source || !dimension) return
    const controller = new AbortController()
    source(
      { dimension, prefix, ...(role ? { role } : {}), ...(factKey ? { factKey } : {}) },
      controller.signal
    )
      .then((next) => {
        if (!controller.signal.aborted) setValues(next)
      })
      .catch(() => {
        if (!controller.signal.aborted) setValues(NONE)
      })
    return () => controller.abort()
  }, [asking, source, dimension, prefix, role, factKey])

  return asking ? values : NONE
}
