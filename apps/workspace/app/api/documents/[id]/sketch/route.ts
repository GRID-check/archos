/**
 * A Skizze read back and saved as a new Fassung (ADR-0148).
 *
 * `GET` answers the stored Excalidraw scene and its outline (texts, shapes,
 * connections, frames), 415 when the document carries no scene; `?scene=omit`
 * leaves the scene out and `?ids=a,b` answers only those elements whole. `PUT`
 * takes `{ scene, baseVersionId }`, draws the picture from the scene on the
 * server (ADR-0149) and publishes the next Fassung of the same document and of
 * its PDF companion; 409 when `baseVersionId` is no longer the current Fassung,
 * 503 when the picture could not be drawn. Thin: the service is `bff/diagrams/sketch-document.ts`, the
 * wire `bff/diagrams/sketch-wire.ts`.
 *
 * The locale matters for the same reason it does in filing
 * (`app/api/projects/[id]/diagrams/route.ts`): the two-author marking is part
 * of the file, resolved where the request is.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { BadRequestError, ServiceUnavailableError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { getLocale } from '@/i18n/server'
import { MAX_DIAGRAM_SOURCE_BYTES, MAX_DIAGRAM_SVG_BYTES } from '@/lib/diagrams/diagram-sources'
import { probeSketchDocument, readSketchDocument, saveSketchDocument } from '@/lib/diagrams/sketch-document'
import { SketchRenderError } from '@/lib/diagrams/sketch-renderer'
import { SketchSceneError } from '@/lib/diagrams/sketch-scene'
import { ROOM_PEER_HEADER, saveSketchSchema, sketchReadOptions, sketchReadQuerySchema } from '@/lib/diagrams/sketch-wire'
import { DiagramSvgError } from '@/lib/diagrams/svg'
import { recordSketchRevisedScore } from '@/lib/langfuse/sketch-score'

type Params = { id: string }

/**
 * The scene cap, doubled for JSON escaping, plus room for the rest. The SVG cap
 * stays in it: an editor tab opened before ADR-0149 still sends its `svg`,
 * which the schema drops unread.
 */
const MAX_SKETCH_REQUEST_BYTES = 2 * (MAX_DIAGRAM_SVG_BYTES + MAX_DIAGRAM_SOURCE_BYTES) + 8 * 1024

const PEER_ID = /^[A-Za-z0-9_-]{8,64}$/

/** `?probe=1`: the Files preview asking whether to offer the editor. It carries nothing of the drawing, so it is no read the download log records. */
export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    if (new URL(request.url).searchParams.get('probe') === '1') return probeSketchDocument(session, params.id)
    return readSketchDocument(session, params.id, sketchReadOptions(parseQuery(request, sketchReadQuerySchema)))
  },
  {
    authz: { enforcedBy: 'readSketchDocument -> getAccessibleDocument (project:view, folder visibility)' },
  }
)

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    // Bounded whether or not the body declares its length: a chunked one is cut off at the cap too.
    const body = await parseJsonBody(request, saveSketchSchema, { maxBytes: MAX_SKETCH_REQUEST_BYTES })
    const peer = request.headers.get(ROOM_PEER_HEADER)
    const diagrams = diagramsCopy.messages[await getLocale()]
    try {
      const { answerRef, pdfOutcome: _pdf, ...saved } = await saveSketchDocument({
        session,
        documentId: params.id,
        body,
        marking: diagrams.markingEdited,
        request,
        peerId: peer && PEER_ID.test(peer) ? peer : null,
      })
      // Not awaited, and it never rejects (`recordSketchRevisedScore`).
      void recordSketchRevisedScore({
        organizationId: session.organizationId,
        documentId: saved.documentId,
        answerRef,
        versionNumber: saved.versionNumber,
      })
      return saved
    } catch (error) {
      if (error instanceof DiagramSvgError) throw new BadRequestError(diagrams.rejected[error.rejection])
      if (error instanceof SketchSceneError) throw new BadRequestError(diagrams.sketch.sceneRejected, { refusal: error.refusal })
      if (error instanceof SketchRenderError) throw new ServiceUnavailableError(diagrams.sketch.renderUnavailable, { reason: error.reason })
      throw error
    }
  },
  {
    authz: {
      enforcedBy:
        'saveSketchDocument -> getAccessibleDocument write (project:documents:write AND project:edit, folder write); only a filed diagram_svg',
    },
  }
)
