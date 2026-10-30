/**
 * Which documents a Skizze has ever been traced over (S6, ADR-0150, migration
 * 0193), and the Skizzen traced over a document.
 *
 * A Skizze's filed SVG and PDF carry the page in every Fassung, so the folder
 * rule (`sketch-underlay-access.ts`) is asked of every base a Fassung of it was
 * drawn on, not of the current scene alone. The rows are written when a Skizze
 * is started on a page and on every save whose scene holds an underlay, and
 * never cleared: a ratchet, so a save that drops or changes the underlay cannot
 * let the next move forget the page an earlier Fassung still holds.
 *
 * Reads here see every row, held ones included (`derived-copies`): a held
 * Skizze or a held base still holds or is the page, and a refusal is all that
 * leaves this module.
 */

import 'server-only'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents } from '@/lib/db/schema/documents'
import { sketchUnderlayBases } from '@/lib/db/schema/sketch-underlay-bases'
import { internalRead } from '@/lib/documents/document-reader'
import { documentVisibleTo } from '@/lib/documents/visibility'

/** Where a document lies: what the folder rule reads. */
export interface PlacedDocument {
  id: string
  projectId: string | null
  folderId: string | null
  name: string
}

/** Record that `sketchId` is traced over `baseId`; nothing when it already was. */
export async function recordUnderlayBase(organizationId: string, sketchId: string, baseId: string): Promise<void> {
  if (sketchId === baseId) return
  await withTenant({ organizationId }, () =>
    getDb().insert(sketchUnderlayBases).values({ organizationId, sketchDocumentId: sketchId, baseDocumentId: baseId }).onConflictDoNothing()
  )
}

const placed = {
  id: documents.id,
  projectId: documents.projectId,
  folderId: documents.folderId,
  filename: documents.filename,
  displayName: documents.displayName,
}

const toPlaced = (row: { id: string; projectId: string | null; folderId: string | null; filename: string; displayName: string | null }): PlacedDocument => ({
  id: row.id,
  projectId: row.projectId,
  folderId: row.folderId,
  name: row.displayName ?? row.filename,
})

/** Every base any Fassung of this Skizze was traced over, where it lies now. */
export async function underlayBasesOf(organizationId: string, sketchId: string): Promise<PlacedDocument[]> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select(placed)
      .from(sketchUnderlayBases)
      .innerJoin(documents, eq(documents.id, sketchUnderlayBases.baseDocumentId))
      .where(
        and(
          eq(sketchUnderlayBases.organizationId, organizationId),
          eq(sketchUnderlayBases.sketchDocumentId, sketchId),
          eq(documents.organizationId, organizationId),
          documentVisibleTo(internalRead('derived-copies'))
        )
      )
      .limit(100)
  )
  return rows.map(toPlaced)
}

/** The Skizzen traced over this document, where they lie now. */
export async function sketchesTracing(organizationId: string, baseId: string): Promise<PlacedDocument[]> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select(placed)
      .from(sketchUnderlayBases)
      .innerJoin(documents, eq(documents.id, sketchUnderlayBases.sketchDocumentId))
      .where(
        and(
          eq(sketchUnderlayBases.organizationId, organizationId),
          eq(sketchUnderlayBases.baseDocumentId, baseId),
          eq(documents.organizationId, organizationId),
          documentVisibleTo(internalRead('derived-copies'))
        )
      )
      .limit(500)
  )
  return rows.map(toPlaced)
}
