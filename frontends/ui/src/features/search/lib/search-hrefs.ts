/**
 * Where each hit opens: the place the workspace already shows it, never a page
 * of the search's own. A document opens in its shelf's preview (`?doc=`), an
 * annotation in the document's review at the mark, a folder as the open level
 * of its shelf, a conversation in its thread.
 *
 * A document hit with a passage opens AT it: `page` and `highlight` on the
 * preview's link (`features/documents/lib/document-locus.ts`), the page and
 * passage a citation hands the same viewer, so the matched passage is lit up
 * on the page it came from.
 *
 * ## Back to the search
 *
 * A document or annotation hit opens in the shelf, often on another page, and
 * the search would be lost behind it. Such a link carries `back`, the search
 * as the reader left it (`features/documents/lib/open-review.ts`, the
 * mechanism Offene Punkte and the Postfach use): closing the preview or the
 * review returns there. A folder, a project or a conversation has nothing to
 * close; Back walks to the search, whose URL holds all of it.
 */

import { withDocumentLocus } from '@/features/documents/lib/document-locus'
import { BACK_PARAM, reviewFilesHref, withBack, withReviewBack } from '@/features/documents/lib/open-review'
import { documentHref } from '@/features/uploads/lib/upload-summary'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import type {
  AnnotationHit,
  ConversationHit,
  DocumentHit,
  FolderHit,
  ProjectHit,
  SearchBody,
  SearchHit,
  SearchScopeQuery,
} from '@/lib/search/search-wire'
import { SHELF_SEARCH_MODE, SHELF_SEARCH_MODE_PARAM } from '../hooks/use-shelf-search-mode'
import { EMPTY_SEARCH_STATE, fromSearchBody, writeSearchParams } from './search-url'

function shelfBase(shelf: 'project' | 'office_shelf', projectId: string | null): string {
  if (shelf === 'project' && projectId) return `/app/projects/${encodeURIComponent(projectId)}/files`
  return '/app/office-shelf'
}

/** Where a hit returns to on closing: the search page as the reader left it, or nowhere. */
export interface HitReturn {
  back?: string | null
}

/**
 * A document hit's open points: its Prüfansicht (`review=1`), which lists the
 * document's open marks, on the shelf the hit opens on; closing the review
 * returns to `back`, the search as the reader left it.
 */
export function documentReviewHitHref(hit: Pick<DocumentHit, 'id' | 'shelf' | 'projectId'>, { back }: HitReturn = {}): string {
  const target = { documentId: hit.id }
  if (hit.shelf === 'project' && hit.projectId) return reviewFilesHref(hit.projectId, target, { back })
  return withReviewBack(`${shelfBase('office_shelf', null)}?doc=${encodeURIComponent(hit.id)}&review=1`, back)
}

/**
 * The search page's own address, to return to: path and query, without a
 * `back` it may itself have been handed (a return is one step, not a chain).
 */
export function searchReturnPath(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete(BACK_PARAM)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function documentHitHref(
  hit: Pick<DocumentHit, 'id' | 'shelf' | 'projectId'> & Partial<Pick<DocumentHit, 'passage'>>,
  { back }: HitReturn = {}
): string {
  const href = documentHref({ scope: hit.shelf, projectId: hit.projectId }, hit.id) ?? `/app/office-shelf?doc=${encodeURIComponent(hit.id)}`
  const at = hit.passage ? withDocumentLocus(href, { page: hit.passage.page, highlight: hit.passage.text }) : href
  return withBack(at, back)
}

export function annotationHitHref(hit: Pick<AnnotationHit, 'id' | 'documentId' | 'projectId'>, { back }: HitReturn = {}): string {
  const target = { documentId: hit.documentId, annotationId: hit.id }
  if (hit.projectId) return reviewFilesHref(hit.projectId, target, { back })
  const href = `${shelfBase('office_shelf', null)}?doc=${encodeURIComponent(hit.documentId)}&review=1&mark=${encodeURIComponent(hit.id)}`
  return withReviewBack(href, back)
}

export function folderHitHref(hit: Pick<FolderHit, 'id' | 'shelf' | 'projectId'>): string {
  return `${shelfBase(hit.shelf, hit.projectId)}?folder=${encodeURIComponent(hit.id)}`
}

export function projectHitHref(hit: Pick<ProjectHit, 'id'>): string {
  return `/app/projects/${encodeURIComponent(hit.id)}`
}

export function conversationHitHref(hit: Pick<ConversationHit, 'id' | 'projectId'>): string {
  const session = `?session=${encodeURIComponent(hit.id)}`
  return hit.projectId ? `/app/projects/${encodeURIComponent(hit.projectId)}/chat${session}` : `/app/chat${session}`
}

/** The workspace search page asking `text`, narrowed to one project when the question was asked in one. */
export function searchPageHref(text: string, projectId: string | null = null): string {
  const query = writeSearchParams({ ...EMPTY_SEARCH_STATE, text, projectId }).toString()
  return query ? `/app/search?${query}` : '/app/search'
}

/**
 * Where a question asked of `workspace-search` runs for a person: the office
 * shelf's own search for one asked there, else the search page, narrowed to the
 * project it was asked in.
 */
export function searchHref(scope: SearchScopeQuery, body: SearchBody): string {
  if (scope.scope === 'office_shelf') {
    const params = writeSearchParams(fromSearchBody(body))
    params.set(SHELF_SEARCH_MODE_PARAM, SHELF_SEARCH_MODE)
    return `/app/office-shelf?${params.toString()}`
  }
  const projectId = scope.scope === 'project' ? (scope.projectId ?? null) : null
  const query = writeSearchParams(fromSearchBody(body, projectId)).toString()
  return query ? `/app/search?${query}` : '/app/search'
}

/** Where a saved search runs (see {@link searchHref}). */
export function savedSearchHref(item: Pick<SavedSearchView, 'scope' | 'query'>): string {
  return searchHref(item.scope, item.query)
}

export function hitHref(hit: SearchHit, from: HitReturn = {}): string {
  switch (hit.kind) {
    case 'document':
      return documentHitHref(hit, from)
    case 'annotation':
      return annotationHitHref(hit, from)
    case 'folder':
      return folderHitHref(hit)
    case 'project':
      return projectHitHref(hit)
    case 'conversation':
      return conversationHitHref(hit)
  }
}
