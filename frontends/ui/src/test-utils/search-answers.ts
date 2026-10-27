/**
 * A shelf's search answer as `POST /api/search` gives it (ADR-0136), built from
 * the file browser's own rows, for the Files pane's specs and `/dev` previews.
 */

import type { FileItem } from '@/features/documents/file-types'
import type { DocumentHit, SearchResponse, SearchScope } from '@/lib/search/search-wire'

/** `file` as a document result, with the passage that matched (none: found by its name). */
export function fileSearchHit(file: FileItem, passage: { text: string; page: number | null } | null = null): DocumentHit {
  return {
    kind: 'document',
    id: file.id,
    name: file.displayName ?? file.filename,
    filename: file.filename,
    shelf: 'project',
    projectId: null,
    projectName: null,
    folderId: file.folderId,
    folderName: null,
    status: file.status ?? 'completed',
    contentType: file.contentType,
    uploadedAt: file.createdAt,
    uploadedBy: null,
    documentType: null,
    title: null,
    planNumber: null,
    planIndex: null,
    planDate: null,
    scale: null,
    documentDate: null,
    pageCount: file.pageCount,
    pagesNotRead: null,
    superseded: false,
    changedFacts: [],
    municipality: null,
    author: null,
    matchedOn: passage ? ['content'] : ['name'],
    passage,
  }
}

/** A documents-only answer holding `hits` in their ranked order. */
export function documentSearchAnswer(hits: DocumentHit[], scope: SearchScope = { kind: 'office_shelf' }): SearchResponse {
  return {
    scope,
    sections: { document: { hits, total: hits.length, totalIsLowerBound: false, nextCursor: null } },
    facets: null,
    unread: null,
    building: [],
    contentPartial: false,
  }
}
