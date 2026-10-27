import { describe, expect, it, vi } from 'vitest'
import type { DocumentFilters } from './search-wire'

vi.mock('server-only', () => ({}))
vi.mock('./document-search', () => ({ narrowedTo: vi.fn(), structuredQuery: vi.fn() }))
vi.mock('./reach', () => ({ reachFor: vi.fn(), resolveScope: vi.fn() }))
vi.mock('./suggest-repository', () => ({ suggestValues: vi.fn() }))

const { filtersBeside } = await import('./suggest')

const ALL: DocumentFilters = {
  documentTypes: ['submission_drawing'],
  parties: [{ name: 'Atelier' }],
  place: 'Wien',
  municipalities: ['Wien'],
  cites: ['norm:önorm b 1600'],
  scale: ['1:100'],
  planNumber: 'EP',
  planIndex: ['C'],
  facts: [
    { key: 'building_class', equals: '4' },
    { key: 'use', equals: 'Wohnen' },
  ],
  currentOnly: true,
}

describe('filtersBeside', () => {
  it('leaves out the dimension’s own filter and keeps every other, so the alternatives to a chosen value show', () => {
    const { parties: _parties, ...withoutParties } = ALL
    expect(filtersBeside(ALL, 'party')).toEqual(withoutParties)
    const { place: _place, municipalities: _municipalities, ...withoutPlace } = ALL
    expect(filtersBeside(ALL, 'place')).toEqual(withoutPlace)
    expect(filtersBeside(ALL, 'cites').cites).toBeUndefined()
    expect(filtersBeside(ALL, 'scale').scale).toBeUndefined()
    expect(filtersBeside(ALL, 'planNumber').planNumber).toBeUndefined()
    expect(filtersBeside(ALL, 'planIndex').planIndex).toBeUndefined()
    expect(filtersBeside(ALL, 'planIndex').planNumber).toBe('EP')
  })

  it('leaves out only the fact being completed', () => {
    expect(filtersBeside(ALL, 'fact', 'building_class').facts).toEqual([{ key: 'use', equals: 'Wohnen' }])
    expect(filtersBeside({ facts: [{ key: 'use', equals: 'Wohnen' }] }, 'fact', 'use').facts).toBeUndefined()
    expect(filtersBeside(ALL, 'party').facts).toHaveLength(2)
  })
})
