/**
 * What a project's documents say about each other: missing documents and
 * drawings, contradicting facts, incomplete reads (`docs/architecture/document-dossier.md`).
 * Thin handler; the logic lives in `@/lib/documents/findings-service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getProjectDocumentFindings } from '@/lib/documents/findings-service'
import { documentFindingsQuerySchema } from '@/lib/documents/findings-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { documentId } = parseQuery(request, documentFindingsQuerySchema)
    return getProjectDocumentFindings(session, params.id, documentId)
  },
  { authz: { enforcedBy: 'getProjectDocumentFindings → listDocumentsPage (requireProjectAccess project:view)' } }
)
