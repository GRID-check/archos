/** Quarantined documents and the failed-ingest walk for retry. */

import 'server-only'
import { and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { type DocumentListCursor } from '../list-cursor'
import { declaredStatusesIn } from '../document-status'
import { documents, type Document } from '@/lib/db/schema/documents'
import { heldAtRest } from '../visibility'
import { CURRENT_INGEST_READER_VERSION } from '../retry-policy'
import { cursorCreatedAtColumn } from './list'
import { dispatchedHash } from './reconcile'

/** Bound on one read of the quarantine queue. A queue longer than this is a policy problem, not a list. */
export const QUARANTINE_LIST_LIMIT = 200

/** Where the next page of the quarantine starts: the last row of the previous one. */
export interface QuarantineCursor {
  updatedAt: Date
  id: string
}

/**
 * One page of the organization's held documents at rest (`heldAtRest`: a
 * quarantine, or a file whose reading ended without a verdict), newest first,
 * after `cursor`. Authorization is the caller's, which is why it pages: a reviewer of
 * one project must not lose their documents behind a page of another project's
 * (`listQuarantineQueue` reads on until its own list is full).
 */
export async function listQuarantinedDocuments(
  organizationId: string,
  cursor: QuarantineCursor | null = null,
): Promise<Document[]> {
  const db = getDb()
  const after = cursor
    ? or(
        lt(documents.updatedAt, cursor.updatedAt),
        and(eq(documents.updatedAt, cursor.updatedAt), lt(documents.id, cursor.id)),
      )
    : undefined
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(and(eq(documents.organizationId, organizationId), heldAtRest(), after))
      .orderBy(desc(documents.updatedAt), desc(documents.id))
      .limit(QUARANTINE_LIST_LIMIT),
  )
}

/**
 * Documents whose ingestion failed and is worth retrying, org-wide, a keyset
 * page at a time.
 *
 * The rescan behind "Rescan failed ingestions" in Organization > Enterprise:
 * every row stuck at `failed`/`error` - plus rows stranded at the `uploaded`
 * birth status that never dispatched - is a file that was stored but never
 * read. Bounded like every other list query; the rescan job re-dispatches each
 * id through `reingestDocument`, so access checks and status guards stay in one
 * place instead of being restated here.
 *
 * A failure the retry rule refuses ({@link retryAllowedSql}) is left out here,
 * not skipped later: the walk never pays a request for a file that would fail
 * the same way, and the audit's counts say what was actually sent back.
 */
export const FAILED_INGEST_RESCAN_STATUSES = ['failed', 'uploaded'] as const

/**
 * `canRetry` (`./retry-policy`) in SQL, for the queries that choose what a bulk
 * retry sends: true unless the row is FAILED for a reason reading it again will
 * not change. Kept beside the TypeScript rule rather than replacing it, because
 * a single document's retry decides on the row it already holds and a walk
 * must not fetch the rows it will not send; `retry-policy.spec.ts` states the
 * rule and `retry-policy.integration.spec.ts` holds this SQL to it row by row.
 *
 *   - not in the failed family: the rule says nothing (`uploaded` rows of the
 *     rescan pass);
 *   - `deterministic`: refused unless the bytes changed since the dispatch
 *     that failed (`ingestContentHash`, both sides known) or the deployed
 *     reader is newer than the one that failed (dotted numbers compared as
 *     integer arrays; a version missing or not dotted numbers counts as older,
 *     as `isNewerReader` counts it);
 *   - no category: refused only when the flag says `false`, so every row from
 *     before migration 0134 passes;
 *   - any other category: refused only for `quarantined`.
 *
 * Each branch is a non-null boolean, and the whole is `coalesce`d besides:
 * `NOT NULL` in a WHERE drops the row, which would quietly withhold exactly the
 * rows the rule means to keep.
 */
export function retryAllowedSql(): SQL {
  const failedStatuses = sql.join(
    declaredStatusesIn('failed').map((status) => sql`${status}`),
    sql`, `,
  )
  const version = documents.ingestReaderVersion
  const readerIsNewer = sql`CASE
      WHEN ${version} IS NULL THEN true
      WHEN ${version} ~ '^[0-9]+([.][0-9]+)*$'
        THEN string_to_array(${version}, '.')::int[] < string_to_array(${CURRENT_INGEST_READER_VERSION}::text, '.')::int[]
      ELSE ${version} <> ${CURRENT_INGEST_READER_VERSION}::text
    END`
  const bytesChanged = sql`(${dispatchedHash} IS NOT NULL AND ${documents.contentHash} IS NOT NULL AND ${documents.contentHash} <> ${dispatchedHash})`
  const refused = sql`(lower(${documents.status}) IN (${failedStatuses}) AND CASE
      WHEN ${documents.ingestFailureCategory} = 'deterministic' THEN NOT (${bytesChanged} OR ${readerIsNewer})
      WHEN ${documents.ingestFailureCategory} IS NULL THEN coalesce(${documents.ingestRetryable}, true) = false
      ELSE ${documents.ingestFailureCategory} = 'quarantined'
    END)`
  return sql`NOT coalesce(${refused}, false)`
}

/** Most ids one page of the failed-ingestion walk returns. */
export const FAILED_INGEST_PAGE_LIMIT = 100

/**
 * The rows AFTER `cursor` in the failed walk's order: oldest first, id as the
 * tiebreak. Ascending twin of {@link afterDocumentListCursor}, with the same
 * microsecond text so a row the cursor was built from is never served twice.
 */
function afterFailedWalkCursor(cursor: DocumentListCursor): SQL {
  const at = sql`(${cursor.createdAt}::timestamp AT TIME ZONE 'UTC')`
  return sql`(${documents.createdAt} > ${at} OR (${documents.createdAt} = ${at} AND ${documents.id} > ${cursor.id}::uuid))`
}

export interface FailedDocumentPage {
  ids: string[]
  /** Where the next page starts, or `null` when the failed set is exhausted. */
  nextCursor: DocumentListCursor | null
}

/**
 * One page of the failed set. A keyset rather than an exclusion list: rows that
 * stay failed after a retry cannot starve the rows behind them, and the walk's
 * state stays one position however many rows there are, so a job can keep it
 * in its payload and resume from it.
 */
export async function listFailedDocumentPageInOrg(
  organizationId: string,
  { limit = FAILED_INGEST_PAGE_LIMIT, cursor }: { limit?: number; cursor?: DocumentListCursor | null } = {},
): Promise<FailedDocumentPage> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), FAILED_INGEST_PAGE_LIMIT)
  const db = getDb()
  const fetched = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id, cursorCreatedAt: cursorCreatedAtColumn })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.status, [...FAILED_INGEST_RESCAN_STATUSES]),
          retryAllowedSql(),
          ...(cursor ? [afterFailedWalkCursor(cursor)] : []),
        ),
      )
      .orderBy(asc(documents.createdAt), asc(documents.id))
      // One more than asked, which is how "is there more" is answered without a COUNT.
      .limit(bounded + 1),
  )
  const hasMore = fetched.length > bounded
  const page = hasMore ? fetched.slice(0, bounded) : fetched
  const last = page.at(-1)
  return {
    ids: page.map((row) => row.id),
    nextCursor: hasMore && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
  }
}
