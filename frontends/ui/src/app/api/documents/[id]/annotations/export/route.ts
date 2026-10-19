/**
 * A document's Anmerkungen as a Protokoll file: PDF, Word or Markdown
 * (`?format=pdf|docx|md&scope=open|all&fassung=current|all&includeProposals=1`).
 *
 * A GET, as the answer and BCF exports are: nothing here writes but the audit
 * event, the browser's own download handles the file, and a link pasted to a
 * colleague is decided by their own session. Thin handler; the read gate, the
 * content and the file name live in `@/lib/annotations/export`.
 */

import { NextResponse } from 'next/server'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { exportAnnotationProtocol } from '@/lib/annotations/export'
import { annotationExportQuerySchema } from '@/lib/annotations/export-request'
import { contentDisposition } from '@/lib/documents/content-disposition'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const options = parseQuery(request, annotationExportQuerySchema)
    const file = await exportAnnotationProtocol(session, params.id, options, request)
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.mediaType,
        // The name carries the document's („Anmerkungen – Grundriss EG – Fassung 3.pdf"), so the
        // UTF-8 `filename*` keeps its umlauts and dashes, with an ASCII fallback beside it.
        'Content-Disposition': contentDisposition('attachment', file.filename),
        // A mark can be resolved a minute later; a cached copy would disagree with the review.
        'Cache-Control': 'no-store',
      },
    })
  },
  { authz: { enforcedBy: 'exportAnnotationProtocol -> getAccessibleDocument (read) + listAnnotations' } }
)
