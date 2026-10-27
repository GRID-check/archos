'use client'

import { useMemo } from 'react'

import { useTranslations } from '@/i18n'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import type { ActiveFilter } from '../lib/active-filters'
import { savedSearchSummary } from '../lib/saved-search-summary'
import { useSearchLabels } from './use-search-labels'

/** The line under a saved search's name: what it asks, in the chips' words (`savedSearchSummary`). */
export function useSavedSearchSummary(): (item: SavedSearchView) => string {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  return useMemo(() => {
    const words = {
      quote: (text: string) => t('saved.summaryText', { text }),
      register: t('views.register'),
      // A saved search's project is its scope, which `fromSearchBody` leaves out: no project chip to name.
      filter: (filter: ActiveFilter) => labels.activeFilter(filter, () => null),
      everything: t('saved.summaryEverything'),
    }
    return (item: SavedSearchView) => savedSearchSummary(item.query, words)
  }, [t, labels])
}
