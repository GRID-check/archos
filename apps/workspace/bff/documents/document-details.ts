/**
 * Reading a document's state: its status (reconciled with the backend), its visual details, and
 * whether it still exists.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { NotFoundError } from '@/lib/api/errors'
import { normalizeDrawingStructured, type DrawingStructured } from './drawing-structured'
import type { AuthorizedSession } from '@/lib/auth/types'
import { reconcileDocumentStatuses } from './reconcile-status'
import { loadRevisionLinks } from './revision-links-loader'
import { collectionFileRef, collectionFileUrl } from './collection-file-ref'
import { documentExistsInCollection } from './repository'
import { getAccessibleDocument } from './access'
import { hasPassedScreening } from './document-reader'
import { maySeeHeld, shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { quarantineVerdictOf } from '@/lib/upload-screening/quarantine'
import { findOpenVersion, listDocumentVersionSummaries } from './version-repository'
import { BACKEND_FETCH_TIMEOUT_MS } from './ingest-dispatch'

export interface DocumentVisualDetail {
  page: number
  contentType: string
  drawingType: string
  scale: string
  text: string
  /**
   * Which depiction on the sheet this is. A sheet carrying a plan AND a section
   * is indexed as one chunk per depiction, so the page number alone no longer
   * identifies a row.
   */
  segment: number
  /**
   * How many depictions share this chunk's sheet. A sheet carrying two floor
   * plans side by side is indexed one chunk per depiction, so the preview
   * reads this to say which of the sheet's depictions a row is. `1` for
   * chunks indexed before per-segment chunking recorded it.
   */
  segmentCount: number
  /**
   * The structured analysis behind the description — entities, compositions,
   * quantities, provenance. `null` for chunks indexed before the structured
   * schema, and for backends that do not produce one.
   */
  structured: DrawingStructured | null
}

/**
 * Per-page VLM descriptions of a document's visual chunks (drawings / images /
 * charts) — the "detailed information" the one-line summary is distilled from.
 * Requires `project:view`. Read-only and fail-soft: any backend hiccup or an
 * unsupported backend yields an empty list rather than an error, since this is
 * a secondary, on-demand view.
 */
export async function getDocumentVisualDetails(
  session: AuthorizedSession,
  documentId: string
): Promise<{ id: string; details: DocumentVisualDetail[] }> {
  const doc = await getAccessibleDocument(session, documentId, 'read')

  // A machine-authored row has no visual chunks — nothing it wrote was ever
  // ingested, so no page of it was ever described by the VLM. Asking anyway
  // returns, on a filename collision, ANOTHER document's extracted page text
  // rendered inside this row's detail panel. The empty list is the truth here,
  // and it is the same thing this function already answers for a backend that
  // has never heard of the file.
  const ref = collectionFileRef(doc)
  if (!ref) return { id: doc.id, details: [] }

  let res: Response
  try {
    res = await fetch(collectionFileUrl(getBackendUrl(), ref, '/visual-details'), {
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
  } catch {
    return { id: doc.id, details: [] }
  }

  if (!res.ok) return { id: doc.id, details: [] }

  const body = await res.json().catch(() => ({}))
  const raw = Array.isArray(body.details) ? body.details : []
  const details: DocumentVisualDetail[] = raw.map((d: Record<string, unknown>) => ({
    page: typeof d.page === 'number' ? d.page : 0,
    contentType: typeof d.content_type === 'string' ? d.content_type : 'drawing',
    drawingType: typeof d.drawing_type === 'string' ? d.drawing_type : '',
    scale: typeof d.scale === 'string' ? d.scale : '',
    text: typeof d.text === 'string' ? d.text : '',
    segment: typeof d.segment === 'number' ? d.segment : 0,
    segmentCount: typeof d.segment_count === 'number' ? d.segment_count : 1,
    structured: normalizeDrawingStructured(d.structured),
  }))
  return { id: doc.id, details }
}

/** Read one document's status, lazily reconciled with the backend. */
export async function getDocumentStatus(session: AuthorizedSession, documentId: string) {
  const doc = await getAccessibleDocument(session, documentId)

  // Pending rows are lazily reconciled with the backend's ingestion state;
  // without this they would stay 'pending' forever (no completion callback).
  const [reconciled] = await reconcileDocumentStatuses([doc], session.organizationId)
  // The rule again, on the row the reconcile handed back (ADR-0086): a file
  // re-read under an earlier pass can come back `quarantined`, and the read
  // above only let it through on that earlier verdict.
  if (!hasPassedScreening(reconciled) && !(await maySeeHeld(session, reconciled))) throw new NotFoundError()
  const [openVersion, [versionSummary]] = await Promise.all([
    findOpenVersion(reconciled.id, session.organizationId),
    listDocumentVersionSummaries([reconciled.id], session.organizationId),
  ])
  const revision =
    (await loadRevisionLinks(session, [reconciled], await shelfReaderFor(session, reconciled))).get(reconciled.id) ?? null

  return {
    id: reconciled.id,
    status: reconciled.status,
    filename: reconciled.filename,
    // The label, next to the identity. Every other surface renders a renamed
    // document through `documentDisplayName`; this payload omitted the column,
    // so the one caller that reads `displayName` here always fell back to the
    // raw filename and a renamed file was named two different ways in one view.
    displayName: reconciled.displayName,
    // The shelf, straight off the row. The composer's "Asking about <file>"
    // bar re-reads it after a reload, where the client no longer holds one —
    // the DB column is the authority, so nothing has to infer a shelf from a
    // collection-id prefix (ADR-0047 decision 3).
    scope: reconciled.scope,
    fileSize: reconciled.fileSize,
    contentType: reconciled.contentType,
    collectionName: reconciled.collectionName,
    errorMessage: reconciled.errorMessage,
    // Why a held file is held, as data (ADR-0113). Only a reader who may see
    // the held row gets this far (the check above).
    quarantine: quarantineVerdictOf(reconciled),
    createdAt: reconciled.createdAt,
    updatedAt: reconciled.updatedAt,
    // Read-only document metadata merged from the backend collection listing.
    summary: reconciled.summary,
    pageCount: reconciled.pageCount,
    chunkCount: reconciled.chunkCount,
    contentTypes: reconciled.contentTypes,
    tags: reconciled.tags,
    topics: reconciled.topics,
    capture: reconciled.capture,
    revisionFacts: reconciled.revisionFacts,
    dossier: reconciled.dossier,
    docReferences: reconciled.docReferences,
    coverage: reconciled.coverage,
    // Resolved for THIS reader: a document they may not open is not in it.
    revision,
    // The place in the ingest queue, null once the job is claimed or settled.
    queueAhead: reconciled.queueAhead ?? null,
    // Whose hand wrote the bytes. Added because this payload is how the CHAT
    // resolves a document into the peek pane, and a report Piloti wrote that
    // opens beside the conversation without its „Von Piloti erstellt" byline is
    // an agent-authored file presented as an uploaded one. PROVENANCE, never
    // responsibility — the row's assignees are unaffected and still say
    // `Unvergeben`.
    authoredBy: reconciled.authoredBy,
    // THE VERSION THE TURN WOULD HAVE TO READ AS BYTES.
    //
    // At most one version per document is still being worked on (the partial
    // unique index behind `findOpenVersion`), and that is precisely the version
    // retrieval cannot see: only a published version is dispatched to the index
    // (ADR-0054), so a draft has no chunks and the focus filter falls open to
    // the whole corpus. This payload is how the composer resolves its subject,
    // so it is where the two facts the turn needs — WHICH version and what state
    // it is in — belong. `null` means the live bytes are the published ones and
    // nothing extra has to travel.
    openVersion: openVersion ? { id: openVersion.id, state: openVersion.state } : null,
    // HOW MANY VERSIONS, so the chat peek can tell a failed re-upload from a
    // file that never indexed. A new version that fails to process leaves the
    // previous one's passages in the index — Piloti still cites it — and a
    // peek that said "cannot cite this file" for that case was wrong. The same
    // count the Files listing carries (`summarizeDocumentVersions`), for the
    // one document this payload is about. `null` when there is no version row
    // at all, which the peek reads as "no earlier version known".
    versionCount: versionSummary?.versionCount ?? null,
  }
}

/**
 * Resolve a document's SeaweedFS storage key from the `(collectionName,
 * filename)` pair the Python backend carries — the read side of the internal
 * document-file lookup (`/api/internal/document-file`).
 *
 * There is deliberately no session / FGA here: the caller is the backend over
 * the service-token-guarded internal network, and the collection name is the
 * tenancy boundary (`proj_<uuid>` / `archiv_<orgId>` are unguessable). When the
 * backend derives an `organizationId` from an `archiv_` collection prefix, it
 * is forwarded to narrow the row lookup to that org; otherwise the lookup is
 * collection-only. The backend uses the key to fetch the raw bytes from
 * SeaweedFS for the `look` tool (ADR-0039), so this is
 * read-only metadata — it never returns the bytes themselves.
 */
/**
 * Whether the document an ingest was dispatched for still exists — the
 * pipeline's question once a file is indexed, before it retires the previous
 * version (`GET /api/internal/document-exists`). A delete that landed while
 * the ingest ran leaves no row, and the pipeline then takes back out the
 * chunks it just inserted. Service-token caller, so no session to authorize.
 */
export async function documentStillExists(
  documentId: string,
  collectionName: string,
  organizationId?: string
): Promise<boolean> {
  return documentExistsInCollection(documentId, collectionName, organizationId)
}
