/**
 * Marking what changed between two Fassungen on the page, and saying it in words
 * (CONTEXT.md, „Fassung").
 *
 * `POST /api/documents/{newer}/fassung-compare` with the older document and a page.
 * The backend (`frontends/aiq_api/.../routes/fassung_compare.py`) renders that page of
 * both stored originals, asks the vision model once about the pair and caches the
 * answer; it knows the documents only as `(collection, file name)`, so everything it
 * must be allowed to do is decided here first:
 *
 *   - the caller may READ both documents, by the same gate the preview uses
 *     (`getAccessibleDocument`: the shelf's rule, the folder's visibility);
 *   - neither is held (ADR-0086): a file still in quarantine, or never screened, is not
 *     shown to a model on the strength of an id, and not named to the backend either;
 *   - they are two documents of ONE collection, both active, both owning backend state
 *     (`collectionFileRef`), and not in a restricted folder, whose files the backend's
 *     lookup never serves outside a chat turn (ADR-0088).
 *
 * A document the caller may not open is a 404, as everywhere else, never a 403.
 * Nothing is written here: the comparison is cached by the backend under what it
 * compared, not stored against either document.
 */

import 'server-only'
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
  UpstreamError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { restrictedCollectionBase } from '@/lib/authz/folder-access-rule'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { Document } from '@/lib/db/schema'
import { INTERNAL_TOKEN_HEADER } from '@/lib/internal-auth'
import { getAccessibleDocument } from './access'
import { collectionFileRef } from './collection-file-ref'
import { hasPassedScreening } from './document-reader'
import { parseFassungVisualChanges, type FassungVisualChanges } from './fassung-compare-types'

/** Two pages rendered, one vision call (90 s on the backend), and the hop. */
const BACKEND_TIMEOUT_MS = 120_000

const compareUrl = (backendUrl: string, collectionName: string): string =>
  `${backendUrl}/v1/collections/${encodeURIComponent(collectionName)}/fassung-compare`

/** Load a document to be compared: readable, not held, active, in the working set. */
async function loadForComparing(session: AuthorizedSession, documentId: string): Promise<Document> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  // A held upload is the uploader's and the reviewers' alone (ADR-0086). Its pages would go
  // to a model and its name to the backend for a reader who may not have it: not found.
  if (!hasPassedScreening(doc)) throw new NotFoundError()
  if (doc.scope === 'session') throw new BadRequestError('A chat attachment has no Fassungen', { reason: 'session_document' })
  if (doc.lifecycle !== 'active') throw new BadRequestError('An archived document has no Fassungen', { reason: 'archived' })
  return doc
}

async function postToBackend(session: AuthorizedSession, collectionName: string, body: object): Promise<Response> {
  try {
    return await fetch(compareUrl(getBackendUrl(), collectionName), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: process.env.GRID_INTERNAL_API_TOKEN ?? '',
        // Whose vision credential and data policy the comparison runs under.
        'x-grid-organization-id': session.organizationId,
        'x-grid-user-id': session.userId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch {
    throw new UpstreamError('Could not reach the document service')
  }
}

/** The backend's refusals, as the errors the compare view shows. */
function refusalFor(status: number): Error {
  switch (status) {
    case 404:
      return new NotFoundError('That page is not available for comparison')
    case 409:
      return new ConflictError('A document has not been read yet', { reason: 'not_ingested' })
    case 400:
    case 422:
      return new BadRequestError('The document service refused this comparison')
    case 503:
      return new ServiceUnavailableError('No vision model is configured')
    default:
      return new UpstreamError('The comparison could not be made')
  }
}

/**
 * What changed on `page` between `olderId` and `newerId`: boxes on the newer page and
 * the changes in words. Throws an `ApiError` on every failure.
 */
export async function compareFassungVisually(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
  page: number,
): Promise<FassungVisualChanges> {
  if (newerId === olderId) throw new BadRequestError('A document is not its own earlier Fassung', { reason: 'same_document' })

  const newer = await loadForComparing(session, newerId)
  const older = await loadForComparing(session, olderId)
  if (newer.collectionName !== older.collectionName) {
    throw new BadRequestError('Both documents must be in the same collection', { reason: 'different_collection' })
  }
  // A machine-authored row owns no chunks over there, and a name it shares belongs to someone else.
  if (!collectionFileRef(newer) || !collectionFileRef(older)) throw new NotFoundError()
  if (restrictedCollectionBase(newer.collectionName.toLowerCase()) !== null) {
    throw new UnprocessableError('Documents in a restricted folder cannot be compared by Piloti', {
      reason: 'restricted_folder',
    })
  }

  const response = await postToBackend(session, newer.collectionName, {
    older: older.filename,
    newer: newer.filename,
    page,
  })
  if (!response.ok) {
    console.warn('[Fassung compare] backend refused:', response.status)
    throw refusalFor(response.status)
  }
  return parseFassungVisualChanges(await response.json().catch(() => null))
}
