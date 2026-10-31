/**
 * A viewpoint belongs to its one mark: it goes in the transaction that deletes the mark, after it (the foreign key is
 * NO ACTION). So do the viewpoints of the same document it was carried from in place (migration 0194), which no other
 * mark names: one statement, so the chain's own foreign keys are checked once it is gone. A viewpoint on the document
 * a mark was carried across from stays with that document's mark. Returns the snapshot objects of the rows that went,
 * for the caller to discard once the transaction committed.
 */

import 'server-only'
import { sql } from 'drizzle-orm'
import type { DbTransaction } from '@/lib/db/executor'

export async function deleteViewpointRow(tx: DbTransaction, organizationId: string, viewpointId: string): Promise<string[]> {
  const rows = await tx.execute<{ snapshot_key: string | null }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, document_id, carried_from_id FROM annotation_viewpoints
       WHERE organization_id = ${organizationId} AND id = ${viewpointId}::uuid
      UNION
      SELECT v.id, v.document_id, v.carried_from_id FROM annotation_viewpoints v
        JOIN chain c ON v.id = c.carried_from_id AND v.document_id = c.document_id
       WHERE v.organization_id = ${organizationId}
         AND NOT EXISTS (SELECT 1 FROM document_annotations a WHERE a.viewpoint_id = v.id)
    )
    DELETE FROM annotation_viewpoints WHERE organization_id = ${organizationId} AND id IN (SELECT id FROM chain)
    RETURNING snapshot_key`)
  return Array.from(rows).flatMap((row) => (row.snapshot_key ? [String(row.snapshot_key)] : []))
}
