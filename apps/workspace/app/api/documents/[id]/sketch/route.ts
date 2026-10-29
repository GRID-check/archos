/**
 * A Skizze read back and saved as a new Fassung (ADR-0148).
 *
 * `GET` answers the stored Excalidraw scene and its outline (texts, shapes,
 * connections, frames), 415 when the document carries no scene. `PUT` takes
 * `{ scene, svg, baseVersionId }` and publishes the next Fassung of the same
 * document and of its PDF companion; 409 when `baseVersionId` is no longer the
 * current Fassung. Thin: the service is `bff/diagrams/sketch-document.ts`, the
 * wire `bff/diagrams/sketch-wire.ts`.
 *
 * The locale matters for the same reason it does in filing
 * (`app/api/projects/[id]/diagrams/route.ts`): the two-author marking is part
 * of the file, resolved where the request is.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError, PayloadTooLargeError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { getLocale } from '@/i18n/server'
import { MAX_DIAGRAM_SOURCE_BYTES, MAX_DIAGRAM_SVG_BYTES } from '@/lib/diagrams/diagram-sources'
import { readSketchDocument, saveSketchDocument } from '@/lib/diagrams/sketch-document'
import { SketchSceneError } from '@/lib/diagrams/sketch-scene'
import { saveSketchSchema } from '@/lib/diagrams/sketch-wire'
import { DiagramSvgError } from '@/lib/diagrams/svg'
import { recordSketchRevisedScore } from '@/lib/langfuse/sketch-score'

type Params = { id: string }

/** The SVG and scene caps, doubled for JSON escaping, plus room for the rest (as in filing). */
const MAX_SKETCH_REQUEST_BYTES = 2 * (MAX_DIAGRAM_SVG_BYTES + MAX_DIAGRAM_SOURCE_BYTES) + 8 * 1024

export const GET = apiRoute<Params>(async ({ session, params }) => readSketchDocument(session, params.id), {
  authz: { enforcedBy: 'readSketchDocument -> getAccessibleDocument (project:view, folder visibility)' },
})

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SKETCH_REQUEST_BYTES) {
      throw new PayloadTooLargeError(MAX_SKETCH_REQUEST_BYTES)
    }
    const body = await parseJsonBody(request, saveSketchSchema)
    const diagrams = diagramsCopy.messages[await getLocale()]
    try {
      const { answerRef, ...saved } = await saveSketchDocument({
        session,
        documentId: params.id,
        body,
        marking: diagrams.markingEdited,
        request,
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
