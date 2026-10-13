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
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { pilotiChanges, type NewPilotiChangeRow, type PilotiChangeRow } from '@/lib/db/schema/piloti-changes'
import { withTenant } from '@/lib/db/tenant-context'

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
