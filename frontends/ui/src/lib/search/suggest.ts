/**
 * Completions for the search's free-text filters (docs/design/document-search.md,
 * „Completions“): what the office's documents hold for one filter, under the
 * reach and the other filters of the search being refined. The route
 * `POST /api/search/suggest` and the operation `workspace-search-suggest` are
 * thin over {@link runSuggest}.
 *
 * The words of the search are not asked: a completion counts the documents a
 * filter would admit, and the content search that words start is no part of a
 * keystroke's answer.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { narrowedTo, structuredQuery } from './document-search'
import { reachFor, resolveScope } from './reach'
import {
  SUGGEST_LIMIT,
  type DocumentFilters,
  type SearchScopeQuery,
  type SuggestBody,
  type SuggestDimension,
  type SuggestResponse,
} from './search-wire'
import { suggestValues } from './suggest-repository'

/**
 * The filters with the dimension's own left out, so the values beside the one
 * already chosen show. A fact leaves out only its own key. Pure.
 */
export function filtersBeside(
  filters: DocumentFilters,
  dimension: SuggestDimension,
  factKey?: string
): DocumentFilters {
  const { parties, place, municipalities, cites, scale, planNumber, planIndex, facts, ...rest } =
    filters
  const kept: DocumentFilters = { ...rest }
  if (dimension !== 'party' && parties) kept.parties = parties
  if (dimension !== 'place') {
    if (place) kept.place = place
    if (municipalities) kept.municipalities = municipalities
  }
  if (dimension !== 'cites' && cites) kept.cites = cites
  if (dimension !== 'scale' && scale) kept.scale = scale
  if (dimension !== 'planNumber' && planNumber) kept.planNumber = planNumber
  if (dimension !== 'planIndex' && planIndex) kept.planIndex = planIndex
  const otherFacts = dimension === 'fact' ? facts?.filter((fact) => fact.key !== factKey) : facts
  if (otherFacts?.length) kept.facts = otherFacts
  return kept
}

/** Complete one filter as `session`, where the search would look. */
export async function runSuggest(
  session: AuthorizedSession,
  scopeQuery: SearchScopeQuery,
  body: SuggestBody
): Promise<SuggestResponse> {
  const filters = filtersBeside(body.filters ?? {}, body.dimension, body.factKey)
  const reach = narrowedTo(await reachFor(session, resolveScope(scopeQuery)), { filters })
  const documents = await structuredQuery(reach, filters)
  if (!documents) return { dimension: body.dimension, values: [] }
  const values = await suggestValues(
    reach,
    { ...documents, text: null },
    {
      dimension: body.dimension,
      prefix: body.prefix ?? '',
      role: body.role,
      factKey: body.factKey,
      limit: SUGGEST_LIMIT,
    }
  )
  return { dimension: body.dimension, values }
}
