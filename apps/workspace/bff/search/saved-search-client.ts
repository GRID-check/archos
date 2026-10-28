/**
 * The browser's door to saved searches (`/api/search/saved`): a person's own
 * searches, and the ones colleagues shared within the office.
 *
 * The shapes are the routes' own (`./saved-search-wire`).
 */

import type { SavedSearchView } from './saved-search-wire'
import type { SearchBody, SearchScopeQuery } from './search-wire'

export type { SavedSearchView }

export interface SavedSearchDraft {
  name: string
  scope: SearchScopeQuery
  query: SearchBody
  shared: boolean
}

export class SavedSearchError extends Error {
  constructor(readonly status: number) {
    super(`saved search request failed (${status})`)
    this.name = 'SavedSearchError'
  }
}

const BASE = '/api/search/saved'
const JSON_HEADERS = { 'content-type': 'application/json' }

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) throw new SavedSearchError(response.status)
  return (await response.json()) as T
}

export async function listSavedSearches(): Promise<SavedSearchView[]> {
  const body = await read<{ savedSearches: SavedSearchView[] }>(await fetch(BASE))
  return body.savedSearches
}

export async function createSavedSearch(draft: SavedSearchDraft): Promise<SavedSearchView> {
  const body = await read<{ savedSearch: SavedSearchView }>(
    await fetch(BASE, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(draft) })
  )
  return body.savedSearch
}

export async function updateSavedSearch(id: string, patch: { name?: string; shared?: boolean }): Promise<void> {
  const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new SavedSearchError(response.status)
}

export async function deleteSavedSearch(id: string): Promise<void> {
  const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new SavedSearchError(response.status)
}
