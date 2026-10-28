'use client'

import { useMemo } from 'react'

import { useLocale, useTranslations } from '@/i18n'
import { dossierCopy } from '@/i18n/namespaces/dossier'
import { searchCopy } from '@/i18n/namespaces/search'
import { DOSSIER_DOCUMENT_TYPES, DOSSIER_FACT_KEYS, DOSSIER_PARTY_ROLES } from '@/lib/documents/dossier'
import { formatDate } from '@/lib/format'
import { SEARCH_READ_STATES, type FacetCount, type SearchFacetDimension } from '@/lib/search/search-wire'
import type { ActiveFilter } from '../lib/active-filters'

function known(vocabulary: readonly string[], value: string | null | undefined): value is string {
  return typeof value === 'string' && vocabulary.includes(value)
}

export interface SearchLabels {
  documentType: (value: string | null | undefined) => string | null
  partyRole: (value: string | null | undefined) => string | null
  readState: (value: string) => string
  factKey: (value: string) => string
  facetValue: (dimension: SearchFacetDimension, facet: Pick<FacetCount, 'value' | 'label'>) => string
  day: (iso: string | null | undefined) => string | null
  activeFilter: (filter: ActiveFilter, projectName: (id: string) => string | null) => string
  /** The filter's value alone („Einreichplan“, „Nur aktuelle Fassung“); null for a project the page cannot name. */
  filterValue: (filter: ActiveFilter, projectName: (id: string) => string | null) => string | null
}

/**
 * The words for the search's values. Document types, party roles and facts
 * speak the dossier's vocabulary (`dossier.*`), so a facet reads as the
 * document's own rail does; a value the vocabulary does not know shows as the
 * server labelled it.
 */
export function useSearchLabels(): SearchLabels {
  const t = useTranslations(searchCopy)
  const tDossier = useTranslations(dossierCopy)
  const { locale } = useLocale()

  return useMemo(() => {
    const documentType = (value: string | null | undefined): string | null =>
      known(DOSSIER_DOCUMENT_TYPES, value) ? tDossier(`documentTypes.${value}`) : (value ?? null)
    const partyRole = (value: string | null | undefined): string | null =>
      known(DOSSIER_PARTY_ROLES, value) ? tDossier(`partyRoles.${value}`) : (value ?? null)
    const readState = (value: string): string => (known(SEARCH_READ_STATES, value) ? t(`readStates.${value}`) : value)
    const factKey = (value: string): string => (known(DOSSIER_FACT_KEYS, value) ? tDossier(`factKeys.${value}`) : value)
    const day = (iso: string | null | undefined): string | null => (iso ? formatDate(iso, locale) : null)

    const facetValue = (dimension: SearchFacetDimension, facet: Pick<FacetCount, 'value' | 'label'>): string => {
      switch (dimension) {
        case 'documentType':
          return documentType(facet.value) ?? facet.value
        case 'partyRole':
          return partyRole(facet.value) ?? facet.value
        case 'state':
          return readState(facet.value)
        case 'changedFact':
          return factKey(facet.value)
        case 'fileType':
          return facet.label ?? facet.value.toUpperCase()
        default:
          return facet.label ?? facet.value
      }
    }

    const range = (from: string | number | null, to: string | number | null, dates: boolean): string => {
      const show = (value: string | number | null): string | null =>
        value === null ? null : dates && typeof value === 'string' ? (day(value) ?? value) : String(value)
      const a = show(from)
      const b = show(to)
      if (a !== null && b !== null) return t('filters.range', { from: a, to: b })
      return a !== null ? t('filters.rangeFrom', { from: a }) : t('filters.rangeTo', { to: b ?? '' })
    }

    const filterValue = (filter: ActiveFilter, projectName: (id: string) => string | null): string | null => {
      const v = filter.value
      switch (v.kind) {
        case 'text':
          return v.text
        case 'documentType':
          return documentType(v.value) ?? v.value
        case 'readState':
          return readState(v.value)
        case 'partyRole':
          return [partyRole(v.role), v.name].filter(Boolean).join(' · ')
        case 'fact': {
          const amount = v.fact.equals ?? range(v.fact.min ?? null, v.fact.max ?? null, false)
          return `${factKey(v.fact.key)} ${amount}`
        }
        case 'factKey':
          return factKey(v.key)
        case 'range':
          return range(v.from, v.to, filter.id !== 'pages')
        case 'project':
          return projectName(v.projectId)
        case 'flag':
          return t(filter.labelKey)
      }
    }

    const activeFilter = (filter: ActiveFilter, projectName: (id: string) => string | null): string => {
      const label = t(filter.labelKey)
      if (filter.value.kind === 'flag') return label
      return t('filters.chip', { label, value: filterValue(filter, projectName) ?? '…' })
    }

    return { documentType, partyRole, readState, factKey, facetValue, day, activeFilter, filterValue }
  }, [t, tDossier, locale])
}
