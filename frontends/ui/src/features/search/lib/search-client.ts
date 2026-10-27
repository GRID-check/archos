/**
 * The browser's door to `POST /api/search` and its Planliste export.
 *
 * Scope is the query string (`scope`, `projectId`, `folderId`) and the
 * question is the body, as the route reads them (`lib/search/search-wire.ts`).
 */

import { downloadFetched, type FetchedDownload } from '@/lib/browser-download'
import type { SearchBody, SearchResponse, SearchScopeQuery } from '@/lib/search/search-wire'

export type SearchExportFormat = 'csv' | 'xlsx'

/** The query string for a scope: nothing for the whole office. */
export function scopeQueryString(scope: SearchScopeQuery): string {
  const params = new URLSearchParams()
  if (scope.scope && scope.scope !== 'office') params.set('scope', scope.scope)
  if (scope.projectId) params.set('projectId', scope.projectId)
  if (scope.folderId) params.set('folderId', scope.folderId)
  return params.toString()
}

export class SearchRequestError extends Error {
  constructor(readonly status: number) {
    super(`search failed (${status})`)
    this.name = 'SearchRequestError'
  }
}

/** Ask one question. `onServerTiming` hears the route's `Server-Timing` header, raw (`search-telemetry.ts` parses it). */
export async function postSearch(
  scope: SearchScopeQuery,
  body: SearchBody,
  signal?: AbortSignal,
  onServerTiming?: (header: string | null) => void
): Promise<SearchResponse> {
  const query = scopeQueryString(scope)
  const response = await fetch(`/api/search${query ? `?${query}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new SearchRequestError(response.status)
  onServerTiming?.(response.headers.get('server-timing'))
  return (await response.json()) as SearchResponse
}

/** Download the current document result as a Planliste, named as the route names it. */
export function exportSearch(
  scope: SearchScopeQuery,
  body: SearchBody,
  format: SearchExportFormat,
  fallbackName: string
): Promise<FetchedDownload> {
  const params = new URLSearchParams(scopeQueryString(scope))
  params.set('format', format)
  const { cursor: _cursor, limit: _limit, facets: _facets, ...question } = body
  return downloadFetched(`/api/search/export?${params.toString()}`, `${fallbackName}.${format}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...question, kinds: ['document'] }),
  })
}
