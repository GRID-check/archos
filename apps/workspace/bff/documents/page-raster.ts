/**
 * One page of a PDF Fassung as a palette PNG: what a Skizze traced over that page
 * shows underneath its strokes (S6, `docs/roadmap/sketches.md`, ADR-0150).
 *
 * The service behind `GET /api/documents/[id]/versions/[versionId]/pages/[page]/raster`,
 * and the one way a Skizze's filing gets the picture it embeds: the server never
 * embeds an image a client sent.
 *
 *   - **Access is reading that document.** `getAccessibleDocument` (shelf,
 *     restricted folders, the hold), then the Fassung by its row: published or
 *     superseded, with bytes this person may receive (ADR-0086). Gone or not
 *     theirs is a 404, so a Skizze never shows its underlay to a reader who cannot
 *     open the base document.
 *   - **A PDF only.** An office file's rendition and a picture upload are not
 *     drawn here (415 `not_a_pdf`).
 *   - **Cached per (Fassung, page, dpi)** in the object store beside the Fassung's
 *     file, `<dir>/_raster/p<page>-<dpi>.png` (`buildPageRasterStorageKey`), swept
 *     with it (`object-cleanup.ts`). A Fassung's bytes never change under its id,
 *     so the cache is never stale. A miss reads the Fassung's bytes and has the
 *     backend draw the page (`agent_host/routes/page_raster.py`, pypdfium, a
 *     16-colour palette, long side at most 4096 px): 300 ms for an A3 sheet at
 *     150 dpi, 328 KB.
 *   - **Checked before it is kept.** PNG signature, IHDR size within 4096 px, at
 *     most 4 MiB, else the backend's answer is a 502 and nothing is cached.
 *   - **Logged as an open** (`preview`, with the Fassung), like every viewer fetch:
 *     recorded when the document sits under its own access list.
 */

import 'server-only'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { ApiError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBackendUrl } from '@/lib/backend-url'
import type { Document } from '@/lib/db/schema/documents'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import { recordDocumentAccess } from '@/lib/download-log/service'
import { pngFacts } from '@/lib/images/png-facts'
import { internalServiceHeaders } from '@/lib/internal-auth'
import { buildPageRasterStorageKey, s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { getAccessibleDocument } from './access'
import { mayReceiveVersionBytes } from './version-content'
import { MAX_PAGE_RASTER_BYTES, MAX_PAGE_RASTER_LONG_SIDE, type PageRasterDpi } from './page-raster-limits'
import { findDocumentVersion } from './version-repository'

/** The PDF a miss sends to the backend; the backend refuses more (`MAX_PDF_BYTES`). */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024
const BACKEND_TIMEOUT_MS = 30_000
const PDF = 'application/pdf'
const BYTES_STATES: ReadonlySet<string> = new Set(['published', 'superseded'])

/** What the page is, kept beside its raster. Points are the PDF's own unit: a Skizze draws the page one scene pixel per point. */
export interface PageRasterFacts {
  page: number
  pageCount: number
  pageLabel: string | null
  width: number
  height: number
  widthPt: number
  heightPt: number
  dpi: PageRasterDpi
}

export interface PageRaster {
  png: Uint8Array
  facts: PageRasterFacts
  document: Document
  version: DocumentVersion
}

export interface PageRasterAddress {
  documentId: string
  versionId: string
  page: number
  dpi: PageRasterDpi
}

/** The document and the Fassung, if this session may read that Fassung's bytes; else 404 (or 415 for no PDF). */
async function readableFassung(session: AuthorizedSession, documentId: string, versionId: string) {
  const document = await getAccessibleDocument(session, documentId, 'read')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version || !BYTES_STATES.has(version.state)) throw new NotFoundError('Version not found')
  if (!(await mayReceiveVersionBytes(session, document, version))) throw new NotFoundError('Version not found')
  if ((version.contentType ?? document.contentType) !== PDF) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only a PDF page can lie under a sketch.', { reason: 'not_a_pdf' })
  }
  return { document, version }
}

async function readObject(bucket: string, key: string): Promise<{ bytes: Uint8Array; metadata: Record<string, string> } | null> {
  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!object.Body) return null
    return { bytes: await object.Body.transformToByteArray(), metadata: object.Metadata ?? {} }
  } catch {
    return null
  }
}

async function sourceBytes(version: DocumentVersion): Promise<Uint8Array> {
  if ((version.fileSize ?? 0) > MAX_SOURCE_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'This PDF is too large to draw a page of.', { reason: 'too_large' })
  const object = await readObject(resolveDocumentBucket(version.storageBucket), version.storageKey)
  if (!object) throw new NotFoundError('Version not found')
  return object.bytes
}

async function postPdf(path: string, pdf: Uint8Array): Promise<Response> {
  const base = getBackendUrl()
  try {
    return await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': PDF, ...internalServiceHeaders(base) },
      body: Buffer.from(pdf),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch {
    throw new UpstreamError('Could not reach the page renderer')
  }
}

/** The backend's 422 detail as the refusal the route answers. */
async function refusal(response: Response): Promise<never> {
  const detail = await response
    .json()
    .then((body: { detail?: unknown }) => (typeof body.detail === 'string' ? body.detail : null))
    .catch(() => null)
  if (response.status === 422 && detail === 'no_such_page') throw new NotFoundError('This page does not exist in that version')
  if (response.status === 422 || response.status === 413) {
    throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'This PDF page cannot be drawn.', { reason: detail ?? 'not_drawable' })
  }
  throw new UpstreamError('The page renderer failed')
}

const num = (value: string | null | undefined): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The PNG kept only when it is one, and of a size a page raster may have. */
function checkedPng(bytes: Uint8Array): { width: number; height: number } {
  const facts = pngFacts(bytes)
  const fits = facts && Math.max(facts.width, facts.height) <= MAX_PAGE_RASTER_LONG_SIDE && bytes.byteLength <= MAX_PAGE_RASTER_BYTES
  if (!facts || !fits) throw new UpstreamError('The page renderer answered no page raster')
  return facts
}

function factsFrom(metadata: Record<string, string>, address: PageRasterAddress, size: { width: number; height: number }): PageRasterFacts {
  const label = metadata['page-label'] ? decodeURIComponent(metadata['page-label']) : null
  return {
    page: address.page,
    pageCount: num(metadata['page-count']),
    pageLabel: label,
    width: size.width,
    height: size.height,
    widthPt: num(metadata['page-width-pt']),
    heightPt: num(metadata['page-height-pt']),
    dpi: address.dpi,
  }
}

async function drawAndKeep(version: DocumentVersion, key: string, address: PageRasterAddress): Promise<{ png: Uint8Array; facts: PageRasterFacts }> {
  const response = await postPdf(`/v1/internal/page-raster?page=${address.page}&dpi=${address.dpi}`, await sourceBytes(version))
  if (!response.ok) return refusal(response)
  const png = new Uint8Array(await response.arrayBuffer())
  const size = checkedPng(png)
  const metadata: Record<string, string> = {
    'page-count': response.headers.get('x-page-count') ?? '0',
    'page-width-pt': response.headers.get('x-page-width-pt') ?? '0',
    'page-height-pt': response.headers.get('x-page-height-pt') ?? '0',
    ...(response.headers.get('x-page-label') ? { 'page-label': response.headers.get('x-page-label') as string } : {}),
  }
  // A cache that cannot be written costs the next reader a render, never this one its page.
  await s3Client
    .send(new PutObjectCommand({ Bucket: resolveDocumentBucket(version.storageBucket), Key: key, Body: Buffer.from(png), ContentType: 'image/png', Metadata: metadata }))
    .catch((error: unknown) => console.warn('[page-raster] could not cache a page raster:', error instanceof Error ? error.message : error))
  return { png, facts: factsFrom(metadata, address, size) }
}

/**
 * The page as this session may see it. `log: false` for a read nobody is
 * handed (a save embedding the raster it already showed, a move matching
 * pages); every person-facing read logs.
 */
export async function readPageRaster(session: AuthorizedSession, address: PageRasterAddress, { log = true }: { log?: boolean } = {}): Promise<PageRaster> {
  const { document, version } = await readableFassung(session, address.documentId, address.versionId)
  const key = buildPageRasterStorageKey(version.storageKey, address.page, address.dpi)
  if (!key) throw new NotFoundError('Version not found')
  const cached = await readObject(resolveDocumentBucket(version.storageBucket), key)
  const size = cached ? pngFacts(cached.bytes) : null
  const raster =
    cached && size && Math.max(size.width, size.height) <= MAX_PAGE_RASTER_LONG_SIDE
      ? { png: cached.bytes, facts: factsFrom(cached.metadata, address, size) }
      : await drawAndKeep(version, key, address)
  if (log) await recordDocumentAccess(session, document, 'preview', { versionId: version.id })
  return { ...raster, document, version }
}

/** Each page's label in a Fassung, `null` where it has none; cached beside its rasters. Nobody is handed bytes, so nothing is logged. */
export async function readPageLabels(session: AuthorizedSession, documentId: string, versionId: string): Promise<(string | null)[]> {
  const { version } = await readableFassung(session, documentId, versionId)
  const key = buildPageRasterStorageKey(version.storageKey, 'labels')
  if (!key) throw new NotFoundError('Version not found')
  const bucket = resolveDocumentBucket(version.storageBucket)
  const cached = await readObject(bucket, key)
  if (cached) {
    const parsed = JSON.parse(new TextDecoder().decode(cached.bytes)) as unknown
    if (Array.isArray(parsed)) return parsed.map((label) => (typeof label === 'string' ? label : null))
  }
  const response = await postPdf('/v1/internal/page-labels', await sourceBytes(version))
  if (!response.ok) return refusal(response)
  const { labels } = (await response.json()) as { labels: (string | null)[] }
  await s3Client
    .send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(labels), ContentType: 'application/json' }))
    .catch(() => undefined)
  return labels
}

/** The raster as the route answers it: private, never sniffed, the page's facts in headers. */
export function pageRasterResponse(raster: PageRaster): Response {
  const { facts } = raster
  return new Response(Buffer.from(raster.png), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      // A Fassung's page never changes under its id; private, because it is tenant data.
      'Cache-Control': 'private, max-age=3600',
      'X-Page-Count': String(facts.pageCount),
      'X-Page-Width-Pt': String(facts.widthPt),
      'X-Page-Height-Pt': String(facts.heightPt),
      ...(facts.pageLabel ? { 'X-Page-Label': encodeURIComponent(facts.pageLabel) } : {}),
    },
  })
}
