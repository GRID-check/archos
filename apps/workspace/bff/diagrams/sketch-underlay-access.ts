/**
 * Who may see the page under a Skizze (S6, ADR-0150).
 *
 * A Skizze never shows its underlay to a reader who cannot open the base
 * document. Live, the raster route enforces it: the editor loads the page with
 * the reader's own rights (`documents/page-raster.ts`), so a reader of the
 * Skizze who may not read the base sees the strokes on a blank sheet. Filed,
 * the page is IN the SVG and the PDF, so where the Skizze lies decides who sees
 * it. The rule, one function for the save and the move:
 *
 *   - the base is a document of the Skizze's own project, and
 *   - when the base's folder is one some member of the project may not read
 *     (ADR-0087), the Skizze lies in that same folder.
 *
 * A save or a move that would break it is refused by name
 * (`underlay_other_project`, `underlay_wider`), never filed without the page:
 * a Skizze drawn on a page means that page, and filing it blank would say
 * something else. The saver must read the base too (`underlay_unavailable`).
 */

import 'server-only'
import { ForbiddenError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { folderRestrictsReading } from '@/lib/conversations/restricted-egress'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { documentDisplayName } from '@/lib/documents/display-name'
import { findDocumentVersion } from '@/lib/documents/version-repository'
import { readPageRaster } from '@/lib/documents/page-raster'
import type { SketchScene } from './sketch-scene'
import type { UnderlayPlacement } from './sketch-render-types'
import type { EmbeddedUnderlay } from './sketch-underlay-svg'
import { underlayOf, type SceneUnderlay } from './sketch-underlay'
import type { SketchUnderlayView } from './sketch-underlay-wire'

export type UnderlayRefusalReason = 'underlay_other_project' | 'underlay_wider' | 'underlay_unavailable'

const WORDS: Record<UnderlayRefusalReason, string> = {
  underlay_other_project: 'A sketch lies in the project of the document it is drawn on.',
  underlay_wider:
    'The document this sketch is drawn on is in a folder not every member may read; the sketch stays in that folder, ' +
    'or its filed picture would show the page to people who may not open the document.',
  underlay_unavailable: 'The document this sketch is drawn on is not available to you.',
}

export class UnderlayRefusedError extends UnprocessableError {
  constructor(readonly reason: UnderlayRefusalReason) {
    super(WORDS[reason], { reason })
    this.name = 'UnderlayRefusedError'
  }
}

/** The base document as this session may read it, or the refusal that says it is not available. */
async function readableBase(session: AuthorizedSession, documentId: string): Promise<Document> {
  try {
    return await getAccessibleDocument(session, documentId, 'read')
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) throw new UnderlayRefusedError('underlay_unavailable')
    throw error
  }
}

/** Why a Skizze of `projectId` may not lie in `folderId` over this base, or null when it may. */
export async function underlayPlacementRefusal(
  session: AuthorizedSession,
  base: Pick<Document, 'projectId' | 'folderId'>,
  sketch: { projectId: string | null; folderId: string | null }
): Promise<UnderlayRefusalReason | null> {
  if (!base.projectId || base.projectId !== sketch.projectId) return 'underlay_other_project'
  if (base.folderId === sketch.folderId) return null
  return (await folderRestrictsReading(session.organizationId, base.projectId, base.folderId)) ? 'underlay_wider' : null
}

/**
 * The page a save files with the Skizze, at the place the renderer gave it, or
 * null for a scene without one. Throws {@link UnderlayRefusedError}.
 */
export async function embeddedUnderlayFor(
  session: AuthorizedSession,
  sketch: Pick<Document, 'projectId' | 'folderId'>,
  scene: SketchScene,
  placement: UnderlayPlacement | undefined
): Promise<EmbeddedUnderlay | null> {
  const underlay = underlayOf(scene.elements)
  if (!underlay) return null
  if (!placement) throw new Error('the renderer did not place the underlay')
  const base = await readableBase(session, underlay.ref.documentId)
  const refused = await underlayPlacementRefusal(session, base, sketch)
  if (refused) throw new UnderlayRefusedError(refused)
  try {
    const raster = await readPageRaster(session, underlay.ref, { log: false })
    return { ...placement, png: raster.png }
  } catch (error) {
    if (error instanceof NotFoundError) throw new UnderlayRefusedError('underlay_unavailable')
    throw error
  }
}

/** Why moving this Skizze into `folderId` is refused, in words, or null; the move asks before it moves. */
export async function underlayMoveRefusal(session: AuthorizedSession, scene: SketchScene | null, sketch: Pick<Document, 'projectId'>, folderId: string | null): Promise<string | null> {
  const underlay = scene ? underlayOf(scene.elements) : null
  if (!underlay) return null
  const base = await readableBase(session, underlay.ref.documentId).catch(() => null)
  if (!base) return WORDS.underlay_unavailable
  const refused = await underlayPlacementRefusal(session, base, { projectId: sketch.projectId, folderId })
  return refused ? WORDS[refused] : null
}

/**
 * The underlay as this reader sees it. Any failure (the base gone, not
 * theirs, its Fassung purged) is `unavailable` with nothing more, and never
 * fails the read of the Skizze around it.
 */
export async function resolveUnderlayView(session: AuthorizedSession, underlay: SceneUnderlay | null): Promise<SketchUnderlayView | null> {
  if (!underlay) return null
  const unavailable: SketchUnderlayView = { state: 'unavailable', elementId: underlay.elementId, ref: underlay.ref }
  try {
    const base = await getAccessibleDocument(session, underlay.ref.documentId, 'read')
    const version = await findDocumentVersion(underlay.ref.versionId, base.id, session.organizationId)
    if (!version) return unavailable
    const current = base.publishedVersionId && base.publishedVersionId !== version.id
      ? await findDocumentVersion(base.publishedVersionId, base.id, session.organizationId)
      : null
    return {
      state: 'available',
      elementId: underlay.elementId,
      ref: underlay.ref,
      title: documentDisplayName(base),
      versionNumber: version.versionNumber,
      newer: current && current.versionNumber > version.versionNumber ? { versionId: current.id, versionNumber: current.versionNumber } : null,
    }
  } catch {
    return unavailable
  }
}
