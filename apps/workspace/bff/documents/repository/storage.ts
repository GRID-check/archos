/** Stored-file keys, page text targets and collection existence. */

import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withOptionalTenant } from '@/lib/db/tenant-context'
import { documentVersions } from '@/lib/db/schema/document-versions'
import { documents } from '@/lib/db/schema/documents'
import { documentVisibleTo, internalRead, SCREENED_ONLY } from '../visibility'

/** Where a document's current bytes are, and which Fassung they are (`versionId`, null before a publish). */
export interface StoredDocumentFile {
  id: string
  storageKey: string
  storageBucket: string | null
  contentType: string | null
  versionId: string | null
}

export async function findStorageKeyByCollectionAndFilename(
  collectionName: string,
  filename: string,
  organizationId?: string,
): Promise<StoredDocumentFile | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-file lookup: the service-token caller identifies the row by its ' +
      'unguessable collection name and carries no organization',
    () =>
      db
        .select({
          // The id lets a tool that resolved a file by name act on the
          // document through the routes keyed by id (its Anmerkungen).
          id: documents.id,
          storageKey: documents.storageKey,
          // The agent tier calls get_object directly (ADR-0039), so it needs
          // the bucket as well as the key — recomputing it there would be a
          // second implementation of the naming rule in a third language.
          storageBucket: documents.storageBucket,
          contentType: documents.contentType,
          // The Fassung these bytes are: the published version the item's
          // storage columns mirror. A look card records it, so an old answer
          // keeps showing the Fassung that was read (ADR-0128); null before
          // anything was published.
          versionId: documents.publishedVersionId,
        })
        .from(documents)
        .where(
          and(
            eq(documents.collectionName, collectionName),
            eq(documents.filename, filename),
            // See the note above: this is a byte-serving path reachable with
            // model-supplied arguments. A machine-authored row must not resolve.
            eq(documents.authoredBy, 'user'),
            // Nor one the content gate has not passed (ADR-0086): a held file
            // has not reached a model, and a name the model was told must not
            // reach it through here either. Nobody's own uploads count.
            documentVisibleTo(SCREENED_ONLY),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(1),
  )
  return row ?? null
}

/**
 * The storage location of a document the ingest pipeline is working on,
 * addressed the way the pipeline knows it: by the `document_id` the dispatch
 * sent AND the collection it was sent for. Both must match — the id alone is
 * unguessable, but requiring the collection means a caller holding one
 * document's id cannot mint derived objects under it from another shelf's
 * ingest. Same row filters as {@link findStorageKeyByCollectionAndFilename}:
 * live, user-authored (this feeds a presigned WRITE under the document's
 * prefix), and org-narrowed when the caller carries one.
 */
/**
 * The row a version's stored page text is written for (ADR-0134): its storage key, bucket and content
 * hash, and the number of the version those mirror. Same lookup and same guards as
 * {@link findStorageKeyByIdAndCollection}; the version comes from the published version it points at.
 */
export async function findPageTextTarget(
  documentId: string,
  collectionName: string,
  organizationId?: string,
): Promise<{ storageKey: string; storageBucket: string | null; contentHash: string | null; version: number | null } | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal page-text presign: the service-token caller identifies the row by its ' +
      'unguessable document id and collection name and carries no organization',
    () =>
      db
        .select({
          storageKey: documents.storageKey,
          storageBucket: documents.storageBucket,
          contentHash: documents.contentHash,
          version: documentVersions.versionNumber,
        })
        .from(documents)
        .leftJoin(
          documentVersions,
          and(eq(documentVersions.id, documents.publishedVersionId), eq(documentVersions.documentId, documents.id)),
        )
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.collectionName, collectionName),
            eq(documents.authoredBy, 'user'),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
            // The pipeline writes the text after its screen; the row is held until it finishes.
            documentVisibleTo(internalRead('ingest')),
          ),
        )
        .limit(1),
  )
  if (!row?.storageKey) return null
  return {
    storageKey: row.storageKey,
    storageBucket: row.storageBucket ?? null,
    contentHash: row.contentHash ?? null,
    version: row.version === null || row.version === undefined ? null : Number(row.version),
  }
}

export async function findStorageKeyByIdAndCollection(
  documentId: string,
  collectionName: string,
  organizationId?: string,
): Promise<{ storageKey: string; storageBucket: string | null } | null> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-image presign: the service-token caller identifies the row by its ' +
      'unguessable document id and collection name and carries no organization',
    () =>
      db
        .select({ storageKey: documents.storageKey, storageBucket: documents.storageBucket })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.collectionName, collectionName),
            eq(documents.authoredBy, 'user'),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
            // The pipeline asks about the file it is reading, which is held
            // until it finishes; the job writes a raster only after its screen.
            documentVisibleTo(internalRead('ingest')),
          ),
        )
        .limit(1),
  )
  return row ?? null
}

/**
 * Whether the document an ingest was dispatched for still exists, addressed
 * the way {@link findStorageKeyByIdAndCollection} addresses it: by id AND
 * collection, org-narrowed when the caller carries one. Asked by the ingest
 * pipeline once a file is indexed, so it can take back out the chunks of a
 * document deleted while it ran (`document_presence` in the knowledge layer).
 *
 * No authorship predicate, unlike the presign lookup. A published
 * machine-authored version IS ingested (ADR-0054's publish door), and
 * answering "gone" for it would have the pipeline discard a live document.
 *
 * A document filed in a folder that is in the Papierkorb (or purged) is gone
 * for this question: its chunks were purged when the folder went to the bin,
 * and an ingest that was still running then must take back out what it
 * inserted afterwards. A restore dispatches it again.
 */
export async function documentExistsInCollection(
  documentId: string,
  collectionName: string,
  organizationId?: string,
): Promise<boolean> {
  const db = getDb()
  const [row] = await withOptionalTenant(
    organizationId,
    'internal document-exists: the ingest pipeline identifies the row by its unguessable ' +
      'document id and collection name, and carries no organization for a project collection',
    () =>
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.collectionName, collectionName),
            ...(organizationId ? [eq(documents.organizationId, organizationId)] : []),
            sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`,
            // The pipeline asks about the file it just indexed, still held.
            documentVisibleTo(internalRead('ingest')),
          ),
        )
        .limit(1),
  )
  return row !== undefined
}

/**
 * Recording a document goes through `insertDocumentWithinQuota`
 * (`@/lib/storage/repository`), not through a plain insert here.
 *
 * There used to be an `insertDocument` in this module. It is gone on purpose: an
 * organization's storage quota is only a ceiling if EVERY insert of a `documents`
 * row is gated by it, and a second, ungated way in is how a ceiling stops being
 * one. Anything that needs to create a document row calls the admitting insert
 * and handles its refusal.
 */
