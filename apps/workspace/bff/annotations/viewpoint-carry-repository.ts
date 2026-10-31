/**
 * The SQL of carrying a mark on a model to a newer Fassung (migration 0195,
 * `./viewpoint-carry.ts`): each write one transaction, compared and swapped
 * against the mark as the service read it, so a colleague's close or carry in
 * the same moment wins and nothing is half written.
 *
 * No authorization here; the service owns that and read both documents for
 * writing. The element reads join `documents` behind the reader's
 * `documentVisibleTo` (`findMissingElements`).
 */

import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import { annotationViewpoints } from '@/lib/db/schema/annotation-viewpoints'
import { documentAnnotations, type DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import { documentVersions } from '@/lib/db/schema/document-versions'
import { withTenant } from '@/lib/db/tenant-context'
import type { DocumentReader } from '@/lib/documents/visibility'
import { allocateNumbers } from './numbering'
import { AlreadyCarriedError, type NewAnnotationValues } from './repository'
import type { carriedViewpointValues } from './viewpoint-carry-plan'
import { findMissingElements } from './viewpoint-repository'

/** A new viewpoint as the plan made it. */
export type CarriedViewpointValues = ReturnType<typeof carriedViewpointValues>

/** The mark as the service read it: what the swap compares against. */
export interface ReadMark {
  id: string
  status: DocumentAnnotationRow['status']
  versionId: string | null
  viewpointId: string
}

/** Thrown inside a transaction to roll it back when the swap found the mark moved. */
class MarkMoved extends Error {}

/** How many GlobalIds one element query asks about. */
const PRESENCE_CHUNK = 1000

/** Which of these GlobalIds the model has, as `reader` may see its document; bounded by what the caller asks. */
export async function presentGlobalIds(
  organizationId: string,
  modelId: string,
  globalIds: readonly string[],
  reader: DocumentReader
): Promise<Set<string>> {
  const present = new Set<string>()
  for (let offset = 0; offset < globalIds.length; offset += PRESENCE_CHUNK) {
    const chunk = globalIds.slice(offset, offset + PRESENCE_CHUNK)
    const missing = new Set(await findMissingElements(organizationId, modelId, chunk, reader))
    for (const id of chunk) if (!missing.has(id)) present.add(id)
  }
  return present
}

/** The number of one Fassung of a document („Fassung 4“), or null. The service read the document. */
export async function versionNumberOf(organizationId: string, documentId: string, versionId: string | null): Promise<number | null> {
  if (!versionId) return null
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ number: documentVersions.versionNumber })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.organizationId, organizationId),
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.id, versionId)
        )
      )
      .limit(1)
  )
  return row ? Number(row.number) : null
}

/** The swap's condition: the mark is where, as what and on which viewpoint the service read it. */
const asRead = (organizationId: string, documentId: string, mark: ReadMark) =>
  and(
    eq(documentAnnotations.organizationId, organizationId),
    eq(documentAnnotations.documentId, documentId),
    eq(documentAnnotations.id, mark.id),
    eq(documentAnnotations.status, mark.status),
    eq(documentAnnotations.viewpointId, mark.viewpointId),
    sql`${documentAnnotations.versionId} IS NOT DISTINCT FROM ${mark.versionId}`
  )

/**
 * The mark goes on with its own document's current Fassung, keeping its
 * number and thread: with `viewpoint`, onto that new viewpoint (written here,
 * on the same document), its loss cleared; without, it keeps its viewpoint and
 * says its elements are gone (`anchor_lost_at`, kept from an earlier loss).
 * Null when the mark moved since the service read it; the new viewpoint is
 * then not written either.
 */
export async function carryViewpointMarkInPlace(input: {
  organizationId: string
  documentId: string
  mark: ReadMark
  toVersionId: string | null
  viewpoint: CarriedViewpointValues | null
  carriedBy: string
}): Promise<DocumentAnnotationRow | null> {
  const { organizationId, documentId, mark, toVersionId, viewpoint } = input
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .transaction(async (tx) => {
        if (viewpoint) {
          await tx
            .insert(annotationViewpoints)
            .values({ ...viewpoint, organizationId, documentId, versionId: toVersionId, createdBy: input.carriedBy })
        }
        const [row] = await tx
          .update(documentAnnotations)
          .set({
            versionId: toVersionId,
            ...(viewpoint
              ? { viewpointId: viewpoint.id, anchorLostAt: null }
              : { anchorLostAt: sql`coalesce(${documentAnnotations.anchorLostAt}, now())` }),
            updatedAt: new Date(),
          })
          .where(asRead(organizationId, documentId, mark))
          .returning()
        if (!row) throw new MarkMoved()
        return row
      })
      .catch((error: unknown) => {
        if (error instanceof MarkMoved) return null
        throw error
      })
  )
}

/**
 * A mark of a document another one replaced says its elements are gone from
 * the replacing document's model, and stays where it is with its viewpoint:
 * there is nothing on the new model to set it on. Null when it moved since.
 */
export async function markViewpointAnchorLost(input: {
  organizationId: string
  documentId: string
  mark: ReadMark
}): Promise<DocumentAnnotationRow | null> {
  const { organizationId, documentId, mark } = input
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(documentAnnotations)
      .set({ anchorLostAt: sql`coalesce(${documentAnnotations.anchorLostAt}, now())`, updatedAt: new Date() })
      .where(and(asRead(organizationId, documentId, mark), isNull(documentAnnotations.delegatedBy)))
      .returning()
  )
  return row ?? null
}

/**
 * The open mark of a replaced model goes on as a mark of the replacing one,
 * as `carryAnnotationToDocument` carries a page mark (migration 0151), in ONE
 * transaction: numbered on `target`, its viewpoint written there, the mark set
 * on it with its text, author, Zuständige and date and `carried_from_id`
 * pointing back; the source closed (`resolved`, by `closedBy`), compared and
 * swapped on being open and not delegated. Null when the source moved since;
 * a second carry is refused by the unique index ({@link AlreadyCarriedError}).
 */
export async function carryViewpointMarkAcross(input: {
  organizationId: string
  source: DocumentAnnotationRow
  target: { documentId: string; versionId: string | null }
  values: Pick<NewAnnotationValues, 'mentions' | 'assigneeUserId'>
  viewpoint: CarriedViewpointValues
  closedBy: string
}): Promise<DocumentAnnotationRow | null> {
  const { organizationId, source, target, viewpoint } = input
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .transaction(async (tx) => {
        const number = await allocateNumbers(tx, organizationId, target.documentId, 1)
        const now = new Date()
        const [closed] = await tx
          .update(documentAnnotations)
          .set({ status: 'resolved', closedBy: input.closedBy, closedAt: now, updatedAt: now })
          .where(
            and(
              eq(documentAnnotations.organizationId, organizationId),
              eq(documentAnnotations.documentId, source.documentId),
              eq(documentAnnotations.id, source.id),
              eq(documentAnnotations.status, 'open'),
              isNull(documentAnnotations.delegatedBy)
            )
          )
          .returning({ id: documentAnnotations.id })
        if (!closed) return null
        await tx.insert(annotationViewpoints).values({
          ...viewpoint,
          organizationId,
          documentId: target.documentId,
          versionId: target.versionId,
          createdBy: input.closedBy,
        })
        const [row] = await tx
          .insert(documentAnnotations)
          .values({
            organizationId,
            documentId: target.documentId,
            versionId: target.versionId,
            number,
            anchorKind: 'viewpoint',
            viewpointId: viewpoint.id,
            page: null,
            shape: null,
            x: null,
            y: null,
            w: null,
            h: null,
            kind: source.kind,
            body: source.body,
            mentions: input.values.mentions ?? [],
            basis: source.basis,
            authorKind: source.authorKind,
            status: 'open',
            assigneeUserId: input.values.assigneeUserId,
            dueOn: source.dueOn,
            createdBy: source.createdBy,
            acceptedBy: source.acceptedBy,
            acceptedAt: source.acceptedAt,
            carriedFromId: source.id,
          })
          .returning()
        return row
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'uniq_document_annotations_carried_from')) throw new AlreadyCarriedError()
        throw error
      })
  )
}
