/**
 * Delivering a document's bytes to a reader: the download, the inline preview, the text preview,
 * the thumbnail and the image stream.
 */

import 'server-only'
import { contentDisposition } from './content-disposition'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, signingS3Client, buildThumbnailStorageKey } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { isFolderVisibleToMember } from '@/lib/authz/folder-access'
import { ForbiddenError } from '@/lib/api/errors'
import { ApiError, NotFoundError } from '@/lib/api/errors'
import { buildDocumentImageUrl, DOCUMENT_IMAGE_CACHE_CONTROL, verifyDocumentImageUrl } from '@/lib/images/signed-image-url'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import { findDocumentInOrg } from './repository'
import { decodeTextBytes } from '@/lib/text/decode-text'
import { getAccessibleDocument } from './access'
import { hasPassedScreening, SCREENED_ONLY } from './document-reader'
import { recordDocumentAccess } from '@/lib/download-log/service'
import { INLINE_PREVIEW_CONTENT_TYPES, TEXT_PREVIEW_CONTENT_TYPES as SHARED_TEXT_PREVIEW_CONTENT_TYPES, isOfficeRenditionSource } from './preview-types'
import { RenditionFailedError, RenditionUnavailableError, ensureRendition, isRenditionEnabled } from './rendition'

const PREVIEW_CONTENT_TYPES: readonly string[] = INLINE_PREVIEW_CONTENT_TYPES

/**
 * Text-shaped documents the reader gets as TEXT rather than as a presigned URL.
 *
 * These are accepted at upload (`shared/config/file-upload.ts`) and had no
 * viewer at all: a `.md` a colleague uploaded showed the same grey "download it
 * to read it" mock as a `.dwg` we genuinely cannot render. They are separate
 * from {@link PREVIEW_CONTENT_TYPES} because the answer is a different shape —
 * the bytes come back through this origin as a string the pane renders, not as
 * an object-store URL an iframe loads. The object store publishes no CORS
 * policy, so a presigned URL is unreadable to a `fetch` anyway; that is the same
 * constraint `streamDocumentFile` exists for.
 *
 * `text/html` is deliberately absent and must stay absent. These bytes are
 * uploaded by users and would be returned same-origin.
 */
const TEXT_PREVIEW_CONTENT_TYPES: readonly string[] = SHARED_TEXT_PREVIEW_CONTENT_TYPES

/**
 * How much of a text document crosses the wire for a preview.
 *
 * A preview is a look at a file, not a delivery of it — the download button is
 * two centimetres away and is the honest route to the whole thing. 256 KiB is
 * some 4000 lines of prose, past the point where anyone is reading rather than
 * searching, and it bounds a response that would otherwise be the upload limit.
 */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024

/**
 * Content types the signed image route hands to the Next optimizer.
 *
 * Deliberately narrower than {@link PREVIEW_CONTENT_TYPES}. SVG is excluded
 * because the optimizer hard-fails on it (400) unless `dangerouslyAllowSVG` is
 * on, which we will not enable — it would let an uploaded SVG carry script into
 * a same-origin response. BMP and TIFF are excluded because sharp's support is
 * patchier than the browsers' and a decode failure is a broken image, not a
 * slow one. Everything excluded here still previews; it just renders straight
 * from the object store as it does today.
 */
const OPTIMIZABLE_IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]

const presignTtlSeconds = (): number => Number(process.env.SEAWEED_PRESIGNED_URL_TTL_SECONDS || 600)

/**
 * The longest the preview and file routes wait for an office file's rendition
 * to be made on first open. Under Cloudflare's ~100s origin timeout with room
 * for the rest of the request, so a slow conversion is answered as the handled
 * `RENDITION_FAILED` 502 rather than an edge 524. The conversion itself keeps
 * its full budget (`GOTENBERG_TIMEOUT_MS` in `./rendition`) and stores its PDF
 * for the next open.
 */
const RENDITION_READER_WAIT_MS = 85_000

/** Presign a browser-facing download URL for a document. */
export async function getDocumentDownload(
  session: AuthorizedSession,
  documentId: string
): Promise<{
  downloadUrl: string
  filename: string
  contentType: string | null
  fileSize: number | null
}> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const downloadUrl = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: doc.storageKey,
      ResponseContentDisposition: contentDisposition('attachment', doc.filename),
    }),
    { expiresIn: presignTtlSeconds() }
  )
  await recordDocumentAccess(session, doc, 'download')

  return {
    downloadUrl,
    filename: doc.filename,
    contentType: doc.contentType,
    fileSize: doc.fileSize,
  }
}

/**
 * The key of an office document's PDF rendition, converting on first read
 * (ADR-0070), with the two failures mapped to what the routes answer.
 *
 * Lazy here because every office file uploaded before the conversion in
 * {@link beginRenditionIngest} existed has no rendition, nor does one whose
 * conversion failed there. "Disabled" is today's 415 exactly — a deployment without
 * `GOTENBERG_URL` must look as it did — and a converter failure is a 502 of its
 * own so the reader is told the preview failed rather than that the product
 * cannot show Word files.
 *
 * A person is waiting here, so the wait is bounded by
 * {@link RENDITION_READER_WAIT_MS} and a file whose conversion failed in the
 * last few minutes is answered as failed at once instead of converted again on
 * every open. The background ingest and its retry do not take that shortcut.
 */
async function officeRenditionKey(doc: Pick<Document, 'storageKey' | 'storageBucket' | 'filename'>, contentType: string): Promise<string> {
  const unsupported = () =>
    new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Preview not available for this file type', { contentType })
  if (!isRenditionEnabled() || !doc.storageKey) throw unsupported()
  try {
    return await ensureRendition(
      {
        bucket: resolveDocumentBucket(doc.storageBucket),
        storageKey: doc.storageKey,
        filename: doc.filename,
      },
      { readerWaitMs: RENDITION_READER_WAIT_MS }
    )
  } catch (error) {
    if (error instanceof RenditionUnavailableError) throw unsupported()
    if (error instanceof RenditionFailedError) {
      console.warn('[documents] office rendition failed:', error.message)
      throw new ApiError(502, 'RENDITION_FAILED', 'The PDF preview of this file could not be created')
    }
    throw error
  }
}

/** `Bericht.docx` → `Bericht.pdf`: the name a rendition is served under. */
function renditionFilename(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return `${dot > 0 ? filename.slice(0, dot) : filename}.pdf`
}

/**
 * Whether this row is served through its PDF rendition. A type the store can
 * already show inline wins, so a real PDF that happens to be named `.docx` is
 * still served as itself.
 */
export function servedAsRendition(doc: Pick<Document, 'contentType' | 'filename'>): boolean {
  const contentType = doc.contentType || 'application/octet-stream'
  if (PREVIEW_CONTENT_TYPES.includes(contentType)) return false
  return isOfficeRenditionSource({ contentType: doc.contentType, filename: doc.filename })
}

export interface DocumentPreview {
  url: string
  /** What `url` serves: the stored type, or `application/pdf` for a rendition. */
  contentType: string
  filename: string
  imageUrl: string | null
  /** True when `url` is the PDF rendition of an office original (ADR-0070), not the stored bytes. */
  rendition: boolean
  /** The stored type of the original when `rendition` is true; null otherwise. */
  sourceContentType: string | null
}

/**
 * Presign a browser-facing inline preview URL. Non-previewable content types
 * are rejected with a 415. An office document is previewed through its PDF
 * rendition — the presigned URL is the rendition's, never the original's.
 */
export async function getDocumentPreview(
  session: AuthorizedSession,
  documentId: string
): Promise<DocumentPreview> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (servedAsRendition(doc)) {
    const renditionKey = await officeRenditionKey(doc, contentType)
    const url = await getSignedUrl(
      signingS3Client,
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: renditionKey,
        ResponseContentDisposition: contentDisposition('inline', renditionFilename(doc.filename)),
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: 3600 }
    )
    await recordDocumentAccess(session, doc, 'preview')
    return {
      url,
      contentType: 'application/pdf',
      filename: doc.filename,
      imageUrl: null,
      rendition: true,
      sourceContentType: doc.contentType ?? null,
    }
  }

  if (!PREVIEW_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Preview not available for this file type', {
      contentType,
    })
  }

  const url = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: doc.storageKey,
      ResponseContentDisposition: contentDisposition('inline', doc.filename),
      ResponseContentType: contentType,
    }),
    { expiresIn: 3600 }
  )
  await recordDocumentAccess(session, doc, 'preview')

  // A same-origin, signature-authorized path for the raster image formats the
  // optimizer can actually process — this is what lets `next/image` resize a
  // full-size upload down to the box it is rendered in. Null for PDFs, SVGs and
  // the exotic formats above, whose callers fall back to `url` unoptimized.
  //
  // Null for a held file too (ADR-0086). That URL is a bearer capability the
  // optimizer fetches without a session, so `streamDocumentImage` serves only
  // screened files through it: the session that minted it (a reviewer, the
  // uploader) is not there to be asked again. The pane falls back to `url`,
  // which this session's own check just presigned.
  const imageUrl =
    OPTIMIZABLE_IMAGE_CONTENT_TYPES.includes(contentType) && hasPassedScreening(doc)
      ? buildDocumentImageUrl(session.organizationId, session.userId, documentId, 'original')
      : null

  return { url, contentType, filename: doc.filename, imageUrl, rendition: false, sourceContentType: null }
}

/**
 * Stream a stored PDF's bytes from THIS origin, under the same authorization
 * `getAccessibleDocument` applies everywhere else — `project:view` for a project
 * document, org membership for an org-wide Archiv document.
 *
 * The presigned URL `getDocumentPreview` mints points at the object store's own
 * domain, and that is fine for anything the browser NAVIGATES to — a new tab, a
 * download, an iframe. It is not fine for anything the browser FETCHES: the
 * in-app PDF viewer reads the file with XHR to build a text layer, which makes
 * the request cross-origin and subject to CORS, and the S3 gateway this deploys
 * against (SeaweedFS, `deploy/compose/docker-compose.coolify.yaml`) publishes no
 * CORS policy at all. Every project upload and every org-Archiv document would
 * therefore fail to load in the viewer and silently drop to the fallback frame —
 * losing the cited-passage highlight on exactly the documents users uploaded
 * themselves, while the base corpus (already same-origin) kept it.
 *
 * So stored PDFs get the same shape the corpus route has. The presigned URL is
 * not replaced: it still serves the "open in new tab" link and the image
 * branch, where a navigation is what happens and an expiring URL is the point.
 *
 * PDF ONLY, and narrower than {@link PREVIEW_CONTENT_TYPES} on purpose. That
 * list admits `image/svg+xml`, and an SVG is a script carrier: served `inline`
 * from THIS origin it executes in the app's origin with the user's session,
 * which is stored XSS. `frame-ancestors` does not prevent script execution in a
 * top-level document. The same hazard is already spelled out for the image
 * optimizer above — this route must not be the hole that reintroduces it.
 * Images have no reason to come through here anyway: nothing fetches their
 * bytes to parse, so every caller keeps them on the presigned URL.
 *
 * An office document streams its PDF RENDITION (ADR-0070), converted on first
 * read, so the viewer and the cited-passage highlight work on it exactly as on
 * a PDF. Still PDF only: what leaves this route is always a PDF the BFF made or
 * a PDF the user stored, never the office bytes themselves.
 */
export async function streamDocumentFile(
  session: AuthorizedSession,
  documentId: string
): Promise<Response> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  let key = doc.storageKey
  let filename = doc.filename
  if (servedAsRendition(doc)) {
    key = await officeRenditionKey(doc, contentType)
    filename = renditionFilename(doc.filename)
  } else if (contentType !== 'application/pdf') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF documents stream from this route', {
      contentType,
    })
  }

  let body
  try {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: key,
      })
    )
    body = object.Body
  } catch {
    throw new NotFoundError('File not available')
  }
  if (!body) throw new NotFoundError('File not available')
  await recordDocumentAccess(session, doc, 'pdf')

  // ASCII-safe filename for the header; this route only ever displays inline.
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')
  return new Response(body.transformToWebStream(), {
    status: 200,
    headers: {
      // Both branches above leave only a PDF to serve.
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${asciiName}"`,
      // Private: these bytes are tenant data.
      'Cache-Control': 'private, max-age=300',
      // The viewer's fallback renders this stream in a same-origin iframe, and
      // the global next.config rule stamps X-Frame-Options: DENY on every
      // route. Override it here, with a matching CSP directive for modern
      // browsers — the same pairing `streamKnowledgeBaseDocument` carries, and
      // next.config carries a route-scoped override to match.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
    },
  })
}

/**
 * A text document's content, for the pane that renders it.
 *
 * Bounded by {@link TEXT_PREVIEW_MAX_BYTES} and decoded the way the knowledge
 * layer reads the same bytes (`decodeTextBytes`: BOM, else strict UTF-8, else
 * Windows-1252). A Windows-authored `.csv` in cp1252 is common, and decoding it
 * as UTF-8 with replacement glyphs showed every umlaut as „�". `truncated` is part of the contract because a viewer that
 * silently shows the first half of a document is worse than one that shows none
 * of it — the reader would take the last line they see for the end of the file.
 */
export async function getDocumentTextPreview(
  session: AuthorizedSession,
  documentId: string
): Promise<{ text: string; truncated: boolean; contentType: string; filename: string }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (!TEXT_PREVIEW_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Not a text document: only plain text, Markdown and CSV files are served as text. Read a PDF or an office ' +
        'document by its pages with passage-read, or a version’s text with document-version-content-get.',
      { contentType }
    )
  }

  let bytes: Uint8Array
  try {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: doc.storageKey,
        // One byte past the cap, so a file sitting exactly on it is not reported
        // as truncated. Servers that ignore Range answer with the whole object,
        // which the slice below bounds anyway.
        Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES}`,
      })
    )
    if (!object.Body) throw new NotFoundError('File not available')
    bytes = await object.Body.transformToByteArray()
  } catch {
    throw new NotFoundError('File not available')
  }
  await recordDocumentAccess(session, doc, 'text')

  const truncated = bytes.byteLength > TEXT_PREVIEW_MAX_BYTES
  let { text } = decodeTextBytes(bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES), { truncated })
  // A Range cut lands mid-line (and, in UTF-16, mid-character). Drop the
  // trailing partial line: a half-written last row of a CSV reads as data, and
  // the truncation notice below it is the honest statement.
  if (truncated) {
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak > 0) text = text.slice(0, lastBreak)
  }

  return { text, truncated, contentType, filename: doc.filename }
}

/**
 * Browser-facing thumbnail URL (null when no thumbnail exists).
 *
 * Prefers the signed same-origin route so the card's 124px well gets an
 * optimizer-resized image, and falls back to a presigned object-store URL when
 * signing is unavailable. The ingest pipeline already writes a 200px JPEG here,
 * so the win is a format change (WebP/AVIF) rather than a resize — small, but it
 * keeps every document image on one path instead of leaving this one special.
 */
export async function getDocumentThumbnail(
  session: AuthorizedSession,
  documentId: string
): Promise<{ url: string | null }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) return { url: null }
  // No derivative of a held file (ADR-0086), for its uploader and its reviewers
  // too: the ingest draws one only after the screen passes, and one left from
  // earlier bytes or an earlier verdict is not this file's to show.
  if (!hasPassedScreening(doc)) return { url: null }

  const thumbnailKey = buildThumbnailStorageKey(doc.storageKey)
  if (!thumbnailKey) return { url: null }

  // The signed same-origin URL is only useful if the JPEG actually exists.
  // Returning it blindly sent Next's image optimizer to a 404 / empty body
  // ("isn't a valid image … received null") for every file that is citable
  // but has no thumbnail yet (#366, #395).
  //
  // Existence is not enough: a failed ingest render can leave a 0-byte object
  // behind in the thumbnail slot, which passes HeadObject and then fails the
  // optimizer's decode — the same error, recurring for the same documents
  // across days. An empty object is no thumbnail.
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: thumbnailKey,
      })
    )
    if ((head?.ContentLength ?? 0) <= 0) return { url: null }
  } catch {
    return { url: null }
  }

  const signedUrl = buildDocumentImageUrl(session.organizationId, session.userId, documentId, 'thumb')
  if (signedUrl) return { url: signedUrl }

  try {
    const url = await getSignedUrl(
      signingS3Client,
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: thumbnailKey,
        ResponseContentType: 'image/jpeg',
      }),
      { expiresIn: 3600 }
    )
    return { url }
  } catch {
    return { url: null }
  }
}

/**
 * Stream a document image for a signed capability URL — the only document route
 * that serves bytes without a session, because the Next image optimizer's
 * internal fetch cannot carry one (see `@/lib/images/signed-image-url`).
 *
 * The signature is the authorization. It was minted by `getDocumentPreview` /
 * `getDocumentThumbnail` AFTER `getAccessibleDocument` ran the real
 * `project:view` check, and it is bound to the org, the person, the document
 * and the variant, so it cannot be walked onto another tenant's document or onto the
 * full-size original when it was issued for a thumbnail. The org id is taken
 * from the signed claims rather than the caller, so the row lookup stays
 * tenant-scoped exactly as the session path is.
 *
 * What may have changed since the mint is asked again: the folder, and the
 * hold (ADR-0086). A re-upload keeps the document's id, so a URL minted for a
 * member before the new bytes were held would otherwise go on serving their
 * thumbnail, or for an image the image itself, until it expired.
 */
export async function streamDocumentImage(
  documentId: string,
  params: URLSearchParams
): Promise<Response> {
  const verified = verifyDocumentImageUrl(documentId, params)
  if (!verified.ok) {
    if (verified.reason === 'disabled') {
      throw new ApiError(503, 'IMAGE_URLS_DISABLED', 'Signed image URLs are not configured')
    }
    // Expired, malformed and forged are one answer to the caller on purpose:
    // distinguishing them tells an attacker which half of the token to work on.
    throw new ForbiddenError('Invalid or expired image URL')
  }

  const { organizationId, userId, variant } = verified.claims
  // Screened files only, whatever the variant and whoever the URL names
  // (ADR-0086). The claims carry a person, not their standing: a reviewer's or
  // an uploader's right to a held file is a session check this sessionless
  // fetch cannot repeat, so neither `getDocumentPreview` nor
  // `getDocumentThumbnail` mints one of these URLs for a held file, and one
  // minted before the file was held (a re-upload, a quarantine) stops working.
  const doc = await findDocumentInOrg(documentId, organizationId, SCREENED_ONLY)
  if (!doc?.storageKey) throw new NotFoundError()
  // The URL outlives the moment it was minted, and the optimizer's fetch has no
  // session, so the person it names is asked again: a folder they can no longer
  // read does not load its images (ADR-0087, ADR-0088). Not found, like every
  // other refusal on this path.
  if (
    doc.scope === 'project' &&
    doc.projectId &&
    !(await isFolderVisibleToMember(organizationId, doc.projectId, doc.folderId, userId))
  ) {
    throw new NotFoundError()
  }

  const contentType = variant === 'thumb' ? 'image/jpeg' : doc.contentType || ''
  // Belt and braces over the signing-side check: this route serves images and
  // nothing else, so a token minted against a row that later changed type
  // cannot turn into a download channel for an arbitrary upload.
  if (!contentType.startsWith('image/')) throw new NotFoundError()

  const key = variant === 'thumb' ? buildThumbnailStorageKey(doc.storageKey) : doc.storageKey
  if (!key) throw new NotFoundError('Image not available')

  let body
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: resolveDocumentBucket(doc.storageBucket), Key: key })
    )
    // Mirror the mint-side guard: an object that truncated to 0 bytes between
    // the HEAD check and this GET (or reached here on a directly-shared signed
    // URL) decodes to nothing — serve the placeholder, not optimizer poison.
    if ((object?.ContentLength ?? 0) <= 0) throw new NotFoundError('Image not available')
    body = object.Body
  } catch (error) {
    // A document with no generated thumbnail lands here; the card reads the 404
    // as "no thumbnail" and shows its warm placeholder.
    if (error instanceof NotFoundError) throw error
    throw new NotFoundError('Image not available')
  }
  if (!body) throw new NotFoundError('Image not available')

  return new Response(body.transformToWebStream(), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      // One token window. The optimizer keeps no copy (`next.config.ts`) but
      // forwards this max-age to the browser, so it bounds how long a picture
      // stays visible without this check running again.
      'Cache-Control': DOCUMENT_IMAGE_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
