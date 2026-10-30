/**
 * „Auf Seite zeichnen“ (S6): a new Skizze traced over one page of a PDF Fassung.
 * The scene holds the locked page only; the Skizze is filed as every sketch is,
 * with the server's raster in its SVG and PDF, and lies beside the base when the
 * base's folder is not open to every member. The page is opened through
 * `readPageRaster`, which records it as every viewer's open. Thin: the service is
 * `bff/diagrams/sketch-underlay-service.ts`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError, ServiceUnavailableError } from '@/lib/api/errors'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { getLocale } from '@/i18n/server'
import { createSketchFromPage } from '@/lib/diagrams/sketch-underlay-service'
import { sketchFromPageSchema } from '@/lib/diagrams/sketch-underlay-wire'
import { SketchRenderError } from '@/lib/diagrams/sketch-renderer'

type Params = { id: string; versionId: string; page: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, sketchFromPageSchema, { maxBytes: 1024 })
    const page = Number(params.page)
    if (!Number.isInteger(page) || page < 1 || page > 9999) throw new BadRequestError('Invalid page')
    const diagrams = diagramsCopy.messages[await getLocale()]
    try {
      const filed = await createSketchFromPage({
        session,
        documentId: params.id,
        versionId: params.versionId,
        page,
        body,
        title: (name, at) => diagrams.underlay.title.replace('{name}', name).replace('{page}', String(at)),
        // A person starts it: no model drew it (S6 review, finding 5).
        marking: diagrams.markingPerson,
        request,
      })
      return { documentId: filed.svg.documentId, pdfDocumentId: filed.pdf?.documentId ?? null, folderId: filed.svg.folderId, underlay: filed.underlay }
    } catch (error) {
      if (error instanceof SketchRenderError) throw new ServiceUnavailableError(diagrams.sketch.renderUnavailable, { reason: error.reason })
      throw error
    }
  },
  {
    authz: {
      enforcedBy:
        'createSketchFromPage -> readPageRaster (getAccessibleDocument read on the base) and fileDiagramDocuments -> assertMayFileGeneratedDocument (project:documents:write)',
    },
  }
)
