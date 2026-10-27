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
 */

import { withDocumentLocus } from '@/features/documents/lib/document-locus'
import { documentHref } from '@/features/uploads/lib/upload-summary'
import type { AnnotationHit, ConversationHit, DocumentHit, FolderHit, ProjectHit, SearchHit } from '@/lib/search/search-wire'

function shelfBase(shelf: 'project' | 'office_shelf', projectId: string | null): string {
  if (shelf === 'project' && projectId) return `/app/projects/${encodeURIComponent(projectId)}/files`
  return '/app/office-shelf'
}

export function documentHitHref(hit: Pick<DocumentHit, 'id' | 'shelf' | 'projectId'> & Partial<Pick<DocumentHit, 'passage'>>): string {
  const href = documentHref({ scope: hit.shelf, projectId: hit.projectId }, hit.id) ?? `/app/office-shelf?doc=${encodeURIComponent(hit.id)}`
  return hit.passage ? withDocumentLocus(href, { page: hit.passage.page, highlight: hit.passage.text }) : href
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
