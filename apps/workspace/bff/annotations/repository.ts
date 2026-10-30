/**
 * Anmerkungen repository — the SQL over `document_annotations` and
 * `document_annotation_replies` (migration 0138).
 *
 * No authorization here; the service owns that. Every read is keyed by a
 * document the service already loaded through its reader
 * (`getAccessibleDocument`), or joins `documents` behind the reader's
 * `documentVisibleTo` ({@link tallyLiveMarks}), which is what
 * `documents/document-visibility.spec.ts` holds each function here to.
 */

import 'server-only'
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import type { DbTransaction } from '@/lib/db/executor'
import { documentAnnotationReplies, documentAnnotations, type DocumentAnnotationReplyRow, type DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import { documentVersions } from '@/lib/db/schema/document-versions'
import { documents } from '@/lib/db/schema/documents'
import { withTenant } from '@/lib/db/tenant-context'
import { documentVisibleTo, type DocumentReader } from '@/lib/documents/visibility'
import { allocateNumbers } from './numbering'
import { deleteViewpointRow } from './viewpoint-delete'
import { LIVE_ANNOTATION_STATUSES, MAX_ANNOTATIONS_PER_DOCUMENT, MAX_REPLIES_PER_ANNOTATION, type AnnotationAuthor, type AnnotationKind, type AnnotationShape, type AnnotationStatus, type MarkMention, type MarkTally } from './types'

/** The other end of a carry (migration 0151): a mark on another document, by its id, its document and its number. */
export interface CarryLink {
  annotationId: string
  documentId: string
  number: number
}

/**
 * A row with the number of the Fassung it was set on, its thread, and where it
 * was carried from or to. The two links name a mark of ANOTHER document: the
 * service shows them only to a reader who may open that document.
 */
export interface AnnotationRecord extends DocumentAnnotationRow {
  revisionNumber: number | null
  replies: DocumentAnnotationReplyRow[]
  /** The replaced document's mark this one went on from; absent from a fake that predates carrying. */
  carriedFrom?: CarryLink | null
  /** The replacing document's mark this one went on as; absent from a fake that predates carrying. */
  carriedTo?: CarryLink | null
}

/** The mark this one was carried from, and the one it was carried to (unique, so at most one). */
export const carriedSource = alias(documentAnnotations, 'carried_source')
export const carriedCopy = alias(documentAnnotations, 'carried_copy')

/** The columns every read of a mark selects; `project-repository.ts` selects them too. */
export const selection = {
  row: documentAnnotations,
  revisionNumber: documentVersions.versionNumber,
  fromId: carriedSource.id,
  fromDocumentId: carriedSource.documentId,
  fromNumber: carriedSource.number,
  toId: carriedCopy.id,
  toDocumentId: carriedCopy.documentId,
  toNumber: carriedCopy.number,
}

export { AnnotationLimitReachedError } from './numbering'

export type SelectedRow = {
  row: DocumentAnnotationRow
  revisionNumber: number | null
  fromId: string | null
  fromDocumentId: string | null
  fromNumber: number | null
  toId: string | null
  toDocumentId: string | null
  toNumber: number | null
}

const linkOf = (id: string | null, documentId: string | null, number: number | null): CarryLink | null =>
  id && documentId && number !== null ? { annotationId: id, documentId, number: Number(number) } : null

/** The threads of these marks, oldest reply first, each bounded. */
async function listReplies(organizationId: string, annotationIds: readonly string[]) {
  if (annotationIds.length === 0) return new Map<string, DocumentAnnotationReplyRow[]>()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(documentAnnotationReplies)
      .where(
        and(
          eq(documentAnnotationReplies.organizationId, organizationId),
          inArray(documentAnnotationReplies.annotationId, [...annotationIds])
        )
      )
      .orderBy(asc(documentAnnotationReplies.createdAt))
      .limit(annotationIds.length * MAX_REPLIES_PER_ANNOTATION)
  )
  const byAnnotation = new Map<string, DocumentAnnotationReplyRow[]>()
  for (const reply of rows) {
    const thread = byAnnotation.get(reply.annotationId) ?? []
    if (thread.length < MAX_REPLIES_PER_ANNOTATION) thread.push(reply)
    byAnnotation.set(reply.annotationId, thread)
  }
  return byAnnotation
}

export async function withThreads(organizationId: string, rows: SelectedRow[]): Promise<AnnotationRecord[]> {
  const threads = await listReplies(organizationId, rows.map(({ row }) => row.id))
  return rows.map(({ row, revisionNumber, ...links }) => ({
    ...row,
    revisionNumber: revisionNumber === null ? null : Number(revisionNumber),
    replies: threads.get(row.id) ?? [],
    carriedFrom: linkOf(links.fromId, links.fromDocumentId, links.fromNumber),
    carriedTo: linkOf(links.toId, links.toDocumentId, links.toNumber),
  }))
}

/** The joins every read of a mark makes: its Fassung's number, and both ends of a carry in the same organization. */
export const carryJoins = (organizationId: string) => ({
  source: and(eq(carriedSource.id, documentAnnotations.carriedFromId), eq(carriedSource.organizationId, organizationId)),
  copy: and(eq(carriedCopy.carriedFromId, documentAnnotations.id), eq(carriedCopy.organizationId, organizationId)),
})

/** Every Anmerkung on one document with its thread, by number. Bounded by {@link MAX_ANNOTATIONS_PER_DOCUMENT}. */
export async function listDocumentAnnotations(
  organizationId: string,
  documentId: string
): Promise<AnnotationRecord[]> {
  const db = getDb()
  const joins = carryJoins(organizationId)
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(selection)
      .from(documentAnnotations)
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
      .leftJoin(carriedSource, joins.source)
      .leftJoin(carriedCopy, joins.copy)
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId)
        )
      )
      .orderBy(asc(documentAnnotations.number))
      .limit(MAX_ANNOTATIONS_PER_DOCUMENT)
  )
  return withThreads(organizationId, rows)
}

/**
 * The live Anmerkungen of each of these documents, counted in ONE grouped
 * query for a listing page: how many are open, how many are Piloti's proposals
 * nobody decided on (told apart, because a proposal is not yet the office's
 * work), and how many of the open ones have `readerUserId` as Zuständige. That
 * third number is the
 * review's „Für Sie“ (`isForReader` over the live marks) in SQL: keep the two
 * equal, `repository.integration.spec.ts` asks both the same cases. Every
 * Fassung counts: a mark set on an earlier one is still work until somebody
 * closes it.
 *
 * The documents are joined and narrowed by the reader the listing was read
 * with (`documentVisibleTo`), so a held upload's marks are not counted for
 * anyone the upload is held from. A document without a live mark is absent.
 */
export async function tallyLiveMarks(
  organizationId: string,
  documentIds: readonly string[],
  reader: DocumentReader,
  readerUserId: string
): Promise<Map<string, MarkTally>> {
  if (documentIds.length === 0) return new Map()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        documentId: documentAnnotations.documentId,
        open: sql<number | string>`count(*) filter (where ${documentAnnotations.status} = 'open')`,
        proposed: sql<number | string>`count(*) filter (where ${documentAnnotations.status} = 'proposed')`,
        forYou: sql<number | string>`count(*) filter (where ${documentAnnotations.status} = 'open' and ${documentAnnotations.assigneeUserId} = ${readerUserId})`,
      })
      .from(documentAnnotations)
      .innerJoin(documents, eq(documents.id, documentAnnotations.documentId))
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documents.organizationId, organizationId),
          inArray(documentAnnotations.documentId, [...documentIds]),
          inArray(documentAnnotations.status, [...LIVE_ANNOTATION_STATUSES]),
          documentVisibleTo(reader)
        )
      )
      .groupBy(documentAnnotations.documentId)
      .limit(documentIds.length)
  )
  // `count(*)` is a bigint, which the driver hands over as a string.
  return new Map(
    rows.map((row) => [
      row.documentId,
      { open: Number(row.open), proposed: Number(row.proposed), forYou: Number(row.forYou) },
    ])
  )
}

/** One Anmerkung of one document with its thread, or null. */
export async function findDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string
): Promise<AnnotationRecord | null> {
  const db = getDb()
  const joins = carryJoins(organizationId)
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(selection)
      .from(documentAnnotations)
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
      .leftJoin(carriedSource, joins.source)
      .leftJoin(carriedCopy, joins.copy)
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId),
          eq(documentAnnotations.id, annotationId)
        )
      )
      .limit(1)
  )
  const [record] = await withThreads(organizationId, rows)
  return record ?? null
}

export interface NewAnnotationValues {
  page: number
  shape: AnnotationShape
  x: number
  y: number
  w: number | null
  h: number | null
  /** On a Skizze, the elements its box was derived from (migration 0192, `./sketch-place.ts`). */
  anchorElementIds?: string[] | null
  /** `sketch` when `anchorElementIds` is set, else `page` (migration 0193). */
  anchorKind?: 'page' | 'sketch'
  kind: AnnotationKind
  body: string
  /** Whom `body` mentions, as the service kept them (`./mentions.ts`); none when absent. */
  mentions?: MarkMention[]
  basis: string | null
  assigneeUserId: string | null
  dueOn: string | null
}

export interface NewAnnotationsInput {
  organizationId: string
  documentId: string
  versionId: string | null
  authorKind: AnnotationAuthor
  createdBy: string
  /**
   * Piloti only: the person who asked for exactly these marks, so they are born
   * `open`, taken over by that person in the same move. Absent, Piloti's marks
   * are born `proposed`.
   */
  acceptedBy?: string | null
  marks: readonly NewAnnotationValues[]
}

/**
 * Insert one or more Anmerkungen in ONE transaction, their numbers allocated
 * as max + 1 under a per-document advisory lock, so two people setting a mark
 * on one sheet at the same moment get 4 and 5 rather than one of them a 23505.
 * A person's mark is born `open`; Piloti's is born `proposed`, or `open` with
 * `accepted_by` when the asker asked for it (the CHECK
 * `…_piloti_needs_a_person` refuses Piloti's open mark without one). The count
 * is checked under the same lock, so the cap holds against a burst of
 * proposals too.
 */
export async function insertDocumentAnnotations(input: NewAnnotationsInput): Promise<DocumentAnnotationRow[]> {
  const db = getDb()
  const acceptedBy = input.authorKind === 'piloti' ? (input.acceptedBy ?? null) : null
  const status: AnnotationStatus = input.authorKind === 'piloti' && !acceptedBy ? 'proposed' : 'open'
  const acceptance = acceptedBy ? { acceptedBy, acceptedAt: new Date() } : {}
  return withTenant({ organizationId: input.organizationId }, () =>
    db.transaction(async (tx) => {
      const first = await allocateNumbers(tx, input.organizationId, input.documentId, input.marks.length)
      return tx
        .insert(documentAnnotations)
        .values(
          input.marks.map((mark, index) => ({
            ...mark,
            organizationId: input.organizationId,
            documentId: input.documentId,
            versionId: input.versionId,
            authorKind: input.authorKind,
            createdBy: input.createdBy,
            status,
            ...acceptance,
            number: first + index,
          }))
        )
        .returning()
    })
  )
}

/** Thrown when the mark was carried already: the unique index on `carried_from_id` refused a second copy. */
export class AlreadyCarriedError extends Error {}

/**
 * Carry one open mark of a replaced document onto the document that replaced
 * it (migration 0151), in ONE transaction: the mark is set again on `target`,
 * numbered there under the same per-document lock and cap as any new mark,
 * with its place, its text, whom it mentions, its author, its Zuständige and
 * its date, and `carried_from_id` pointing back; the source is closed
 * (`resolved`, by `closedBy`), compared and swapped on `open` and on nobody
 * having delegated it to Piloti. Null when the source is no longer open (a
 * colleague closed it first) or was delegated meanwhile; a second carry of
 * the same mark is refused by the unique index ({@link AlreadyCarriedError}).
 * Both documents were read for writing by the service.
 */
export async function carryAnnotationToDocument(input: {
  organizationId: string
  source: DocumentAnnotationRow
  target: { documentId: string; versionId: string | null }
  values: Pick<NewAnnotationValues, 'mentions' | 'assigneeUserId'>
  closedBy: string
}): Promise<DocumentAnnotationRow | null> {
  const { organizationId, source, target } = input
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
              // A mark Piloti works is not carried: its running turn writes on the source. The
              // service refuses one it read delegated; a delegation that lands after that read
              // is caught here, in the swap, and the carry is the same conflict as a close.
              isNull(documentAnnotations.delegatedBy)
            )
          )
          .returning({ id: documentAnnotations.id })
        if (!closed) return null
        const [row] = await tx
          .insert(documentAnnotations)
          .values({
            organizationId,
            documentId: target.documentId,
            versionId: target.versionId,
            number,
            page: source.page,
            shape: source.shape,
            x: source.x,
            y: source.y,
            w: source.w,
            h: source.h,
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

export interface AnnotationChanges {
  kind?: AnnotationKind
  body?: string
  /** Whom the new body mentions; changes only with the body. */
  mentions?: MarkMention[]
  basis?: string | null
  assigneeUserId?: string | null
  dueOn?: string | null
  /** A move of status carries its bookkeeping, so the CHECK's columns move together. */
  transition?: {
    status: AnnotationStatus
    acceptedBy?: string
    acceptedAt?: Date
    closedBy: string | null
    closedAt: Date | null
  }
  /** Piloti as the delegate (migration 0139): both set, or both cleared, as the CHECK holds. */
  delegation?: { delegatedBy: string; delegatedAt: Date } | { delegatedBy: null; delegatedAt: null }
  /**
   * The mark goes on with the document's current Fassung: `version_id` becomes
   * `to`, compared and swapped against `from` (the Fassung it was read on), so
   * two people carrying it at once move it once.
   */
  revision?: { from: string | null; to: string | null }
}

/**
 * Work that must commit or roll back with a write: the wake of Piloti the
 * write is the event of (`./wake.ts`), enqueued in the write's transaction.
 */
export type InTransaction<T> = (tx: DbTransaction, row: T) => Promise<void>

/**
 * Apply a change to one Anmerkung; null when it is gone, or when its status
 * is no longer `expectedStatus` (a colleague moved it first: compare and swap,
 * the way `document_versions` transitions are).
 */
export async function updateDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string,
  expectedStatus: AnnotationStatus,
  changes: AnnotationChanges,
  /** Runs in the update's transaction when a row was changed. */
  afterUpdate?: InTransaction<DocumentAnnotationRow>
): Promise<DocumentAnnotationRow | null> {
  const { transition, delegation, revision: revision, ...fields } = changes
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(documentAnnotations)
        .set({
          ...fields,
          ...(transition ?? {}),
          ...(delegation ?? {}),
          ...(revision ? { versionId: revision.to } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentAnnotations.organizationId, organizationId),
            eq(documentAnnotations.documentId, documentId),
            eq(documentAnnotations.id, annotationId),
            eq(documentAnnotations.status, expectedStatus),
            ...(revision ? [sql`${documentAnnotations.versionId} IS NOT DISTINCT FROM ${revision.from}`, ne(documentAnnotations.anchorKind, 'viewpoint')] : [])
          )
        )
        .returning()
      if (row && afterUpdate) await afterUpdate(tx, row)
      return row ?? null
    })
  )
}

/**
 * Delete one Anmerkung and its thread; whether a row went. Its number is not
 * reused while a higher one exists. `beforeDelete` runs in the delete's
 * transaction, before the row and its wakes go: the one moment the wake of a
 * delegation can still be read.
 */
export async function deleteDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string,
  beforeDelete?: (tx: DbTransaction) => Promise<void>
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      await beforeDelete?.(tx)
      const removed = await tx
        .delete(documentAnnotations)
        .where(
          and(
            eq(documentAnnotations.organizationId, organizationId),
            eq(documentAnnotations.documentId, documentId),
            eq(documentAnnotations.id, annotationId)
          )
        )
        .returning({ id: documentAnnotations.id, viewpointId: documentAnnotations.viewpointId })
      // A viewpoint belongs to its one mark: it goes in the same transaction, after the mark (the foreign key is NO ACTION).
      const viewpointId = removed[0]?.viewpointId
      if (viewpointId) await deleteViewpointRow(tx, organizationId, viewpointId)
      return removed
    })
  )
  return rows.length > 0
}

/** Thrown when a thread already carries {@link MAX_REPLIES_PER_ANNOTATION}. */
export class ReplyLimitReachedError extends Error {}

/**
 * Append one reply to an Anmerkung the service read for writing, and touch the
 * mark's `updated_at`, so „zuletzt aktiv" moves with its thread.
 *
 * A reply never touches the mark's delegation: Piloti hands a mark back when
 * the turn the delegation woke ends (`lib/turns/outcome.ts`), not when it
 * writes in the thread. `afterInsert` runs in the same transaction, so a wake
 * the reply is the event of exists exactly when the reply does.
 */
export async function insertAnnotationReply(
  input: {
    organizationId: string
    annotationId: string
    authorKind: AnnotationAuthor
    body: string
    createdBy: string
    addressesAgent?: boolean
    /** Whom the reply mentions, as the service kept them (`./mentions.ts`). */
    mentions?: MarkMention[]
  },
  afterInsert?: InTransaction<DocumentAnnotationReplyRow>
): Promise<DocumentAnnotationReplyRow> {
  const db = getDb()
  return withTenant({ organizationId: input.organizationId }, () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document_annotation_replies:${input.annotationId}`}, 0))`
      )
      const [current] = await tx
        .select({ count: sql<number | string>`count(*)` })
        .from(documentAnnotationReplies)
        .where(
          and(
            eq(documentAnnotationReplies.organizationId, input.organizationId),
            eq(documentAnnotationReplies.annotationId, input.annotationId)
          )
        )
      if (Number(current?.count ?? 0) >= MAX_REPLIES_PER_ANNOTATION) throw new ReplyLimitReachedError()
      const [reply] = await tx.insert(documentAnnotationReplies).values(input).returning()
      await tx
        .update(documentAnnotations)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(documentAnnotations.organizationId, input.organizationId),
            eq(documentAnnotations.id, input.annotationId)
          )
        )
      if (afterInsert) await afterInsert(tx, reply)
      return reply
    })
  )
}

/**
 * Delete one reply of an Anmerkung; whether a row went. With `expectedBody` the
 * delete is a compare-and-swap on what the reply says, so a reply changed
 * since the caller read it stays. The service read the Anmerkung's document
 * first.
 */
export async function deleteAnnotationReply(
  organizationId: string,
  annotationId: string,
  replyId: string,
  expectedBody?: string
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(documentAnnotationReplies)
      .where(
        and(
          eq(documentAnnotationReplies.organizationId, organizationId),
          eq(documentAnnotationReplies.annotationId, annotationId),
          eq(documentAnnotationReplies.id, replyId),
          ...(expectedBody === undefined ? [] : [eq(documentAnnotationReplies.body, expectedBody)])
        )
      )
      .returning({ id: documentAnnotationReplies.id })
  )
  return rows.length > 0
}

/**
 * Change what one reply says and whom it mentions (migration 0152): a
 * compare-and-swap on the words the service read, so an edit that raced
 * another edit, or a delete, changes nothing. `edited_at` is the database's
 * clock, the clock `created_at` was set by
 * (`document_annotation_replies_edited_after_created`). The row as it now
 * stands, or null when nothing matched. The service read the Anmerkung's
 * document for writing first.
 */
export async function updateAnnotationReply(
  organizationId: string,
  annotationId: string,
  replyId: string,
  expectedBody: string,
  changes: { body: string; mentions: MarkMention[] }
): Promise<DocumentAnnotationReplyRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(documentAnnotationReplies)
      .set({ body: changes.body, mentions: changes.mentions, editedAt: sql`now()` })
      .where(
        and(
          eq(documentAnnotationReplies.organizationId, organizationId),
          eq(documentAnnotationReplies.annotationId, annotationId),
          eq(documentAnnotationReplies.id, replyId),
          eq(documentAnnotationReplies.body, expectedBody)
        )
      )
      .returning()
  )
  return row ?? null
}
