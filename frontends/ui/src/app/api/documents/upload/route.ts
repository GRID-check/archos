/**
 * Upload one file to a shelf: a project's (`projectId`) or the office shelf
 * (`scope=office_shelf`, which needs `org:office_shelf:manage`), optionally into
 * one of its folders, and hand it to ingestion. Multipart: `file`, the shelf
 * fields, and the optional `folderId`, `originPath`, `screeningRelease`,
 * `uploadBatchId` and `revisionOf`. Thin handler; the shelf pipeline is
 * `@/lib/documents/shelf-upload`.
 */

import { apiRoute, parseFormData } from '@/lib/api/handler'
import { DOCUMENT_UPLOAD_LIMIT } from '@/lib/limits'
import { BadRequestError } from '@/lib/api/errors'
import { readRevisionOf } from '@/lib/documents/revision-upload'
import { uploadDocument } from '@/lib/documents/service'
import { SHELF_SCOPES, shelfOf } from '@/lib/documents/shelf-scope'
import { uploadOfficeShelfDocument } from '@/lib/office-shelf/service'
import { readScreeningRelease } from '@/lib/upload-screening/service'
import { readUploadBatchId } from '@/lib/upload-batches/service'

const text = (value: FormDataEntryValue | null): string | undefined =>
  typeof value === 'string' && value ? value : undefined

export const POST = apiRoute(
  async ({ session, request }) => {
    const formData = await parseFormData(request)
    const file = formData.get('file')
    if (!(file instanceof File)) throw new BadRequestError('file is required')
    const scope = text(formData.get('scope'))
    if (scope !== undefined && !(SHELF_SCOPES as readonly string[]).includes(scope)) {
      throw new BadRequestError(`scope must be one of ${SHELF_SCOPES.join(', ')}`)
    }
    const shelf = shelfOf({ scope: scope as (typeof SHELF_SCOPES)[number] | undefined, projectId: text(formData.get('projectId')) }, request)
    const input = {
      folderId: text(formData.get('folderId')) ?? null,
      // Where the file sat before it was uploaded, when the browser knows. Only a
      // folder upload sends it; the service sanitizes and bounds it.
      originPath: text(formData.get('originPath')) ?? null,
      screeningRelease: readScreeningRelease(formData.get('screeningRelease')),
      uploadBatchId: readUploadBatchId(formData.get('uploadBatchId')),
      // The older document, when the reader filed this as its new revision (ADR-0099); checked by the service.
      revisionOf: readRevisionOf(formData.get('revisionOf') ?? formData.get('fassungOf')),
    }
    return shelf.kind === 'project'
      ? uploadDocument(session, { projectId: shelf.projectId, file, ...input }, request)
      : uploadOfficeShelfDocument(session, file, request, input)
  },
  {
    authz: {
      enforcedBy:
        'uploadDocument (requireProjectAccess project:documents:write) | uploadOfficeShelfDocument (canManageOfficeShelf)',
    },
    limits: { rule: DOCUMENT_UPLOAD_LIMIT },
  }
)
