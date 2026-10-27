/**
 * Saved searches (ADR-0133 slice 5): a person keeps a search question, and may
 * share it with the office.
 *
 * What sharing shares: the QUESTION, never an answer. A saved search stores
 * where to look and what to ask, no result, no document, no count. A colleague
 * who runs a shared one sends an ordinary `POST /api/search` as themselves, so
 * the reach (`reach.ts`) is theirs: they find what they may read and nothing
 * the owner could see beyond it. That is why any member may share one with the
 * whole office without a permission of its own.
 *
 * Who may change one: only its owner. Every write is keyed by the owner, so a
 * colleague's row, shared or not, answers 404 exactly as a missing one does:
 * a 403 would confirm the id exists.
 */

import 'server-only'
import { ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { nextOffsetCursor, offsetPageOf } from '@/lib/api/offset-page'
import { isUniqueViolation } from '@/lib/db/errors'
import type { SavedSearchRow } from '@/lib/db/schema'
import {
  countOwnedSavedSearches,
  deleteOwnSavedSearch,
  insertSavedSearch,
  listVisibleSavedSearches,
  updateOwnSavedSearch,
  type SavedSearchOwner,
} from './saved-search-repository'
import {
  SAVED_SEARCHES_PER_PERSON_MAX,
  type CreateSavedSearchInput,
  type ListSavedSearchesQuery,
  type SavedSearchListResponse,
  type SavedSearchView,
  type UpdateSavedSearchInput,
} from './saved-search-wire'

const NAME_CONSTRAINT = 'saved_searches_owner_name_key'

export function toSavedSearchView(row: SavedSearchRow, readerUserId: string): SavedSearchView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    query: row.query,
    shared: row.shared,
    ownedByMe: row.ownerUserId === readerUserId,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

/** The reader's own and the office's shared saved searches, newest first, one page. */
export async function listSavedSearches(
  reader: SavedSearchOwner,
  query: ListSavedSearchesQuery
): Promise<SavedSearchListResponse> {
  const page = offsetPageOf(query)
  const rows = await listVisibleSavedSearches(reader, page)
  return {
    savedSearches: rows.slice(0, page.limit).map((row) => toSavedSearchView(row, reader.userId)),
    nextCursor: nextOffsetCursor(page, rows.length),
  }
}

export async function createSavedSearch(owner: SavedSearchOwner, input: CreateSavedSearchInput): Promise<SavedSearchView> {
  if ((await countOwnedSavedSearches(owner)) >= SAVED_SEARCHES_PER_PERSON_MAX) {
    throw new UnprocessableError(`You already keep ${SAVED_SEARCHES_PER_PERSON_MAX} saved searches; delete one first.`)
  }
  try {
    const row = await insertSavedSearch(owner, input)
    return toSavedSearchView(row, owner.userId)
  } catch (error) {
    if (isUniqueViolation(error, NAME_CONSTRAINT)) throw duplicateName(input.name)
    throw error
  }
}

/** Rename or share the owner's own saved search; 404 for anyone else's. */
export async function updateSavedSearch(
  owner: SavedSearchOwner,
  id: string,
  patch: UpdateSavedSearchInput
): Promise<SavedSearchView> {
  try {
    const row = await updateOwnSavedSearch(owner, id, patch)
    if (!row) throw new NotFoundError('Saved search not found')
    return toSavedSearchView(row, owner.userId)
  } catch (error) {
    if (patch.name !== undefined && isUniqueViolation(error, NAME_CONSTRAINT)) throw duplicateName(patch.name)
    throw error
  }
}

/** Delete the owner's own saved search; 404 for anyone else's. */
export async function deleteSavedSearch(owner: SavedSearchOwner, id: string): Promise<void> {
  if (!(await deleteOwnSavedSearch(owner, id))) throw new NotFoundError('Saved search not found')
}

function duplicateName(name: string): ConflictError {
  return new ConflictError(`You already have a saved search named "${name}".`)
}
