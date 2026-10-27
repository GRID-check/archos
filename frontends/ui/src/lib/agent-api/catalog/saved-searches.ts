/**
 * Saved searches (ADR-0136 slice 5): a person keeps a search question and may
 * share it with the office. See `projects.ts` for the shape and
 * `docs/architecture/agent-surface.md` for the rules.
 *
 * Kept apart from the `search` operation itself so the two grow without
 * touching each other; both are in the `documents` domain.
 */

import {
  createSavedSearchSchema,
  listSavedSearchesQuerySchema,
  savedSearchParamsSchema,
  updateSavedSearchSchema,
} from '@/lib/search/saved-search-wire'
import type { AgentOperation } from '../operation'

/** Outside the entries: a body key `name` inside one would read as the next entry to the catalog's source checks. */
const CREATE_EXAMPLE = {
  body: {
    name: 'Current fire safety concepts',
    scope: {},
    query: { kinds: ['document'], filters: { documentTypes: ['fire_safety_concept'], currentOnly: true } },
    shared: true,
  },
}

export const savedSearchOperations = [
  {
    name: 'saved-search-list',
    domain: 'documents',
    summary: 'List saved searches',
    description:
      'The caller’s own saved searches and the ones colleagues shared with the office, newest first: ' +
      '`{ savedSearches: [{ id, name, scope, query, shared, ownedByMe, ownerName, createdAt }], nextCursor }`, a page of `limit` ' +
      '(default 50, max 200). To run one, pass its `scope` as the query and its `query` as the body of the search ' +
      'operation; it runs with the caller’s own rights, so a shared one finds only what the caller may read. ' +
      '`ownerName` names the colleague who saved a shared one (null on the caller’s own). ' +
      'Only rows with `ownedByMe` can be changed with saved-search-update or saved-search-delete.',
    method: 'GET',
    path: '/api/search/saved',
    query: listSavedSearchesQuerySchema,
    load: () => import('@/app/api/search/saved/route'),
  },
  {
    name: 'saved-search-create',
    domain: 'documents',
    summary: 'Save a search question',
    description:
      'Saves a search question under a `name` unique among the caller’s own: `scope` and `query` as the search ' +
      'operation takes them (query without `cursor`). `shared: true` shows it to every member of the office; each runs ' +
      'it with their own rights. Stores the question only, never results. Any member may save one, up to 200. ' +
      'Returns `{ savedSearch }`; a name already used answers 409.',
    method: 'POST',
    path: '/api/search/saved',
    body: createSavedSearchSchema,
    examples: [CREATE_EXAMPLE],
    load: () => import('@/app/api/search/saved/route'),
  },
  {
    name: 'saved-search-update',
    domain: 'documents',
    summary: 'Rename or share a saved search',
    description:
      'Renames (`name`) or shares and unshares (`shared`) one of the caller’s own saved searches, by its id from ' +
      'saved-search-list. A colleague’s answers 404. Returns `{ savedSearch }`; a name already used answers 409.',
    method: 'PATCH',
    path: '/api/search/saved/[id]',
    params: savedSearchParamsSchema,
    body: updateSavedSearchSchema,
    idempotent: true,
    load: () => import('@/app/api/search/saved/[id]/route'),
  },
  {
    name: 'saved-search-delete',
    domain: 'documents',
    summary: 'Delete a saved search',
    description:
      'Permanently deletes one of the caller’s own saved searches, by its id from saved-search-list; colleagues it was ' +
      'shared with lose it too. Documents are untouched. A colleague’s answers 404.',
    method: 'DELETE',
    path: '/api/search/saved/[id]',
    params: savedSearchParamsSchema,
    destructive: true,
    load: () => import('@/app/api/search/saved/[id]/route'),
  },
] as const satisfies readonly AgentOperation[]
