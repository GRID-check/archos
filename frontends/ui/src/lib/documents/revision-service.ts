/**
 * Confirming, or taking back, that a newer document replaces an older one
 * (CONTEXT.md, „Fassung").
 *
 * The backend suggests such a link; only a person makes it. This is that
 * gesture: `PUT /api/documents/{newer}/revision-links` with the older document and
 * whether the two are linked. The backend stores the link by file name in the
 * collection both documents are indexed in, so everything it needs to be true
 * is decided here first: the caller may change both documents, both are
 * visible to them and past screening, both are active, and they are two
 * documents of one collection. A document the caller may not open is a 404, as
 * everywhere else, never a 403 that confirms it exists.
 */

import 'server-only'
import { BadRequestError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { Document } from '@/lib/db/schema'
import { internalServiceHeaders } from '@/lib/internal-auth'
import { refreshSearchRows } from '@/lib/search/refresh-rows'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { getAccessibleDocument } from './access'
import { collectionFileRef } from './collection-file-ref'
import { hasPassedScreening } from './document-reader'
import { changeSummaryAgainst, type RevisionLinks } from './revision-links'
import { loadRevisionLinks } from './revision-links-loader'
import { announceNewRevision } from './revision-notify'

const BACKEND_TIMEOUT_MS = 10_000

export interface RevisionLinkResult {
  /** The newer document, whose facts changed. */
  id: string
  revision: RevisionLinks | null
  /** The older one: its `supersededBy` changed with the link. */
  older: { id: string; revision: RevisionLinks | null }
}

/**
 * The backend route that stores the link. One function, so a path that changes
 * on the Python side is a one-line fix here.
 */
const revisionUrl = (backendUrl: string, collectionName: string): string =>
  `${backendUrl}/v1/collections/${encodeURIComponent(collectionName)}/revision`

/** Load a document for a change: write access to its shelf and folder, not held, in the working set. */
async function loadForLinking(session: AuthorizedSession, documentId: string): Promise<Document> {
  const doc = await getAccessibleDocument(session, documentId, 'write')
  // A held upload is the uploader's and the reviewers' alone (ADR-0086), and a
  // link would carry its name and, through the change summary, what it holds
  // into documents everyone reads. Not found, like every other path.
  if (!hasPassedScreening(doc)) throw new NotFoundError()
  if (doc.scope === 'session') throw new BadRequestError('A chat attachment has no Fassungen', { reason: 'session_document' })
  if (doc.lifecycle !== 'active') throw new BadRequestError('An archived document has no Fassungen', { reason: 'archived' })
  return doc
}

async function putLink(session: AuthorizedSession, newer: Document, older: Document, linked: boolean): Promise<void> {
  // The same gate as every `(collection, filename)` call: a machine-authored
  // row owns no chunks over there, and a name it shares belongs to someone else.
  if (!collectionFileRef(newer) || !collectionFileRef(older)) throw new NotFoundError()

  let res: Response
  try {
    res = await fetch(revisionUrl(getBackendUrl(), newer.collectionName), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...internalServiceHeaders(getBackendUrl()),
        // A confirmation writes the change summary on the summary model: whose
        // credential, data policy (BYOK, ZDR) and spend ledger it runs under.
        // Without it the backend falls back to the deployment's key and default
        // policy, and the spend is booked to nobody.
        'x-grid-organization-id': session.organizationId,
        'x-grid-user-id': session.userId,
      },
      body: JSON.stringify({ newer: newer.filename, older: older.filename, linked }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch {
    throw new UpstreamError('Could not reach the document service')
  }
  if (res.status === 404) throw new NotFoundError()
  if (res.status === 400 || res.status === 409 || res.status === 422) {
    throw new BadRequestError('The document service refused this Fassung link')
  }
  if (!res.ok) throw new UpstreamError('The document service rejected the Fassung update')
}

/**
 * Link `olderId` to `newerId` as its earlier Fassung, or take the link back.
 * Answers the facts of both documents as the caller now reads them.
 */
export async function setRevisionLink(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
  linked: boolean,
  request: Request,
): Promise<RevisionLinkResult> {
  if (newerId === olderId) throw new BadRequestError('A document is not its own earlier Fassung', { reason: 'same_document' })

  const newer = await loadForLinking(session, newerId)
  const older = await loadForLinking(session, olderId)
  if (newer.collectionName !== older.collectionName) {
    throw new BadRequestError('Both documents must be in the same collection', { reason: 'different_collection' })
  }

  await putLink(session, newer, older, linked)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.revision_changed',
    targetType: 'document',
    targetId: newer.id,
    metadata: { olderDocumentId: older.id, linked, collectionName: newer.collectionName },
    request,
  })

  // Read back from the backend's listing, fresh: the cached one predates the write.
  // The search rows follow in the same breath: the older document's `superseded`
  // is this decision, and the person who made it searches next (ADR-0136).
  const reader = await shelfReaderFor(session, newer)
  const [facts] = await Promise.all([
    loadRevisionLinks(session, [newer, older], reader, { fresh: true }),
    refreshSearchRows(session.organizationId, [newer, older]),
  ])
  const newerRevision = facts.get(newer.id) ?? null

  // Only a confirmed link is news; taking one back tells nobody. Detached, so a
  // slow directory never holds up the answer, and it logs rather than fails.
  if (linked) {
    void announceNewRevision({
      organizationId: session.organizationId,
      actorUserId: session.userId,
      newerId: newer.id,
      olderId: older.id,
      // Only a summary written AGAINST the older document: one against another
      // comparison (a third document the recipient may not open) says nothing
      // about this link, and may say what that other document held.
      changeSummary: changeSummaryAgainst(newerRevision?.changeSummary ?? null, older.id),
    })
  }

  return {
    id: newer.id,
    revision: newerRevision,
    older: { id: older.id, revision: facts.get(older.id) ?? null },
  }
}
