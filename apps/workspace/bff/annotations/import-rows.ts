/**
 * A BCF import's hand-over row stands while the person still has marks of it
 * to answer (`./import-attention.ts`). It anchors on one of their marks, so
 * settling that mark (closed, handed on, deleted) would settle all of them;
 * these two wrappers take the inbox's own anchored writes and put such a row
 * back on the person's next open mark of the import, counting what remains
 * (`openMarks`). With none left it stays settled. Every other row passes
 * through untouched. `./attention.ts` calls them in place of the inbox's.
 *
 * The rows are recognised by their group anchor (`import:<batch>`), the marks
 * by `import_batch_id` (migration 0195), so nothing here guesses.
 */

import 'server-only'
import type { InboxItemType } from '@/lib/db/schema/inbox'
import { publishToUser } from '@/lib/events/bus'
import { reanchorFoldedRow, standingFoldedRows, type FoldedRow } from '@/lib/inbox/folded-rows-repository'
import type { AnchoredRows } from '@/lib/inbox/repository'
import {
  markInboxItemsInertAnchoredOn as markInertInInbox,
  resolveInboxItemsAnchoredOn as resolveInInbox,
} from '@/lib/inbox/service'
import { excerptOf } from './excerpt'
import { openImportedMarksOf } from './import-repository'

/** The group anchor of one import's hand-over rows: `import:<batch>`. */
export const IMPORT_GROUP_ANCHOR = 'import:'

const HANDED_OVER: InboxItemType = 'annotation.assigned_to_you'

type Anchored = { organizationId: string; types: readonly InboxItemType[]; anchorId: string; recipientUserId?: string }

/**
 * The import rows the write is about to settle, read before it does. A failed
 * read costs the row its second life, never the write it wraps.
 */
const importRowsAmong = (input: Anchored): Promise<FoldedRow[]> =>
  input.types.includes(HANDED_OVER)
    ? standingFoldedRows({ ...input, types: [HANDED_OVER], groupAnchor: IMPORT_GROUP_ANCHOR }).catch((error: unknown) => {
        console.warn(`[inbox] could not read the import rows on ${input.anchorId}:`, error)
        return []
      })
    : Promise.resolve([])

/** Put each settled import row back on its person's next open mark of the import, if one remains. */
async function standBackUp(organizationId: string, rows: readonly FoldedRow[]): Promise<void> {
  for (const row of rows) {
    const batch = row.groupKey.slice(row.groupKey.lastIndexOf(`:${IMPORT_GROUP_ANCHOR}`) + IMPORT_GROUP_ANCHOR.length + 1)
    const open = await openImportedMarksOf({
      organizationId,
      documentId: row.resourceId,
      importBatchId: batch,
      assigneeUserId: row.recipientUserId,
    })
    const next = open[0]
    if (!next) continue
    await reanchorFoldedRow({
      organizationId,
      id: row.id,
      anchorId: next.id,
      payload: { ...row.payload, related: String(next.number), excerpt: excerptOf(next.body), mentions: [], openMarks: open.length },
    })
    await publishToUser(row.recipientUserId, { kind: 'inbox.changed', pending: -1 })
  }
}

/** The inbox's `resolveInboxItemsAnchoredOn`, keeping an import's hand-over row while marks of it remain. */
export async function resolveInboxItemsAnchoredOn(input: Anchored): Promise<number> {
  const rows = await importRowsAmong(input)
  const told = await resolveInInbox(input)
  await standBackUp(input.organizationId, rows)
  return told
}

/** The inbox's `markInboxItemsInertAnchoredOn`, the same for a mark that was deleted. */
export async function markInboxItemsInertAnchoredOn(input: AnchoredRows): Promise<number> {
  const rows = await importRowsAmong(input)
  const told = await markInertInInbox(input)
  await standBackUp(input.organizationId, rows)
  return told
}
