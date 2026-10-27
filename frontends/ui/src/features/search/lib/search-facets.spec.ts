import { describe, expect, it } from 'vitest'

import { SEARCH_FACET_DIMENSIONS, type SearchFacetDimension } from '@/lib/search/search-wire'
import { activeFilters, clearFilters, splitList } from './active-filters'
import { isFacetActive, toggleFacet } from './search-facets'
import { EMPTY_SEARCH_STATE, type SearchUrlState } from './search-url'

const PROJECT = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'

const VALUE: Record<SearchFacetDimension, string> = {
  documentType: 'permit',
  tag: 'Brandschutz',
  project: PROJECT,
  partyRole: 'authority',
  municipality: 'Wien',
  cites: 'norm:ÖNORM B 1600',
  state: 'reading',
  fileType: 'pdf',
}

describe('a facet click', () => {
  it.each(SEARCH_FACET_DIMENSIONS)('switches %s on, and off again', (dimension) => {
    const on = toggleFacet(EMPTY_SEARCH_STATE, dimension, VALUE[dimension])
    expect(isFacetActive(on, dimension, VALUE[dimension])).toBe(true)
    const off = toggleFacet(on, dimension, VALUE[dimension])
    expect(isFacetActive(off, dimension, VALUE[dimension])).toBe(false)
    expect(off).toEqual(EMPTY_SEARCH_STATE)
  })

  it('adds to a list rather than replacing it', () => {
    const one = toggleFacet(EMPTY_SEARCH_STATE, 'documentType', 'permit')
    const two = toggleFacet(one, 'documentType', 'submission_drawing')
    expect(two.filters.documentTypes).toEqual(['permit', 'submission_drawing'])
    expect(toggleFacet(two, 'documentType', 'permit').filters.documentTypes).toEqual(['submission_drawing'])
  })

  it('narrows the office-wide page to the project, which is its scope', () => {
    const state = toggleFacet(EMPTY_SEARCH_STATE, 'project', PROJECT)
    expect(state.projectId).toBe(PROJECT)
    expect(state.filters).toEqual({})
  })

  it('leaves a party filtered by name alone when its role is clicked', () => {
    const named: SearchUrlState = { ...EMPTY_SEARCH_STATE, filters: { parties: [{ role: 'authority', name: 'MA 37' }] } }
    expect(isFacetActive(named, 'partyRole', 'authority')).toBe(false)
    const both = toggleFacet(named, 'partyRole', 'authority')
    expect(both.filters.parties).toEqual([{ role: 'authority', name: 'MA 37' }, { role: 'authority' }])
    expect(toggleFacet(both, 'partyRole', 'authority').filters.parties).toEqual([{ role: 'authority', name: 'MA 37' }])
  })

  it('ignores a value the query cannot name', () => {
    expect(toggleFacet(EMPTY_SEARCH_STATE, 'documentType', 'castle')).toBe(EMPTY_SEARCH_STATE)
    expect(toggleFacet(EMPTY_SEARCH_STATE, 'state', 'gone')).toBe(EMPTY_SEARCH_STATE)
    expect(toggleFacet(EMPTY_SEARCH_STATE, 'tag', 'Unsinn')).toBe(EMPTY_SEARCH_STATE)
  })
})

describe('the chips of the filters that are set', () => {
  const state: SearchUrlState = {
    ...EMPTY_SEARCH_STATE,
    text: 'EP',
    projectId: PROJECT,
    filters: { documentTypes: ['permit', 'site_plan'], currentOnly: true, planDate: { from: '2026-01-01' }, facts: [{ key: 'units', min: 10 }] },
  }

  it('lists one chip per value, and removing one leaves the rest', () => {
    const chips = activeFilters(state)
    expect(chips.map((chip) => chip.id)).toEqual([
      'project',
      'documentTypes:permit',
      'documentTypes:site_plan',
      'planDate',
      'currentOnly',
      'facts:units::10:',
    ])
    const withoutPermit = chips[1].next
    expect(withoutPermit.filters.documentTypes).toEqual(['site_plan'])
    expect(withoutPermit.text).toBe('EP')
    expect(chips[0].next.projectId).toBeNull()
    expect(chips[5].next.filters.facts).toBeUndefined()
  })

  it('clears every filter and keeps the words', () => {
    expect(clearFilters(state)).toEqual({ ...state, filters: {}, projectId: null })
  })

  it('splits a typed list', () => {
    expect(splitList(' C, D ,,C ')).toEqual(['C', 'D'])
  })
})
