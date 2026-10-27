/**
 * What a saved search asks, in one line under its name: the words in
 * quotes, „Planliste“ when it opens the register, then its filters in the
 * chips' words („„Fluchtweg“ · Einreichplan · Nur aktuelle Fassung · Verweist
 * auf: ÖNORM B 1600“; which words is the caller's, `useSavedSearchSummary`). A name is what the person chose to call it; this is what it will
 * do, so a colleague's „Zitiert ÖNORM B 1600“ can be told from one's own
 * before it runs.
 *
 * Pure: the caller hands in the words (`useSearchLabels`).
 */

import type { SearchBody } from '@/lib/search/search-wire'
import { activeFilters, type ActiveFilter } from './active-filters'
import { fromSearchBody } from './search-url'

export interface SavedSearchSummaryWords {
  /** The words searched for, quoted: „Fluchtweg“. */
  quote: (text: string) => string
  /** The register's name, „Planliste“. */
  register: string
  /** A filter as its chip says it. */
  filter: (filter: ActiveFilter) => string
  /** A search with neither words nor filters. */
  everything: string
}

const SEPARATOR = ' · '

export function savedSearchSummary(query: SearchBody, words: SavedSearchSummaryWords): string {
  // The project a saved scope names is not in the question: the menu cannot name it, and the row already sits on the page it applies to.
  const state = fromSearchBody(query)
  const text = state.text.trim()
  const parts = [
    ...(text ? [words.quote(text)] : []),
    ...(state.view === 'register' ? [words.register] : []),
    ...activeFilters(state).map(words.filter),
  ]
  return parts.length > 0 ? parts.join(SEPARATOR) : words.everything
}
