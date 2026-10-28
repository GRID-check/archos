/**
 * Which of a register row's cells say nothing, and how far its name may run
 * on into them.
 *
 * A document without a plan head (a Brandschutzkonzept, a Gutachten) has no
 * Plannummer, Index, Planstand or Maßstab, and its name, the longest thing in
 * the row, was cut at its column beside empty cells. A spreadsheet lets text
 * run on into the empty cells to its right; the register does the same, so the
 * columns keep their widths and their alignment for the rows that fill them,
 * and the row that does not gets its name back.
 */

import { documentReadFamily } from '@/lib/documents/document-status'
import type { DocumentHit } from '@/lib/search/search-wire'
import type { RegisterColumn } from './search-sort'

/** Whether `column` shows nothing for `hit`, by the same fields its cell draws. */
export function registerCellEmpty(column: RegisterColumn, hit: DocumentHit): boolean {
  switch (column) {
    case 'planNumber':
      return !hit.planNumber
    case 'planIndex':
      return !hit.planIndex
    case 'title':
      return false
    case 'planDate':
      return !hit.planDate
    case 'scale':
      return !hit.scale
    case 'documentType':
      return !hit.documentType
    case 'author':
      return !hit.author
    case 'project':
      return hit.shelf !== 'office_shelf' && !hit.projectName
    case 'folder':
      return !hit.folderName
    case 'uploaded':
      return !hit.uploadedAt
    case 'pages':
      return hit.pageCount === null
    case 'status':
      // The column shows only the exceptions: a read document says nothing.
      return documentReadFamily(hit.status) === 'readable'
  }
}

/**
 * How many columns the name's cell covers: its own, and every empty cell
 * right after it, up to the first that says something.
 */
export function titleSpan(columns: readonly RegisterColumn[], hit: DocumentHit): number {
  const at = columns.indexOf('title')
  if (at === -1) return 1
  let span = 1
  while (at + span < columns.length && registerCellEmpty(columns[at + span]!, hit)) span += 1
  return span
}
