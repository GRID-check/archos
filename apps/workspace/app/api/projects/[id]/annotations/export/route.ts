/**
 * A project's Offene Punkte as one Protokoll file: PDF, Word or Markdown,
 * with the list's own filters (`?format=pdf|docx|md&status=&assignee=&due=`).
 *
 * A GET, as a document's Protokoll is: nothing here writes but the audit
 * event, and the browser's own download handles the file. Thin handler; the
 * read, the content and the file name live in
 * `@/lib/annotations/project-export`.
 */

import { NextResponse } from 'next/server'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { exportProjectProtocol } from '@/lib/annotations/project-export'
import { projectProtocolQuerySchema } from '@/lib/annotations/project-types'
import { contentDisposition } from '@/lib/documents/content-disposition'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const file = await exportProjectProtocol(session, params.id, parseQuery(request, projectProtocolQuerySchema), request)
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.mediaType,
        'Content-Disposition': contentDisposition('attachment', file.filename),
        // A mark can be resolved a minute later; a cached copy would disagree with the list.
        'Cache-Control': 'no-store',
      },
    })
  },
  { authz: { enforcedBy: 'exportProjectProtocol -> listProjectAnnotations (requireProjectAccess project:view)' } }
)
