import { describe, expect, it } from 'vitest'

import { SEARCH_SORTS, type SearchSort } from '@/lib/search/search-wire'
import {
  COLUMN_SORT,
  columnSortState,
  DEFAULT_REGISTER_COLUMNS,
  effectiveSort,
  REGISTER_COLUMNS,
  sortByColumn,
  toggleRegisterColumn,
  visibleRegisterColumns,
  type RegisterColumn,
} from './search-sort'
import { EMPTY_SEARCH_STATE } from './search-url'

const register = { ...EMPTY_SEARCH_STATE, view: 'register' as const }
const list = EMPTY_SEARCH_STATE

describe('the register’s headers and the search’s order', () => {
  it('makes every column a sort control, each onto an order the contract has', () => {
    const expected: Record<RegisterColumn, SearchSort> = {
      planNumber: 'plan_number',
      planIndex: 'plan_index',
      title: 'name',
      planDate: 'plan_date',
      scale: 'scale',
      documentType: 'document_type',
      author: 'author',
      project: 'project',
      folder: 'folder',
      uploaded: 'added',
      pages: 'page_count',
      status: 'status',
    }
    expect(COLUMN_SORT).toEqual(expected)
    for (const column of REGISTER_COLUMNS) expect(SEARCH_SORTS).toContain(COLUMN_SORT[column])
  })

  it('takes each column in its natural direction: words A to Z, dates and counts largest first', () => {
    const natural: Record<RegisterColumn, 'asc' | 'desc'> = {
      planNumber: 'asc',
      planIndex: 'asc',
      title: 'asc',
      planDate: 'desc',
      scale: 'asc',
      documentType: 'asc',
      author: 'asc',
      project: 'asc',
      folder: 'asc',
      uploaded: 'desc',
      pages: 'desc',
      status: 'asc',
    }
    // Ordered by relevance, so no column is active yet.
    const byRelevance = { ...register, text: 'Fluchtweg' }
    for (const column of REGISTER_COLUMNS) {
      const sorted = sortByColumn(byRelevance, column)
      expect(sorted, column).toMatchObject({ sort: COLUMN_SORT[column], dir: natural[column] })
      expect(columnSortState(sorted, column), column).toBe(natural[column])
    }
  })

  it('reads the register by Plannummer, A to Z, until a column is chosen; the list by the newest upload', () => {
    expect(effectiveSort(register)).toEqual({ sort: 'plan_number', dir: 'asc' })
    expect(columnSortState(register, 'planNumber')).toBe('asc')
    expect(effectiveSort(list)).toEqual({ sort: 'added', dir: 'desc' })
    expect(effectiveSort({ ...register, text: 'Statik' })).toEqual({ sort: 'relevance', dir: 'desc' })
    expect(effectiveSort({ ...list, sort: 'relevance' })).toEqual({ sort: 'added', dir: 'desc' })
  })

  it('flips the active column, and shows which way it orders', () => {
    const once = sortByColumn(list, 'planNumber')
    expect(columnSortState(once, 'planNumber')).toBe('asc')
    expect(columnSortState(once, 'title')).toBeNull()
    const twice = sortByColumn(once, 'planNumber')
    expect(twice).toMatchObject({ sort: 'plan_number', dir: 'desc' })
    expect(sortByColumn(twice, 'planNumber')).toMatchObject({ dir: 'asc' })
    // The register already reads by Plannummer: the first click turns it round.
    expect(sortByColumn(register, 'planNumber')).toMatchObject({ sort: 'plan_number', dir: 'desc' })
  })
})

describe('which columns the register shows', () => {
  it('shows the Jour fixe’s columns by default, Ordner, Hochgeladen and Seiten on request', () => {
    expect(visibleRegisterColumns(null)).toEqual([...DEFAULT_REGISTER_COLUMNS])
    expect(DEFAULT_REGISTER_COLUMNS).not.toContain('folder')
    expect(DEFAULT_REGISTER_COLUMNS).not.toContain('uploaded')
    expect(DEFAULT_REGISTER_COLUMNS).not.toContain('pages')
  })

  it('leaves the Projekt column out in one project', () => {
    expect(visibleRegisterColumns(null, { hideProject: true })).not.toContain('project')
  })

  it('switches a column on in its place and off again, back to the default', () => {
    const withFolder = toggleRegisterColumn(null, 'folder')
    expect(withFolder).toEqual(['planNumber', 'planIndex', 'title', 'planDate', 'scale', 'documentType', 'author', 'project', 'folder'])
    expect(toggleRegisterColumn(withFolder, 'folder')).toBeNull()
  })

  it('never hides the title', () => {
    expect(toggleRegisterColumn(null, 'title')).toBeNull()
    expect(visibleRegisterColumns(['planNumber'])).toEqual(['planNumber', 'title'])
  })
})
