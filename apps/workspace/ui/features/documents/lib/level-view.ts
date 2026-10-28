/**
 * Which view of a shelf the Files workspace reads (ADR-0102), as pure rules.
 *
 * The default is a folder LEVEL read page by page from the server: the order,
 * the name search, the status filter and the two server filters are request
 * parameters. What the server cannot answer still needs the whole shelf in the
 * browser (the drain, `useFileListing`): the filters that read what the
 * backend put on a document (kind, tags), its assignees or its version state,
 * and the status order. Those, and nothing else, turn the drain on.
 *
 * Pure and outside the component for the reason `file-filters.ts` is.
 */

import type { DocumentReadFamily } from '@/lib/documents/document-status'
import type { DocumentLevelSort } from '@/lib/documents/list-cursor'
import type { FileFilters, FileStatusGroup } from './file-filters'
import type { FileSort } from './file-sort'

/** How long the name search waits for the reader to stop typing before it asks the server. */
export const LEVEL_SEARCH_DEBOUNCE_MS = 250

/** The server's order for a column, or `null` for one only the browser can sort by. */
export function levelSortOf(sort: FileSort): DocumentLevelSort | null {
  switch (sort.key) {
    case 'added':
    case 'name':
    case 'size':
      return sort.key
    case 'status':
    case 'relevance':
      return null
  }
}

/** A status group is a view of one read-state family (`statusGroupOf`), so the server filters by the family. */
const FAMILY_OF_GROUP: Record<FileStatusGroup, DocumentReadFamily> = {
  ready: 'readable',
  processing: 'reading',
  failed: 'failed',
}

export function readFamiliesOf(groups: readonly FileStatusGroup[]): DocumentReadFamily[] {
  return groups.map((group) => FAMILY_OF_GROUP[group])
}

/**
 * Whether a filter is on that only the whole shelf in the browser can answer:
 * assignment (another table), „Freigabe ausstehend“ (the version state), the
 * kind and the tags (what the backend read off the document).
 */
export function filtersNeedWholeShelf(filters: FileFilters, canCollaborate: boolean): boolean {
  return (
    (canCollaborate && filters.assignment !== 'all') ||
    filters.reviewPendingOnly ||
    filters.kinds.length > 0 ||
    filters.tags.length > 0
  )
}

/** Whether the workspace reads the whole shelf instead of a level page by page. */
export function readsWholeShelf(filters: FileFilters, sort: FileSort, canCollaborate: boolean): boolean {
  return levelSortOf(sort) === null || filtersNeedWholeShelf(filters, canCollaborate)
}
