/**
 * What a Skizze edit would do, without doing it (S4): `POST` takes the edit's
 * body and answers `{ diff, warnings, svg }`, the change drawn by the server on
 * the Fassung the edit was made on (added green, removed dashed red, changed
 * blue over its dashed grey state before). Nothing is saved. The receipt card
 * shows it; an agent can check an edit with it before proposing. Thin: the
 * service is `bff/diagrams/sketch-edit-service.ts`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ServiceUnavailableError, UnprocessableError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { getLocale } from '@/i18n/server'
import { SketchEditError } from '@/lib/diagrams/sketch-edit'
import { previewSketchEdit, sketchEditRefusalMessage } from '@/lib/diagrams/sketch-edit-service'
import { sketchEditSchema } from '@/lib/diagrams/sketch-edit-wire'
import { SketchRenderError } from '@/lib/diagrams/sketch-renderer'

type Params = { id: string }

const MAX_EDIT_REQUEST_BYTES = 128 * 1024

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, sketchEditSchema, { maxBytes: MAX_EDIT_REQUEST_BYTES })
    const locale = await getLocale()
    const diagrams = diagramsCopy.messages[locale]
    try {
      return await previewSketchEdit(session, params.id, body)
    } catch (error) {
      if (error instanceof SketchEditError) {
        const message = locale === 'en' ? sketchEditRefusalMessage(error) : diagrams.sketchEdit.refused
        throw new UnprocessableError(message, { reason: 'sketch-edit-refused', refusal: error.refusal, op: error.opIndex + 1, elementId: error.elementId })
      }
      if (error instanceof SketchRenderError) throw new ServiceUnavailableError(diagrams.sketch.renderUnavailable, { reason: error.reason })
      throw error
    }
  },
  {
    authz: { enforcedBy: 'previewSketchEdit -> getAccessibleDocument read (project:view, folder visibility); an earlier Fassung through readVersionContent' },
  }
)
