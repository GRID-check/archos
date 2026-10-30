/**
 * A Skizze as a document: read its scene back, and save an edit as a new
 * Fassung of the same document (ADR-0148). The service behind
 * `GET` and `PUT /api/documents/[id]/sketch`.
 *
 * ## What a save writes
 *
 *   1. The scene is checked (`sketch-scene.ts`); the server used to store it
 *      unread.
 *   2. The server draws the SVG from the scene (`sketch-picture.ts`, ADR-0149):
 *      no picture a client sends is stored, so scene and picture cannot disagree.
 *      It goes through the filing validator (`acceptDiagram`), which writes
 *      the stored bytes from its allow-list, puts the scene in `<metadata>` and
 *      the marking in `<title>`/`<desc>`. The marking is the two-author one
 *      (`markingEdited`), because a person changed what Piloti drew; the
 *      machine half stays `AIGenerated=true; AIHumanReviewed=false`, because
 *      editing is not a Freigabe (ADR-0141).
 *   3. The bytes become the document's next Fassung (`sketch-version.ts`),
 *      refused with 409 when `baseVersionId` is no longer the current one.
 *   4. The PDF companion, the `diagram_pdf` row filed under the same reference,
 *      is drawn again from the new SVG and becomes its next Fassung too
 *      (`sketch-companion.ts`). When it cannot be found or drawn, the SVG's
 *      Fassung stands and `pdf` is `null`: the SVG is the half that carries the
 *      scene, as in filing (`filing.ts`).
 *
 * ## A save during Freigabe (`docs/architecture/revisions.md`)
 *
 * A save never publishes around an open round. While the Skizze has a draft
 * (`draft`, or `changes_requested` after a reviewer sent it back) the editor
 * opens that draft and a save writes into it, through the draft machinery every
 * revision uses (`replaceVersionContent`, the scene checked as on any save,
 * compare-and-swap on the draft's content hash): nothing is published, no PDF
 * is drawn, and the reviewer's next look is at the reworked draft. While a
 * version is `in_review` (or `approved`, from before approval became one step),
 * a save is refused, 409 `review_open`: the reviewer is reading those bytes, and
 * the editor says so and lets the person draw on, live, without saving.
 *
 * Only a sketch filed into the project is saved here (`diagram_svg`, the
 * excalidraw kind): its row is machine-authored and `stored`, so new bytes need
 * no screening. A person's own upload that happens to carry a scene is read,
 * never written: its new bytes would be an upload, with an upload's screening.
 */

import 'server-only'
import { randomBytes, randomInt } from 'node:crypto'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { ApiError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { markingIsInBytes } from '@/lib/ai-provenance'
import type { Document } from '@/lib/db/schema/documents'
import { recordDocumentAccess } from '@/lib/download-log/service'
import { getAccessibleDocument } from '@/lib/documents/access'
import { generatedDocumentMarking } from '@/lib/documents/generated'
import { PublishedVersionMovedError } from '@/lib/documents/published-guard'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { contentDigest } from '@/lib/documents/content-digest'
import { replaceVersionContent } from '@/lib/documents/lifecycle'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import { sketchOpeningFor, sketchTargetOf } from './sketch-target'
import { mayReceiveVersionBytes } from '@/lib/documents/version-content'
import { redrawCompanionPdf, type CompanionPdfOutcome } from './sketch-companion'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { MAX_DIAGRAM_SOURCE_BYTES, MAX_DIAGRAM_SVG_BYTES } from './diagram-sources'
import { publishNextVersion } from './sketch-version'
import { outlineSketch } from './sketch-outline'
import { resolveSketchLinks } from './sketch-link-resolve'
import { reviseScene, withoutTombstones } from './sketch-revise'
import { drawSketchScene } from './sketch-picture'
import { indexSketchForSearch } from './sketch-search'
import { SketchRenderError } from './sketch-renderer'
import {
  checkSketchScene,
  MAX_SCENE_ELEMENTS,
  parseStoredSketchScene,
  sceneHashOf,
  serializeSketchScene,
  SketchSceneError,
  type SketchScene,
} from './sketch-scene'
import type { SaveSketchBody, SavedSketch, SketchDocumentView, SketchProbe, SketchReadOptions } from './sketch-wire'
import { storedDiagramSource } from './stored-source'
import { viewBoxOf } from '@/lib/annotations/sketch-anchor'
import { recordSketchSaveScore, type SketchSaveInput, type SketchSaveOutcome } from '@/lib/langfuse/sketch-score'
import { acceptDiagram, DiagramSvgError, type AcceptedDiagram } from './svg'

export type { CompanionPdfOutcome } from './sketch-companion'

const SVG = 'image/svg+xml'
/** A stored sketch is its picture plus its scene, and the markup around them. */
const MAX_STORED_SKETCH_BYTES = MAX_DIAGRAM_SVG_BYTES + 2 * MAX_DIAGRAM_SOURCE_BYTES

function notASketch(): ApiError {
  return new ApiError(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'Not a sketch: this document carries no Excalidraw scene. Read it with document-text-get, ' +
      'document-visual-details-get or document-look instead.'
  )
}

async function readStoredText(bytes: Pick<Document, 'storageBucket' | 'storageKey'>): Promise<string> {
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: resolveDocumentBucket(bytes.storageBucket), Key: bytes.storageKey })
    )
    if (!object.Body) throw new NotFoundError('File not available')
    return await object.Body.transformToString('utf8')
  } catch {
    throw new NotFoundError('File not available')
  }
}

/** A Skizze as its current bytes hold it: the scene, and the size of the sheet its SVG draws. */
export interface PublishedSketch {
  scene: SketchScene
  /** Null for an SVG sized by `width` and `height` alone, which the editor never writes. */
  viewBox: { width: number; height: number } | null
}

/**
 * The scene and the sheet a document's current bytes carry, or null when they
 * carry no scene this product can read: the document is no Skizze. Where a
 * mark on a Skizze takes its box from (`lib/annotations/sketch-place.ts`).
 */
export async function publishedSketchOf(
  document: Pick<Document, 'contentType' | 'fileSize' | 'storageBucket' | 'storageKey'>
): Promise<PublishedSketch | null> {
  if (document.contentType !== SVG || (document.fileSize ?? 0) > MAX_STORED_SKETCH_BYTES) return null
  const text = await readStoredText(document)
  const stored = storedDiagramSource(text)
  const scene = stored?.kind === 'excalidraw' ? parseStoredSketchScene(stored.source) : null
  return scene ? { scene, viewBox: viewBoxOf(text) } : null
}

/** The scene some bytes carry (the current ones, or a draft's), or a 415 when they carry none this product can read. */
async function storedSceneOf(document: Pick<Document, 'contentType' | 'fileSize' | 'storageBucket' | 'storageKey'>): Promise<SketchScene> {
  const sketch = await publishedSketchOf(document)
  if (!sketch) throw notASketch()
  return sketch.scene
}

function titleOf(document: Document): string {
  return (document.displayName ?? document.filename).replace(/\.svg$/i, '')
}

/** Whether the save takes new bytes for this document at all: only a sketch filed into the project. */
const savesAsVersion = (document: Document) => document.authoredByProducer === 'diagram_svg' && Boolean(document.authoredByRef)

/** The drawn elements a focused read names, whole, in scene order. */
function focusedElements(scene: SketchScene, ids: readonly string[]) {
  const wanted = new Set(ids)
  return scene.elements.filter((element) => wanted.has(element.id) && !element.isDeleted)
}

/** Whether the editor opens to draw or to watch: what the PUT would take. The save and the room's edit lane check it again. */
async function mayWrite(session: AuthorizedSession, document: Document): Promise<boolean> {
  if (!savesAsVersion(document)) return false
  return getAccessibleDocument(session, document.id, 'write').then(
    () => true,
    (error: unknown) => {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) return false
      throw error
    }
  )
}

/** The scene a save would replace, and the version it must name (`sketch-edit-service.ts`). */
export interface SketchSaveBase {
  document: Document
  scene: SketchScene
  /** The open draft's id, or the current Fassung's. */
  versionId: string | null
  contentHash: string | null
  target: 'published' | 'draft' | 'review_open'
}

/**
 * What a save of this session would build on: the open Freigabe draft when
 * there is one this session may receive, else the current Fassung. Reads the
 * scene without logging a hand-over: nothing reaches the person here.
 */
export async function sketchSaveBaseOf(session: AuthorizedSession, documentId: string, access: 'read' | 'write'): Promise<SketchSaveBase> {
  const document = await getAccessibleDocument(session, documentId, access)
  const target = await sketchTargetOf(document)
  if (target.kind === 'draft' && (await mayReceiveVersionBytes(session, document, target.version))) {
    const scene = await storedSceneOf({ ...target.version, contentType: SVG })
    return { document, scene, versionId: target.version.id, contentHash: target.version.contentHash, target: 'draft' }
  }
  return { document, scene: await storedSceneOf(document), versionId: document.publishedVersionId, contentHash: null, target: target.kind }
}

/** The scene stored in some bytes of a Skizze (an earlier Fassung's), or a 415 when they hold none. */
export function sketchSceneOfText(text: string): SketchScene {
  const stored = storedDiagramSource(text)
  const scene = stored?.kind === 'excalidraw' ? parseStoredSketchScene(stored.source) : null
  if (!scene) throw notASketch()
  return scene
}

/**
 * `GET /api/documents/[id]/sketch?probe=1`: the Files preview asking whether to
 * offer the editor. No reading of the document by the person, so it is not
 * logged, and so it carries nothing of the drawing: no scene, no outline, no
 * title. Opening the editor reads without the probe, and that read is logged.
 */
export async function probeSketchDocument(session: AuthorizedSession, documentId: string): Promise<SketchProbe> {
  const document = await getAccessibleDocument(session, documentId, 'read')
  const hasScene = (await publishedSketchOf(document).catch(() => null)) !== null
  const canWrite = hasScene && (await sketchOpeningFor(session, document, await mayWrite(session, document))).canWrite
  return { hasScene, canWrite, versionId: document.publishedVersionId }
}

/**
 * `GET /api/documents/[id]/sketch`. A writer opens the open draft when the
 * Skizze is in Freigabe (`./sketch-target.ts`); a reader always the current
 * Fassung, which is what the office shows.
 */
export async function readSketchDocument(
  session: AuthorizedSession,
  documentId: string,
  options: SketchReadOptions = { scene: true, ids: null }
): Promise<SketchDocumentView> {
  const document = await getAccessibleDocument(session, documentId, 'read')
  // A draft only when this session may receive its bytes and write into it (`./sketch-target.ts`).
  const { target, draft, canWrite } = await sketchOpeningFor(session, document, await mayWrite(session, document))
  const scene = await storedSceneOf(draft ? { ...draft, contentType: SVG } : document)
  // The scene is the document's content as much as its picture is.
  await recordDocumentAccess(session, document, 'preview', draft ? { versionId: draft.id } : undefined)
  const outline = outlineSketch(scene)
  return {
    documentId: document.id,
    projectId: document.projectId,
    versionId: draft?.id ?? document.publishedVersionId,
    canWrite,
    title: titleOf(document),
    outline,
    // What each link is for this reader: the outline names ids, this what they may see of them.
    links: await resolveSketchLinks(session, outline.links),
    ...(options.scene ? { scene } : {}),
    ...(options.ids ? { elements: focusedElements(scene, options.ids) } : {}),
    saveTarget: target.kind,
    contentHash: draft?.contentHash ?? null,
  }
}

export interface SaveSketchInput {
  session: AuthorizedSession
  documentId: string
  body: SaveSketchBody
  /** The two-author line, in the reader's locale (`markingEdited`), resolved by the route. */
  marking: string
  request?: Request
  /** The saving editor's peer id in the document room, so the room's notice of the save is no echo to it. */
  peerId?: string | null
}

/** A 31-bit random integer, as Excalidraw's `randomInteger` draws a nonce. */
const nonce = () => randomInt(2 ** 31)

/**
 * The scene as it is stored: checked, then versioned against the one it
 * replaces (`sketch-revise.ts`), so open canvases merge it rather than undo it.
 * Tombstones that would push it over the source cap are left out: the save
 * matters more than a stale canvas's merge.
 */
function storedSceneFor(stored: SketchScene, next: SketchScene): { scene: SketchScene; source: string; bumped: number; tombstoned: number } {
  const revised = reviseScene(stored, next, nonce)
  const fits = revised.scene.elements.length <= MAX_SCENE_ELEMENTS
  try {
    if (fits) return { ...revised, source: serializeSketchScene(revised.scene) }
  } catch (error) {
    if (!(error instanceof SketchSceneError) || revised.tombstoned === 0) throw error
  }
  const scene = withoutTombstones(revised, next)
  return { scene, source: serializeSketchScene(scene), bumped: revised.bumped, tombstoned: 0 }
}

/**
 * The scene checked, its picture drawn by the server from it (`sketch-picture.ts`,
 * ADR-0149), then versioned and filed through the validator. The picture is
 * always the server's: no SVG a client sends is stored.
 */
async function acceptSketch(body: SaveSketchBody, stored: SketchScene, marking: string, ref: string) {
  const drawn = await drawSketchScene(stored, checkSketchScene(body.scene))
  const { scene, source, bumped, tombstoned } = storedSceneFor(stored, drawn.scene)
  const provenance = generatedDocumentMarking('diagram_svg', ref)
  const accepted: AcceptedDiagram = acceptDiagram({ svg: drawn.svg, source, sourceKind: 'excalidraw' }, { notice: marking, provenance })
  return { accepted, source, scene, bumped, tombstoned, render: drawn.render }
}

/** The 409 a save meets while a Freigabe round is reading the Skizze: nothing is saved, the canvas stays live. */
export function reviewOpenRefusal(version: Pick<DocumentVersion, 'id' | 'state'>): ConflictError {
  return new ConflictError('This sketch is in review: it cannot be saved until the review is decided.', {
    reason: 'review_open',
    versionId: version.id,
    state: version.state,
  })
}

/** `PUT /api/documents/[id]/sketch`: the saved Fassung, and the reference the score finds the drawing turn by (never sent on the wire). */
export async function saveSketchDocument(
  input: SaveSketchInput
): Promise<SavedSketch & { answerRef: string; pdfOutcome: CompanionPdfOutcome }> {
  const { session } = input
  const document = await getAccessibleDocument(session, input.documentId, 'write')
  if (!savesAsVersion(document) || !document.authoredByRef) {
    await storedSceneOf(document)
    throw new BadRequestError('Only a sketch filed into the project is saved as a new version; upload a new file instead.')
  }
  const answerRef = document.authoredByRef
  const score = (outcome: SketchSaveOutcome, extra: Partial<SketchSaveInput> = {}) =>
    void recordSketchSaveScore({ organizationId: session.organizationId, documentId: document.id, answerRef, outcome, ...extra })
  try {
    const target = await sketchTargetOf(document)
    if (target.kind === 'review_open') throw reviewOpenRefusal(target.version)
    const saved =
      target.kind === 'draft'
        ? await writeDraft(input, document, target.version, answerRef)
        : await writeVersion(input, document, await storedSceneOf(document), answerRef)
    score(saved.state === 'draft' ? 'drafted' : saved.pdfOutcome === 'failed' ? 'pdf_stale' : 'saved', { metadata: saved.facts })
    const { facts: _facts, ...rest } = saved
    return rest
  } catch (error) {
    if (error instanceof PublishedVersionMovedError) score('conflict')
    else if (error instanceof ConflictError && reasonOf(error) === 'review_open') score('review_open')
    else if (error instanceof SketchSceneError) score('refused', { refusal: error.refusal })
    else if (error instanceof DiagramSvgError) score('refused', { refusal: error.rejection })
    else if (error instanceof SketchRenderError) score('render_failed', { refusal: error.reason })
    throw error
  }
}

/** The server's drawing of the save, as the score's metadata (ADR-0149). */
const renderFacts = (render: { ms: number; elements: number; remeasured: number }) => ({
  render_ms: render.ms,
  render_elements: render.elements,
  remeasured: render.remeasured,
})

const reasonOf = (error: ConflictError) => (error.details as { reason?: string } | undefined)?.reason

async function writeVersion(input: SaveSketchInput, document: Document, stored: SketchScene, answerRef: string) {
  const { session, body } = input
  const { accepted, scene, bumped, tombstoned, render } = await acceptSketch(body, stored, input.marking, answerRef)
  const bytes = new TextEncoder().encode(accepted.svg)
  const provenance = generatedDocumentMarking('diagram_svg', answerRef)
  if (!markingIsInBytes(bytes, provenance)) throw new Error('the sketch SVG lost its AI marking')

  const sceneHash = sceneHashOf(scene.elements)
  const version = await publishNextVersion({
    session,
    document,
    bytes,
    contentType: SVG,
    expected: { publishedVersionId: body.baseVersionId },
    request: input.request,
    // Its marks go on with it, placed on the sheet just accepted (`lib/annotations/sketch-carry.ts`).
    sketch: { elements: scene.elements, viewBox: accepted.viewport },
    // The room hears of it, stamped with the saving tab so it hears no echo (`lib/documents/current-version.ts`).
    room: { sceneHash, peerId: input.peerId ?? null },
  })
  // The search finds the sketch by what is drawn on it now (`sketch-search.ts`).
  await indexSketchForSearch({ organizationId: session.organizationId, documentId: document.id, title: titleOf(document), scene })
  const { pdf, outcome } = await redrawCompanionPdf({
    session,
    sketch: document,
    svgVersionId: version.id,
    drawing: accepted,
    marking: input.marking,
    title: titleOf(document),
    request: input.request,
  })
  return {
    documentId: document.id,
    versionId: version.id,
    versionNumber: version.versionNumber,
    state: 'published' as const,
    contentHash: version.contentHash,
    pdf,
    pdfStale: outcome === 'failed',
    pdfOutcome: outcome,
    answerRef,
    facts: {
      version_number: version.versionNumber,
      bumped,
      tombstoned,
      pdf: outcome,
      carried: version.carried.moved.length,
      lost: version.carried.lost.length,
      ...renderFacts(render),
    },
  }
}

/**
 * A save into the Skizze's open draft: its scene is versioned against the
 * draft's, the bytes are checked as on any save, and the draft's content is
 * replaced through the lifecycle (`replaceVersionContent`, compare-and-swap on
 * the hash read here). A save that started from anything but this draft, or
 * from an older state of it, is the 409 `stale_base_version` a published save
 * gets, so the editor merges and tries once more.
 */
async function writeDraft(input: SaveSketchInput, document: Document, draft: DocumentVersion, answerRef: string) {
  const { session, body } = input
  const stale = () => new PublishedVersionMovedError(document.id, draft.id)
  if (body.baseVersionId !== draft.id) throw stale()
  if (body.baseContentHash && draft.contentHash && body.baseContentHash !== draft.contentHash) throw stale()
  // Held bytes reach only who may see them (ADR-0086): a draft nobody screened is not merged into.
  if (!(await mayReceiveVersionBytes(session, document, draft))) throw new NotFoundError('Version not found')
  const stored = await storedSceneOf({ ...draft, contentType: SVG })
  const { accepted, scene, bumped, tombstoned, render } = await acceptSketch(body, stored, input.marking, answerRef)
  const bytes = Buffer.from(accepted.svg, 'utf8')
  if (!markingIsInBytes(bytes, generatedDocumentMarking('diagram_svg', answerRef))) throw new Error('the sketch SVG lost its AI marking')
  let written: DocumentVersion
  try {
    written = await replaceVersionContent(
      session,
      document.id,
      draft.id,
      { bytes, contentType: SVG, contentHash: contentDigest(bytes) },
      draft.contentHash,
      { request: input.request }
    )
  } catch (error) {
    // Another save won the swap, or a reviewer took the draft meanwhile: read again (the retry meets `review_open`).
    if (error instanceof ConflictError && !(error instanceof PublishedVersionMovedError)) throw stale()
    throw error
  }
  // The open canvases merge it; the draft is nobody's current Fassung, so nothing else is told.
  const peerId = input.peerId ?? `save_${randomBytes(6).toString('hex')}`
  await publishToDocumentRoom(document.id, {
    kind: 'scene.saved',
    peer: { peerId, userId: session.userId, name: session.name ?? session.email, kind: 'person' },
    versionId: written.id,
    sceneHash: sceneHashOf(scene.elements),
  })
  return {
    documentId: document.id,
    versionId: written.id,
    versionNumber: written.versionNumber,
    state: 'draft' as const,
    contentHash: written.contentHash,
    pdf: null,
    pdfStale: false,
    pdfOutcome: 'none' as CompanionPdfOutcome,
    answerRef,
    facts: { version_number: written.versionNumber, bumped, tombstoned, pdf: 'none', carried: 0, lost: 0, ...renderFacts(render) },
  }
}
