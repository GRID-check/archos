/**
 * The lazy resolution index behind every citation chip: the cited name's
 * project and Archiv rows, this conversation's attachments and the base-corpus
 * file list, cached per project+conversation for the page's lifetime.
 */

import { onDocumentsChanged } from '@/lib/documents/document-changes'
import {
  resetDocumentsByNameCache,
  resolveDocumentsByName,
} from '@/features/documents/lib/documents-by-name'
import type { RevisionRef } from '@/lib/documents/revision-links'
import type { StoredDocumentRef } from '../../lib/citations'
import type { Shelf } from '../../lib/source-kinds'

// ---------------------------------------------------------------------------
// Lazy resolution index (project documents + base-corpus files)
// ---------------------------------------------------------------------------

export interface SourcePreviewIndex {
  /**
   * The DB-backed documents the user can open that the citation could mean:
   * this project's uploads with the cited name FIRST, then this conversation's
   * private attachments, then the organization's Archiv rows with the name. Each row carries the shelf it came from, so a citation that names
   * its own shelf resolves to the right copy of a filename held on several;
   * order is only the tie-break for one that names no shelf at all.
   */
  storedDocuments: StoredDocumentRef[]
  baseCorpusFiles: string[]
}

/** What does not depend on the cited name: attachments and the base corpus. */
interface ShelfLists {
  sessionDocuments: StoredDocumentRef[]
  baseCorpusFiles: string[]
}

/** Module-wide cache: one fetch set per project+conversation per page lifetime. */
const indexCache = new Map<string, Promise<ShelfLists>>()

/** Test hook — clears the module caches between specs. */
export const resetSourcePreviewIndexCache = (): void => {
  indexCache.clear()
  resetDocumentsByNameCache()
}

// A document uploaded DURING the conversation is one the answer can cite and
// this index has never seen. Without this the chip offered no way in and no
// reason until a reload — the #623 complaint, on the path its fix did not
// reach.
onDocumentsChanged(resetSourcePreviewIndexCache)

// The shelf is stated by the LIST the rows came from — the project document
// route or the org Archiv route — not guessed from a collection id.
interface ListedRow {
  id: string
  filename: string
  contentType?: string | null
  revision?: { supersededBy?: RevisionRef | null } | null
}

const toRefs = (rows: unknown, shelf: Shelf): StoredDocumentRef[] =>
  Array.isArray(rows)
    ? rows
        .filter(
          (doc): doc is ListedRow =>
            !!doc && typeof doc.id === 'string' && typeof doc.filename === 'string'
        )
        .map((doc) => ({
          id: doc.id,
          filename: doc.filename,
          contentType: doc.contentType ?? null,
          shelf,
          // Only what the server resolved for THIS reader: a newer Fassung they
          // may not open is not in the row, name and all.
          supersededBy: doc.revision?.supersededBy ?? null,
        }))
    : []

/**
 * The resolution index for one cited name: its project and Archiv rows asked
 * of the server by name, between them the conversation's attachments, and the
 * base corpus.
 */
export const loadSourcePreviewIndex = async (
  projectId: string | null,
  conversationId: string | null,
  fileName: string | null
): Promise<SourcePreviewIndex> => {
  const [lists, named] = await Promise.all([
    loadShelfLists(projectId, conversationId),
    fileName ? resolveDocumentsByName(projectId, [fileName]) : Promise.resolve(null),
  ])
  const answers = named ? [...named.values()] : []
  // Tagged with the shelf each row came from, so a citation that names its own
  // shelf resolves to the right copy of a filename held on several. Project
  // uploads still come first, as the tie-break for a citation that does not.
  // All three shelves that CAN be `documents` rows are represented here; the
  // fourth (`base`) is the corpus and has no row to list.
  return {
    storedDocuments: [
      ...toRefs(answers.flatMap((answer) => answer.project), 'project'),
      ...lists.sessionDocuments,
      ...toRefs(answers.flatMap((answer) => answer.officeShelf), 'office_shelf'),
    ],
    baseCorpusFiles: lists.baseCorpusFiles,
  }
}

const loadShelfLists = (
  projectId: string | null,
  conversationId: string | null
): Promise<ShelfLists> => {
  // The conversation is part of the key, not just of the fetch: two chats in one
  // project have different private attachments, and a single cached list would
  // hand one thread the other's files.
  const key = `${projectId ?? '__no-project__'}|${conversationId ?? '__no-conversation__'}`
  const existing = indexCache.get(key)
  if (existing) return existing

  const promise = (async (): Promise<ShelfLists> => {
    const [sessionResult, corpusResult] = await Promise.allSettled([
      // This conversation's private attachments (ADR-0047 Phase 2). Without
      // them the `session` shelf had NO rows at all, so a session citation
      // matched nothing — and, before the shelf became part of a document's
      // identity, quietly opened the project's unrelated file of the same name.
      conversationId
        ? fetch(`/api/session/documents?conversationId=${encodeURIComponent(conversationId)}`).then(
            (r) => (r.ok ? r.json() : null)
          )
        : Promise.resolve(null),
      fetch('/api/knowledge-base').then((r) => (r.ok ? r.json() : null)),
    ])
    const sessionDocs = sessionResult.status === 'fulfilled' ? sessionResult.value?.documents : null
    const files = corpusResult.status === 'fulfilled' ? corpusResult.value?.files : null

    // Only corpus files whose PDF actually exists on this deployment are
    // openable (index-only entries and removed files would 404 the viewer).
    const baseCorpusFiles: string[] = Array.isArray(files)
      ? files
          .filter(
            (file): file is { fileName: string; state?: string; origin?: string } =>
              !!file && typeof file.fileName === 'string'
          )
          .filter((file) => file.state !== 'removed' && file.origin !== 'index_only')
          .map((file) => file.fileName)
      : []

    return { sessionDocuments: toRefs(sessionDocs, 'session'), baseCorpusFiles }
  })()

  indexCache.set(key, promise)
  return promise
}
