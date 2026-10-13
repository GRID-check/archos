/**
 * Anmerkungen repository — the SQL over `document_annotations` and
 * `document_annotation_replies` (migration 0135).
 *
 * No authorization here; the service owns that. Every read is keyed by a
 * document the service already loaded through its reader
 * (`getAccessibleDocument`), which is what `documents/document-visibility.spec.ts`
 * holds each function here to.
 */

import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documentAnnotationReplies,
  documentAnnotations,
  documentVersions,
  type DocumentAnnotationReplyRow,
  type DocumentAnnotationRow,
} from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import {
  MAX_ANNOTATIONS_PER_DOCUMENT,
  MAX_REPLIES_PER_ANNOTATION,
  type AnnotationAuthor,
  type AnnotationKind,
  type AnnotationShape,
  type AnnotationStatus,
} from './types'

/** A row with the number of the Fassung it was set on, and its thread. */
export interface AnnotationRecord extends DocumentAnnotationRow {
  fassungNumber: number | null
  replies: DocumentAnnotationReplyRow[]
}

const selection = { row: documentAnnotations, fassungNumber: documentVersions.versionNumber }

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

async function withThreads(
  organizationId: string,
  rows: { row: DocumentAnnotationRow; fassungNumber: number | null }[]
): Promise<AnnotationRecord[]> {
  const threads = await listReplies(
    organizationId,
    rows.map(({ row }) => row.id)
  )
  return rows.map(({ row, fassungNumber }) => ({
    ...row,
    fassungNumber: fassungNumber === null ? null : Number(fassungNumber),
    replies: threads.get(row.id) ?? [],
  }))
}

/** Every Anmerkung on one document with its thread, by number. Bounded by {@link MAX_ANNOTATIONS_PER_DOCUMENT}. */
export async function listDocumentAnnotations(
  organizationId: string,
  documentId: string
): Promise<AnnotationRecord[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(selection)
      .from(documentAnnotations)
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
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

/** One Anmerkung of one document with its thread, or null. */
export async function findDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string
): Promise<AnnotationRecord | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(selection)
      .from(documentAnnotations)
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
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
  kind: AnnotationKind
  body: string
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
  marks: readonly NewAnnotationValues[]
}

/** Thrown when the marks would take a document past {@link MAX_ANNOTATIONS_PER_DOCUMENT}. */
export class AnnotationLimitReachedError extends Error {}

/**
 * Insert one or more Anmerkungen in ONE transaction, their numbers allocated
 * as max + 1 under a per-document advisory lock, so two people setting a mark
 * on one sheet at the same moment get 4 and 5 rather than one of them a 23505.
 * A person's mark is born `open`, Piloti's `proposed` (the CHECKs refuse any
 * other birth). The count is checked under the same lock, so the cap holds
 * against a burst of proposals too.
 */
export async function insertDocumentAnnotations(input: NewAnnotationsInput): Promise<DocumentAnnotationRow[]> {
  const db = getDb()
  const status: AnnotationStatus = input.authorKind === 'piloti' ? 'proposed' : 'open'
  return withTenant({ organizationId: input.organizationId }, () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document_annotations:${input.documentId}`}, 0))`
      )
      const [current] = await tx
        .select({
          highest: sql<number | string | null>`max(${documentAnnotations.number})`,
          count: sql<number | string>`count(*)`,
        })
        .from(documentAnnotations)
        .where(
          and(
            eq(documentAnnotations.organizationId, input.organizationId),
            eq(documentAnnotations.documentId, input.documentId)
          )
        )
      if (Number(current?.count ?? 0) + input.marks.length > MAX_ANNOTATIONS_PER_DOCUMENT) {
        throw new AnnotationLimitReachedError()
      }
      const highest = current?.highest
      const first = highest === null || highest === undefined ? 1 : Number(highest) + 1
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
            number: first + index,
          }))
        )
        .returning()
    })
  )
}

export interface AnnotationChanges {
  kind?: AnnotationKind
  body?: string
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
}

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
  changes: AnnotationChanges
): Promise<DocumentAnnotationRow | null> {
  const { transition, ...fields } = changes
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(documentAnnotations)
      .set({ ...fields, ...(transition ?? {}), updatedAt: new Date() })
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId),
          eq(documentAnnotations.id, annotationId),
          eq(documentAnnotations.status, expectedStatus)
        )
      )
      .returning()
  )
  return row ?? null
}

/** Delete one Anmerkung and its thread; whether a row went. Its number is not reused while a higher one exists. */
export async function deleteDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(documentAnnotations)
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId),
          eq(documentAnnotations.id, annotationId)
        )
      )
      .returning({ id: documentAnnotations.id })
  )
  return rows.length > 0
}

/** Thrown when a thread already carries {@link MAX_REPLIES_PER_ANNOTATION}. */
export class ReplyLimitReachedError extends Error {}

/**
 * Append one reply to an Anmerkung the service read for writing, and touch the
 * mark's `updated_at`, so „zuletzt aktiv" moves with its thread.
 */
export async function insertAnnotationReply(input: {
  organizationId: string
  annotationId: string
  authorKind: AnnotationAuthor
  body: string
  createdBy: string
}): Promise<DocumentAnnotationReplyRow> {
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
      return reply
    })
  )
}
