/**
 * Marking what changed between two Fassungen on the page, and saying it in words
 * (CONTEXT.md, „Fassung").
 *
 * `POST /api/documents/{newer}/revision-compare` with the older document and a page.
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
import { parseRevisionVisualChanges, type RevisionVisualChanges } from './revision-compare-types'

/** Two pages rendered, one vision call (90 s on the backend), and the hop. */
const BACKEND_TIMEOUT_MS = 120_000

const compareUrl = (backendUrl: string, collectionName: string): string =>
  `${backendUrl}/v1/collections/${encodeURIComponent(collectionName)}/revision-compare`

const pagesUrl = (backendUrl: string, collectionName: string): string =>
  `${backendUrl}/v1/collections/${encodeURIComponent(collectionName)}/revision-pages`

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

async function postToBackend(session: AuthorizedSession, url: string, body: object): Promise<Response> {
  try {
    return await fetch(url, {
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

/** Who waits on a comparison: a person in the compare view, or a notice Piloti runs on its own (ADR-0130). */
export type ComparePurpose = 'person' | 'notice'

/**
 * The two documents of a comparison, after every check the comparison needs:
 * both readable by `session`, neither held, both active, one collection, both
 * owning backend state, and outside a restricted folder. Throws an `ApiError`.
 */
async function loadPair(session: AuthorizedSession, newerId: string, olderId: string): Promise<[Document, Document]> {
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
  return [newer, older]
}

/** One page's comparison, with the trace of the vision call that made it (null when cached or untraced). */
export interface RevisionPageComparison {
  changes: RevisionVisualChanges
  traceId: string | null
}

const traceIdOf = (raw: unknown): string | null => {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).trace_id : null
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : null
}

/**
 * What changed on `page` between `olderId` and `newerId`, and the trace of the
 * call. Throws an `ApiError` on every failure. The trace id stays on the
 * server: {@link compareRevisionVisually} is what a browser is answered with.
 */
export async function compareRevisionPage(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
  page: number,
  purpose: ComparePurpose = 'person',
): Promise<RevisionPageComparison> {
  const { changes, traceId } = await comparePair(session, newerId, olderId, page, purpose)
  return { changes, traceId }
}

/** {@link compareRevisionPage} with the two file names the pair was loaded under. */
async function comparePair(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
  page: number,
  purpose: ComparePurpose,
): Promise<RevisionPageComparison & { olderName: string; newerName: string }> {
  const [newer, older] = await loadPair(session, newerId, olderId)
  const response = await postToBackend(session, compareUrl(getBackendUrl(), newer.collectionName), {
    older: older.filename,
    newer: newer.filename,
    page,
    purpose,
  })
  if (!response.ok) {
    console.warn('[Fassung compare] backend refused:', response.status)
    throw refusalFor(response.status)
  }
  const raw: unknown = await response.json().catch(() => null)
  return { changes: parseRevisionVisualChanges(raw), traceId: traceIdOf(raw), olderName: older.filename, newerName: newer.filename }
}

/**
 * What changed on `page` between `olderId` and `newerId`: boxes on the newer page and
 * the changes in words, with the two documents' file names (the route already loaded
 * both to check access, so naming them costs no lookup; an agent's card labels its
 * sides with them). Throws an `ApiError` on every failure.
 */
export async function compareRevisionVisually(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
  page: number,
): Promise<RevisionVisualChanges & { older_name: string; newer_name: string }> {
  const { changes, olderName, newerName } = await comparePair(session, newerId, olderId, page, 'person')
  return { ...changes, older_name: olderName, newer_name: newerName }
}

/** Which pages of the newer Fassung changed, read from the index (no model call). */
export interface ChangedRevisionPages {
  pages: number[]
  newerPageCount: number
  /** False when neither Fassung has read text or a drawing reading: no page can be called unchanged. */
  comparable: boolean
}

const pageList = (raw: unknown): number[] =>
  Array.isArray(raw) ? raw.filter((page): page is number => Number.isInteger(page) && page >= 1 && page <= 2000) : []

/**
 * The changed pages of `newerId` against `olderId`, under the same checks as a
 * comparison (`POST /v1/collections/{c}/revision-pages`). Throws an `ApiError`.
 */
export async function changedRevisionPages(
  session: AuthorizedSession,
  newerId: string,
  olderId: string,
): Promise<ChangedRevisionPages> {
  const [newer, older] = await loadPair(session, newerId, olderId)
  const response = await postToBackend(session, pagesUrl(getBackendUrl(), newer.collectionName), {
    older: older.filename,
    newer: newer.filename,
  })
  if (!response.ok) {
    console.warn('[Fassung compare] backend refused the changed pages:', response.status)
    throw refusalFor(response.status)
  }
  const body: unknown = await response.json().catch(() => null)
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const count = record.newer_page_count
  return {
    pages: pageList(record.pages),
    newerPageCount: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0,
    comparable: record.comparable === true,
  }
}
