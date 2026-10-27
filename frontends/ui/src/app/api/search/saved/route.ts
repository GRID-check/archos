/**
 * Saved searches (ADR-0136 slice 5).
 *
 * GET  — the caller's own saved searches and the office's shared ones, newest
 *        first, a page of `limit` with `nextCursor`.
 * POST — save a search question as the caller, optionally shared.
 *
 * Any member may do both: a saved search holds a question, never an answer,
 * and running a shared one runs as the reader with the reader's own reach.
 * Thin handlers; the logic is `@/lib/search/saved-search-service`.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { createSavedSearch, listSavedSearches } from '@/lib/search/saved-search-service'
import { createSavedSearchSchema, listSavedSearchesQuerySchema } from '@/lib/search/saved-search-wire'

const MEMBER_WHY =
  'a saved search is a question, never an answer: running a shared one runs as the reader with their own reach, so any member may keep and share one; rows are keyed by session.organizationId and writes by session.userId'

export const GET = apiRoute(
  async ({ session, request }) => {
    const query = parseQuery(request, listSavedSearchesQuerySchema)
    return listSavedSearches({ organizationId: session.organizationId, userId: session.userId }, query)
  },
  { authz: { sessionOnly: true, why: MEMBER_WHY } }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createSavedSearchSchema)
    const savedSearch = await createSavedSearch({ organizationId: session.organizationId, userId: session.userId }, input)
    return { savedSearch }
  },
  { status: 201, authz: { sessionOnly: true, why: MEMBER_WHY } }
)
