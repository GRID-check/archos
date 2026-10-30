/**
 * One page of a PDF Fassung as a palette PNG (S6): what a Skizze traced over the
 * page shows underneath. `?dpi=` 100, 150 (default) or 200, long side at most
 * 4096 px, cached per (Fassung, page, dpi). Reading it is reading that document:
 * restricted folders, held bytes and the download log as every byte read. Thin:
 * the service is `bff/documents/page-raster.ts`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { pageRasterResponse, readPageRaster } from '@/lib/documents/page-raster'
import { DEFAULT_PAGE_RASTER_DPI, type PageRasterDpi } from '@/lib/documents/page-raster-limits'
import { pageRasterQuerySchema } from '@/lib/diagrams/sketch-underlay-wire'

type Params = { id: string; versionId: string; page: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = parseQuery(request, pageRasterQuerySchema)
    const page = Number(params.page)
    if (!Number.isInteger(page) || page < 1 || page > 9999) throw new BadRequestError('Invalid page')
    const dpi = (query.dpi ?? DEFAULT_PAGE_RASTER_DPI) as PageRasterDpi
    return pageRasterResponse(await readPageRaster(session, { documentId: params.id, versionId: params.versionId, page, dpi }))
  },
  {
    authz: {
      enforcedBy:
        'readPageRaster -> getAccessibleDocument read (project:view, folder read, the hold); the version must be published or superseded with bytes this session may receive',
    },
  }
)
