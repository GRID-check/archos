/**
 * Complete a free-text filter of the search from what the office holds: party
 * names, places, cited norms and drawings, scales, drawing numbers, revisions,
 * a fact's values, each with how many documents hold it. Where to look is the
 * query, as for `POST /api/search`; the body names the filter, the typed start
 * and the search's other filters. Thin handler; the work is `@/lib/search/suggest`.
 *
 * `Server-Timing` carries `sql`, as the search's route does.
 */

import { NextResponse } from 'next/server'

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { searchScopeQuerySchema, suggestBodySchema } from '@/lib/search/search-wire'
import { runSuggest } from '@/lib/search/suggest'

export const POST = apiRoute(
  async ({ session, request }) => {
    const started = performance.now()
    const scope = parseQuery(request, searchScopeQuerySchema)
    const body = await parseJsonBody(request, suggestBodySchema)
    const response = await runSuggest(session, scope, body)
    const ms = Math.round((performance.now() - started) * 10) / 10
    return NextResponse.json(response, { headers: { 'Server-Timing': `sql;dur=${ms}` } })
  },
  {
    authz: {
      enforcedBy:
        'runSuggest -> reachFor: listProjects (project:view per project) or requireProjectAccess project:view, getProjectFolderAccess (hidden and restricted folders), shelfReaderFor (held uploads); the office shelf is any member',
    },
  }
)
