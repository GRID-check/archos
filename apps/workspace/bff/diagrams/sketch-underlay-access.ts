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
 *
 * **Only screened bytes** (ADR-0086). A Skizze is machine-filed and never held,
 * so a page traced from bytes no passing verdict judged would reach every
 * member through it. Starting, saving and moving refuse such a page
 * (`underlay_held`, from `documents/page-raster.ts`), and a redraw from stored
 * bytes (a Freigabe, its retry) draws the sheet blank when the base has been
 * held since, or when the slot's PNG is not the server's raster of the page the
 * scene names ({@link underlayForRendition}).
 */

import 'server-only'
import { ForbiddenError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { folderRestrictsReading } from '@/lib/conversations/restricted-egress'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { documentDisplayName } from '@/lib/documents/display-name'
import { findDocumentVersion } from '@/lib/documents/version-repository'
import { PageRasterHeldError, readPageRaster } from '@/lib/documents/page-raster'
import type { SketchScene } from './sketch-scene'
import type { UnderlayPlacement } from './sketch-render-types'
import { underlayPngHash, type EmbeddedUnderlay } from './sketch-underlay-svg'
import { underlayOf, type SceneUnderlay } from './sketch-underlay'
import type { SketchUnderlayView } from './sketch-underlay-wire'

export type UnderlayRefusalReason = 'underlay_other_project' | 'underlay_wider' | 'underlay_unavailable' | 'underlay_held'

const WORDS: Record<UnderlayRefusalReason, string> = {
  underlay_other_project: 'A sketch lies in the project of the document it is drawn on.',
  underlay_wider:
    'The document this sketch is drawn on is in a folder not every member may read; the sketch stays in that folder, ' +
    'or its filed picture would show the page to people who may not open the document.',
  underlay_unavailable: 'The document this sketch is drawn on is not available to you.',
  underlay_held: 'The version this sketch is drawn on is held by the upload screening; the sketch is saved on it once it is released.',
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
    if (error instanceof PageRasterHeldError) throw new UnderlayRefusedError('underlay_held')
    if (error instanceof NotFoundError) throw new UnderlayRefusedError('underlay_unavailable')
    throw error
  }
}

/**
 * The page a redraw from stored bytes may draw (a Freigabe's PDF, its retry):
 * the slot's page when it is still the server's raster of the page the scene
 * names, read with this session's rights from screened bytes; else null, a
 * blank sheet. Never throws: a redraw without its page is still the strokes.
 */
export async function underlayForRendition(session: AuthorizedSession, scene: SketchScene, lifted: EmbeddedUnderlay | null): Promise<EmbeddedUnderlay | null> {
  const underlay = underlayOf(scene.elements)
  if (!underlay || !lifted) return null
  const raster = await readPageRaster(session, underlay.ref, { log: false }).catch(() => null)
  if (!raster || underlayPngHash(raster.png) !== underlayPngHash(lifted.png)) return null
  return lifted
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
