/**
 * The search (ADR-0133): one question, every kind, any scope. The route
 * `POST /api/search`, the agent operation `search` and the export are thin over
 * {@link runSearch}; nothing else evaluates a query.
 *
 * Postgres decides which documents are in the result (the reach, the filters,
 * the sort, the counts); the content search only ranks passages and says which
 * page matched. A Qdrant number is never shown: with text, the documents total
 * counts the joined SQL set, and says it is a lower bound when the content
 * search's candidate budget was reached.
 */

import 'server-only'
import { BadRequestError, UnprocessableError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { documentReadFamily } from '@/lib/documents/document-status'
import {
  BACKEND_SEARCH_MAX_COLLECTIONS,
  fetchGroupedSemanticHits,
  type BackendSearchHit,
  type GroupedSearchFilters,
} from '@/lib/documents/service'
import { resolvePeople } from '@/lib/sharing/directory'
import {
  contentKey,
  documentFacetCounts,
  listCandidateDocumentIds,
  readReferenceSubject,
  searchDocumentPage,
  type DocumentQuery,
  type DocumentSearchRow,
  type FacetKey,
  type ReferenceTargets,
} from './document-repository'
import { narrowReach, reachCollections, reachFor, reachShelves, resolveScope, type SearchReach } from './reach'
import {
  SEARCH_KINDS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_OFFSET_MAX,
  SEARCH_SECTION_PREVIEW,
  type DocumentHit,
  type FacetCount,
  type SearchBody,
  type SearchFacetDimension,
  type SearchKind,
  type SearchResponse,
  type SearchScopeQuery,
  type SearchSection,
  type SearchSort,
} from './search-wire'
import { searchAnnotations, searchConversations, searchFolders, searchProjects } from './providers'
import { refreshStaleShelves } from './shelf-projection'

/** Documents one content search returns per collection, and passages it ranks in all. */
const CONTENT_FILES_PER_COLLECTION = 20
/** The passages one content search ranks (the backend's candidate budget, `qdrant/search.py`); as many documents at most. */
const CONTENT_CANDIDATES = 200
/** The most documents a content search is narrowed to by id; past it, by what they are and cite. */
const PREFILTER_MAX_IDS = 1000
/** Characters of a passage shown under a document. */
const PASSAGE_CHARS = 400
/** Text shorter than this goes to the names and the reading only. */
const CONTENT_MIN_CHARS = 3

/** Sorts read ascending unless the request says otherwise. */
const ASCENDING_BY_DEFAULT: ReadonlySet<SearchSort> = new Set(['name', 'plan_number', 'plan_index', 'document_type', 'project'])

const FACET_KEYS: Record<SearchFacetDimension, FacetKey> = {
  documentType: 'documentType',
  tag: 'tag',
  project: 'project',
  partyRole: 'partyRole',
  municipality: 'municipality',
  cites: 'cites',
  state: 'status',
  fileType: 'fileType',
  uploader: 'uploader',
}

/** The reach every kind reads: cut to the projects a `projectIds` filter names, when it names any. */
function narrowedTo(reach: SearchReach, body: Pick<SearchBody, 'filters'>): SearchReach {
  const projectIds = body.filters?.projectIds ?? []
  return projectIds.length > 0 ? narrowReach(reach, projectIds) : reach
}

/** A cursor names one kind and an offset; opaque on the wire. */
export function encodeSearchCursor(kind: SearchKind, offset: number): string {
  return Buffer.from(JSON.stringify({ k: kind, o: offset })).toString('base64url')
}

export function decodeSearchCursor(cursor: string, kind: SearchKind): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k?: unknown; o?: unknown }
    if (parsed.k === kind && typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.o <= SEARCH_OFFSET_MAX) {
      return parsed.o
    }
  } catch {
    // Falls through to the refusal: a cursor this API did not write.
  }
  throw new BadRequestError('cursor is not a nextCursor of this search with this single kind')
}

/** The order of a document result: relevance with text, else newest first, as the request says. */
export function documentOrder(body: Pick<SearchBody, 'sort' | 'dir' | 'text'>): { sort: SearchSort; dir: 'asc' | 'desc' } {
  const hasText = Boolean(body.text?.trim())
  const sort = body.sort === 'relevance' && !hasText ? 'added' : (body.sort ?? (hasText ? 'relevance' : 'added'))
  return { sort, dir: body.dir ?? (ASCENDING_BY_DEFAULT.has(sort) ? 'asc' : 'desc') }
}

/** What the documents a reference filter names must carry, read for this reader; null when the document is out of reach. */
async function referenceTargets(reach: SearchReach, documentId: string, direction: 'citedBy' | 'citing'): Promise<ReferenceTargets | null> {
  const subject = await readReferenceSubject(reach, documentId)
  if (!subject) return null
  if (direction === 'citing') {
    return { planKeys: subject.planNumberKey ? [subject.planNumberKey] : [], documentTypes: subject.documentType ? [subject.documentType] : [] }
  }
  const planKeys = subject.referenceTokens
    .filter((token) => token.startsWith('plan:'))
    .map((token) => token.slice('plan:'.length).replace(/[\s\-_]+/g, ''))
  const documentTypes = subject.referenceTokens.filter((token) => token.startsWith('document:')).map((token) => token.slice('document:'.length))
  return { planKeys, documentTypes }
}

/**
 * What narrows the content search before it ranks, so a selective filter does
 * not leave the candidate budget to documents it then drops: the filtered ids
 * when they are few, else the payload's own reading type and references. It
 * only ever narrows what SQL decides; a mismatch costs recall, never visibility.
 * `null` filters: the filters admit no document.
 */
export async function contentPrefilter(
  reach: SearchReach,
  query: DocumentQuery
): Promise<{ filters: GroupedSearchFilters | undefined } | null> {
  const narrowed = Object.entries(query.filters).some(([key, value]) => key !== 'includeArchived' && value !== undefined)
  if (!narrowed && !query.citedBy && !query.citing && !reach.folderIds) return { filters: undefined }
  const ids = await listCandidateDocumentIds(reach, query, PREFILTER_MAX_IDS)
  if (ids.length === 0) return null
  if (ids.length <= PREFILTER_MAX_IDS) return { filters: { document_ids: ids } }
  const readingTypes = query.filters.documentTypes ?? []
  const refersTo = (query.filters.cites ?? []).slice(0, 8)
  if (readingTypes.length === 0 && refersTo.length === 0) return { filters: undefined }
  return {
    filters: {
      ...(readingTypes.length > 0 ? { reading_types: [...readingTypes] } : {}),
      ...(refersTo.length > 0 ? { refers_to: refersTo } : {}),
    },
  }
}

/** The content search over the reach's collections, or null when it could not run. */
async function contentHits(
  reach: SearchReach,
  text: string,
  filters: GroupedSearchFilters | undefined
): Promise<{ hits: BackendSearchHit[]; partial: boolean } | null> {
  const collections = reachCollections(reach)
  if (collections.length === 0) return { hits: [], partial: false }
  try {
    const named = collections.slice(0, BACKEND_SEARCH_MAX_COLLECTIONS)
    const hits = await fetchGroupedSemanticHits(named, text, CONTENT_FILES_PER_COLLECTION, PASSAGE_CHARS, filters ? { filters } : {})
    return { hits, partial: named.length < collections.length }
  } catch (error) {
    if (error instanceof UpstreamError) return null
    throw error
  }
}

function toDocumentHit(row: DocumentSearchRow, passage: BackendSearchHit | undefined, uploader: string | null): DocumentHit {
  return {
    kind: 'document',
    id: row.id,
    name: row.displayName ?? row.filename,
    filename: row.filename,
    shelf: row.scope === 'office_shelf' ? 'office_shelf' : 'project',
    projectId: row.projectId,
    projectName: row.projectName,
    folderId: row.folderId,
    folderName: row.folderName,
    status: row.status,
    contentType: row.contentType,
    uploadedAt: row.createdAt.toISOString(),
    uploadedBy: uploader,
    documentType: row.documentType,
    title: row.title,
    planNumber: row.planNumber,
    planIndex: row.planIndex,
    planDate: row.planDate,
    scale: row.scale,
    documentDate: row.documentDate,
    pageCount: row.pageCount,
    pagesNotRead: row.pagesNotRead,
    superseded: row.superseded,
    municipality: row.municipality,
    author: row.author,
    matchedOn: [
      ...(row.matchedName ? (['name'] as const) : []),
      ...(row.matchedReading ? (['reading'] as const) : []),
      ...(passage ? (['content'] as const) : []),
    ],
    passage: passage ? { text: passage.snippet, page: passage.page_number ?? null } : null,
  }
}

/** Facet counts with their labels: a project's name, a reference's own spelling; statuses folded into families. */
function labelFacets(
  reach: SearchReach,
  counts: Record<string, Array<{ value: string; count: number }>>,
  dimensions: readonly SearchFacetDimension[],
  people: ReadonlyMap<string, { name: string | null }>
): Partial<Record<SearchFacetDimension, FacetCount[]>> {
  const projectNames = new Map(reach.projects.map((reached) => [reached.project.id, reached.project.name]))
  const out: Partial<Record<SearchFacetDimension, FacetCount[]>> = {}
  for (const dimension of dimensions) {
    const values = counts[FACET_KEYS[dimension]] ?? []
    if (dimension === 'state') {
      const families = new Map<string, number>()
      for (const { value, count } of values) families.set(documentReadFamily(value), (families.get(documentReadFamily(value)) ?? 0) + count)
      out.state = [...families].map(([value, count]) => ({ value, label: null, count })).sort((a, b) => b.count - a.count)
      continue
    }
    out[dimension] = values.map(({ value, count }) => ({
      value,
      label:
        dimension === 'project'
          ? (projectNames.get(value) ?? null)
          : dimension === 'cites'
            ? value.slice(value.indexOf(':') + 1)
            : dimension === 'uploader'
              ? (people.get(value)?.name ?? null)
              : null,
      count,
    }))
  }
  return out
}

/** The content search under the structured filters' pre-filter; no call when the filters admit nothing. */
async function rankedContent(
  reach: SearchReach,
  structured: DocumentQuery,
  text: string
): Promise<{ hits: BackendSearchHit[]; partial: boolean } | null> {
  const prefilter = await contentPrefilter(reach, structured)
  if (!prefilter) return { hits: [], partial: false }
  return contentHits(reach, text, prefilter.filters)
}

/** The documents section, and the facets when asked. */
async function searchDocuments(
  reach: SearchReach,
  body: SearchBody,
  page: { limit: number; offset: number },
  withFacets: boolean
): Promise<{ section: SearchSection<DocumentHit>; facets: SearchResponse['facets']; contentPartial: boolean }> {
  const empty = { section: { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null }, facets: withFacets ? {} : null, contentPartial: false }
  const filters = body.filters ?? {}
  const [citedBy, citing] = await Promise.all([
    filters.citedBy ? referenceTargets(reach, filters.citedBy, 'citedBy') : null,
    filters.citing ? referenceTargets(reach, filters.citing, 'citing') : null,
  ])
  if ((filters.citedBy && !citedBy) || (filters.citing && !citing)) return empty
  const text = body.text?.trim() || null
  const structured: DocumentQuery = { filters, text: null, citedBy, citing }
  const content = text && text.length >= CONTENT_MIN_CHARS ? await rankedContent(reach, structured, text) : { hits: [], partial: false }
  const found = content?.hits ?? []
  // A hit names its document by id when it can; only a hit without one is joined by name (ADR-0133 item 5).
  const passagesById = new Map(found.flatMap((hit) => (hit.grid_document_id ? [[hit.grid_document_id, hit] as const] : [])))
  const passagesByKey = new Map(
    found.flatMap((hit) => (hit.grid_document_id ? [] : [[contentKey(hit.collection, hit.file_name), hit] as const]))
  )
  const query: DocumentQuery = {
    ...structured,
    text: text
      ? {
          text,
          contentKeys: found.map((hit) => (hit.grid_document_id ? '' : contentKey(hit.collection, hit.file_name))),
          contentIds: found.map((hit) => hit.grid_document_id ?? ''),
        }
      : null,
  }
  const order = documentOrder(body)
  const [result, counts] = await Promise.all([
    searchDocumentPage(reach, query, { ...order, ...page }),
    withFacets ? documentFacetCounts(reach, query, Object.values(FACET_KEYS)) : Promise.resolve(null),
  ])
  const uploaders = (counts?.uploader ?? []).map((entry) => entry.value)
  const people = await resolvePeople(reach.organizationId, [...new Set([...result.rows.map((row) => row.createdBy), ...uploaders])])
  const hits = result.rows.map((row) =>
    toDocumentHit(
      row,
      passagesById.get(row.id) ??
        (row.authoredBy === 'user' ? passagesByKey.get(contentKey(row.collectionName, row.filename)) : undefined),
      people.get(row.createdBy)?.name ?? null
    )
  )
  const nextOffset = page.offset + hits.length
  return {
    section: {
      hits,
      total: result.total,
      // Content found more than it could rank, or could not run: more documents may say it.
      totalIsLowerBound: Boolean(text) && (content === null || content.partial || found.length >= CONTENT_CANDIDATES),
      nextCursor: nextOffset < result.total && nextOffset <= SEARCH_OFFSET_MAX ? encodeSearchCursor('document', nextOffset) : null,
    },
    facets: counts ? labelFacets(reach, counts, Object.keys(FACET_KEYS) as SearchFacetDimension[], people) : null,
    contentPartial: content === null || content.partial,
  }
}

/** A section of another kind from its provider's page. */
function sectionOf<T extends SearchResponse['sections'][SearchKind]>(
  kind: SearchKind,
  result: { hits: NonNullable<T>['hits']; total: number },
  offset: number
): NonNullable<T> {
  const next = offset + result.hits.length
  return {
    hits: result.hits,
    total: result.total,
    totalIsLowerBound: false,
    nextCursor: next < result.total && next <= SEARCH_OFFSET_MAX ? encodeSearchCursor(kind, next) : null,
  } as NonNullable<T>
}

/** Run one search as `session`. */
export async function runSearch(session: AuthorizedSession, scopeQuery: SearchScopeQuery, body: SearchBody): Promise<SearchResponse> {
  const scope = resolveScope(scopeQuery)
  const reach = narrowedTo(await reachFor(session, scope), body)
  const kinds = SEARCH_KINDS.filter((kind) => !body.kinds || body.kinds.includes(kind))
  const single = kinds.length === 1
  if (body.cursor && !single) throw new BadRequestError('A cursor pages one kind: ask with kinds set to that kind alone')
  const offset = body.cursor ? decodeSearchCursor(body.cursor, kinds[0]) : 0
  const limit = body.limit ?? SEARCH_LIMIT_DEFAULT
  const pageFor = (kind: SearchKind) => ({ limit: single || kind === 'document' ? limit : SEARCH_SECTION_PREVIEW, offset })
  const text = body.text?.trim() || null

  const freshness = refreshStaleShelves(reach.organizationId, reachShelves(reach))
  const sections: SearchResponse['sections'] = {}
  let facets: SearchResponse['facets'] = null
  let contentPartial = false
  await Promise.all(
    kinds.map(async (kind) => {
      if (kind === 'document') {
        const documents = await searchDocuments(reach, body, pageFor(kind), body.facets !== false && offset === 0)
        sections.document = documents.section
        facets = documents.facets
        contentPartial = documents.contentPartial
        return
      }
      // The other kinds are found by their words or, for annotations, by their filters alone.
      if (kind === 'annotation') {
        if (!text && !body.annotationFilters) return
        sections.annotation = sectionOf('annotation', await searchAnnotations(reach, text, body.annotationFilters ?? {}, pageFor(kind)), offset)
        return
      }
      if (!text) return
      if (kind === 'folder') sections.folder = sectionOf('folder', await searchFolders(reach, text, pageFor(kind)), offset)
      if (kind === 'project') sections.project = sectionOf('project', await searchProjects(reach, text, pageFor(kind)), offset)
      if (kind === 'conversation') {
        sections.conversation = sectionOf('conversation', await searchConversations(session, reach, text, pageFor(kind)), offset)
      }
    })
  )
  return { scope, sections, facets, building: (await freshness).building, contentPartial }
}

/**
 * Every document a search finds, in its order, for the Planliste export: one
 * reach, one content search, one bounded SQL read. More than `max` is a 422,
 * never a list that silently ends.
 */
export async function listSearchDocumentsForExport(
  session: AuthorizedSession,
  scopeQuery: SearchScopeQuery,
  body: SearchBody,
  max: number
): Promise<{ scope: SearchReach['scope']; hits: DocumentHit[] }> {
  const reach = narrowedTo(await reachFor(session, resolveScope(scopeQuery)), body)
  const { section } = await searchDocuments(reach, { ...body, cursor: undefined }, { limit: max + 1, offset: 0 }, false)
  if (section.hits.length > max) {
    throw new UnprocessableError(`A plan list carries at most ${max} documents; narrow the search with a filter.`, {
      reason: 'too-many-documents',
    })
  }
  return { scope: reach.scope, hits: section.hits }
}
