import { describe, expect, it } from 'vitest'

import { SEARCH_SORTS } from '@/lib/search/search-wire'
import { COLUMN_SORT, columnSortState, effectiveSort, REGISTER_COLUMNS, sortByColumn } from './search-sort'
import { EMPTY_SEARCH_STATE } from './search-url'

const base = { ...EMPTY_SEARCH_STATE, view: 'register' as const }

describe('the register’s headers and the search’s order', () => {
  it('maps only onto orders the contract has', () => {
    for (const column of REGISTER_COLUMNS) {
      const sort = COLUMN_SORT[column]
      if (sort !== null) expect(SEARCH_SORTS).toContain(sort)
    }
    expect(COLUMN_SORT.scale).toBeNull()
    expect(COLUMN_SORT.folder).toBeNull()
    expect(COLUMN_SORT.status).toBeNull()
  })

  it('orders by relevance with words and by the newest upload without', () => {
    expect(effectiveSort(base)).toEqual({ sort: 'added', dir: 'desc' })
    expect(effectiveSort({ ...base, text: 'Statik' })).toEqual({ sort: 'relevance', dir: 'desc' })
    expect(effectiveSort({ ...base, sort: 'relevance' })).toEqual({ sort: 'added', dir: 'desc' })
    expect(columnSortState(base, 'uploaded')).toBe('desc')
  })

  it('takes a new column in its natural direction', () => {
    expect(sortByColumn(base, 'planNumber')).toMatchObject({ sort: 'plan_number', dir: 'asc' })
    expect(sortByColumn(base, 'planDate')).toMatchObject({ sort: 'plan_date', dir: 'desc' })
    expect(sortByColumn(base, 'pages')).toMatchObject({ sort: 'page_count', dir: 'desc' })
  })

  it('flips the active column, and shows which way it orders', () => {
    const once = sortByColumn(base, 'planNumber')
    expect(columnSortState(once, 'planNumber')).toBe('asc')
    expect(columnSortState(once, 'title')).toBeNull()
    const twice = sortByColumn(once, 'planNumber')
    expect(twice).toMatchObject({ sort: 'plan_number', dir: 'desc' })
    expect(sortByColumn(twice, 'planNumber')).toMatchObject({ dir: 'asc' })
  })

  it('leaves the search alone for a column it cannot order by', () => {
    const state = { ...base, sort: 'name' as const, dir: 'asc' as const }
    expect(sortByColumn(state, 'scale')).toBe(state)
    expect(columnSortState(state, 'status')).toBeNull()
  })
})
