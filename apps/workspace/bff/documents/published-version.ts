/**
 * What every path that makes a Fassung current does inside its transaction
 * (`insertPublishedVersion` and `promoteVersionToPublished` in
 * `./version-repository.ts`): a Skizze's pinned marks go onto it
 * (`lib/annotations/sketch-carry.ts`). In the repository rather than beside
 * each caller, so a new path that publishes cannot forget it; what is told once
 * it committed is `./current-version.ts`.
 */

import 'server-only'
import { moveSketchMarks, type MovedSketchMarks, type NextSketch } from '@/lib/annotations/sketch-carry'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { DbTransaction } from '@/lib/storage/repository'

/** A Fassung made current: the row, what it superseded, and the pinned marks that went onto it. */
export type PublishedVersionRows = { version: DocumentVersion; superseded: DocumentVersion[]; carried: MovedSketchMarks }

/** Carry the document's live pinned marks onto `version`, placed on `sketch` when given. */
export const carryOnto = (tx: DbTransaction, version: DocumentVersion, sketch: NextSketch | null) =>
  moveSketchMarks(tx, { organizationId: version.organizationId, documentId: version.documentId, toVersionId: version.id, sketch })
