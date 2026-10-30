/**
 * Move a Skizze to its base document's newer Fassung (S6): `GET` says what the
 * move would do (the page found again by its label, else its number), `POST`
 * does it and saves the Skizze's next Fassung. Markup stays bound to the Fassung
 * it was drawn on until a person moves it (research r2). Thin: the service is
 * `bff/diagrams/sketch-underlay-service.ts`.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { ServiceUnavailableError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { getLocale } from '@/i18n/server'
import { moveSketchUnderlay, planSketchUnderlayMove } from '@/lib/diagrams/sketch-underlay-service'
import { underlayMoveSchema, underlayPlanQuerySchema } from '@/lib/diagrams/sketch-underlay-wire'
import { SketchRenderError } from '@/lib/diagrams/sketch-renderer'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = parseQuery(request, underlayPlanQuerySchema)
    return planSketchUnderlayMove(session, params.id, query.versionId, query.page)
  },
  { authz: { enforcedBy: 'planSketchUnderlayMove -> sketchSaveBaseOf (getAccessibleDocument write) and getAccessibleDocument read on the base' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, underlayMoveSchema, { maxBytes: 1024 })
    const diagrams = diagramsCopy.messages[await getLocale()]
    try {
      return await moveSketchUnderlay({ session, documentId: params.id, body, marking: diagrams.markingEdited, request })
    } catch (error) {
      if (error instanceof SketchRenderError) throw new ServiceUnavailableError(diagrams.sketch.renderUnavailable, { reason: error.reason })
      throw error
    }
  },
  { authz: { enforcedBy: 'moveSketchUnderlay -> sketchSaveBaseOf (getAccessibleDocument write); the save as PUT /sketch' } }
)
