/**
 * The findings of a project's documents (`./findings`), read for one person.
 *
 * No SQL of its own: it reads the project's shelf through `listDocumentsPage`,
 * the listing the Dateien page reads, so the same gate (`project:view`), the
 * same folder hiding and the same visibility rule (`documentVisibleTo`, held
 * uploads) decide which documents the findings may rest on. A document the
 * reader may not open is in no finding and no reference.
 *
 * The project's profile is read beside it, after the listing's own gate let
 * the reader in, so the documents can be compared with the Steckbrief
 * (`profile_contradiction`). A profile that cannot be read costs that kind
 * only: the other findings stand without it.
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
import type { ProfileFacts } from './profile-contradictions'
import { listDocumentsPage } from './shelf-page'
import { findProjectProfileInOrg } from '@/lib/projects/repository'

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

/** The project's confirmed profile, or null when it cannot be read: the comparison is then left out. */
async function readProfile(organizationId: string, projectId: string): Promise<ProfileFacts | null> {
  try {
    return (await findProjectProfileInOrg(projectId, organizationId))?.profile ?? null
  } catch (error) {
    console.warn(`[findings] the profile of project ${projectId} could not be read; compared without it:`, error)
    return null
  }
}

/** What the findings of a project are derived from, as `session` may see it. */
export interface ProjectFindingsInput {
  documents: FindingsDocument[]
  truncated: boolean
  profile: ProfileFacts | null
}

/** The project's documents (the listing's gate first) and then its profile. */
export async function readProjectFindingsInput(session: AuthorizedSession, projectId: string): Promise<ProjectFindingsInput> {
  const { documents, truncated } = await readShelf(session, projectId)
  return { documents, truncated, profile: await readProfile(session.organizationId, projectId) }
}

/** The project's findings, and with `documentId` that document's resolved references. */
export async function getProjectDocumentFindings(
  session: AuthorizedSession,
  projectId: string,
  documentId?: string
): Promise<DocumentFindingsResponse> {
  const { documents, truncated, profile } = await readProjectFindingsInput(session, projectId)
  const subject = documentId ? documents.find((document) => document.id === documentId) : undefined
  return {
    findings: deriveDocumentFindings(documents, profile),
    documentCount: documents.length,
    truncated,
    document: subject
      ? { references: resolveReferences(subject, documents), referencedBy: referencedBy(subject, documents) }
      : null,
  }
}
