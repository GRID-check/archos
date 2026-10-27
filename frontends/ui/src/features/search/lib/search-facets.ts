/**
 * A facet value is a filter the reader can switch on and off with one click.
 *
 * Each dimension the search counts (`SEARCH_FACET_DIMENSIONS`) maps onto one
 * field of the query, so the count beside a value is what the result becomes
 * when the value is clicked. Two dimensions have no list filter in the
 * contract and are a single value: the project narrows the office-wide page to
 * one project (its scope), the municipality is the `place` filter.
 */

import { DOSSIER_DOCUMENT_TYPES, DOSSIER_PARTY_ROLES } from '@/lib/documents/dossier'
import { ALLOWED_TAGS } from '@/lib/documents/tag-vocabulary'
import { SEARCH_READ_STATES, type DocumentFilters, type SearchFacetDimension } from '@/lib/search/search-wire'
import { compactFilters, type SearchUrlState } from './search-url'

function includes(values: readonly string[] | undefined, value: string): boolean {
  return (values ?? []).includes(value)
}

function toggled<T extends string>(values: readonly T[] | undefined, value: T): T[] {
  const current = values ?? []
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
}

function known<T extends string>(vocabulary: readonly T[], value: string): value is T {
  return (vocabulary as readonly string[]).includes(value)
}

/** Whether the value is switched on in the search. */
export function isFacetActive(state: SearchUrlState, dimension: SearchFacetDimension, value: string): boolean {
  const f = state.filters
  switch (dimension) {
    case 'documentType':
      return includes(f.documentTypes, value)
    case 'tag':
      return includes(f.tags, value)
    case 'project':
      return state.projectId === value
    case 'partyRole':
      return (f.parties ?? []).some((party) => party.role === value && party.name === undefined)
    case 'municipality':
      return f.place === value
    case 'cites':
      return includes(f.cites, value)
    case 'state':
      return includes(f.states, value)
    case 'fileType':
      return includes(f.fileTypes, value)
  }
}

/** The search with the value switched: on when it was off, off when it was on. A value the query cannot name is ignored. */
export function toggleFacet(state: SearchUrlState, dimension: SearchFacetDimension, value: string): SearchUrlState {
  const f = state.filters
  const withFilters = (filters: DocumentFilters): SearchUrlState => ({ ...state, filters: compactFilters(filters) })
  switch (dimension) {
    case 'documentType':
      return known(DOSSIER_DOCUMENT_TYPES, value) ? withFilters({ ...f, documentTypes: toggled(f.documentTypes, value) }) : state
    case 'tag':
      return ALLOWED_TAGS.has(value) ? withFilters({ ...f, tags: toggled(f.tags, value) }) : state
    case 'project':
      return { ...state, projectId: state.projectId === value ? null : value }
    case 'partyRole': {
      if (!known(DOSSIER_PARTY_ROLES, value)) return state
      const parties = f.parties ?? []
      const roleOnly = (party: (typeof parties)[number]): boolean => party.role === value && party.name === undefined
      const next = parties.some(roleOnly) ? parties.filter((party) => !roleOnly(party)) : [...parties, { role: value }]
      return withFilters({ ...f, parties: next })
    }
    case 'municipality':
      return withFilters({ ...f, place: f.place === value ? undefined : value })
    case 'cites':
      return withFilters({ ...f, cites: toggled(f.cites, value) })
    case 'state':
      return known(SEARCH_READ_STATES, value) ? withFilters({ ...f, states: toggled(f.states, value) }) : state
    case 'fileType':
      return withFilters({ ...f, fileTypes: toggled(f.fileTypes, value.toLowerCase()) })
  }
}
