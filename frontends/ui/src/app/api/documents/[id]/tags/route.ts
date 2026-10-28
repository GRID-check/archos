/**
 * Document tag-edit API — replace a document's controlled ingestion tags.
 * Thin handler; access checks, vocabulary validation, and the backend proxy
 * live in `@/lib/documents/document-edits`. The backend remains the authority on the
 * tag vocabulary; the zod schema here only guards request shape + basic bounds.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { updateDocumentTags } from '@/lib/documents/document-edits'
import { updateTagsSchema } from '@/lib/documents/document-wire'

type Params = { id: string }

export const PATCH = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { tags, topics } = await parseJsonBody(request, updateTagsSchema)
    return updateDocumentTags(session, params.id, tags, topics)
  },
  { authz: { enforcedBy: 'updateDocumentTags -> getAccessibleDocument (project:documents:write)' } }
)
