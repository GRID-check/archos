/**
 * INTERNAL service endpoint — issues one presigned PUT for a part of a version's stored
 * page text (ADR-0134), so the backend (read-only on SeaweedFS) can write
 * `<version dir>/_text/pages.md` and `index.json` beside the file it read. Called twice
 * per ingested PDF, after its screen; the read side is the agent's file reader
 * (ADR-0133), the delete side the `_text/` sweep in `lib/documents/object-cleanup.ts`.
 *
 * Service-to-service only, like `document-image-upload-url`: `INTERNAL_API_TOKEN`
 * via `internalApiRoute`, the row addressed by the dispatched `documentId` AND its
 * collection, and the key built from the row's own storage key and a part from a
 * closed list (`PAGE_TEXT_PARTS`), so nothing else can be minted under the prefix.
 * The answer carries the row's id, version and content hash, which `index.json` repeats.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withOptionalTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { PAGE_TEXT_PARTS } from '@/lib/s3'
import { presignDocumentPageTextUpload } from '@/lib/documents/service'

const bodySchema = z.object({
  documentId: z.guid(),
  collection: z.string().min(1),
  part: z.enum(PAGE_TEXT_PARTS),
  organizationId: z.string().min(1).optional(),
})

export const POST = internalApiRoute(
  'document-text-upload-url',
  async ({ request }) => {
    const { documentId, collection, part, organizationId } = await parseJsonBody(request, bodySchema)
    return withOptionalTenant(
      organizationId,
      'document addressed by unguessable id and collection name, with no organization supplied',
      async () => {
        const slot = await presignDocumentPageTextUpload(documentId, collection, part, organizationId)
        if (!slot) throw new NotFoundError('Document not found')
        return slot
      }
    )
  },
  { tenancy: { fromPayload: 'body.organizationId, the organization of the ingest job' } }
)
