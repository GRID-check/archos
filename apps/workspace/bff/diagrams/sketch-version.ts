/**
 * New bytes for a filed diagram document, recorded as its next Fassung
 * (ADR-0148).
 *
 * ## Why not `createDocumentVersion` with `op: 'upload'`
 *
 * That transition is a person's re-upload, and its effects say so: it
 * announces a new revision (`document.new_revision` in the inbox of everyone on
 * the document) and its storage admission resets the row to `uploaded`, unscreened,
 * as a person's new bytes must be. A Skizze is saved far more often than a file is
 * uploaded, every save is a Fassung, and announcing each would flood inboxes; its
 * row is machine-authored, `stored` and never ingested, and must stay so.
 *
 * So this records the version through the same repository write every published
 * version goes through, {@link insertPublishedVersion} (supersede, insert, move
 * the pointer, one transaction, under the per-document lock), and runs the two
 * effects of the upload row that hold here: the audit event and the event hint.
 * Its permission is the upload row's, `project:documents:write` AND
 * `project:edit`, which the caller's `getAccessibleDocument(…, 'write')` has
 * already asked, folder write included.
 *
 * ## A sketch filed before it had Fassungen
 *
 * Filing (`fileGeneratedDocument`) writes no `document_versions` row. The first
 * save therefore records the bytes the document already holds as Fassung 1,
 * authored and published by whoever filed it, at the time it was filed, and the
 * new bytes as Fassung 2. Without that, the pointer move would orphan the filed
 * object and the timeline would start at the edit.
 */

import 'server-only'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { filedInOf } from '@/lib/audit/document-names'
import { contentDigest } from '@/lib/documents/content-digest'
import { documentShelf } from '@/lib/documents/shelf'
import { publishShelfChanged } from '@/lib/documents/shelf-live'
import { newVersionWriteId, resolveVersionBucket, versionWriteKey } from '@/lib/documents/version-content'
import { insertPublishedVersion, listDocumentVersions, nextVersionNumber } from '@/lib/documents/version-repository'
import type { PublishedVersionExpectation } from '@/lib/documents/published-guard'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { Document } from '@/lib/db/schema/documents'
import { publishToUsers } from '@/lib/events/bus'
import { s3Client } from '@/lib/s3'
import { discardObject } from '@/lib/storage/discard'
import { assertWithinStorageQuota } from '@/lib/storage/service'

export interface NextVersionInput {
  session: AuthorizedSession
  /** The document, read by the caller through `getAccessibleDocument(…, 'write')`. */
  document: Document
  bytes: Uint8Array
  contentType: string
  /** The Fassung the caller's change starts from; a newer one is a 409. */
  expected: PublishedVersionExpectation
  request?: Request
}

/** Record the filed bytes as Fassung 1 when the document has no version yet; the expectation it leaves. */
async function recordFiledBytes(
  document: Document,
  expected: PublishedVersionExpectation,
): Promise<PublishedVersionExpectation> {
  if (document.publishedVersionId !== null || !document.storageKey) return expected
  const existing = await listDocumentVersions(document.id, document.organizationId)
  if (existing.length > 0) return expected
  const { version } = await insertPublishedVersion(
    {
      organizationId: document.organizationId,
      documentId: document.id,
      projectId: document.projectId,
      storageKey: document.storageKey,
      storageBucket: document.storageBucket,
      contentType: document.contentType,
      fileSize: document.fileSize,
      contentHash: document.contentHash,
      createdBy: document.createdBy,
      state: 'published',
      origin: 'upload',
      publishedBy: document.createdBy,
      publishedAt: document.createdAt,
    },
    expected,
  )
  return { publishedVersionId: version.id }
}

async function announce(session: AuthorizedSession, document: Document, version: DocumentVersion, request?: Request) {
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.version.published',
    targetType: 'document',
    targetId: document.id,
    filedIn: filedInOf(document),
    metadata: {
      versionId: version.id,
      versionNumber: version.versionNumber,
      state: version.state,
      projectId: document.projectId ?? '',
      withComment: false,
    },
    request,
  })
  await publishToUsers([session.userId], {
    kind: 'document.version.changed',
    documentId: document.id,
    versionId: version.id,
    state: version.state,
  })
  publishShelfChanged(session.organizationId, documentShelf(document))
}

/** Store the bytes under their own key and publish them as the document's next Fassung. */
export async function publishNextVersion(input: NextVersionInput): Promise<DocumentVersion> {
  const { session, document, bytes, contentType } = input
  await assertWithinStorageQuota(session.organizationId, bytes.byteLength)
  const expected = await recordFiledBytes(document, input.expected)

  const storageBucket = await resolveVersionBucket(session.organizationId)
  // The number in the key is a hint (`versionWriteKey`); the write id keeps two writers apart.
  const hint = await nextVersionNumber(document.id, session.organizationId)
  const storageKey = versionWriteKey(document.storageKey, hint, newVersionWriteId())
  await s3Client.send(new PutObjectCommand({ Bucket: storageBucket, Key: storageKey, Body: bytes, ContentType: contentType }))

  let version: DocumentVersion
  try {
    ;({ version } = await insertPublishedVersion(
      {
        organizationId: session.organizationId,
        documentId: document.id,
        projectId: document.projectId,
        storageKey,
        storageBucket,
        contentType,
        fileSize: bytes.byteLength,
        contentHash: contentDigest(bytes),
        createdBy: session.userId,
        state: 'published',
        origin: 'upload',
        publishedBy: session.userId,
        publishedAt: new Date(),
      },
      expected,
    ))
  } catch (error) {
    // Refused (a newer Fassung, the document gone): nothing names these bytes.
    await discardObject(storageBucket, storageKey)
    throw error
  }
  await announce(session, document, version, input.request)
  return version
}
