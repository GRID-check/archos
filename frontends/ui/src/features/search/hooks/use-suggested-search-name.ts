'use client'

import { useMemo } from 'react'

import { activeFilters } from '../lib/active-filters'
import { suggestSavedSearchName } from '../lib/saved-search-name'
import type { SearchUrlState } from '../lib/search-url'
import { useSearchLabels } from './use-search-labels'

const UNNAMED = (): null => null

/** The name the save dialog opens with, from the words and the chips of this search. */
export function useSuggestedSearchName(state: SearchUrlState, projectName: (id: string) => string | null = UNNAMED): string {
  const labels = useSearchLabels()
  return useMemo(
    () => suggestSavedSearchName(state.text, activeFilters(state).map((filter) => labels.filterValue(filter, projectName))),
    [state, labels, projectName]
  )
}
