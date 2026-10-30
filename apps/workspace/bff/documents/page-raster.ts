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
 *     most 4 MiB. No PNG is a 502 and nothing is cached; a PNG past 4 MiB is the
 *     named refusal `raster_too_large`, remembered like the other refusals.
 *   - **Only screened bytes** (ADR-0086). A page is traced only from bytes a
 *     passing verdict judged (`versionBytesPassedScreening`): the uploader and the
 *     reviewers, who may open a held Fassung, get the named refusal
 *     `underlay_held` here, everyone else the 404. A base that is held later is
 *     a blank sheet in the editor from then on.
 *   - **Bounded work.** A refusal (`no_such_page`, `not_a_pdf`, …) is
 *     remembered for {@link REFUSAL_TTL_MS} per (organization, Fassung, page,
 *     dpi), so asking again costs no transfer and no parse; concurrent misses of
 *     one page share one render; the route is rate-limited per person
 *     (`PAGE_RASTER_LIMIT`).
 *   - **Logged as an open** (`preview`, with the Fassung), like every viewer fetch:
 *     recorded when the document sits under its own access list.
 */

import 'server-only'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { ApiError, NotFoundError, UnprocessableError, UpstreamError } from '@/lib/api/errors'
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
import { versionBytesPassedScreening } from './document-reader'
import { mayReceiveVersionBytes } from './version-content'
import { MAX_PAGE_RASTER_BYTES, MAX_PAGE_RASTER_LONG_SIDE, type PageRasterDpi } from './page-raster-limits'
import { findDocumentVersion } from './version-repository'

/** The PDF a miss sends to the backend; the backend refuses more (`MAX_PDF_BYTES`). */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024
const BACKEND_TIMEOUT_MS = 30_000
const PDF = 'application/pdf'
const BYTES_STATES: ReadonlySet<string> = new Set(['published', 'superseded'])
/** How long a refusal is remembered: long enough that a loop costs nothing, short enough that a fix is seen soon. */
export const REFUSAL_TTL_MS = 5 * 60 * 1000
const MAX_REMEMBERED_REFUSALS = 2000

/**
 * The page lies in bytes no passing verdict judged (ADR-0086): its uploader and
 * its reviewers may open the Fassung, but nothing is traced over it until it is
 * released, because a Skizze's filed picture is never held.
 */
export class PageRasterHeldError extends UnprocessableError {
  constructor() {
    super('This version is held by the upload screening; a sketch is drawn on it once it is released.', { reason: 'underlay_held' })
    this.name = 'PageRasterHeldError'
  }
}

/** A refusal the backend gave, kept to be given again without asking it. */
type Refusal = { kind: 'gone' } | { kind: 'unprocessable'; reason: string }
const refusals = new Map<string, { refusal: Refusal; until: number }>()
const inFlight = new Map<string, Promise<{ png: Uint8Array; facts: PageRasterFacts }>>()

function refusalError(refusal: Refusal): ApiError {
  if (refusal.kind === 'gone') return new NotFoundError('This page does not exist in that version')
  return new ApiError(422, 'UNPROCESSABLE_ENTITY', 'This PDF page cannot be drawn.', { reason: refusal.reason })
}

function remembered(key: string): Refusal | null {
  const entry = refusals.get(key)
  if (!entry) return null
  if (entry.until > Date.now()) return entry.refusal
  refusals.delete(key)
  return null
}

function remember(key: string, refusal: Refusal): ApiError {
  if (refusals.size >= MAX_REMEMBERED_REFUSALS) refusals.delete(refusals.keys().next().value as string)
  refusals.set(key, { refusal, until: Date.now() + REFUSAL_TTL_MS })
  return refusalError(refusal)
}

/** Test seam: forget every remembered refusal. */
export function forgetPageRasterRefusals(): void {
  refusals.clear()
}

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
async function readableVersion(session: AuthorizedSession, documentId: string, versionId: string) {
  const document = await getAccessibleDocument(session, documentId, 'read')
  const version = await findDocumentVersion(versionId, documentId, session.organizationId)
  if (!version || !BYTES_STATES.has(version.state)) throw new NotFoundError('Version not found')
  if (!versionBytesPassedScreening(document, version)) {
    // Who may open the held Fassung learns why; anyone else gets the 404 an unknown one gets.
    if (await mayReceiveVersionBytes(session, document, version)) throw new PageRasterHeldError()
    throw new NotFoundError('Version not found')
  }
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
      // The bytes as read, not a second copy of a file that may be large; the store's reader answers an ArrayBuffer view.
      body: pdf as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch {
    throw new UpstreamError('Could not reach the page renderer')
  }
}

/** The backend's refusal, as the route answers it; a 422 or 413 is a fact about these bytes and is remembered under `key`. */
async function refusal(response: Response, key: string): Promise<never> {
  const detail = await response
    .json()
    .then((body: { detail?: unknown }) => (typeof body.detail === 'string' ? body.detail : null))
    .catch(() => null)
  if (response.status === 422 && detail === 'no_such_page') throw remember(key, { kind: 'gone' })
  if (response.status === 422 || response.status === 413) throw remember(key, { kind: 'unprocessable', reason: detail ?? 'not_drawable' })
  throw new UpstreamError('The page renderer failed')
}

const num = (value: string | null | undefined): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The PNG kept only when it is one, and of a size a page raster may have; a page that draws too heavy is a remembered refusal. */
function checkedPng(bytes: Uint8Array, key: string): { width: number; height: number } {
  const facts = pngFacts(bytes)
  if (!facts || Math.max(facts.width, facts.height) > MAX_PAGE_RASTER_LONG_SIDE) throw new UpstreamError('The page renderer answered no page raster')
  if (bytes.byteLength > MAX_PAGE_RASTER_BYTES) throw remember(key, { kind: 'unprocessable', reason: 'raster_too_large' })
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

async function drawAndKeep(version: DocumentVersion, key: string, address: PageRasterAddress, refusalKey: string): Promise<{ png: Uint8Array; facts: PageRasterFacts }> {
  const response = await postPdf(`/v1/internal/page-raster?page=${address.page}&dpi=${address.dpi}`, await sourceBytes(version))
  if (!response.ok) return refusal(response, refusalKey)
  const png = new Uint8Array(await response.arrayBuffer())
  const size = checkedPng(png, refusalKey)
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

/** A miss, drawn once however many readers ask at the same time, and refused at once while a refusal is remembered. */
function drawOnce(organizationId: string, version: DocumentVersion, key: string, address: PageRasterAddress) {
  const flight = `${organizationId}:${version.id}:${address.page}:${address.dpi}`
  const known = remembered(flight)
  if (known) return Promise.reject(refusalError(known))
  const running = inFlight.get(flight)
  if (running) return running
  const started = drawAndKeep(version, key, address, flight).finally(() => inFlight.delete(flight))
  inFlight.set(flight, started)
  return started
}

/**
 * The page as this session may see it. `log: false` for a read nobody is
 * handed (a save embedding the raster it already showed, a move matching
 * pages); every person-facing read logs.
 */
export async function readPageRaster(session: AuthorizedSession, address: PageRasterAddress, { log = true }: { log?: boolean } = {}): Promise<PageRaster> {
  const { document, version } = await readableVersion(session, address.documentId, address.versionId)
  const key = buildPageRasterStorageKey(version.storageKey, address.page, address.dpi)
  if (!key) throw new NotFoundError('Version not found')
  const cached = await readObject(resolveDocumentBucket(version.storageBucket), key)
  const size = cached ? pngFacts(cached.bytes) : null
  const raster =
    cached && size && Math.max(size.width, size.height) <= MAX_PAGE_RASTER_LONG_SIDE
      ? { png: cached.bytes, facts: factsFrom(cached.metadata, address, size) }
      : await drawOnce(session.organizationId, version, key, address)
  if (log) await recordDocumentAccess(session, document, 'preview', { versionId: version.id })
  return { ...raster, document, version }
}

/** A Fassung's page labels, `null` where a page has none, and how many pages it has (labels stop at the backend's `MAX_LABELS`). */
export interface PageLabels {
  labels: (string | null)[]
  pageCount: number
}

/** What a cached `labels.json` says, or null when it says nothing usable: a corrupt or old file is read again, never a 500. */
export function parsePageLabels(text: string): PageLabels | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { labels, pageCount } = parsed as { labels?: unknown; pageCount?: unknown }
  if (!Array.isArray(labels) || typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 0) return null
  return { labels: labels.map((label) => (typeof label === 'string' ? label : null)), pageCount }
}

/** Each page's label in a Fassung, and its page count; cached beside its rasters. Nobody is handed bytes, so nothing is logged. */
export async function readPageLabels(session: AuthorizedSession, documentId: string, versionId: string): Promise<PageLabels> {
  const { version } = await readableVersion(session, documentId, versionId)
  const key = buildPageRasterStorageKey(version.storageKey, 'labels')
  if (!key) throw new NotFoundError('Version not found')
  const bucket = resolveDocumentBucket(version.storageBucket)
  const cached = await readObject(bucket, key)
  const kept = cached ? parsePageLabels(new TextDecoder().decode(cached.bytes)) : null
  if (kept) return kept
  const refusalKey = `${session.organizationId}:${version.id}:labels`
  const known = remembered(refusalKey)
  if (known) throw refusalError(known)
  const response = await postPdf('/v1/internal/page-labels', await sourceBytes(version))
  if (!response.ok) return refusal(response, refusalKey)
  const read = parsePageLabels(await response.text())
  if (!read) throw new UpstreamError('The page renderer answered no page labels')
  await s3Client
    .send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(JSON.stringify(read)), ContentType: 'application/json' }))
    .catch(() => undefined)
  return read
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
