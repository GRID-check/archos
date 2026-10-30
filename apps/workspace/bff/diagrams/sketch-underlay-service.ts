/**
 * A Skizze traced over a PDF page (S6, ADR-0150): start one on a page, read
 * what its page is for this reader, and move it to the base's newer Fassung.
 *
 * **Bound to its Fassung.** Markup stays on the Fassung it was drawn over
 * (research r2: Bluebeam's and PlanRadar's lesson). When the base document gets
 * a newer Fassung, nothing moves by itself: the read says `newer`, the editor
 * says „liegt auf Fassung 3, aktuell 4“, and the move is a person's explicit
 * step, saved as the Skizze's next Fassung. The page is found again by its
 * label in the PDF (`A-101`), else by its number. Pins and links are the
 * Skizze's own elements and do not move.
 *
 * **Starting one.** `document-sketch-from-page` files a Skizze whose scene holds
 * only the locked page, through the filing every sketch takes
 * (`fileDiagramDocuments`), with the server's raster in its SVG and PDF. When the
 * base lies in a folder not every member may read, the Skizze is filed without
 * the page in its picture, then moved into the base's folder; its first save
 * there files the page (`sketch-underlay-access.ts`). So the page is never in a
 * file wider than the base, even for the moment between the two steps.
 */

import 'server-only'
import { randomInt, randomUUID } from 'node:crypto'
import { ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { folderRestrictsReading } from '@/lib/conversations/restricted-egress'
import { getAccessibleDocument } from '@/lib/documents/access'
import { documentDisplayName } from '@/lib/documents/display-name'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { readPageLabels, readPageRaster, type PageRaster } from '@/lib/documents/page-raster'
import { DEFAULT_PAGE_RASTER_DPI } from '@/lib/documents/page-raster-limits'
import { findDocumentVersion } from '@/lib/documents/version-repository'
import type { Document } from '@/lib/db/schema/documents'
import { fileDiagramDocuments, type FiledDiagram } from './filing'
import { underlayMoveRefusal } from './sketch-underlay-access'
import { publishedSketchOf, saveSketchDocument, sketchSaveBaseOf } from './sketch-document'
import { drawSketchScene } from './sketch-picture'
import { checkSketchScene, serializeSketchScene, type SketchScene } from './sketch-scene'
import { newUnderlayElement, underlayFileId, underlayOf, type SketchUnderlay } from './sketch-underlay'
import type { SketchFromPageBody, UnderlayMoveBody, UnderlayMovePlan, UnderlayPage } from './sketch-underlay-wire'

const nonce = () => randomInt(2 ** 31)

export interface SketchFromPageInput {
  session: AuthorizedSession
  documentId: string
  versionId: string
  page: number
  body: SketchFromPageBody
  /** The Skizze's name, in the reader's locale (`diagrams.underlay.title`), filled with the base's name and page. */
  title: (baseName: string, page: number) => string
  marking: string
  request?: Request
}

/** A scene that holds the page alone, checked as any stored scene. */
function sceneOnPage(underlay: SketchUnderlay, raster: PageRaster): SketchScene {
  const element = newUnderlayElement(`underlay-${randomUUID()}`, underlay, raster.facts, nonce())
  return checkSketchScene({ type: 'excalidraw', version: 2, elements: [element], appState: { viewBackgroundColor: '#ffffff' } })
}

/** `POST …/versions/[versionId]/pages/[page]/sketch`: the new Skizze's ids, and where it lies. */
export async function createSketchFromPage(input: SketchFromPageInput): Promise<FiledDiagram & { underlay: SketchUnderlay; movedToBase: boolean }> {
  const { session } = input
  const ref: SketchUnderlay = { documentId: input.documentId, versionId: input.versionId, page: input.page, dpi: (input.body.dpi ?? DEFAULT_PAGE_RASTER_DPI) as SketchUnderlay['dpi'] }
  // The person opens the page here: logged like any viewer's open.
  const raster = await readPageRaster(session, ref)
  const base = raster.document
  if (!base.projectId) throw new UnprocessableError('A sketch on a page lies in a project; this document is in the office shelf.', { reason: 'underlay_other_project' })
  const drawn = await drawSketchScene(null, sceneOnPage(ref, raster))
  const confined = await folderRestrictsReading(session.organizationId, base.projectId, base.folderId)
  const filed = await fileDiagramDocuments({
    session,
    projectId: base.projectId,
    svg: drawn.svg,
    source: serializeSketchScene(drawn.scene),
    sourceKind: 'excalidraw',
    // A person's Skizze has no answer it was drawn in: its own reference, so it files once.
    answerRef: `page-sketch-${randomUUID()}`,
    title: input.title(documentDisplayName(base).replace(/\.pdf$/i, ''), input.page),
    marking: input.marking,
    request: input.request,
    underlay: !confined && drawn.underlay ? { ...drawn.underlay, png: raster.png } : null,
  })
  if (!confined || filed.svg.folderId === base.folderId) return { ...filed, underlay: ref, movedToBase: false }
  const moved = await moveDocumentToFolder({ documentId: filed.svg.documentId, folderId: base.folderId }, session)
  return { ...filed, underlay: ref, movedToBase: moved.ok }
}

function pageOf(versionId: string, versionNumber: number, page: number, labels: readonly (string | null)[]): UnderlayPage {
  return { versionId, versionNumber, page, pageLabel: labels[page - 1] ?? null }
}

/** Where the page lands in `toVersionId`: the same label when the PDF names one, else the same number. */
async function planFor(session: AuthorizedSession, ref: SketchUnderlay, toVersionId: string): Promise<UnderlayMovePlan> {
  const [fromVersion, toVersion] = await Promise.all([
    findDocumentVersion(ref.versionId, ref.documentId, session.organizationId),
    findDocumentVersion(toVersionId, ref.documentId, session.organizationId),
  ])
  if (!fromVersion || !toVersion) throw new NotFoundError('Version not found')
  const [fromLabels, toLabels] = await Promise.all([readPageLabels(session, ref.documentId, ref.versionId), readPageLabels(session, ref.documentId, toVersionId)])
  const label = fromLabels[ref.page - 1] ?? null
  const byLabel = label ? toLabels.indexOf(label) : -1
  if (byLabel < 0 && ref.page > toLabels.length) {
    throw new UnprocessableError('That page is not in the newer version.', { reason: 'page_gone', pageCount: toLabels.length })
  }
  const page = byLabel >= 0 ? byLabel + 1 : ref.page
  return {
    from: pageOf(fromVersion.id, fromVersion.versionNumber, ref.page, fromLabels),
    to: pageOf(toVersion.id, toVersion.versionNumber, page, toLabels),
    matchedBy: byLabel >= 0 ? 'label' : 'index',
  }
}

/** The Skizze's underlay and the base version a move goes to; 409 when it already lies there. */
async function moveTarget(session: AuthorizedSession, documentId: string, versionId: string | undefined) {
  const saveBase = await sketchSaveBaseOf(session, documentId, 'write')
  const underlay = underlayOf(saveBase.scene.elements)
  if (!underlay) throw new ConflictError('This sketch is not drawn on a page.', { reason: 'no_underlay' })
  const base = await getAccessibleDocument(session, underlay.ref.documentId, 'read')
  const to = versionId ?? base.publishedVersionId
  if (!to || to === underlay.ref.versionId) throw new ConflictError('The sketch already lies on that version.', { reason: 'underlay_current' })
  return { saveBase, underlay, to }
}

/** `GET /api/documents/[id]/sketch/underlay`: what the move would do, before the person decides. */
export async function planSketchUnderlayMove(session: AuthorizedSession, documentId: string, versionId?: string): Promise<UnderlayMovePlan> {
  const { underlay, to } = await moveTarget(session, documentId, versionId)
  return planFor(session, underlay.ref, to)
}

/** `POST /api/documents/[id]/sketch/underlay`: the page swapped for the newer Fassung's, saved as the Skizze's next Fassung. */
export async function moveSketchUnderlay(input: { session: AuthorizedSession; documentId: string; body: UnderlayMoveBody; marking: string; request?: Request }) {
  const { session } = input
  const { saveBase, underlay, to } = await moveTarget(session, input.documentId, input.body.versionId)
  const plan = await planFor(session, underlay.ref, to)
  const ref: SketchUnderlay = { ...underlay.ref, versionId: to, page: plan.to.page }
  const raster = await readPageRaster(session, ref, { log: false })
  const elements = saveBase.scene.elements.map((element) => {
    if (element.id !== underlay.elementId) return element
    return {
      ...element,
      width: Math.max(1, Math.round(raster.facts.widthPt)),
      height: Math.max(1, Math.round(raster.facts.heightPt)),
      fileId: underlayFileId(ref),
      customData: { underlay: ref },
      version: (typeof element.version === 'number' ? element.version : 0) + 1,
      versionNonce: nonce(),
    }
  })
  const saved = await saveSketchDocument({
    session,
    documentId: input.documentId,
    body: { scene: { ...saveBase.scene, elements }, baseVersionId: input.body.baseVersionId },
    marking: input.marking,
    request: input.request,
  })
  const { answerRef: _answerRef, pdfOutcome: _pdfOutcome, ...rest } = saved
  return { ...rest, plan }
}

/** Why this Skizze may not move into `folderId`, in words, or null (`lib/documents/move-to-folder.ts` asks before it moves). */
export async function sketchMoveRefusal(session: AuthorizedSession, document: Document, folderId: string | null): Promise<string | null> {
  const sketch = await publishedSketchOf(document).catch(() => null)
  return underlayMoveRefusal(session, sketch?.scene ?? null, document, folderId)
}
