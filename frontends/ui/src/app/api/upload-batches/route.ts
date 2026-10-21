/**
 * Open an upload batch (ADR-0086): the browser does this before it sends the
 * first file of an upload, so the server can tell the uploader when it has all
 * been read, and keep the project's upload history.
 *
 * `excluded` carries what the office's screening kept on the uploader's
 * machine as terms and counts only — never file names.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { openUploadBatchSchema } from '@/lib/upload-batches/batch-wire'
import { openUploadBatch } from '@/lib/upload-batches/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, openUploadBatchSchema)
    await openUploadBatch(session, input)
    return { id: input.id }
  },
  {
    authz: {
      enforcedBy:
        'openUploadBatch (project: requireProjectAccess project:documents:write; Büroablage: canManageOfficeShelf; chat: each upload is authorized on its own and the batch grants nothing)',
    },
  }
)
