/** A viewpoint belongs to its one mark: it goes in the transaction that deletes the mark, after it (the foreign key is NO ACTION). */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { DbTransaction } from '@/lib/db/executor'
import { annotationViewpoints } from '@/lib/db/schema/annotation-viewpoints'

export async function deleteViewpointRow(tx: DbTransaction, organizationId: string, viewpointId: string): Promise<void> {
  await tx
    .delete(annotationViewpoints)
    .where(and(eq(annotationViewpoints.organizationId, organizationId), eq(annotationViewpoints.id, viewpointId)))
}
