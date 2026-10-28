/**
 * Saved searches (ADR-0136 slice 5): a person keeps a search question, and may
 * share it with the office.
 *
 * What sharing shares: the QUESTION, never an answer. A saved search stores
 * where to look and what to ask, no result, no document, no count. A colleague
 * who runs a shared one sends an ordinary `POST /api/search` as themselves, so
 * the reach (`reach.ts`) is theirs: they find what they may read and nothing
 * the owner could see beyond it. That is why any member may share one with the
 * whole office without a permission of its own.
 *
 * What a colleague's question still names: a project id in its scope or its
 * `projectIds` filter. A reader who may not view that project must not learn it
 * exists, so {@link listSavedSearches} hides a colleague's search scoped to such
 * a project (running it would answer 404 anyway) and drops such ids from its
 * filter. Document ids (`citedBy`, `citing`) stay: an id names no project, and
 * the reader's run applies their own reach to it.
 *
 * Who may change one: only its owner. Every write is keyed by the owner, so a
 * colleague's row, shared or not, answers 404 exactly as a missing one does:
 * a 403 would confirm the id exists.
 */

import 'server-only'
import { ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { nextOffsetCursor, offsetPageOf } from '@/lib/api/offset-page'
import { isUniqueViolation } from '@/lib/db/errors'
import type { SavedSearchRow } from '@/lib/db/schema/saved-searches'
import { resolvePeople } from '@/lib/sharing/directory'
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

export function toSavedSearchView(row: SavedSearchRow, readerUserId: string, ownerName: string | null = null): SavedSearchView {
  const ownedByMe = row.ownerUserId === readerUserId
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    query: row.query,
    shared: row.shared,
    ownedByMe,
    ownerName: ownedByMe ? null : ownerName,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

/** The projects a colleague's saved search names, in its scope and its filter. */
function namedProjects(row: SavedSearchRow): string[] {
  return [...(row.scope.projectId ? [row.scope.projectId] : []), ...(row.query.filters?.projectIds ?? [])]
}

/**
 * A colleague's saved search as `viewable` lets the reader see it: null when
 * scoped to a project they may not view, else without such projects in its
 * filter. The reader's own is theirs whole.
 */
export function savedSearchForReader(
  row: SavedSearchRow,
  readerUserId: string,
  viewable: ReadonlySet<string>
): SavedSearchRow | null {
  if (row.ownerUserId === readerUserId) return row
  if (row.scope.projectId && !viewable.has(row.scope.projectId)) return null
  const projectIds = row.query.filters?.projectIds
  if (!projectIds || projectIds.every((id) => viewable.has(id))) return row
  const kept = projectIds.filter((id) => viewable.has(id))
  // Every named project hidden: the question without them would search wider than the owner asked.
  if (kept.length === 0) return null
  return { ...row, query: { ...row.query, filters: { ...row.query.filters, projectIds: kept } } }
}

/**
 * The reader's own and the office's shared saved searches, newest first, one
 * page. A colleague's is named by who saved it (the people directory, cached),
 * so the reader knows whose question they are about to run, and shows only the
 * projects the reader may view (`viewableProjects`, read only when a
 * colleague's names one).
 */
export async function listSavedSearches(
  reader: SavedSearchOwner,
  query: ListSavedSearchesQuery,
  viewableProjects: () => Promise<ReadonlySet<string>>
): Promise<SavedSearchListResponse> {
  const page = offsetPageOf(query)
  const fetched = await listVisibleSavedSearches(reader, page)
  const onPage = fetched.slice(0, page.limit)
  const namesProjects = onPage.some((row) => row.ownerUserId !== reader.userId && namedProjects(row).length > 0)
  const viewable = namesProjects ? await viewableProjects() : new Set<string>()
  const rows = onPage.flatMap((row) => savedSearchForReader(row, reader.userId, viewable) ?? [])
  const colleagues = [...new Set(rows.map((row) => row.ownerUserId).filter((userId) => userId !== reader.userId))]
  const people = await resolvePeople(reader.organizationId, colleagues)
  return {
    savedSearches: rows.map((row) => toSavedSearchView(row, reader.userId, people.get(row.ownerUserId)?.name ?? null)),
    nextCursor: nextOffsetCursor(page, fetched.length),
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
