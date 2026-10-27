/**
 * Search everything the person may read (ADR-0136): documents by name, by what
 * they are and by what they say, their annotations, folders, projects and
 * conversations. Where to look is the query (`scope`, `projectId`, `folderId`;
 * absent is the whole office), the question is the body. Thin handler; the
 * search lives in `@/lib/search/document-search`.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { runSearch } from '@/lib/search/document-search'
import { searchBodySchema, searchScopeQuerySchema } from '@/lib/search/search-wire'

export const POST = apiRoute(
  async ({ session, request }) => {
    const scope = parseQuery(request, searchScopeQuerySchema)
    const body = await parseJsonBody(request, searchBodySchema)
    return runSearch(session, scope, body)
  },
  {
    authz: {
      enforcedBy:
        'runSearch -> reachFor: listProjects (project:view per project) or requireProjectAccess project:view, getProjectFolderAccess (hidden and restricted folders), shelfReaderFor (held uploads); the office shelf is any member',
    },
  }
)
