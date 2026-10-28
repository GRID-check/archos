/**
 * Grouped semantic search over project collections, and joining the backend's hits back to
 * document rows.
 */

import 'server-only'
import { getProjectFolderAccess } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { buildGridRequestContextWireHeaders } from '@/lib/request-context'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { ProjectFactsWire, SearchBoostWire } from '@/lib/cross-project/project-facts-mirror'
import { NotFoundError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Project } from '@/lib/db/schema/projects'
import { toListedDocuments, type ListedDocument } from './shelf-listing'
import { findProjectDocumentsByFilenames } from './repository'
import { SCREENED_ONLY } from './document-reader'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { BACKEND_FETCH_TIMEOUT_MS } from './ingest-dispatch'

/**
 * A single hit from the backend's document-centric semantic search
 * (`POST /v1/collections/{c}/search`). One hit per file, best snippet, sorted
 * by score descending. Deterministic vector search — no LLM.
 */
export interface BackendSearchHit {
  file_name: string
  score: number
  snippet: string
  page_number: number | null
  collection: string
  /** Position in ONE ranking across collections (`fetchGroupedSemanticHits`), 0 = best; absent on one collection's search. */
  rank?: number
  /** The document's id, when the backend states it (the grouped search, from the chunk's payload). */
  grid_document_id?: string
  /** The grouped search: a passage holds a word of the query (`true`), or it matched by meaning alone (`false`). */
  lexical?: boolean | null
}

/**
 * A document row joined with its semantic-search match evidence — the existing
 * list row (name, status, metadata) plus WHY it matched: the best snippet, the
 * page it came from, and the 0..1 relevance score. Returned reordered by score.
 */
export type SearchedDocument<T> = T & {
  snippet: string
  page: number | null
  score: number
  /** Position in one ranking across several collections, when the search produced one (`BackendSearchHit.rank`). */
  rank?: number
}

/**
 * One ranking across many collections, from the backend's grouped search
 * (`POST /v1/collections/search`, ADR-0116): every collection named is ranked
 * in ONE query, and the documents come back in that ranking's order across
 * collections (at most `filesPerCollection` from any one), each hit carrying
 * its position as `rank`. Scores from separate searches are not comparable;
 * this order is. `options` narrow the search and lift similar projects inside
 * the same query.
 *
 * Qdrant is the only store (ADR-0115), so there is nothing to fall back to: a
 * backend that refuses, cannot be reached or answers something unreadable is
 * an {@link UpstreamError}, never an empty result a caller would read as
 * "nothing found". The envelope is signed for exactly these collections, every
 * one of which the caller has already authorized.
 */
export async function fetchGroupedSemanticHits(
  collections: readonly string[],
  query: string,
  filesPerCollection: number,
  snippetMaxChars?: number,
  options: GroupedSearchOptions = {}
): Promise<BackendSearchHit[]> {
  const unique = [...new Set(collections)]
  if (unique.length === 0) return []
  const scopeHeaders = buildGridRequestContextWireHeaders(
    { collectionScope: unique },
    process.env.INTERNAL_API_TOKEN
  )
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/collections/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...scopeHeaders },
      body: JSON.stringify({
        query,
        collections: unique,
        groups: Math.min(unique.length, GROUPED_SEARCH_MAX_GROUPS),
        files_per_group: Math.min(Math.max(1, filesPerCollection), GROUPED_SEARCH_MAX_FILES_PER_GROUP),
        ...(snippetMaxChars ? { snippet_max_chars: snippetMaxChars } : {}),
        ...(options.filters ? { filters: options.filters } : {}),
        ...(options.boost ? { boost: options.boost } : {}),
        ...(options.purpose ? { purpose: options.purpose } : {}),
      }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('Grouped search backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (!res.ok) throw new UpstreamError(`Grouped search backend returned ${res.status}`)
  const body = await res.json().catch(() => null)
  if (!Array.isArray(body?.hits)) throw new UpstreamError('Grouped search backend returned an unexpected shape')
  const allowed = new Set(unique)
  // A hit names the collection it came from; one this call did not ask for
  // is dropped rather than trusted, so the join can only ever see these.
  return (body.hits as BackendSearchHit[])
    .filter((hit) => allowed.has(hit.collection))
    .map((hit, rank) => ({ ...hit, rank }))
}

/** The backend's bounds on a grouped search (`GroupedDocumentSearchRequest`). */
const GROUPED_SEARCH_MAX_GROUPS = 200

const GROUPED_SEARCH_MAX_FILES_PER_GROUP = 20

/**
 * The most collections one backend search may name: `collections` is
 * `max_length=500` on both `GroupedDocumentSearchRequest`
 * (`agent_host/models/requests.py`) and `SimilarPassagesRequest`
 * (`agent_host/models/similar.py`). Past it the backend answers 422. A project
 * brings its own collection and every restricted folder's the reader is
 * cleared for, so a page of projects can pass it.
 */
export const BACKEND_SEARCH_MAX_COLLECTIONS = 500

/**
 * How many of a walk's projects, by their collection counts in walk order,
 * one search can name together within `cap`. The project that would pass it,
 * and every one after it, waits. The first always counts, so a walk never
 * stalls on a project cleared for more folders than the cap: the caller cuts
 * its collections to the cap.
 */
export function projectsWithinCollectionCap(sizes: readonly number[], cap = BACKEND_SEARCH_MAX_COLLECTIONS): number {
  let total = 0
  for (const [index, size] of sizes.entries()) {
    total += size
    if (total > cap) return Math.max(index, 1)
  }
  return sizes.length
}

/** The grouped search's pre-filters (`GroupedSearchFilters`): within a list any of, across lists all of. */
export interface GroupedSearchFilters {
  document_types?: string[]
  disciplines?: string[]
  project_facts?: Partial<ProjectFactsWire>
  project_status?: Array<'active' | 'paused' | 'closed'>
  /** Only passages of these documents (their ids, `grid_document_id` on the chunks); at most 1000. */
  document_ids?: string[]
  file_names?: string[] // The same documents' names, for passages without `grid_document_id`: any of the ids or these.
  /** The dossier's `document_type` (`site_plan`, ...), any of; not `document_types`, which reads the tags. */
  reading_types?: string[]
  /** Documents referring to any of these: typed text ("ÖNORM B 1600", "EP-05") or a `kind:key` token; at most 8. */
  refers_to?: string[]
}

/** What narrows and what lifts a grouped search, applied inside its one query. */
export interface GroupedSearchOptions {
  filters?: GroupedSearchFilters
  /** The current project's facts and the similarity weights (`similarityBoostOf`). */
  boost?: SearchBoostWire | null
  /**
   * Who asks, when the backend should trace the search itself: the workspace
   * search's call is a `retrieve.workspace_search` observation there, because
   * no NAT run sees it. The cross-project lookup sends none: Piloti's
   * `project_lookup` tool already traces it as `retrieve.project_lookup`.
   */
  purpose?: 'workspace_search'
}

/** The identity of a document in the backend: its collection and its filename. */
function collectionFileKey(collectionName: string, filename: string): string {
  return JSON.stringify([collectionName, filename])
}

/**
 * Join backend hits to the existing file rows BY COLLECTION AND FILENAME
 * (`hit.collection` === `file.collectionName` and `hit.file_name` ===
 * `file.filename`), returning the matched rows reordered by score (hit order,
 * which the backend guarantees is score-descending), each augmented with its
 * snippet, page, and score. Hits with no matching row are dropped. When the pair
 * collides across rows the most-recent row (latest `createdAt`) wins, so a
 * re-uploaded document resolves to its current entry.
 *
 * ## The collection is part of the identity, and it is the hit's own
 *
 * A filename is unique only within a collection, and a project has several: its
 * own, plus one per restricted folder (`<collection>_r<12hex>`, ADR-0087), and
 * a project's search covers every one the reader is cleared for. The
 * same name can sit in a restricted folder and, newer, at the root. A join on
 * the name alone handed the restricted folder's passage to the root row, so the
 * reader saw a restricted passage under the open document, filed at the root
 * with no restricted marker. The row a hit becomes must therefore be the row of
 * the collection the hit came from.
 *
 * ## Machine-authored rows are not candidates, and the collision rule is why
 *
 * A hit comes from the retrieval index, and nothing machine-authored is ever
 * indexed — so every hit describes a document a person supplied. This join is
 * what turns that hit back into a row, and it keys on FILENAME, which is not a
 * safe identity across authorship.
 *
 * `generatedFilename` builds `slug(title)-YYYY-MM-DD.ext` from a title the
 * MODEL wrote — a report's own H1, a diagram card's `title`. So a filed report
 * whose title slugs to the stem of a real Gutachten, on the same day, collides.
 * The tie-break then decides it, and it decides it the wrong way by
 * construction: the agent row was written after the corpus it was written from,
 * so it is always the most recent. The reader would get a search result labelled
 * „Von Piloti erstellt" carrying a snippet and a page number lifted from
 * somebody's actual Gutachten.
 *
 * No chunk was created for the agent row and no retrieval invariant was broken —
 * the leak is in the join, not in the index, which is why the dispatch-site
 * guard and the storage-key allow-list do not reach it. This is the third path
 * by which a machine-authored row can reach a reader as evidence, and it is
 * closed the same way as the other two: by asking the row, not by trusting the
 * name.
 */
export function joinHitsToFiles<
  T extends { filename: string; collectionName: string; createdAt: Date | string; authoredBy: string },
>(hits: BackendSearchHit[], files: T[]): Array<SearchedDocument<T>> {
  const byName = new Map<string, T>()
  for (const file of files) {
    // Only a human-authored row may take a hit. A filename is not an identity
    // across authorship: `generatedFilename` builds `slug(title)-DATE.ext` from a
    // title the model wrote, so a collision with a real document is reachable by
    // the model, and recency would then hand it that document's snippet and page
    // under a „Von Piloti erstellt" label.
    //
    // `authoredBy` is required rather than optional on purpose. Every caller
    // selects it (`documentListColumns`); making it optional would
    // mean a future caller that forgets the column fails OPEN at runtime instead
    // of failing to compile.
    //
    // `collectionName` is required for the same reason, and the failure it
    // prevents is worse: a row type without it would key every row under
    // `undefined`, match no hit, and a "fix" that falls back to the name alone
    // would reopen the restricted-folder misjoin. Every caller selects it too.
    if (file.authoredBy !== 'user') continue
    const key = collectionFileKey(file.collectionName, file.filename)
    const existing = byName.get(key)
    if (!existing || new Date(file.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      byName.set(key, file)
    }
  }

  const matched: Array<SearchedDocument<T>> = []
  for (const hit of hits) {
    // The hit's own collection, never a name match across collections.
    const file = byName.get(collectionFileKey(hit.collection, hit.file_name))
    if (!file) continue
    matched.push({
      ...file,
      snippet: hit.snippet,
      page: hit.page_number ?? null,
      score: hit.score,
      ...(hit.rank === undefined ? {} : { rank: hit.rank }),
    })
  }
  return matched
}

/** How a project search's hits are cut and who they are for. */
export interface ProjectSearchOptions {
  /**
   * The hits go to a model: joined to screened rows only (`SCREENED_ONLY`,
   * ADR-0086), and no superseded Fassung among them (ADR-0099).
   */
  forModel?: boolean
}

/** What a reader may search in one project: the project and the collections they are cleared for. */
export interface ProjectSearchPlan {
  project: Project
  access: Awaited<ReturnType<typeof getProjectFolderAccess>>
  /** The project's own collection and every restricted one this reader is cleared for (ADR-0087). */
  collections: string[]
}

/** Authorize a search of one project (`project:view`) and name the collections it covers. */
export async function planProjectSearch(session: AuthorizedSession, projectId: string): Promise<ProjectSearchPlan> {
  await requireProjectAccess(session, projectId, 'project:view')

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const access = await getProjectFolderAccess(session, projectId, project.collectionName)
  return { project, access, collections: [project.collectionName, ...access.clearedRestrictedCollections] }
}

/**
 * Turn one project's backend hits into its document rows, in the hits' order.
 * Only hits from the plan's own collections are considered: the join below
 * keys on the hit's collection, and a plan is what this reader was cleared for.
 */
export async function hydrateProjectHits(
  session: AuthorizedSession,
  plan: ProjectSearchPlan,
  hits: BackendSearchHit[],
  options: ProjectSearchOptions = {}
): Promise<Array<SearchedDocument<ListedDocument>>> {
  const allowed = new Set(plan.collections)
  const own = hits.filter((hit) => allowed.has(hit.collection))
  if (own.length === 0) return []
  const projectId = plan.project.id
  // The canonical rows, hydrated exactly as the listing hydrates them, so a
  // semantic result is always a real, visible document with its live status.
  const reader = options.forModel ? SCREENED_ONLY : await shelfReaderFor(session, { scope: 'project', projectId })
  // The lookup is by project and name, so it returns the same-named rows of the
  // project's own collection and of every cleared restricted folder alike (a
  // hidden folder's rows are left out); the join then picks, per hit, the row of
  // the hit's own collection.
  const rows = await findProjectDocumentsByFilenames(
    projectId,
    session.organizationId,
    own.map((hit) => hit.file_name),
    { hiddenFolderIds: [...plan.access.hiddenFolderIds], reader }
  )
  const joined = joinHitsToFiles(own, await toListedDocuments(session, rows, reader))
  // A model is handed no superseded Fassung (ADR-0099: search leaves it out
  // unless asked by name). The backend filters Qdrant's copy of the mark,
  // which can lag a person's confirmation; the row is the authority. A person
  // searching still sees it, badged by the listing.
  return options.forModel ? joined.filter((row) => !row.revision?.supersededBy) : joined
}
