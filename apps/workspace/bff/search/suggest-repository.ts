/**
 * The values a free-text filter of the search can take, as the documents in
 * reach hold them, with how many documents hold each (`POST /api/search/suggest`).
 * One statement under the search's own WHERE (`documentSearchWhere`): the
 * reach, the hidden folders, the hold and the other filters, so a completion
 * never names a value of a document the reader could not find, and its count
 * is the count that filter would bring.
 *
 * Matched on the start of any word of the value, folded as `foldForSuggest`
 * (`./suggest-fold`) folds the typed text (case, accents, „ß“, separators).
 * No index serves it: under row-level security none does for `LIKE` (0185's
 * header, docs/contributing/gotchas.md), and the scan is the facet count's,
 * over the matched documents only (`search-latency.integration.spec.ts`).
 */

import 'server-only'
import { eq, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { executeRows } from '@/lib/db/execute-rows'
import { documentSearchFacets } from '@/lib/db/schema/document-search'
import { documents } from '@/lib/db/schema/documents'
import { withTenant } from '@/lib/db/tenant-context'
import { squashDrawingNumber } from '@/lib/documents/findings'
import { escapeLikePattern } from '@/lib/text/like-pattern'
import { documentSearchWhere, type DocumentQuery } from './document-repository'
import type { SearchReach } from './reach'
import type { FacetCount, SuggestDimension } from './search-wire'
import { FOLD_FROM, FOLD_TO, foldForSuggest } from './suggest-fold'

const f = documentSearchFacets

/** `foldForSuggest` in SQL, after a space, so `LIKE '% word%'` finds the start of any word. */
const words = (value: SQL): SQL =>
  sql`(' ' || btrim(regexp_replace(replace(translate(lower(${value}), ${FOLD_FROM}, ${FOLD_TO}), 'ß', 'ss'), '\\s+', ' ', 'g')))`

/** What one completion asks: the dimension, the typed start, a party's role or a fact's key, how many values. */
export interface SuggestRequest {
  dimension: SuggestDimension
  prefix: string
  role?: string
  factKey?: string
  limit: number
}

const SOURCE = sql.raw('matched.source')
const RAW_VALUE = sql.raw('raw.value')
const RAW_LABEL = sql.raw('raw.label')

/**
 * One dimension. Per matched document: the search-row column it reads
 * (`source`), the values it expands to (`from`, `keep`), each value as the
 * filter takes it and as the documents write it. Per distinct value: what is
 * folded and matched (`hay`; null matches the squashed drawing number, as its
 * filter does), and what makes two spellings one value (`group`; null: their
 * folded words).
 */
interface DimensionSql {
  source: SQL
  from: SQL
  value: SQL
  label: SQL
  keep: SQL
  hay: SQL | null
  group: SQL | null
}

/** A plain text column of the search row. */
function column(source: SQL, group: SQL | null): DimensionSql {
  return {
    source,
    from: sql``,
    value: SOURCE,
    label: SOURCE,
    keep: sql`true`,
    hay: RAW_VALUE,
    group,
  }
}

function dimensionSql(request: SuggestRequest): DimensionSql {
  switch (request.dimension) {
    case 'party': {
      const name = sql`(party.value->>'name')`
      return {
        source: sql`${f.parties}`,
        from: sql`CROSS JOIN LATERAL jsonb_array_elements(${SOURCE}) AS party(value)`,
        value: name,
        label: name,
        keep: request.role ? sql`(party.value->>'role') = ${request.role}` : sql`true`,
        hay: RAW_VALUE,
        group: null,
      }
    }
    case 'place':
      return {
        ...column(sql`ARRAY[${f.address}, ${f.municipality}, ${f.federalState}]`, null),
        from: sql`CROSS JOIN LATERAL unnest(${SOURCE}) AS place(value)`,
        value: sql`place.value`,
        label: sql`place.value`,
      }
    case 'cites': {
      const key = sql`substr(raw.value, strpos(raw.value, ':') + 1)`
      return {
        source: sql`${f.referenceTokens}`,
        from: sql`CROSS JOIN LATERAL unnest(${SOURCE}) AS token(value)`,
        value: sql`token.value`,
        label: sql`coalesce(matched.labels->>token.value, substr(token.value, strpos(token.value, ':') + 1))`,
        keep: sql`true`,
        hay: sql`(${RAW_LABEL} || ' ' || ${key})`,
        group: RAW_VALUE,
      }
    }
    case 'scale':
      return column(sql`${f.scale}`, sql`replace(${RAW_VALUE}, ' ', '')`)
    case 'planIndex':
      return column(sql`${f.planIndex}`, sql`lower(btrim(${RAW_VALUE}))`)
    case 'planNumber':
      // Matched and grouped on the squashed number, as the filter is: „EP0“ finds „EP-05“ and „EP 05“ is one value with it.
      return {
        ...column(sql`${f.planNumber}`, null),
        hay: null,
        group: sql`regexp_replace(lower(${RAW_VALUE}), '[\\s\\-_]+', '', 'g')`,
      }
    case 'fact': {
      const value = sql`(fact.value->>'value')`
      return {
        source: sql`${f.facts}`,
        from: sql`CROSS JOIN LATERAL jsonb_array_elements(${SOURCE}) AS fact(value)`,
        value,
        label: sql`concat_ws(' ', ${value}, fact.value->>'unit')`,
        keep: sql`(fact.value->>'key') = ${request.factKey ?? ''}`,
        hay: RAW_VALUE,
        group: null,
      }
    }
  }
}

/** The typed start as a condition over one distinct value (`folded`). */
function startsAs(request: SuggestRequest, d: DimensionSql): SQL {
  if (d.hay === null) {
    const start = squashDrawingNumber(request.prefix)
    return start === '' ? sql`true` : sql`folded.grp LIKE ${`${escapeLikePattern(start)}%`}`
  }
  const start = foldForSuggest(request.prefix)
  return start === '' ? sql`true` : sql`folded.words LIKE ${`% ${escapeLikePattern(start)}%`}`
}

/**
 * The statement of {@link suggestValues}; exported for the latency spec's `EXPLAIN`.
 *
 * The matched documents are read first, under the search's WHERE, carrying
 * only the column the dimension reads: the scan a facet count makes. Their
 * values are counted per exact spelling (`raw`), and only the distinct
 * spellings are folded, matched and merged into values. `raw` is
 * MATERIALIZED on purpose: without the fence the planner pushes the match on
 * a grouped column below the GROUP BY and folds every occurrence again, one
 * `translate()` per party of every document. `EXPLAIN ANALYZE` office-wide,
 * 18,000 matched documents: 316 ms, 290 of them in that fold; fenced, 80 ms
 * p50, about one facet count (`search-latency.integration.spec.ts`, 2026-10-27).
 *
 * Merging sums the per-spelling counts, so a document that writes one name two
 * ways counts twice for it; a document naming it twice the same way counts once.
 */
export function suggestStatement(
  reach: SearchReach,
  query: DocumentQuery,
  request: SuggestRequest
): SQL {
  const d = dimensionSql(request)
  return sql`
    WITH matched AS MATERIALIZED (
      SELECT ${f.documentId} AS document_id, ${d.source} AS source,
        ${request.dimension === 'cites' ? sql`${f.referenceLabels}` : sql`NULL::jsonb`} AS labels
      FROM ${documents}
      JOIN ${f} ON ${eq(f.documentId, documents.id)}
      WHERE ${documentSearchWhere(reach, query)}
    ), raw AS MATERIALIZED (
      SELECT ${d.value} AS value, ${d.label} AS label, count(DISTINCT matched.document_id) AS count
      FROM matched ${d.from}
      WHERE ${d.keep}
      GROUP BY 1, 2
    ), folded AS (
      SELECT raw.value, raw.label, raw.count,
        ${d.hay === null ? sql`NULL::text` : words(d.hay)} AS words, ${d.group ?? sql`NULL::text`} AS grp
      FROM raw
      WHERE raw.value IS NOT NULL
    )
    SELECT (array_agg(folded.value ORDER BY folded.count DESC, folded.value))[1] AS value,
      (array_agg(folded.label ORDER BY folded.count DESC, folded.label))[1] AS label,
      sum(folded.count) AS count
    FROM folded
    WHERE ${startsAs(request, d)} AND coalesce(folded.grp, btrim(folded.words), '') <> ''
    GROUP BY coalesce(folded.grp, btrim(folded.words))
    ORDER BY sum(folded.count) DESC, 2
    LIMIT ${request.limit}`
}

/**
 * The values of one dimension among the documents `query` admits in `reach`,
 * starting as `prefix` does, most documents first, then by label, at most
 * `limit`. A value written several ways is one value, shown in its most
 * frequent spelling.
 */
export async function suggestValues(
  reach: SearchReach,
  query: DocumentQuery,
  request: SuggestRequest
): Promise<FacetCount[]> {
  const rows = executeRows<{ value: string; label: string | null; count: string }>(
    await withTenant({ organizationId: reach.organizationId }, async () =>
      getDb().execute(suggestStatement(reach, query, request))
    )
  )
  return rows.map((row) => ({
    value: String(row.value),
    label: row.label === null ? null : String(row.label),
    count: Number(row.count),
  }))
}
