/**
 * Search everything the person may read (ADR-0136): documents by name, by what
 * they are and by what they say, their annotations, folders, projects and
 * conversations. Where to look is the query (`scope`, `projectId`, `folderId`;
 * absent is the whole office), the question is the body. Thin handler; the
 * search lives in `@/lib/search/document-search`.
 *
 * `Server-Timing` says where the time went (`sql`, `content`, `total`); the
 * browser reads it into PostHog's `search_issued`
 * (docs/observability/posthog-events.md).
 */

import { NextResponse } from 'next/server'

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { runTimedSearch, serverTimingHeader } from '@/lib/search/document-search'
import { searchBodySchema, searchScopeQuerySchema } from '@/lib/search/search-wire'

export const POST = apiRoute(
  async ({ session, request }) => {
    const scope = parseQuery(request, searchScopeQuerySchema)
    const body = await parseJsonBody(request, searchBodySchema)
    const { response, timing } = await runTimedSearch(session, scope, body)
    return NextResponse.json(response, { headers: { 'Server-Timing': serverTimingHeader(timing) } })
  },
  {
    authz: {
      enforcedBy:
        'runTimedSearch -> reachFor: listProjects (project:view per project) or requireProjectAccess project:view, getProjectFolderAccess (hidden and restricted folders), shelfReaderFor (held uploads); the office shelf is any member',
    },
  }
)
