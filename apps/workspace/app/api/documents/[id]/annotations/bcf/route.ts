/**
 * A model's Anmerkungen as a BCF 3.0 file (`?scope=all|open`).
 *
 * A GET, as the other exports are: nothing here writes but the audit event, the
 * browser's own download handles the file. BCF 2.1 stays the default download
 * of the Prüfbuch (`/api/projects/{id}/bim/checks/export`); this is the second,
 * newer file. Thin handler; the read gate and the mapping live in
 * `@/lib/bim/bcf3-service` and `@/lib/bim/bcf3-build`.
 */

import { NextResponse } from 'next/server'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { exportAnnotationsBcf3 } from '@/lib/bim/bcf3-service'
import { BCF3_MEDIA_TYPE, bcf3QuerySchema } from '@/lib/bim/bcf3-wire'
import { contentDisposition } from '@/lib/documents/content-disposition'
import { BIM_EXPORT_LIMIT } from '@/lib/limits'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = parseQuery(request, bcf3QuerySchema)
    const file = await exportAnnotationsBcf3(session, params.id, query, request)
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': BCF3_MEDIA_TYPE,
        'Content-Disposition': contentDisposition('attachment', file.filename),
        // So a caller that is not a browser can tell an empty file from a failed one without unzipping it.
        'X-Bcf-Topics': String(file.topics),
        'X-Bcf-Snapshots-Omitted': String(file.snapshotsOmitted),
        // A mark can be resolved a minute later; a cached copy would disagree with the review.
        'Cache-Control': 'no-store',
      },
    })
  },
  {
    authz: { enforcedBy: 'exportAnnotationsBcf3 -> getAccessibleDocument (read) + getModelForDocument + listAnnotations' },
    // Declared: reads are not defaulted, and this one reads a picture per mark from the object store and zips them.
    limits: { rule: BIM_EXPORT_LIMIT },
  }
)
