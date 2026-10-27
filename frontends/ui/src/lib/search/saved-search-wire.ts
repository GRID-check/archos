/**
 * Saved searches (ADR-0136 slice 5, migration 0186): what the routes under
 * `/api/search/saved`, the agent operations `saved-search-*` and the browser
 * parse against.
 *
 * A saved search is the question, never the answer: `scope` is the search's
 * query parameters and `query` its body (`search-wire.ts`) without a cursor.
 * Running one is an ordinary `POST /api/search` by the reader, so a shared one
 * finds for each colleague only what that colleague may read.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { pageQueryShape } from '@/lib/api/offset-page'
import { searchBodySchema, searchScopeQuerySchema, type SearchBody, type SearchScopeQuery } from './search-wire'

export const SAVED_SEARCH_NAME_MAX = 120
/**
 * Bytes of the question as JSON. The table refuses 16,000 of Postgres's own
 * rendering, which spaces out what `JSON.stringify` packs, so the route stops
 * well before it and answers a 400 rather than a constraint violation.
 */
export const SAVED_SEARCH_QUERY_MAX_BYTES = 12_000
/** Most saved searches one person may own. */
export const SAVED_SEARCHES_PER_PERSON_MAX = 200

const nameSchema = z.string().trim().min(1).max(SAVED_SEARCH_NAME_MAX).describe('Unique among your own saved searches.')

/** The question as stored: the search body without its cursor. */
export const savedSearchQuerySchema = searchBodySchema
  .omit({ cursor: true })
  .refine((query) => new TextEncoder().encode(JSON.stringify(query)).length <= SAVED_SEARCH_QUERY_MAX_BYTES, {
    message: `The question is larger than ${SAVED_SEARCH_QUERY_MAX_BYTES} bytes`,
  })

/**
 * The question on the wire of `POST /api/search/saved`: an object, checked
 * against {@link savedSearchQuerySchema} in full by the route's parse. Its JSON
 * Schema is a bare object on purpose: `workspace-search` already describes
 * the body in full, and a second copy in this operation's input schema would
 * cost every agent's tool list several thousand characters for nothing
 * (`mcp-server.spec.ts`, "what tools mode costs a client").
 */
const savedSearchQueryInput = z.record(z.string(), z.unknown()).transform((value, ctx) => {
  const parsed = savedSearchQuerySchema.safeParse(value)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) ctx.addIssue({ ...issue })
  return z.NEVER
})

/** `POST /api/search/saved`. */
export const createSavedSearchSchema = z.object({
  name: nameSchema,
  scope: searchScopeQuerySchema.describe('Where to look, as workspace-search takes it in its query; {} is the whole office.'),
  query: savedSearchQueryInput.describe(
    'The question: the body of workspace-search (text, kinds, filters, annotationFilters, sort, dir, limit, facets), without a cursor.'
  ),
  shared: z.boolean().default(false).describe('Every member of the office sees and runs it, each with their own rights.'),
})
export type CreateSavedSearchInput = z.infer<typeof createSavedSearchSchema>

/** `PATCH /api/search/saved/[id]`: rename or share your own. */
export const updateSavedSearchSchema = z
  .object({
    name: nameSchema.optional(),
    shared: z.boolean().optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.shared !== undefined, { message: 'Pass name or shared' })
export type UpdateSavedSearchInput = z.infer<typeof updateSavedSearchSchema>

/** `GET /api/search/saved`: a page, newest first. */
export const listSavedSearchesQuerySchema = z.object({ ...pageQueryShape })
export type ListSavedSearchesQuery = z.infer<typeof listSavedSearchesQuerySchema>

/** `[id]` of `/api/search/saved/[id]`. */
export const savedSearchParamsSchema = z.object({
  id: z.string().uuid().describe('The saved search id, from saved-search-list.'),
})

/** One saved search as every client reads it. */
export interface SavedSearchView {
  id: string
  name: string
  scope: SearchScopeQuery
  query: SearchBody
  shared: boolean
  /** The reader saved it: only then may they rename, share or delete it. */
  ownedByMe: boolean
  /**
   * Who saved it, by the office's people directory, on a colleague's shared
   * one; null on the reader's own, and when the directory cannot name the
   * person (left the office, WorkOS not answering).
   */
  ownerName: string | null
  createdAt: string
}

export interface SavedSearchListResponse {
  savedSearches: SavedSearchView[]
  nextCursor: string | null
}
