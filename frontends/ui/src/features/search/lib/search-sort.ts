/**
 * The register's columns and the order each one asks of the search.
 *
 * A column header is a sort control only when the contract can order by it
 * (`SEARCH_SORTS`); Maßstab, Ordner and Status are shown, not ordered.
 */

import type { SearchSort } from '@/lib/search/search-wire'
import type { SearchUrlState, SortDirection } from './search-url'

/**
 * In reading order: the number and Index that name a drawing, then what it is
 * called (early, so a narrow screen still shows which document a row is),
 * then its date and scale, then the rest.
 */
export const REGISTER_COLUMNS = [
  'planNumber',
  'planIndex',
  'title',
  'planDate',
  'scale',
  'documentType',
  'project',
  'folder',
  'uploaded',
  'pages',
  'status',
] as const
export type RegisterColumn = (typeof REGISTER_COLUMNS)[number]

/** The sort a column header drives, or null for a column the search cannot order by. */
export const COLUMN_SORT: Readonly<Record<RegisterColumn, SearchSort | null>> = {
  planNumber: 'plan_number',
  planIndex: 'plan_index',
  planDate: 'plan_date',
  scale: null,
  title: 'name',
  documentType: 'document_type',
  project: 'project',
  folder: null,
  uploaded: 'added',
  pages: 'page_count',
  status: null,
}

/** Words read A to Z first; dates, counts and relevance newest or largest first. */
export function defaultDirection(sort: SearchSort): SortDirection {
  switch (sort) {
    case 'name':
    case 'plan_number':
    case 'plan_index':
    case 'document_type':
    case 'project':
      return 'asc'
    default:
      return 'desc'
  }
}

/** The order the result is in: what the URL names, else relevance with text and the newest upload without. */
export function effectiveSort(state: Pick<SearchUrlState, 'sort' | 'dir' | 'text'>): { sort: SearchSort; dir: SortDirection } {
  const hasText = state.text.trim() !== ''
  const sort = state.sort === null || (state.sort === 'relevance' && !hasText) ? (hasText ? 'relevance' : 'added') : state.sort
  return { sort, dir: state.dir ?? defaultDirection(sort) }
}

/** How a column header shows: the direction it orders in, or null when the result is not ordered by it. */
export function columnSortState(state: Pick<SearchUrlState, 'sort' | 'dir' | 'text'>, column: RegisterColumn): SortDirection | null {
  const sort = COLUMN_SORT[column]
  if (sort === null) return null
  const current = effectiveSort(state)
  return current.sort === sort ? current.dir : null
}

/**
 * The search after a click on a column header: the active column flips its
 * direction, another column takes over in its natural direction. A column
 * the search cannot order by changes nothing.
 */
export function sortByColumn<T extends Pick<SearchUrlState, 'sort' | 'dir' | 'text'>>(state: T, column: RegisterColumn): T {
  const sort = COLUMN_SORT[column]
  if (sort === null) return state
  const active = columnSortState(state, column)
  const dir: SortDirection = active === null ? defaultDirection(sort) : active === 'asc' ? 'desc' : 'asc'
  return { ...state, sort, dir }
}
