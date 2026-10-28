'use client'

import { useMemo } from 'react'

import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import type { ActiveFilter } from '../lib/active-filters'
import { savedSearchSummary } from '../lib/saved-search-summary'
import { useSearchLabels } from './use-search-labels'

const SELF_NAMING = new Set<ActiveFilter['value']['kind']>(['documentType', 'readState', 'flag'])

/** The line under a saved search's name: what it asks, in the chips' words (`savedSearchSummary`). */
export function useSavedSearchSummary(): (item: SavedSearchView) => string {
  const t = useTranslations(searchCopy)
  const labels = useSearchLabels()
  return useMemo(() => {
    const words = {
      quote: (text: string) => t('saved.summaryText', { text }),
      register: t('views.register'),
      // A Dokumentart or a switch says what it is by its value alone („Einreichplan“,
      // „Nur aktuelle Fassung“); a typed value needs its field („Verweist auf: ÖNORM B 1600“).
      // A saved search's project is its scope, which `fromSearchBody` leaves out: no project chip to name.
      filter: (filter: ActiveFilter) =>
        SELF_NAMING.has(filter.value.kind) ? (labels.filterValue(filter, () => null) ?? '') : labels.activeFilter(filter, () => null),
      everything: t('saved.summaryEverything'),
    }
    return (item: SavedSearchView) => savedSearchSummary(item.query, words)
  }, [t, labels])
}
