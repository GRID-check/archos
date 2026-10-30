/**
 * Take a Skizze's current Fassung back (S4, the receipt's „Rückgängig“):
 * `POST { versionId }` saves the Fassung before it as the next one, when
 * `versionId` is still the current Fassung and no Freigabe round is open; else
 * 409 `moved_on` and nothing changes. The save is the ordinary one (ADR-0148,
 * ADR-0149). Thin: the service is `bff/diagrams/sketch-edit-service.ts`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError, ConflictError, ServiceUnavailableError, UnprocessableError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { sketchNoticesOf } from '@/lib/diagrams/sketch-notice'
import { getLocale } from '@/i18n/server'
import { revertSketchDocument, SketchMovedOnError } from '@/lib/diagrams/sketch-edit-service'
import { sketchRevertSchema } from '@/lib/diagrams/sketch-edit-wire'
import { SketchRenderError } from '@/lib/diagrams/sketch-renderer'
import { SketchSceneError } from '@/lib/diagrams/sketch-scene'
import { DiagramSvgError } from '@/lib/diagrams/svg'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, sketchRevertSchema, { maxBytes: 4 * 1024 })
    const diagrams = diagramsCopy.messages[await getLocale()]
    try {
      return await revertSketchDocument({ session, documentId: params.id, body, marking: diagrams.markingEdited, notices: sketchNoticesOf(diagrams), request })
    } catch (error) {
      if (error instanceof SketchMovedOnError) {
        throw new ConflictError(diagrams.sketchEdit.movedOn, { reason: 'moved_on', currentVersionId: error.currentVersionId })
      }
      if (error instanceof DiagramSvgError) throw new BadRequestError(diagrams.rejected[error.rejection])
      if (error instanceof SketchSceneError) throw new BadRequestError(diagrams.sketch.sceneRejected, { refusal: error.refusal })
      if (error instanceof SketchRenderError && error.reason === 'too_much_text') {
        throw new UnprocessableError(diagrams.sketch.tooMuchText, { reason: 'too_much_text' })
      }
      if (error instanceof SketchRenderError) throw new ServiceUnavailableError(diagrams.sketch.renderUnavailable, { reason: error.reason })
      throw error
    }
  },
  {
    authz: { enforcedBy: 'revertSketchDocument -> getAccessibleDocument write (project:documents:write AND project:edit, folder write); the save as PUT /sketch' },
  }
)
