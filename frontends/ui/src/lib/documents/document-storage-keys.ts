/**
 * Where a document's objects are stored, and presigned uploads for the backend's derived images
 * and page text.
 */

import 'server-only'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { presignForBackend, buildImageStorageKey, buildPageTextStorageKey } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { findStorageKeyByCollectionAndFilename, type StoredDocumentFile, findStorageKeyByIdAndCollection, findPageTextTarget } from './repository'

/**
 * One presigned PUT slot for the `imageIndex`-th raster the ingest pipeline
 * cut out of a document, plus the key it will land on.
 *
 * Issued per image, on request, rather than as a batch in the ingest body:
 * how many rasters a PDF holds is unknown until extraction has run, most
 * documents hold none, and every pre-issued URL is a live write credential
 * that would ride along unused. The index is the only free variable —
 * `buildImageStorageKey` builds the key from the document's OWN storage key
 * and refuses an index at or past `MAX_STORED_IMAGES_PER_DOCUMENT`, which is
 * how the per-document ceiling is enforced: the backend stops at the first
 * refusal. Null when the document is unknown or the index is out of range.
 */
export async function presignDocumentImageUpload(
  documentId: string,
  collectionName: string,
  imageIndex: number,
  organizationId?: string
): Promise<{ uploadUrl: string; storageKey: string } | null> {
  const doc = await findStorageKeyByIdAndCollection(documentId, collectionName, organizationId)
  if (!doc) return null
  const storageKey = buildImageStorageKey(doc.storageKey, imageIndex)
  if (!storageKey) return null
  const uploadUrl = await presignForBackend(
    new PutObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: storageKey,
      ContentType: 'image/jpeg',
    }),
    3600
  )
  return { uploadUrl, storageKey }
}

/**
 * One presigned PUT for a part of a version's stored page text (ADR-0134), with the row's id,
 * version and content hash, which the pipeline writes into `index.json` so the reader can refuse
 * a file that is not this version's. Null when the row is unknown or the part is not one of
 * `PAGE_TEXT_PARTS`; the pipeline then stores nothing.
 */
export async function presignDocumentPageTextUpload(
  documentId: string,
  collectionName: string,
  part: string,
  organizationId?: string
): Promise<{ uploadUrl: string; storageKey: string; documentId: string; version: number | null; contentHash: string | null } | null> {
  const doc = await findPageTextTarget(documentId, collectionName, organizationId)
  if (!doc) return null
  const storageKey = buildPageTextStorageKey(doc.storageKey, part)
  if (!storageKey) return null
  const uploadUrl = await presignForBackend(
    new PutObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: storageKey,
      ContentType: part.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8',
    }),
    3600
  )
  return { uploadUrl, storageKey, documentId, version: doc.version, contentHash: doc.contentHash }
}

/**
 * Where the `imageIndex`-th stored raster of a `(collection, filename)` pair
 * lives — the read half of {@link presignDocumentImageUpload}, for the
 * backend's `look` tool. The key is built from the owning
 * document's row, never taken from the caller, so a derived read can only ever
 * name an object under that document's prefix. Null when the pair is unknown
 * or the index is out of range; the tool degrades to a text answer.
 */
export async function findDocumentImageStorageKey(
  collectionName: string,
  filename: string,
  imageIndex: number,
  organizationId?: string
): Promise<{ storageKey: string; storageBucket: string | null; contentType: string } | null> {
  const doc = await findStorageKeyByCollectionAndFilename(collectionName, filename, organizationId)
  if (!doc) return null
  const storageKey = buildImageStorageKey(doc.storageKey, imageIndex)
  if (!storageKey) return null
  return { storageKey, storageBucket: doc.storageBucket, contentType: 'image/jpeg' }
}

export async function findDocumentStorageKey(
  collectionName: string,
  filename: string,
  organizationId?: string
): Promise<StoredDocumentFile | null> {
  return findStorageKeyByCollectionAndFilename(collectionName, filename, organizationId)
}
