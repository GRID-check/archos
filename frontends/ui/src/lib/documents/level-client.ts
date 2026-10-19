/**
 * The typed client of a shelf's paged reads (ADR-0055, ADR-0102): the one
 * place the URLs and the response parsing of a folder level, a shelf summary
 * and one document by id live, so no hook spells a path of its own.
 *
 * - A level page: `GET {list}?folderId=&sort=&dir=&q=&state=&limit=&cursor=`
 *   on the shelf's listing route (`/api/documents`, `/api/archiv/documents`).
 * - The shelf summary: `GET {list}/summary`.
 * - One document as a listing row: `GET /api/documents/{id}` (both shelves).
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import type { DocumentWireRow } from '@/features/documents/lib/file-item'
import type { DocumentReadFamily } from './document-status'
import type { DocumentLevelDirection, DocumentLevelSort } from './list-cursor'
import type { ShelfSummary } from './shelf-summary-types'

/** A paged read the API refused, or a transport failure (status 0). */
export class LevelFetchError extends Error {
  constructor(readonly status: number) {
    super(`Shelf read failed (${status})`)
    this.name = 'LevelFetchError'
  }
}

/** The shelf's listing route and its fixed parameters (`projectId`). */
export interface ShelfListingRoute {
  list: string
  listParams?: Readonly<Record<string, string>>
}

/** The listing's two server filters, which the summary takes as well so its counts match. */
export interface ShelfServerFilters {
  agentAuthoredOnly?: boolean
  includeArchived?: boolean
}

export interface LevelPageRequest extends ShelfListingRoute, ShelfServerFilters {
  /** A folder id, `null` for the shelf root, `undefined` for the whole shelf (a search). */
  folderId?: string | null
  sort: DocumentLevelSort
  dir: DocumentLevelDirection
  /** A name substring; empty or absent asks for none. */
  q?: string
  /** Read-state families to keep; empty or absent keeps every one. */
  states?: readonly DocumentReadFamily[]
  limit: number
}

/** One level page as it arrives. */
export interface LevelPageBody {
  documents: DocumentWireRow[]
  nextCursor: string | null
  /** The Archiv's listing says which collection it is; a project's page knows it already. */
  collectionName?: string
}

type Fetcher = typeof fetch

function serverFilterParams(params: URLSearchParams, filters: ShelfServerFilters): void {
  if (filters.agentAuthoredOnly) params.set('authoredBy', 'agent')
  if (filters.includeArchived) params.set('includeArchived', 'true')
}

/** The URL of a level's first page. The request's identity: a change of it is another level. */
export function levelPageUrl(request: LevelPageRequest): string {
  const params = new URLSearchParams({ ...(request.listParams ?? {}) })
  if (request.folderId !== undefined) params.set('folderId', request.folderId ?? 'root')
  params.set('sort', request.sort)
  params.set('dir', request.dir)
  const q = request.q?.trim() ?? ''
  if (q !== '') params.set('q', q)
  if (request.states && request.states.length > 0) params.set('state', request.states.join(','))
  serverFilterParams(params, request)
  params.set('limit', String(request.limit))
  return `${request.list}?${params.toString()}`
}

/** `url` with one query parameter set (a page's `cursor`, a reload's larger `limit`). */
export function withQueryParam(url: string, key: string, value: string): string {
  const at = url.indexOf('?')
  const path = at === -1 ? url : url.slice(0, at)
  const params = new URLSearchParams(at === -1 ? '' : url.slice(at + 1))
  params.set(key, value)
  return `${path}?${params.toString()}`
}

/** The shelf summary's URL, with the listing's server filters. */
export function shelfSummaryUrl(route: ShelfListingRoute, filters: ShelfServerFilters): string {
  const params = new URLSearchParams({ ...(route.listParams ?? {}) })
  serverFilterParams(params, filters)
  const query = params.toString()
  return query ? `${route.list}/summary?${query}` : `${route.list}/summary`
}

async function getJson(url: string, signal: AbortSignal | undefined, fetcher: Fetcher): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, { signal })
  } catch (error) {
    // An abort is the caller's own doing; it rethrows as itself so the caller can tell.
    if (signal?.aborted) throw error
    throw new LevelFetchError(0)
  }
  if (!response.ok) throw new LevelFetchError(response.status)
  return response.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function fetchLevelPage(
  url: string,
  { signal, fetcher = fetch }: { signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<LevelPageBody> {
  const body = await getJson(url, signal, fetcher)
  if (!isRecord(body)) throw new LevelFetchError(0)
  return {
    // The rows are the listing's own wire shape (`toDocumentWireRow`), passed
    // through as every listing reader takes them.
    documents: Array.isArray(body.documents) ? (body.documents as DocumentWireRow[]) : [],
    nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    ...(typeof body.collectionName === 'string' ? { collectionName: body.collectionName } : {}),
  }
}

export async function fetchShelfSummary(
  url: string,
  { signal, fetcher = fetch }: { signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<ShelfSummary> {
  const body = await getJson(url, signal, fetcher)
  if (!isRecord(body) || !Array.isArray(body.folders) || !Array.isArray(body.failed)) throw new LevelFetchError(0)
  return {
    folders: body.folders as ShelfSummary['folders'],
    failed: body.failed as ShelfSummary['failed'],
    failedTruncated: body.failedTruncated === true,
  }
}

/** The path of one document's row. */
export const documentRowPath = (documentId: string): string => `/api/documents/${encodeURIComponent(documentId)}`

/**
 * One document as a listing row, or `null` when it is not there for this
 * reader (403, 404): a link to a document that was deleted, moved out of
 * reach or is held back is a link to nothing, not an error.
 */
export async function fetchDocumentRow(
  documentId: string,
  { signal, fetcher = fetch }: { signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<DocumentWireRow | null> {
  try {
    const body = await getJson(documentRowPath(documentId), signal, fetcher)
    return isRecord(body) && isRecord(body.document) ? (body.document as DocumentWireRow) : null
  } catch (error) {
    if (error instanceof LevelFetchError && (error.status === 403 || error.status === 404)) return null
    throw error
  }
}
