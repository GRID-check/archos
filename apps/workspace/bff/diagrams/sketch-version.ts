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
 *
 * ## The marks go on with it
 *
 * A Skizze's open and proposed marks name the elements they are about, and the
 * save carries them onto the new Fassung in its own transaction, their boxes
 * drawn again from the new scene (`lib/annotations/sketch-carry.ts`, run by
 * {@link insertPublishedVersion} on every path that publishes). Once it
 * committed, the same hook every publish runs tells the room
 * (`lib/documents/current-version.ts`): the carried marks, `scene.saved`, and
 * `version.published` for the previews.
 *
 * ## A save over a released Fassung is news
 *
 * Work in progress stays silent. A save that supersedes a Fassung released
 * through Freigabe (`approvedBy` set) is not: the office relied on that one, so
 * its followers get the revision notice an upload sends (`./revision-notify`),
 * once, for the save that left it.
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
import type { MovedSketchMarks, NextSketch } from '@/lib/annotations/sketch-carry'
import { versionBecameCurrent } from '@/lib/documents/current-version'
import { announceNewRevision } from '@/lib/documents/revision-notify'
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
  /** A Skizze's new scene: its marks go on with the Fassung, placed on it again. Absent for its PDF. */
  sketch?: NextSketch
  /** A Skizze's scene hash and the saving tab, for the room's `scene.saved`. */
  room?: { sceneHash: number; peerId: string | null }
}

/** The Fassung written, and the pinned marks that went onto it. */
export type NextVersion = DocumentVersion & { carried: MovedSketchMarks }

/** Record the filed bytes as Fassung 1 when the document has no version yet; the expectation it leaves. */
async function recordFiledBytes(document: Document, expected: PublishedVersionExpectation): Promise<PublishedVersionExpectation> {
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
    // A derived write (the PDF beside a Skizze) checks its source below; the filed bytes only need there to be none yet.
    expected.of === undefined ? expected : { publishedVersionId: null },
  )
  return expected.of === undefined ? { publishedVersionId: version.id } : expected
}

async function announce(input: NextVersionInput, version: DocumentVersion, superseded: DocumentVersion[], carried: MovedSketchMarks) {
  const { session, document, request } = input
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
  await versionBecameCurrent({ session, document, version, carried, scene: input.room })
  const released = superseded.find((row) => Boolean(row.approvedBy))
  if (!input.sketch || !released) return
  void announceNewRevision({
    organizationId: session.organizationId,
    actorUserId: session.userId,
    newerId: document.id,
    olderId: document.id,
    versionId: version.id,
    previousUploaderIds: [released.createdBy],
  })
}

/** Store the bytes under their own key and publish them as the document's next Fassung. */
export async function publishNextVersion(input: NextVersionInput): Promise<NextVersion> {
  const { session, document, bytes, contentType } = input
  await assertWithinStorageQuota(session.organizationId, bytes.byteLength)
  // The filed bytes recorded as Fassung 1 are the same drawing: its marks keep their boxes.
  const expected = await recordFiledBytes(document, input.expected)

  const storageBucket = await resolveVersionBucket(session.organizationId)
  // The number in the key is a hint (`versionWriteKey`); the write id keeps two writers apart.
  const hint = await nextVersionNumber(document.id, session.organizationId)
  const storageKey = versionWriteKey(document.storageKey, hint, newVersionWriteId())
  await s3Client.send(new PutObjectCommand({ Bucket: storageBucket, Key: storageKey, Body: bytes, ContentType: contentType }))

  let published: Awaited<ReturnType<typeof insertPublishedVersion>>
  try {
    published = await insertPublishedVersion(
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
      input.sketch ?? null,
    )
  } catch (error) {
    // Refused (a newer Fassung, the document gone): nothing names these bytes.
    await discardObject(storageBucket, storageKey)
    throw error
  }
  // The Fassung is committed: an audit or hint that fails now must not answer the save as failed,
  // or the editor's retry writes a second Fassung of the same scene.
  const { version, superseded, carried } = published
  await announce(input, version, superseded, carried).catch((error: unknown) =>
    console.error('[diagrams] a Fassung was published and not announced', {
      documentId: document.id,
      versionId: version.id,
      cause: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
    })
  )
  return { ...version, carried }
}
