/**
 * The SQL the office's conventions read and write (ADR-0129). No authorization
 * here: the record is the organization's own, written by a refresh no person runs and read
 * by the turn context after its access checks. Every list is bounded, and every
 * read of `documents` states its reader: the model's, which sees only screened
 * documents (`SCREENED_ONLY`, ADR-0086).
 */

import 'server-only'
import { and, count, desc, eq, inArray, isNull, lt, max, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, type Document } from '@/lib/db/schema/documents'
import { officeConventionDecisions, officeConventions, type OfficeConventionsRow } from '@/lib/db/schema/office-conventions'
import { projectFolders } from '@/lib/db/schema/project-folders'
import { proposedChanges } from '@/lib/db/schema/proposed-changes'
import { withTenant } from '@/lib/db/tenant-context'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import { documentVisibleTo } from '@/lib/documents/visibility'
import { fileOperationPayloadSchema } from '@/lib/proposals/types'
import type { OfficeConventions } from './extract'
import { conventionLineSchema } from './office-conventions-wire'
import type { StoredDecision } from './lines'

/** Most documents one refresh counts, newest first. */
export const MAX_CONVENTION_DOCUMENTS = 4000

/** The office's record, or null when none was ever claimed. */
export async function readOfficeConventions(organizationId: string): Promise<OfficeConventionsRow | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb().select().from(officeConventions).where(eq(officeConventions.organizationId, organizationId)).limit(1)
  )
  return row ?? null
}

/** Replace the office's conventions with a fresh count. */
export async function writeOfficeConventions(
  organizationId: string,
  values: { conventions: OfficeConventions; extractorVersion: number; sourceFingerprint: string }
): Promise<void> {
  const now = new Date()
  const row = { ...values, computedAt: now, updatedAt: now }
  await withTenant({ organizationId }, () =>
    getDb()
      .insert(officeConventions)
      .values({ organizationId, ...row })
      .onConflictDoUpdate({ target: officeConventions.organizationId, set: row })
  )
}

/**
 * Claim the right to queue a refresh: true for exactly one caller per
 * `minIntervalMs`, however many turns find the office changed at once. The
 * row is created by the first claim, before any conventions exist.
 */
export async function claimOfficeConventionsRefresh(organizationId: string, minIntervalMs: number): Promise<boolean> {
  const now = new Date()
  const claimed = await withTenant({ organizationId }, () =>
    getDb()
      .insert(officeConventions)
      .values({ organizationId, refreshRequestedAt: now })
      .onConflictDoUpdate({
        target: officeConventions.organizationId,
        set: { refreshRequestedAt: now, updatedAt: now },
        setWhere: or(
          isNull(officeConventions.refreshRequestedAt),
          lt(officeConventions.refreshRequestedAt, new Date(now.getTime() - minIntervalMs))
        ),
      })
      .returning({ organizationId: officeConventions.organizationId })
  )
  return claimed.length > 0
}

/**
 * What the conventions are counted from, as one string: how many screened
 * project documents and living project folders the office has, and when the
 * last of each changed. An upload, a move, a rename, a delete or a folder
 * change moves it. Two aggregates over the organization's rows.
 */
export async function officeSourceFingerprint(organizationId: string): Promise<string> {
  const [docs, folders] = await withTenant({ organizationId }, () =>
    Promise.all([
      getDb()
        .select({ n: count(), last: max(documents.updatedAt) })
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, organizationId),
            eq(documents.scope, 'project'),
            documentVisibleTo(SCREENED_ONLY)
          )
        ),
      getDb()
        .select({ n: count(), last: max(projectFolders.updatedAt) })
        .from(projectFolders)
        .where(
          and(
            eq(projectFolders.organizationId, organizationId),
            eq(projectFolders.scope, 'project'),
            isNull(projectFolders.deletedAt)
          )
        ),
    ])
  )
  const stamp = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : '-')
  return `d${Number(docs[0]?.n ?? 0)}@${stamp(docs[0]?.last)};f${Number(folders[0]?.n ?? 0)}@${stamp(folders[0]?.last)}`
}

/**
 * The screened, ingested documents of these projects, newest first: what the
 * conventions are counted from. Bounded by {@link MAX_CONVENTION_DOCUMENTS}.
 */
export async function listConventionDocuments(organizationId: string, projectIds: readonly string[]): Promise<Document[]> {
  if (projectIds.length === 0) return []
  return withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.scope, 'project'),
          inArray(documents.projectId, [...projectIds]),
          eq(documents.status, 'completed'),
          documentVisibleTo(SCREENED_ONLY)
        )
      )
      .orderBy(desc(documents.createdAt))
      .limit(MAX_CONVENTION_DOCUMENTS)
  )
}

/** Most decisions one organization keeps; a decision per line, and the lines are few. */
export const MAX_DECISIONS = 500

/** The office's decisions on its convention lines. A row whose stored line no longer parses is left out. */
export async function listConventionDecisions(organizationId: string): Promise<StoredDecision[]> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(officeConventionDecisions)
      .where(eq(officeConventionDecisions.organizationId, organizationId))
      .orderBy(desc(officeConventionDecisions.decidedAt))
      .limit(MAX_DECISIONS)
  )
  return rows.flatMap((row) => {
    const line = conventionLineSchema.safeParse(row.line)
    if (!line.success || line.data.key !== row.lineKey) return []
    return [{ lineKey: row.lineKey, decision: row.decision, line: line.data, decidedBy: row.decidedBy, decidedAt: new Date(row.decidedAt) }]
  })
}

/** Record a decision, replacing an earlier one on the same line. */
export async function saveConventionDecision(organizationId: string, decision: Omit<StoredDecision, 'decidedAt'>): Promise<void> {
  const values = { decision: decision.decision, line: decision.line, decidedBy: decision.decidedBy, decidedAt: new Date() }
  await withTenant({ organizationId }, () =>
    getDb()
      .insert(officeConventionDecisions)
      .values({ organizationId, lineKey: decision.lineKey, ...values })
      .onConflictDoUpdate({ target: [officeConventionDecisions.organizationId, officeConventionDecisions.lineKey], set: values })
  )
}

/** Take a decision back. */
export async function deleteConventionDecision(organizationId: string, lineKey: string): Promise<void> {
  await withTenant({ organizationId }, () =>
    getDb()
      .delete(officeConventionDecisions)
      .where(and(eq(officeConventionDecisions.organizationId, organizationId), eq(officeConventionDecisions.lineKey, lineKey)))
  )
}

/** Most accepted proposals one refresh reads, newest first. */
export const MAX_ACCEPTED_MOVES = 1000

/** One document a person accepted a move of, by name, into a folder path. */
export interface AcceptedMove {
  projectId: string
  document: string
  folderPath: string
}

/**
 * The moves a person accepted in these projects: applied `file_operation`
 * proposals whose operation is `move`, one entry per item that names a document
 * and a target folder. Bounded by {@link MAX_ACCEPTED_MOVES}.
 */
export async function listAcceptedMoves(organizationId: string, projectIds: readonly string[]): Promise<AcceptedMove[]> {
  if (projectIds.length === 0) return []
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({ projectId: proposedChanges.projectId, payload: proposedChanges.payload })
      .from(proposedChanges)
      .where(
        and(
          eq(proposedChanges.organizationId, organizationId),
          eq(proposedChanges.scope, 'project'),
          eq(proposedChanges.kind, 'file_operation'),
          eq(proposedChanges.status, 'applied'),
          sql`${proposedChanges.payload}->>'operation' = 'move'`,
          inArray(proposedChanges.projectId, [...projectIds])
        )
      )
      .orderBy(desc(proposedChanges.decidedAt))
      .limit(MAX_ACCEPTED_MOVES)
  )
  return rows.flatMap((row) => {
    const payload = fileOperationPayloadSchema.safeParse(row.payload)
    if (!payload.success || !row.projectId) return []
    const projectId = row.projectId
    return payload.data.operations.flatMap((item) => {
      const folderPath = item.target_folder ?? payload.data.new_folder?.path
      return item.document && folderPath && item.source !== 'office' ? [{ projectId, document: item.document, folderPath }] : []
    })
  })
}
