/**
 * The documents a search finds as a Planliste file (`?format=csv|xlsx`, the
 * search's scope in the query, the question in the body). A POST, because the
 * question is a body; nothing is written but the audit event. Thin handler;
 * the rows and the file live in `@/lib/search/plan-list-export`.
 */

import { NextResponse } from 'next/server'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { contentDisposition } from '@/lib/documents/content-disposition'
import { exportPlanList } from '@/lib/search/plan-list-export'
import { searchBodyInputSchema, searchExportQuerySchema } from '@/lib/search/search-wire'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { format, ...scope } = parseQuery(request, searchExportQuerySchema)
    const body = await parseJsonBody(request, searchBodyInputSchema)
    const file = await exportPlanList(session, scope, body, format, request)
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.mediaType,
        'Content-Disposition': contentDisposition('attachment', file.filename),
        'Cache-Control': 'no-store',
      },
    })
  },
  { authz: { enforcedBy: 'exportPlanList -> listSearchDocumentsForExport -> reachFor (the search route\'s gates)' } }
)
