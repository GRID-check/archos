/**
 * One page of a project's documents, read for one person: the Dateien listing.
 *
 * Its own module, apart from `./service`, because `./service` also uploads and
 * files. The findings read the shelf through this function, the upload report
 * reads the findings, and settling an upload batch writes that report; project
 * mail's receive side settles statuses too, and review first (ADR-0137,
 * `lib/inbound-mail/review-first.spec.ts`) forbids it to reach filing code at
 * any depth. `./service` re-exports it for the routes that import it there.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { DocumentAuthor } from '@/lib/db/schema'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import type { DocumentLevelQuery } from './list-query'
import { listDocumentLevelPage } from './repository'
import { projectShelf } from './shelf'
import { toListedLevelPage, type ListedDocument } from './shelf-listing'

/**
 * One page of a project's documents (ADR-0102, ADR-0131): one folder level, or
 * the whole shelf, in the reader's order, lazily reconciling in-flight
 * ingestion statuses with the backend and merging the backend's read-only
 * document metadata (summary, page/chunk counts, content types). The internal
 * `metadata` jsonb column (which carries `ingestJobId`) never leaves the BFF.
 *
 * `authoredBy` is pushed down to the query rather than filtered here: the
 * „Von Piloti" chip asks for the small minority of rows a machine wrote, and
 * migration 0063 gave that predicate its own partial index. Archived documents
 * have LEFT the working set, so they are absent unless the caller says
 * otherwise (ADR-0054).
 */
export async function listDocumentsPage(
  session: AuthorizedSession,
  projectId: string,
  options: { authoredBy?: DocumentAuthor; includeArchived?: boolean; level: DocumentLevelQuery }
): Promise<{ documents: ListedDocument[]; nextCursor: string | null }> {
  await requireProjectAccess(session, projectId, 'project:view')
  // A file in quarantine is listed for its uploader and its reviewers only (ADR-0086).
  const reader = await shelfReaderFor(session, { scope: 'project', projectId })
  const levelPage = await listDocumentLevelPage(projectShelf(projectId), session.organizationId, {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader,
    authoredBy: options.authoredBy,
    includeArchived: options.includeArchived,
    level: options.level,
  })
  return toListedLevelPage(session, levelPage, reader)
}
