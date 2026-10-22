/**
 * Unarchive a document (ADR-0054, ADR-0131 rule 7): back in the working set
 * and read into the index again. The reverse of `POST …/archive`. No body.
 * Thin handler; `@/lib/documents/unarchive` decides.
 */

import { apiRoute } from '@/lib/api/handler'
import { unarchiveDocument } from '@/lib/documents/unarchive'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => unarchiveDocument(session, params.id, request),
  { authz: { enforcedBy: 'unarchiveDocument -> getAccessibleDocument + requireProjectAccess (project:documents:write | project:edit)' } }
)
