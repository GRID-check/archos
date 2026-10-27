/**
 * Where each hit opens: the place the workspace already shows it, never a page
 * of the search's own. A document opens in its shelf's preview (`?doc=`), an
 * annotation in the document's review at the mark, a folder as the open level
 * of its shelf, a conversation in its thread.
 *
 * The passage's page is not in the link: the Dateien preview reads `doc`,
 * `review` and `mark` and has no page parameter yet.
 */

import { documentHref } from '@/features/uploads/lib/upload-summary'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import type { AnnotationHit, ConversationHit, DocumentHit, FolderHit, ProjectHit, SearchHit } from '@/lib/search/search-wire'
import { SHELF_SEARCH_MODE, SHELF_SEARCH_MODE_PARAM } from '../hooks/use-shelf-search-mode'
import { EMPTY_SEARCH_STATE, fromSearchBody, writeSearchParams } from './search-url'

function shelfBase(shelf: 'project' | 'office_shelf', projectId: string | null): string {
  if (shelf === 'project' && projectId) return `/app/projects/${encodeURIComponent(projectId)}/files`
  return '/app/office-shelf'
}

export function documentHitHref(hit: Pick<DocumentHit, 'id' | 'shelf' | 'projectId'>): string {
  return documentHref({ scope: hit.shelf, projectId: hit.projectId }, hit.id) ?? `/app/office-shelf?doc=${encodeURIComponent(hit.id)}`
}

export function annotationHitHref(hit: Pick<AnnotationHit, 'id' | 'documentId' | 'projectId'>): string {
  const base = shelfBase(hit.projectId ? 'project' : 'office_shelf', hit.projectId)
  return `${base}?doc=${encodeURIComponent(hit.documentId)}&review=1&mark=${encodeURIComponent(hit.id)}`
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

/** Where a saved search runs: the office shelf's own search for a question asked there, else the search page. */
export function savedSearchHref(item: Pick<SavedSearchView, 'scope' | 'query'>): string {
  if (item.scope.scope === 'office_shelf') {
    const params = writeSearchParams(fromSearchBody(item.query))
    params.set(SHELF_SEARCH_MODE_PARAM, SHELF_SEARCH_MODE)
    return `/app/office-shelf?${params.toString()}`
  }
  const projectId = item.scope.scope === 'project' ? (item.scope.projectId ?? null) : null
  const query = writeSearchParams(fromSearchBody(item.query, projectId)).toString()
  return query ? `/app/search?${query}` : '/app/search'
}

export function hitHref(hit: SearchHit): string {
  switch (hit.kind) {
    case 'document':
      return documentHitHref(hit)
    case 'annotation':
      return annotationHitHref(hit)
    case 'folder':
      return folderHitHref(hit)
    case 'project':
      return projectHitHref(hit)
    case 'conversation':
      return conversationHitHref(hit)
  }
}
