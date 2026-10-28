'use client'

import type { JSX } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import { useSearchLabels } from '../hooks/use-search-labels'
import { activeFilters, clearFilters } from '../lib/active-filters'
import type { SearchUrlState } from '../lib/search-url'
import { ActiveFilters, RemovableChip } from './search-atoms'

/**
 * The filters that are set, as chips that take themselves off, and one control
 * that takes them all off. A summary, not a home: each filter's control is in
 * the rail, except „Nur aktuelle Fassung“ in the register, whose switch is on
 * screen above the table and so has no chip there.
 */
export function SearchActiveFilters({
  state,
  onChange,
  projectName,
}: {
  state: SearchUrlState
  onChange: (next: SearchUrlState) => void
  projectName: (id: string) => string | null
}): JSX.Element | null {
  const t = useTranslations(searchCopy, 'filters')
  const labels = useSearchLabels()
  // The register says „Nur aktuelle Fassung“ with its own switch above the
  // table; a chip beside it would be the one setting shown twice.
  const filters = activeFilters(state).filter((filter) => !(state.view === 'register' && filter.id === 'currentOnly'))
  if (filters.length === 0) return null
  return (
    <ActiveFilters>
      {filters.map((filter) => {
        const label = labels.activeFilter(filter, projectName)
        return <RemovableChip key={filter.id} label={label} removeLabel={t('remove', { label })} onRemove={() => onChange(filter.next)} />
      })}
      {filters.length > 1 ? (
        <Button type="button" variant="link" size="sm" onClick={() => onChange(clearFilters(state))} data-testid="search-clear-filters">
          {/* On a phone the short words keep it on the chips' line rather than a line of its own. */}
          <span className="max-sm:hidden">{t('clearAll')}</span>
          <span className="sm:hidden">{t('clearAllShort')}</span>
        </Button>
      ) : null}
    </ActiveFilters>
  )
}
