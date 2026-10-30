/**
 * A document's running Anmerkung numbers (CONTEXT.md „Anmerkung"): every
 * insert takes the next free ones under a per-document advisory lock, so two
 * people setting a mark on one sheet at the same moment get 4 and 5, never a
 * 23505 for one of them. The count is checked under the same lock, so the cap
 * holds against a burst too.
 */

import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { DbTransaction } from '@/lib/db/executor'
import { documentAnnotations } from '@/lib/db/schema/document-annotations'
import { MAX_ANNOTATIONS_PER_DOCUMENT } from './types'

/** Thrown when the marks would take a document past {@link MAX_ANNOTATIONS_PER_DOCUMENT}. */
export class AnnotationLimitReachedError extends Error {}

/** The number of the first of `count` new marks on a document, in the caller's transaction; holds the lock until it ends. */
export async function allocateNumbers(
  tx: DbTransaction,
  organizationId: string,
  documentId: string,
  count: number
): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document_annotations:${documentId}`}, 0))`)
  const [current] = await tx
    .select({
      highest: sql<number | string | null>`max(${documentAnnotations.number})`,
      count: sql<number | string>`count(*)`,
    })
    .from(documentAnnotations)
    .where(and(eq(documentAnnotations.organizationId, organizationId), eq(documentAnnotations.documentId, documentId)))
  if (Number(current?.count ?? 0) + count > MAX_ANNOTATIONS_PER_DOCUMENT) throw new AnnotationLimitReachedError()
  const highest = current?.highest
  return highest === null || highest === undefined ? 1 : Number(highest) + 1
}
