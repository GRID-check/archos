/**
 * The SQL of rows that fold MANY things on one group anchor while anchoring on
 * ONE of them (a BCF import's hand-over row, `annotations/import-rows.ts`):
 * read the ones still standing on an anchor before it is settled, and put one
 * back on another anchor afterwards. Session-less, like the other inbox
 * writes; the caller is in the event's tenant (`bestEffortInbox`).
 */

import 'server-only'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { inboxItems, type InboxItemType } from '@/lib/db/schema/inbox'

export interface FoldedRow {
  id: string
  recipientUserId: string
  groupKey: string
  resourceId: string
  payload: Record<string, unknown>
}

/** A `LIKE` pattern for a group key whose anchor segment starts with `prefix` (as `./repository.ts` builds them). */
const foldedOn = (prefix: string): string => `%:${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

/** The open, live rows of these types anchored on `anchorId` and folded on a `groupAnchor` prefix. */
export async function standingFoldedRows(input: {
  organizationId: string
  types: readonly InboxItemType[]
  anchorId: string
  groupAnchor: string
  recipientUserId?: string
}): Promise<FoldedRow[]> {
  if (input.types.length === 0) return []
  return getDb()
    .select({
      id: inboxItems.id,
      recipientUserId: inboxItems.recipientUserId,
      groupKey: inboxItems.groupKey,
      resourceId: inboxItems.resourceId,
      payload: inboxItems.payload,
    })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.organizationId, input.organizationId),
        inArray(inboxItems.type, [...input.types]),
        eq(inboxItems.anchorId, input.anchorId),
        isNull(inboxItems.resolvedAt),
        isNull(inboxItems.inertAt),
        sql`${inboxItems.groupKey} LIKE ${foldedOn(input.groupAnchor)}`,
        input.recipientUserId ? eq(inboxItems.recipientUserId, input.recipientUserId) : undefined
      )
    )
}

/**
 * Stand a folded row back up on another anchor, with the payload it had and
 * these facts merged in. Neither read again nor moved up the list: what it
 * counts got smaller, nothing new happened.
 */
export async function reanchorFoldedRow(input: {
  organizationId: string
  id: string
  anchorId: string
  payload: Record<string, unknown>
}): Promise<void> {
  await getDb()
    .update(inboxItems)
    .set({ anchorId: input.anchorId, payload: input.payload, resolvedAt: null, inertAt: null })
    .where(and(eq(inboxItems.organizationId, input.organizationId), eq(inboxItems.id, input.id)))
}
