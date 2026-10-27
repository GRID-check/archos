/**
 * The register's columns, which of them show, and the order each one asks of
 * the search.
 *
 * Every column is a sort control: the contract orders by each (`SEARCH_SORTS`),
 * and the repository puts the documents without a value last in both
 * directions (`NULLS LAST`), so a Planliste by Plannummer starts at EP-01 and
 * ends with what carries no number. Nothing here reorders a page.
 */

import type { SearchSort } from '@/lib/search/search-wire'
import type { SearchUrlState, SortDirection } from './search-url'

/**
 * In reading order: the number and Index that name a drawing, then what it is
 * called (early, so a narrow screen still shows which document a row is),
 * then its date and scale, what it is and who drew it, then the rest.
 */
export const REGISTER_COLUMNS = [
  'planNumber',
  'planIndex',
  'title',
  'planDate',
  'scale',
  'documentType',
  'author',
  'project',
  'folder',
  'uploaded',
  'pages',
  'status',
] as const
export type RegisterColumn = (typeof REGISTER_COLUMNS)[number]

/**
 * The columns a register shows until the reader picks others: the ones the Jour
 * fixe reads (Plannummer, Index, Planstand, Maßstab, Verfasser, Dokumentart).
 * Ordner, Hochgeladen, Seiten and Status are a choice in the column menu:
 * Status shows only the exceptions, and „Ersetzt“ already sits on the name.
 */
export const DEFAULT_REGISTER_COLUMNS: readonly RegisterColumn[] = [
  'planNumber',
  'planIndex',
  'title',
  'planDate',
  'scale',
  'documentType',
  'author',
  'project',
]

/** The column that names a row: it is always shown, so a row is never anonymous. */
export const FIXED_REGISTER_COLUMN: RegisterColumn = 'title'

/** The sort each column header drives. */
export const COLUMN_SORT: Readonly<Record<RegisterColumn, SearchSort>> = {
  planNumber: 'plan_number',
  planIndex: 'plan_index',
  planDate: 'plan_date',
  scale: 'scale',
  title: 'name',
  documentType: 'document_type',
  author: 'author',
  project: 'project',
  folder: 'folder',
  uploaded: 'added',
  pages: 'page_count',
  status: 'status',
}

/**
 * The columns a register shows: the reader's choice in the register's order,
 * the title always, the project only where the search spans projects.
 */
export function visibleRegisterColumns(columns: readonly RegisterColumn[] | null, options: { hideProject?: boolean } = {}): RegisterColumn[] {
  const chosen = new Set<RegisterColumn>(columns ?? DEFAULT_REGISTER_COLUMNS)
  chosen.add(FIXED_REGISTER_COLUMN)
  return REGISTER_COLUMNS.filter((column) => chosen.has(column) && !(options.hideProject && column === 'project'))
}

/**
 * The column choice after the reader switches one on or off, in the register's
 * order. Back at the default it is null, so the URL carries nothing.
 */
export function toggleRegisterColumn(columns: readonly RegisterColumn[] | null, column: RegisterColumn): RegisterColumn[] | null {
  if (column === FIXED_REGISTER_COLUMN) return columns === null ? null : [...columns]
  const chosen = new Set<RegisterColumn>(columns ?? DEFAULT_REGISTER_COLUMNS)
  if (chosen.has(column)) chosen.delete(column)
  else chosen.add(column)
  chosen.add(FIXED_REGISTER_COLUMN)
  return normalizeRegisterColumns(REGISTER_COLUMNS.filter((entry) => chosen.has(entry)))
}

/** A choice in the register's order, or null when it is the default. */
export function normalizeRegisterColumns(columns: readonly RegisterColumn[] | null): RegisterColumn[] | null {
  if (columns === null) return null
  const chosen = new Set<RegisterColumn>(columns)
  chosen.add(FIXED_REGISTER_COLUMN)
  const ordered = REGISTER_COLUMNS.filter((column) => chosen.has(column))
  const isDefault = ordered.length === DEFAULT_REGISTER_COLUMNS.length && DEFAULT_REGISTER_COLUMNS.every((column) => chosen.has(column))
  return isDefault ? null : ordered
}

/** Words read A to Z first; dates, counts and relevance newest or largest first. */
export function defaultDirection(sort: SearchSort): SortDirection {
  switch (sort) {
    case 'name':
    case 'plan_number':
    case 'plan_index':
    case 'document_type':
    case 'project':
    case 'scale':
    case 'folder':
    case 'status':
    case 'author':
      return 'asc'
    default:
      return 'desc'
  }
}

/**
 * The order the result is in: what the URL names, else relevance with text;
 * without text the list shows the newest upload first and the register reads
 * by Plannummer, as a Planliste does.
 */
export function effectiveSort(state: Pick<SearchUrlState, 'sort' | 'dir' | 'text' | 'view'>): { sort: SearchSort; dir: SortDirection } {
  const hasText = state.text.trim() !== ''
  const fallback: SearchSort = hasText ? 'relevance' : state.view === 'register' ? 'plan_number' : 'added'
  const sort = state.sort === null || (state.sort === 'relevance' && !hasText) ? fallback : state.sort
  return { sort, dir: state.dir ?? defaultDirection(sort) }
}

type SortState = Pick<SearchUrlState, 'sort' | 'dir' | 'text' | 'view'>

/** How a column header shows: the direction it orders in, or null when the result is not ordered by it. */
export function columnSortState(state: SortState, column: RegisterColumn): SortDirection | null {
  const current = effectiveSort(state)
  return current.sort === COLUMN_SORT[column] ? current.dir : null
}

/**
 * The search after a click on a column header: the active column flips its
 * direction, another column takes over in its natural direction.
 */
export function sortByColumn<T extends SortState>(state: T, column: RegisterColumn): T {
  const sort = COLUMN_SORT[column]
  const active = columnSortState(state, column)
  const dir: SortDirection = active === null ? defaultDirection(sort) : active === 'asc' ? 'desc' : 'asc'
  return { ...state, sort, dir }
}
