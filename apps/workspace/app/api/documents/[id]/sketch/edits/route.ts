/**
 * A Skizze changed by operations (S4): `POST` takes `{ baseVersionId, ops, note? }`,
 * applies the operations on the server and saves the result as the next Fassung
 * (or into the open Freigabe draft), the picture drawn by the server (ADR-0149).
 * No operations and a note: nothing is saved, `{ declined: true, note }`. 409
 * `sketch_changed` when a newer Fassung no longer has an element the edit names,
 * or someone changed one it leans on (`sketch-edit-rebase.ts`);
 * 422 for an operation the sketch cannot take. Thin: the service is
 * `bff/diagrams/sketch-edit-service.ts`, the wire `bff/diagrams/sketch-edit-wire.ts`.
 *
 * Piloti's call is a proposal (`document-sketch-edit`); a person's yes runs this
 * route in that person's session.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError, ConflictError, ServiceUnavailableError, UnprocessableError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { sketchNoticesOf } from '@/lib/diagrams/sketch-notice'
import { getLocale } from '@/i18n/server'
import { SketchEditError } from '@/lib/diagrams/sketch-edit'
import { editSketchDocument, SketchChangedError, sketchEditRefusalMessage } from '@/lib/diagrams/sketch-edit-service'
import { sketchEditSchema } from '@/lib/diagrams/sketch-edit-wire'
import { SketchRenderError } from '@/lib/diagrams/sketch-renderer'
import { SketchSceneError } from '@/lib/diagrams/sketch-scene'
import { DiagramSvgError } from '@/lib/diagrams/svg'

type Params = { id: string }

/** Sixty operations of a few hundred bytes each, with room. */
const MAX_EDIT_REQUEST_BYTES = 128 * 1024

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, sketchEditSchema, { maxBytes: MAX_EDIT_REQUEST_BYTES })
    const locale = await getLocale()
    const diagrams = diagramsCopy.messages[locale]
    try {
      return await editSketchDocument({ session, documentId: params.id, body, marking: diagrams.markingEdited, notices: sketchNoticesOf(diagrams), request })
    } catch (error) {
      if (error instanceof SketchEditError) {
        const message = locale === 'en' ? sketchEditRefusalMessage(error) : diagrams.sketchEdit.refused
        throw new UnprocessableError(message, { reason: 'sketch-edit-refused', refusal: error.refusal, op: error.opIndex + 1, elementId: error.elementId })
      }
      if (error instanceof SketchChangedError) {
        throw new ConflictError(diagrams.sketchEdit.changed, { reason: 'sketch_changed', currentVersionId: error.currentVersionId })
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
    authz: {
      enforcedBy:
        'editSketchDocument -> getAccessibleDocument write (project:documents:write AND project:edit, folder write); the save as PUT /sketch',
    },
  }
)
