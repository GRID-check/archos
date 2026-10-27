import { describe, expect, it } from 'vitest'

import { EMPTY_SEARCH_STATE } from '@/features/search/lib/search-url'
import { searchFixtureAnswer } from './search-answer'

/** The preview's answer agrees with the chips over it: what is set is what the rows show. */
describe('searchFixtureAnswer', () => {
  it('filters the documents by what the reader set, and counts what is left', () => {
    const answer = searchFixtureAnswer({ ...EMPTY_SEARCH_STATE, view: 'register', filters: { documentTypes: ['submission_drawing'], currentOnly: true } })
    const hits = answer.sections.document?.hits ?? []
    expect(hits.map((hit) => hit.planNumber)).toEqual(['EP-03', 'EP-05'])
    expect(hits.every((hit) => hit.documentType === 'submission_drawing' && !hit.superseded)).toBe(true)
    expect(answer.sections.document?.total).toBe(2)
    expect(answer.facets?.documentType).toEqual([{ value: 'submission_drawing', label: null, count: 2 }])
    // The register is the documents alone.
    expect(answer.sections.annotation).toBeUndefined()
  })

  it('takes a Plannummer as a prefix, folded, and sorts blanks last', () => {
    const byPrefix = searchFixtureAnswer({ ...EMPTY_SEARCH_STATE, filters: { planNumber: 'ep03' } })
    expect(byPrefix.sections.document?.hits.map((hit) => hit.planIndex)).toEqual(['C', 'B'])
    const sorted = searchFixtureAnswer({ ...EMPTY_SEARCH_STATE, view: 'register', sort: 'plan_number', dir: 'desc' })
    const numbers = sorted.sections.document?.hits.map((hit) => hit.planNumber) ?? []
    expect(numbers.slice(0, 3)).toEqual(['EP-05', 'EP-03', 'EP-03'])
    expect(numbers.slice(3)).toEqual([null, null, null])
  })

  it('narrows every kind to the project chosen', () => {
    const answer = searchFixtureAnswer({ ...EMPTY_SEARCH_STATE, projectId: '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a02' })
    expect(answer.sections.document?.hits.map((hit) => hit.projectName)).toEqual(['Dachausbau Hernalser Hauptstraße 112'])
    expect(answer.sections.annotation?.hits).toEqual([])
  })
})
