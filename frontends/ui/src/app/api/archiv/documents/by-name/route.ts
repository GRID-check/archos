/**
 * Archiv API — the Archiv documents with these filenames, as listing rows.
 *
 * The Archiv half of the by-name resolve (`POST /api/documents/by-name`;
 * `lib/documents/by-name-types.ts` is the shared contract; ADR-0024). Thin
 * handler; all logic lives in `@/lib/office-shelf/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { resolveOfficeShelfDocumentsByName } from '@/lib/office-shelf/service'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { officeShelfByNameRequestSchema } from '@/lib/documents/by-name-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { names } = await parseJsonBody(request, officeShelfByNameRequestSchema)
    const documents = await resolveOfficeShelfDocumentsByName(session, names)
    // The same row the listing serves, version summary included, so a resolved
    // document and a listed one cannot render differently.
    return { documents: await toDocumentWireRows(session.organizationId, documents) }
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only lookup of the caller's own org Archiv by filename; scoped by session.organizationId, the same rows listOfficeShelf already shows any member",
    },
  }
)
