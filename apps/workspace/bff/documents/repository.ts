/**
 * Documents repository — the only module that talks to the `documents` table
 * (and the folder-path probe the upload flow needs) for the documents domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no SeaweedFS/backend calls.
 *   - Every query that serves tenant data takes `organizationId` (and, where
 *     applicable, `projectId`) and scopes the WHERE clause with it — tenancy
 *     is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'

export { DOCUMENT_LIST_LIMIT, outsideHiddenFolders, documentListColumns, listProjectDocuments, afterDocumentListCursor, readDocumentListPage, cursorCreatedAtColumn, listDocumentPage, listProjectDocumentPage } from './repository/list'
export type { DocumentListRow, ListProjectDocumentsOptions, DocumentListPage } from './repository/list'
export { afterDocumentLevelCursor, nameContains, readFamilyWhere, readDocumentLevelPage, listDocumentLevelPage } from './repository/levels'
export type { ShelfReadFilters, DocumentLevelPage } from './repository/levels'
export { findShelfDocumentListRow, summarizeShelfFolders, listShelfFailedDocuments, filenameLookupWhere, findDocumentsByFilenames, findProjectDocumentsByFilenames } from './repository/shelf-reads'
export { findRevisionCounterparts, documentNameMatchColumns, probeDocumentNames, findDocumentsByNames, findProjectDocumentsByNames } from './repository/name-lookup'
export type { RevisionCounterpartRow, DocumentNameMatchRow } from './repository/name-lookup'
export { findDocumentTenancy, updateDocumentVisibilityInOrg, listDocumentIdsForProject, listUnreadableProjectDocuments, documentIdsExisting, findDocumentInOrg } from './repository/lookup'
export { findDocumentAuthoredByRef, findLiveDocumentByFilename, findProjectCollectionsHoldingFilename } from './repository/lookup-by-ref'
export { findStorageKeyByCollectionAndFilename, findPageTextTarget, findStorageKeyByIdAndCollection, documentExistsInCollection } from './repository/storage'
export type { StoredDocumentFile } from './repository/storage'
export { deleteProjectDocument, setDocumentDisplayName, setDocumentIngestJob, markDocumentNotIndexed, PLACEMENT_REINGEST_MARKER, markDocumentProcessing, setDocumentBackgroundJob } from './repository/mutations'
export { listStuckProcessingDocuments, listTransientFailures, markDocumentIngestFailed } from './repository/ingest-state'
export type { StuckProcessingDocument, TransientFailureDocument } from './repository/ingest-state'
export { findFolderPathsInProject, findFolderPathInProject, findFolderPathInOfficeShelf, countDocumentsByProject } from './repository/folders'
export { setDocumentReconciledStatus, markScreeningReleased } from './repository/reconcile'
export type { ReconciledFrom } from './repository/reconcile'
export { QUARANTINE_LIST_LIMIT, listQuarantinedDocuments, FAILED_INGEST_RESCAN_STATUSES, retryAllowedSql, FAILED_INGEST_PAGE_LIMIT, listFailedDocumentPageInOrg } from './repository/quarantine-and-retry'
export type { QuarantineCursor, FailedDocumentPage } from './repository/quarantine-and-retry'
