/**
 * The change record's SQL, over `piloti_changes` (migration 0142, ADR-0109).
 * No authorization here; `./service` owns it. Every statement is keyed by the
 * organization as well as the id, and runs in its tenant scope.
 *
 * Undo is claimed with a compare-and-swap on `undone_at IS NULL`, so two
 * people (or two tabs) undoing at once cannot both win: the loser's update
 * finds no row. A claim whose inverse then fails is given back by the exact
 * stamp it set, so it never clears somebody else's undo.
 */

import 'server-only'
import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { conversationVisibleInProject } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { conversations, documents } from '@/lib/db/schema'
import { pilotiChanges, type NewPilotiChangeRow, type PilotiChangeRow } from '@/lib/db/schema/piloti-changes'
import { withTenant } from '@/lib/db/tenant-context'
import { projectShelfScope, type ProjectDocumentGate } from '@/lib/documents/repository'
import { documentVisibleTo } from '@/lib/documents/visibility'

export type { PilotiChangeRow }

/** What one turn may have changed, as one read returns it: a turn of twenty-mark calls, many times over. */
export const MAX_CHANGES_PER_TURN = 200

export type NewPilotiChange = Omit<NewPilotiChangeRow, 'id' | 'createdAt' | 'undoneAt' | 'undoneBy'>

/** Record changes one call applied, all in one organization. */
export async function insertPilotiChanges(organizationId: string, rows: readonly NewPilotiChange[]): Promise<PilotiChangeRow[]> {
  if (rows.length === 0) return []
  if (rows.some((row) => row.organizationId !== organizationId)) {
    throw new Error('insertPilotiChanges: every change belongs to the one organization named')
  }
  const db = getDb()
  return withTenant({ organizationId }, () => db.insert(pilotiChanges).values([...rows]).returning())
}

/** The changes the turn behind `messageId` in `conversationId` applied, oldest first, bounded. */
export async function listTurnChangeRows(
  organizationId: string,
  conversationId: string,
  messageId: string
): Promise<PilotiChangeRow[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(pilotiChanges)
      .where(
        and(
          eq(pilotiChanges.organizationId, organizationId),
          eq(pilotiChanges.originMessageId, messageId),
          eq(pilotiChanges.originConversationId, conversationId)
        )
      )
      .orderBy(asc(pilotiChanges.createdAt), asc(pilotiChanges.id))
      .limit(MAX_CHANGES_PER_TURN)
  )
}

/** One change of this organization, or null. */
export async function findPilotiChange(organizationId: string, id: string): Promise<PilotiChangeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(pilotiChanges)
      .where(and(eq(pilotiChanges.organizationId, organizationId), eq(pilotiChanges.id, id)))
      .limit(1)
  )
  return row ?? null
}

/** Claim the undo for `userId`: stamp it when nobody has. Null when somebody undid it first. */
export async function claimUndo(organizationId: string, id: string, userId: string): Promise<PilotiChangeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(pilotiChanges)
      .set({ undoneAt: new Date(), undoneBy: userId })
      .where(and(eq(pilotiChanges.organizationId, organizationId), eq(pilotiChanges.id, id), isNull(pilotiChanges.undoneAt)))
      .returning()
  )
  return row ?? null
}

/** Give back an undo claim whose inverse did not go through: only the claim with exactly this stamp. */
export async function releaseUndo(
  organizationId: string,
  claim: Pick<PilotiChangeRow, 'id' | 'undoneAt' | 'undoneBy'>
): Promise<void> {
  const { undoneAt: at, undoneBy: by } = claim
  if (!at || !by) return
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(pilotiChanges)
      .set({ undoneAt: null, undoneBy: null })
      .where(
        and(
          eq(pilotiChanges.organizationId, organizationId),
          eq(pilotiChanges.id, claim.id),
          eq(pilotiChanges.undoneBy, by),
          eq(pilotiChanges.undoneAt, at)
        )
      )
  )
}

/** What one turn changed on a project's Anmerkungen, as one reader may count it. */
export interface TurnChangesRow {
  conversationId: string
  messageId: string
  /** The changes on documents the reader may see. */
  count: number
  /** How many of those were undone since. */
  undoneCount: number
  /** When the newest of them was made. */
  newestAt: Date
  /** The person the turn acted for (one per turn; the least, should a turn ever carry two). */
  onBehalfOf: string
  /** How many of the reader's documents the turn changed marks on. */
  documentCount: number
  /** The first `documentsShown` of those documents' ids. */
  documentIds: string[]
}

/**
 * The turns that changed marks in the gate's project at or after `since`, one
 * row per turn (its conversation and answer message), newest change first, at
 * most `limit`. Counts only the changes on documents the gate's reader may see
 * (the document joined behind the project scope and `documentVisibleTo`), and
 * only turns of a conversation the reader may open in the project
 * (`conversationVisibleInProject`, not deleted): the turn card's own rule as a
 * list. A conversation locked by what it drew on is the caller's to drop
 * (`lockedConversationIds`). Scans `idx_piloti_changes_org_created` (0144).
 */
export async function listRecentTurnChanges(
  gate: ProjectDocumentGate,
  userId: string,
  since: Date,
  limit: number,
  documentsShown: number
): Promise<TurnChangesRow[]> {
  const db = getDb()
  const newest = sql<Date | string>`max(${pilotiChanges.createdAt})`
  const rows = await withTenant({ organizationId: gate.organizationId }, () =>
    db
      .select({
        conversationId: pilotiChanges.originConversationId,
        messageId: pilotiChanges.originMessageId,
        count: sql<number | string>`count(*)`,
        undoneCount: sql<number | string>`count(${pilotiChanges.undoneAt})`,
        newestAt: newest,
        onBehalfOf: sql<string>`min(${pilotiChanges.onBehalfOf})`,
        documentCount: sql<number | string>`count(DISTINCT ${pilotiChanges.documentId})`,
        documentIds: sql<string[]>`(array_agg(DISTINCT ${pilotiChanges.documentId}::text))[1:${documentsShown}::int]`,
      })
      .from(pilotiChanges)
      .innerJoin(
        documents,
        and(eq(documents.id, pilotiChanges.documentId), eq(documents.organizationId, pilotiChanges.organizationId))
      )
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, pilotiChanges.originConversationId),
          eq(conversations.organizationId, pilotiChanges.organizationId)
        )
      )
      .where(
        and(
          eq(pilotiChanges.organizationId, gate.organizationId),
          gte(pilotiChanges.createdAt, since),
          ...projectShelfScope(gate),
          documentVisibleTo(gate.reader),
          isNull(conversations.deletedAt),
          conversationVisibleInProject(gate.organizationId, userId, gate.projectId)
        )
      )
      .groupBy(pilotiChanges.originConversationId, pilotiChanges.originMessageId)
      .orderBy(desc(newest), desc(pilotiChanges.originMessageId))
      .limit(limit)
  )
  return rows.map((row) => ({
    conversationId: row.conversationId,
    messageId: row.messageId,
    count: Number(row.count),
    undoneCount: Number(row.undoneCount),
    newestAt: new Date(row.newestAt),
    onBehalfOf: row.onBehalfOf,
    documentCount: Number(row.documentCount),
    documentIds: (row.documentIds ?? []).map(String),
  }))
}
