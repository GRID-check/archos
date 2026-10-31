/**
 * A model's Anmerkungen as a BCF 3.0 file (`GET ?scope=all|open`), and a
 * coordination BCF file (2.1 or 3.0) imported onto the model as Anmerkungen
 * (`POST`, multipart with one `file`).
 *
 * A GET, as the other exports are: nothing here writes but the audit event, the
 * browser's own download handles the file. BCF 2.1 stays the default download
 * of the Prüfbuch (`/api/projects/{id}/bim/checks/export`); this is the second,
 * newer file. Thin handler; the read gate and the mapping live in
 * `@/lib/bim/bcf3-service` and `@/lib/bim/bcf3-build`.
 */

import { NextResponse } from 'next/server'
import { BadRequestError, PayloadTooLargeError } from '@/lib/api/errors'
import { apiRoute, parseFormData, parseQuery } from '@/lib/api/handler'
import { MAX_BCF_ARCHIVE_BYTES } from '@/lib/bim/bcf-archive'
import { importAnnotationsBcf } from '@/lib/bim/bcf-import-service'
import { isBcfFilename } from '@/lib/bim/bcf-import-wire'
import { exportAnnotationsBcf3 } from '@/lib/bim/bcf3-service'
import { BCF3_MEDIA_TYPE, bcf3QuerySchema } from '@/lib/bim/bcf3-wire'
import { contentDisposition } from '@/lib/documents/content-disposition'
import { BIM_EXPORT_LIMIT, DOCUMENT_UPLOAD_LIMIT } from '@/lib/limits'

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

/** The multipart part's slack over the file: boundaries and headers. */
const MULTIPART_OVERHEAD = 64 * 1024

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    // Refused before the body is read when the request says it is too large; the file's own size is checked after.
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > MAX_BCF_ARCHIVE_BYTES + MULTIPART_OVERHEAD) throw new PayloadTooLargeError(MAX_BCF_ARCHIVE_BYTES)
    const form = await parseFormData(request)
    const file = form.get('file')
    if (!(file instanceof File)) throw new BadRequestError('file is required: one .bcf or .bcfzip file')
    if (!isBcfFilename(file.name)) throw new BadRequestError('Only a .bcf or .bcfzip file is imported.')
    if (file.size > MAX_BCF_ARCHIVE_BYTES) throw new PayloadTooLargeError(MAX_BCF_ARCHIVE_BYTES)
    const bytes = new Uint8Array(await file.arrayBuffer())
    return importAnnotationsBcf(session, params.id, { name: file.name, bytes }, request)
  },
  {
    authz: { enforcedBy: 'importAnnotationsBcf -> getAccessibleDocument (write) + getModelForDocument' },
    // An upload, and a burst of writes: one mark, viewpoint and picture per topic.
    limits: { rule: DOCUMENT_UPLOAD_LIMIT },
  }
)
