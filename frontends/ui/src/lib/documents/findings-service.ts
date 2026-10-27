/**
 * The findings of a project's documents (`./findings`), read for one person.
 *
 * No SQL of its own: it reads the project's shelf through `listDocumentsPage`,
 * the listing the Dateien page reads, so the same gate (`project:view`), the
 * same folder hiding and the same visibility rule (`documentVisibleTo`, held
 * uploads) decide which documents the findings may rest on. A document the
 * reader may not open is in no finding and no reference.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  deriveDocumentFindings,
  referencedBy,
  resolveReferences,
  toFindingsDocument,
  type FindingsDocument,
} from './findings'
import type { DocumentFindingsResponse } from './findings-wire'
import { documentLevelQuery, DOCUMENT_LEVEL_LIMIT_MAX } from './list-query'
import { listDocumentsPage } from './service'

/** Pages of the shelf one read follows: 4 × 500 documents, a bound, not a design limit. */
const MAX_PAGES = 4

async function readShelf(
  session: AuthorizedSession,
  projectId: string
): Promise<{ documents: FindingsDocument[]; truncated: boolean }> {
  const documents: FindingsDocument[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const level = documentLevelQuery({ limit: DOCUMENT_LEVEL_LIMIT_MAX, ...(cursor ? { cursor } : {}) })
    const read = await listDocumentsPage(session, projectId, { includeArchived: false, level })
    documents.push(...read.documents.map(toFindingsDocument))
    if (!read.nextCursor) return { documents, truncated: false }
    cursor = read.nextCursor
  }
  return { documents, truncated: true }
}

/** The project's findings, and with `documentId` that document's resolved references. */
export async function getProjectDocumentFindings(
  session: AuthorizedSession,
  projectId: string,
  documentId?: string
): Promise<DocumentFindingsResponse> {
  const { documents, truncated } = await readShelf(session, projectId)
  const subject = documentId ? documents.find((document) => document.id === documentId) : undefined
  return {
    findings: deriveDocumentFindings(documents),
    documentCount: documents.length,
    truncated,
    document: subject
      ? { references: resolveReferences(subject, documents), referencedBy: referencedBy(subject, documents) }
      : null,
  }
}
