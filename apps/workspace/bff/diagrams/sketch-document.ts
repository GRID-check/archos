/**
 * A Skizze as a document: read its scene back, and save an edit as a new
 * Fassung of the same document (ADR-0148). The service behind
 * `GET` and `PUT /api/documents/[id]/sketch`.
 *
 * ## What a save writes
 *
 *   1. The scene is checked (`sketch-scene.ts`); the server used to store it
 *      unread.
 *   2. The SVG goes through the filing validator (`acceptDiagram`), which writes
 *      the stored bytes from its allow-list, puts the scene in `<metadata>` and
 *      the marking in `<title>`/`<desc>`. The marking is the two-author one
 *      (`markingEdited`), because a person changed what Piloti drew; the
 *      machine half stays `AIGenerated=true; AIHumanReviewed=false`, because
 *      editing is not a Freigabe (ADR-0141).
 *   3. The bytes become the document's next Fassung (`sketch-version.ts`),
 *      refused with 409 when `baseVersionId` is no longer the current one.
 *   4. The PDF companion, the `diagram_pdf` row filed under the same reference,
 *      is drawn again from the new SVG and becomes its next Fassung too. When it
 *      cannot be found or drawn, the SVG's Fassung stands and `pdf` is `null`:
 *      the SVG is the half that carries the scene, as in filing (`filing.ts`).
 *
 * Only a sketch filed into the project is saved here (`diagram_svg`, the
 * excalidraw kind): its row is machine-authored and `stored`, so new bytes need
 * no screening. A person's own upload that happens to carry a scene is read,
 * never written: its new bytes would be an upload, with an upload's screening.
 */

import 'server-only'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { ApiError, BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { markingIsInBytes } from '@/lib/ai-provenance'
import type { Document } from '@/lib/db/schema/documents'
import { recordDocumentAccess } from '@/lib/download-log/service'
import { getAccessibleDocument } from '@/lib/documents/access'
import { generatedDocumentMarking } from '@/lib/documents/generated'
import { findDocumentAuthoredByRef } from '@/lib/documents/repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { MAX_DIAGRAM_SOURCE_BYTES, MAX_DIAGRAM_SVG_BYTES } from './diagram-sources'
import { publishNextVersion } from './sketch-version'
import { outlineSketch } from './sketch-outline'
import { checkSketchScene, parseStoredSketchScene, serializeSketchScene, type SketchScene } from './sketch-scene'
import type { SaveSketchBody, SavedSketch, SketchDocumentView } from './sketch-wire'
import { storedDiagramSource } from './stored-source'
import { viewBoxOf } from '@/lib/annotations/sketch-anchor'
import { acceptDiagram, censusSvg, type AcceptedDiagram } from './svg'
import { renderDiagramPdf } from './svg-to-pdf'

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

async function readStoredText(document: Document): Promise<string> {
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: resolveDocumentBucket(document.storageBucket), Key: document.storageKey })
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
export async function publishedSketchOf(document: Document): Promise<PublishedSketch | null> {
  if (document.contentType !== SVG || (document.fileSize ?? 0) > MAX_STORED_SKETCH_BYTES) return null
  const text = await readStoredText(document)
  const stored = storedDiagramSource(text)
  const scene = stored?.kind === 'excalidraw' ? parseStoredSketchScene(stored.source) : null
  return scene ? { scene, viewBox: viewBoxOf(text) } : null
}

/** The scene a document's current bytes carry, or a 415 when they carry none this product can read. */
async function storedSceneOf(document: Document): Promise<SketchScene> {
  const sketch = await publishedSketchOf(document)
  if (!sketch) throw notASketch()
  return sketch.scene
}

function titleOf(document: Document): string {
  return (document.displayName ?? document.filename).replace(/\.svg$/i, '')
}

/** `GET /api/documents/[id]/sketch`. */
export async function readSketchDocument(session: AuthorizedSession, documentId: string): Promise<SketchDocumentView> {
  const document = await getAccessibleDocument(session, documentId, 'read')
  const scene = await storedSceneOf(document)
  // Whether the editor opens to draw or to watch; the save and the room's edit lane check it again.
  const canWrite = await getAccessibleDocument(session, documentId, 'write').then(
    () => true,
    (error: unknown) => {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) return false
      throw error
    }
  )
  // The scene is the document's content as much as its picture is.
  await recordDocumentAccess(session, document, 'preview')
  return {
    documentId: document.id,
    versionId: document.publishedVersionId,
    canWrite,
    title: titleOf(document),
    scene,
    outline: outlineSketch(scene),
  }
}

export interface SaveSketchInput {
  session: AuthorizedSession
  documentId: string
  body: SaveSketchBody
  /** The two-author line, in the reader's locale (`markingEdited`), resolved by the route. */
  marking: string
  request?: Request
}

function acceptSketch(
  body: SaveSketchBody,
  marking: string,
  ref: string
): { accepted: AcceptedDiagram; source: string; scene: SketchScene } {
  const scene = checkSketchScene(body.scene)
  const source = serializeSketchScene(scene)
  const provenance = generatedDocumentMarking('diagram_svg', ref)
  const accepted = acceptDiagram({ svg: body.svg, source, sourceKind: 'excalidraw' }, { notice: marking, provenance })
  return { accepted, source, scene }
}

/** `PUT /api/documents/[id]/sketch`. */
/** The saved Fassung, and the reference the score finds the drawing turn by (never sent on the wire). */
export async function saveSketchDocument(input: SaveSketchInput): Promise<SavedSketch & { answerRef: string }> {
  const { session, body } = input
  const document = await getAccessibleDocument(session, input.documentId, 'write')
  await storedSceneOf(document)
  if (document.authoredByProducer !== 'diagram_svg' || !document.authoredByRef) {
    throw new BadRequestError('Only a sketch filed into the project is saved as a new version; upload a new file instead.')
  }
  const { accepted, scene } = acceptSketch(body, input.marking, document.authoredByRef)
  const bytes = new TextEncoder().encode(accepted.svg)
  const provenance = generatedDocumentMarking('diagram_svg', document.authoredByRef)
  if (!markingIsInBytes(bytes, provenance)) throw new Error('the sketch SVG lost its AI marking')

  const version = await publishNextVersion({
    session,
    document,
    bytes,
    contentType: SVG,
    expected: { publishedVersionId: body.baseVersionId },
    request: input.request,
    // Its marks go on with it, placed on the sheet just accepted (`lib/annotations/sketch-carry.ts`).
    sketch: { elements: scene.elements, viewBox: accepted.viewport },
  })
  const pdf = await redrawCompanionPdf(input, document, accepted)
  return { documentId: document.id, versionId: version.id, versionNumber: version.versionNumber, pdf, answerRef: document.authoredByRef }
}

/** The PDF filed beside the sketch, drawn again as its next Fassung; `null` when there is none or it failed. */
async function redrawCompanionPdf(
  input: SaveSketchInput,
  sketch: Document,
  accepted: AcceptedDiagram,
): Promise<SavedSketch['pdf']> {
  const { session } = input
  if (!sketch.projectId || !sketch.authoredByRef) return null
  try {
    const found = await findDocumentAuthoredByRef(sketch.authoredByRef, session.organizationId, sketch.projectId, 'diagram_pdf')
    if (!found) return null
    const pdfDocument = await getAccessibleDocument(session, found.id, 'write')
    const project = await findProjectInOrg(sketch.projectId, session.organizationId)
    const provenance = generatedDocumentMarking('diagram_pdf', sketch.authoredByRef)
    const bytes = await renderDiagramPdf({
      root: accepted.root,
      viewport: accepted.viewport,
      title: titleOf(sketch),
      projectName: project?.name ?? '',
      marking: input.marking,
      provenance,
      createdAt: new Date(),
    })
    if (!markingIsInBytes(bytes, provenance)) throw new Error('the sketch PDF does not carry its AI marking')
    const version = await publishNextVersion({
      session,
      document: pdfDocument,
      bytes,
      contentType: 'application/pdf',
      expected: { publishedVersionId: pdfDocument.publishedVersionId },
      request: input.request,
    })
    return { documentId: pdfDocument.id, versionId: version.id }
  } catch (error) {
    console.error('[diagrams] the sketch was saved and its PDF was not', {
      documentId: sketch.id,
      cause: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
      census: censusSvg(accepted.root),
    })
    return null
  }
}
