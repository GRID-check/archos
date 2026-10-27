'use client'

import type { JSX } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { useSearchLabels } from '../hooks/use-search-labels'
import { activeFilters, clearFilters } from '../lib/active-filters'
import type { SearchUrlState } from '../lib/search-url'
import { ActiveFilters, RemovableChip } from './search-atoms'

/** The filters that are set, as chips that take themselves off, and one control that takes them all off. */
export function SearchActiveFilters({
  state,
  onChange,
  projectName,
}: {
  state: SearchUrlState
  onChange: (next: SearchUrlState) => void
  projectName: (id: string) => string | null
}): JSX.Element | null {
  const t = useTranslations('search.filters')
  const labels = useSearchLabels()
  const filters = activeFilters(state)
  if (filters.length === 0) return null
  return (
    <ActiveFilters>
      {filters.map((filter) => {
        const label = labels.activeFilter(filter, projectName)
        return <RemovableChip key={filter.id} label={label} removeLabel={t('remove', { label })} onRemove={() => onChange(filter.next)} />
      })}
      {filters.length > 1 ? (
        <Button type="button" variant="link" size="sm" onClick={() => onChange(clearFilters(state))} data-testid="search-clear-filters">
          {t('clearAll')}
        </Button>
      ) : null}
    </ActiveFilters>
  )
}
