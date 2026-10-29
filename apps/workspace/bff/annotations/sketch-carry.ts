/**
 * A Skizze's marks go on with its next Fassung, in the transaction that
 * publishes it (migration 0192).
 *
 * A mark set on a PDF stays on the Fassung it was read on, and goes on only
 * when someone says it still holds („Auf aktuelle Fassung übernehmen“,
 * `carryToCurrent` in `./service.ts`). A Skizze gets a Fassung on every save,
 * and its marks name the elements they are about, so the elements are the
 * referent and the save carries them (`docs/architecture/document-annotations.md`,
 * „A mark on a Skizze“):
 *
 *   - **open and proposed marks pinned to elements move in place**: `version_id`
 *     becomes the new Fassung, compared and swapped against the Fassung they
 *     were on and their status, as `revision` in `updateDocumentAnnotation`
 *     does, so a colleague's close in the same moment wins and the mark stays
 *     where it was closed;
 *   - **their box is drawn again** from the elements still in the new scene;
 *   - **none left**: the mark keeps its last box and says so
 *     (`anchor_lost_at`, „Element gelöscht“); an element that comes back with
 *     a later save clears it;
 *   - **resolved and dismissed marks stay** on the Fassung they were closed on,
 *     as every closed mark does.
 *
 * Nobody is told beyond the room: a save of a Skizze is no news
 * (`lib/diagrams/sketch-version.ts`), and the mark is where its readers left it,
 * on its elements.
 */

import 'server-only'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { DbTransaction } from '@/lib/db/executor'
import { documentAnnotations } from '@/lib/db/schema/document-annotations'
import { LIVE_ANNOTATION_STATUSES, MAX_ANNOTATIONS_PER_DOCUMENT } from './types'
import { elementRegion, presentIds, type AnchorElement } from './sketch-anchor'

/** The new Fassung's scene and the sheet its SVG draws; absent when the bytes are the same ones recorded again. */
export interface NextSketch {
  elements: readonly AnchorElement[]
  viewBox: { width: number; height: number } | null
}

export interface MoveSketchMarksInput {
  organizationId: string
  documentId: string
  /** The Fassungen the publish superseded; none when the document had no version row. */
  fromVersionIds: readonly string[]
  toVersionId: string
  /** The scene the marks are placed on again; null keeps every box as it is. */
  sketch: NextSketch | null
}

/** What moved: the marks that went on, and of those the ones whose elements are all gone. */
export interface MovedSketchMarks {
  moved: string[]
  lost: string[]
}

/** The box and the loss of one mark on the new scene; null leaves both as they are. */
function placeAgain(ids: readonly string[], sketch: NextSketch | null) {
  if (!sketch?.viewBox) return null
  const present = presentIds(sketch.elements, ids)
  const region = present.length > 0 ? elementRegion({ elements: sketch.elements }, present, sketch.viewBox) : null
  return { region, lost: region === null }
}

/** Move the live marks pinned to elements onto the Fassung just published, in its transaction. */
export async function moveSketchMarks(tx: DbTransaction, input: MoveSketchMarksInput): Promise<MovedSketchMarks> {
  const onPrevious =
    input.fromVersionIds.length > 0
      ? inArray(documentAnnotations.versionId, [...input.fromVersionIds])
      : isNull(documentAnnotations.versionId)
  const marks = await tx
    .select({
      id: documentAnnotations.id,
      versionId: documentAnnotations.versionId,
      status: documentAnnotations.status,
      ids: documentAnnotations.anchorElementIds,
    })
    .from(documentAnnotations)
    .where(
      and(
        eq(documentAnnotations.organizationId, input.organizationId),
        eq(documentAnnotations.documentId, input.documentId),
        inArray(documentAnnotations.status, [...LIVE_ANNOTATION_STATUSES]),
        isNotNull(documentAnnotations.anchorElementIds),
        onPrevious
      )
    )
    .limit(MAX_ANNOTATIONS_PER_DOCUMENT)
  const result: MovedSketchMarks = { moved: [], lost: [] }
  for (const mark of marks) {
    const placed = placeAgain(mark.ids ?? [], input.sketch)
    const [row] = await tx
      .update(documentAnnotations)
      .set({
        versionId: input.toVersionId,
        ...(placed?.region ?? {}),
        ...(placed ? { anchorLostAt: placed.lost ? sql`coalesce(${documentAnnotations.anchorLostAt}, now())` : null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentAnnotations.organizationId, input.organizationId),
          eq(documentAnnotations.id, mark.id),
          eq(documentAnnotations.status, mark.status),
          sql`${documentAnnotations.versionId} IS NOT DISTINCT FROM ${mark.versionId}`
        )
      )
      .returning({ id: documentAnnotations.id })
    if (!row) continue
    result.moved.push(row.id)
    if (placed?.lost) result.lost.push(row.id)
  }
  return result
}
