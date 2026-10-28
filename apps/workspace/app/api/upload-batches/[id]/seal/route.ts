/**
 * Seal an upload (ADR-0086): the browser has sent its last file. `unchanged`
 * and `failed` are the files that, for those reasons, wrote no row; `excluded`
 * the ones the server's name check refused, as terms and counts only — never
 * file names.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { sealUploadBatchSchema } from '@/lib/upload-batches/batch-wire'
import { sealOwnUploadBatch } from '@/lib/upload-batches/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const counts = await parseJsonBody(request, sealUploadBatchSchema)
    await sealOwnUploadBatch(session, params.id, counts)
    return { id: params.id }
  },
  { authz: { enforcedBy: 'sealOwnUploadBatch -> findOwnUploadBatch (the uploader only)' } }
)
