'use client'

import type { JSX } from 'react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { SEARCH_FACET_DIMENSIONS, type FacetCount, type SearchFacetDimension, type SearchResponse } from '@/lib/search/search-wire'
import { useSearchLabels } from '../hooks/use-search-labels'
import { isFacetActive } from '../lib/search-facets'
import type { SearchUrlState } from '../lib/search-url'
import { FacetOption, QuietLine, RailAction, RailSection } from './search-atoms'

/** How many values a dimension shows before „Alle zeigen“. */
const FACET_PREVIEW = 6

export interface SearchFacetRailProps {
  state: SearchUrlState
  facets: SearchResponse['facets']
  /** Documents in scope not read yet, which no count above includes. */
  unread?: number | null
  onToggle: (dimension: SearchFacetDimension, value: string) => void
  /** The project dimension narrows the office-wide page only; inside a project or on the shelf it is no choice. */
  showProjects: boolean
}

/**
 * The counts over the matched documents, one group per dimension, the values
 * switched on first. A click switches a value on or off (`toggleFacet`).
 */
export function SearchFacetRail({ state, facets, unread = null, onToggle, showProjects }: SearchFacetRailProps): JSX.Element | null {
  const t = useTranslations('search.facets')
  if (!facets) return null
  const dimensions = SEARCH_FACET_DIMENSIONS.filter((dimension) => (dimension === 'project' ? showProjects : true))
  return (
    <>
      {dimensions.map((dimension) => (
        <FacetGroup key={dimension} dimension={dimension} values={facets[dimension] ?? []} state={state} onToggle={onToggle} />
      ))}
      {unread ? <QuietLine testId="search-facets-unread">{t('unread', { count: unread })}</QuietLine> : null}
    </>
  )
}

function FacetGroup({
  dimension,
  values,
  state,
  onToggle,
}: {
  dimension: SearchFacetDimension
  values: FacetCount[]
  state: SearchUrlState
  onToggle: (dimension: SearchFacetDimension, value: string) => void
}): JSX.Element | null {
  const t = useTranslations('search.facets')
  const labels = useSearchLabels()
  const [expanded, setExpanded] = useState(false)
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => Number(isFacetActive(state, dimension, b.value)) - Number(isFacetActive(state, dimension, a.value)) || b.count - a.count)
  const shown = expanded ? sorted : sorted.slice(0, FACET_PREVIEW)
  return (
    <RailSection title={t(dimension)} testId={`search-facet-${dimension}`}>
      {shown.map((facet) => (
        <FacetOption
          key={facet.value}
          label={labels.facetValue(dimension, facet)}
          count={facet.count}
          active={isFacetActive(state, dimension, facet.value)}
          onToggle={() => onToggle(dimension, facet.value)}
          testId={`search-facet-${dimension}-${facet.value}`}
        />
      ))}
      {sorted.length > FACET_PREVIEW && (
        <RailAction>
          <Button type="button" variant="link" size="sm" onClick={() => setExpanded((open) => !open)}>
            {expanded ? t('showFewer') : t('showAll', { count: sorted.length })}
          </Button>
        </RailAction>
      )}
    </RailSection>
  )
}
