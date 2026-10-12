/**
 * Which read the Files workspace makes (ADR-0102): a folder level page by page
 * unless something only the whole shelf in the browser can answer is asked.
 */

import { describe, expect, it } from 'vitest'
import { NO_FILE_FILTERS, type FileFilters } from './file-filters'
import { DEFAULT_FILE_SORT, type FileSortKey } from './file-sort'
import { filtersNeedWholeShelf, levelSortOf, readFamiliesOf, readsWholeShelf } from './level-view'

describe('levelSortOf', () => {
  const ORDERS: Array<[FileSortKey, string | null]> = [
    ['added', 'added'],
    ['name', 'name'],
    ['size', 'size'],
    ['status', null],
    ['relevance', null],
  ]
  it.each(ORDERS)('orders %s on the server as %s', (key, expected) => {
    expect(levelSortOf({ key, direction: 'asc' })).toBe(expected)
  })
})

describe('readFamiliesOf', () => {
  it('asks the server for the read-state family each status group is a view of', () => {
    expect(readFamiliesOf(['ready', 'processing', 'failed'])).toEqual(['readable', 'reading', 'failed'])
    expect(readFamiliesOf([])).toEqual([])
  })
})

describe('readsWholeShelf', () => {
  it('reads a level by default, and with the filters the server answers', () => {
    expect(readsWholeShelf(NO_FILE_FILTERS, DEFAULT_FILE_SORT, true)).toBe(false)
    const serverAnswered: FileFilters = {
      ...NO_FILE_FILTERS,
      agentAuthoredOnly: true,
      includeArchived: true,
      showOlderFassungen: true,
      statuses: ['failed'],
    }
    expect(readsWholeShelf(serverAnswered, { key: 'name', direction: 'asc' }, true)).toBe(false)
  })

  it('drains the shelf for the status order, which only the browser can sort by', () => {
    expect(readsWholeShelf(NO_FILE_FILTERS, { key: 'status', direction: 'asc' }, false)).toBe(true)
  })

  const WHOLE_SHELF_FILTERS: Array<[string, Partial<FileFilters>]> = [
    ['a kind', { kinds: ['photo'] }],
    ['a tag', { tags: ['brandschutz'] }],
    ['Freigabe ausstehend', { reviewPendingOnly: true }],
    ['an assignment', { assignment: 'mine' }],
  ]
  it.each(WHOLE_SHELF_FILTERS)('drains the shelf for %s', (_label, filter) => {
    expect(filtersNeedWholeShelf({ ...NO_FILE_FILTERS, ...filter }, true)).toBe(true)
  })

  it('ignores an assignment filter the reader is not offered', () => {
    expect(filtersNeedWholeShelf({ ...NO_FILE_FILTERS, assignment: 'mine' }, false)).toBe(false)
  })
})
