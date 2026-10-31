/**
 * The snapshot of a viewpoint: the image the viewer showed when the mark was
 * set (migration 0193). Bytes live in the object store under the document's
 * `_bim/viewpoints/` prefix, so `deleteBimDerivedObjects` sweeps them with the
 * document; the row keeps the key, the type and the size.
 *
 * What arrives is base64 in a JSON body: the bytes are checked here against
 * their magic number, never taken on the claim of `contentType`.
 */

import 'server-only'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { buildBimDerivedKeys } from '@/lib/bim/service'
import type { Document } from '@/lib/db/schema/documents'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { MAX_SNAPSHOT_BYTES, type SnapshotContentType, type SnapshotInput } from './viewpoint-types'

const MAGIC: Record<SnapshotContentType, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
}

const EXTENSION: Record<SnapshotContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' }

/** A snapshot ready to store: the bytes, checked, and where they go. */
export interface SnapshotUpload {
  bucket: string
  key: string
  contentType: SnapshotContentType
  body: Buffer
}

const refuse = (message: string) => new UnprocessableError(message, { reason: 'bad_snapshot' })

/** The bytes the request carries, or a 422 `bad_snapshot`: empty, over 1.5 MB, or not the image `contentType` says. */
export function decodeSnapshot(snapshot: SnapshotInput): Buffer {
  // Base64 holds 3 bytes in 4 characters: a string this long cannot decode within the cap.
  if (snapshot.dataBase64.length > Math.ceil((MAX_SNAPSHOT_BYTES * 4) / 3) + 4) {
    throw refuse('The snapshot is larger than 1.5 MB.')
  }
  const body = Buffer.from(snapshot.dataBase64, 'base64')
  if (body.length === 0) throw refuse('The snapshot is empty.')
  if (body.length > MAX_SNAPSHOT_BYTES) throw refuse('The snapshot is larger than 1.5 MB.')
  const magic = MAGIC[snapshot.contentType]
  if (!magic.every((byte, index) => body[index] === byte)) {
    throw refuse(`The snapshot is not a ${snapshot.contentType} image.`)
  }
  return body
}

/** Where a viewpoint's snapshot is stored, or a 422 for a document whose own key has no directory. */
export function snapshotUploadFor(doc: Pick<Document, 'storageKey' | 'storageBucket'>, viewpointId: string, snapshot: SnapshotInput): SnapshotUpload {
  return snapshotUploadOf(doc, viewpointId, snapshot.contentType, decodeSnapshot(snapshot))
}

/**
 * Where checked bytes are stored: the caller has judged them by their magic
 * number and bounded them (the request's {@link decodeSnapshot}, or a BCF
 * file's picture in `lib/bim/bcf-read.ts`).
 */
export function snapshotUploadOf(
  doc: Pick<Document, 'storageKey' | 'storageBucket'>,
  viewpointId: string,
  contentType: SnapshotContentType,
  body: Buffer
): SnapshotUpload {
  const keys = buildBimDerivedKeys(doc.storageKey)
  if (!keys) throw refuse('This model has nowhere to keep a snapshot.')
  return {
    bucket: resolveDocumentBucket(doc.storageBucket),
    key: `${keys.prefix}viewpoints/${viewpointId}.${EXTENSION[contentType]}`,
    contentType,
    body,
  }
}

export async function putSnapshot(upload: SnapshotUpload): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: upload.bucket, Key: upload.key, Body: upload.body, ContentType: upload.contentType })
  )
}

/** Best effort: a mark that failed to save must not leave its picture behind, and a failed cleanup is only a stray object the document's sweep removes. */
export async function discardSnapshot(upload: Pick<SnapshotUpload, 'bucket' | 'key'>): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: upload.bucket, Key: upload.key })).catch(() => undefined)
}

/** Best effort: the object of a viewpoint that went with its mark. */
export const discardStoredSnapshot = (doc: Pick<Document, 'storageBucket'>, key: string): Promise<void> =>
  discardSnapshot({ bucket: resolveDocumentBucket(doc.storageBucket), key })

/** The stored bytes of a snapshot. */
export async function readSnapshot(doc: Pick<Document, 'storageBucket'>, key: string): Promise<Uint8Array | null> {
  const response = await s3Client
    .send(new GetObjectCommand({ Bucket: resolveDocumentBucket(doc.storageBucket), Key: key }))
    .catch((error: unknown) => {
      // The row names an object the store no longer has (swept, or never written): the snapshot is not there.
      if (error instanceof Error && error.name === 'NoSuchKey') throw new NotFoundError()
      throw error
    })
  return response.Body ? response.Body.transformToByteArray() : null
}
