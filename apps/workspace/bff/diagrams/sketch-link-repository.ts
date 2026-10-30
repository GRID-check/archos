/**
 * The rows a Skizze's links name, read in one query per kind and document
 * (`sketch-link-resolve.ts`). Each is keyed by a document the resolver read
 * through `getAccessibleDocument` first, and returns only what a link shows:
 * an Anmerkung's first words and status, never its thread; a Fassung's number
 * and what its screening needs, never its bytes.
 */

import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentAnnotations } from '@/lib/db/schema/document-annotations'
import { documentVersions, type DocumentVersion } from '@/lib/db/schema/document-versions'
import { withTenant } from '@/lib/db/tenant-context'

export type PinnedVersionRow = Pick<DocumentVersion, 'id' | 'versionNumber' | 'state' | 'contentHash' | 'screenedHash'>

/** The Fassungen of one document a sketch's links pin, by id. */
export async function listPinnedVersions(organizationId: string, documentId: string, versionIds: readonly string[]): Promise<PinnedVersionRow[]> {
  if (versionIds.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
    .select({
      id: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
      state: documentVersions.state,
      contentHash: documentVersions.contentHash,
      screenedHash: documentVersions.screenedHash,
    })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.organizationId, organizationId),
        eq(documentVersions.documentId, documentId),
        inArray(documentVersions.id, [...versionIds])
      )
    )
    .limit(versionIds.length)
  )
}

export interface AnnotationHeadRow {
  id: string
  body: string
  status: 'proposed' | 'open' | 'resolved' | 'dismissed'
  kind: 'hint' | 'question' | 'defect'
}

/** The Anmerkungen of one document a sketch's links name: body, status and kind, no thread. */
export async function listAnnotationHeads(organizationId: string, documentId: string, annotationIds: readonly string[]): Promise<AnnotationHeadRow[]> {
  if (annotationIds.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({ id: documentAnnotations.id, body: documentAnnotations.body, status: documentAnnotations.status, kind: documentAnnotations.kind })
      .from(documentAnnotations)
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId),
          inArray(documentAnnotations.id, [...annotationIds])
        )
      )
      .limit(annotationIds.length)
  )
}
