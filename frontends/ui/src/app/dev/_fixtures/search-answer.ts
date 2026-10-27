/**
 * The `/dev/search` preview's answer to whatever the reader set: the fixture
 * filtered, sorted and counted in memory, so a capture never shows a chip, a
 * count or a sort arrow the rows beside it contradict.
 *
 * It honours what the page can set and the fixture can judge: the kinds, the
 * project facet, every counted facet, Plannummer (a prefix, as the server
 * folds it: case, spaces and hyphens ignored), Index, Maßstab, the dates,
 * current Fassung, pages, file type and uploader; and the register's sort.
 * As the server does, an annotation shows only while its document matches the
 * document filters, and folders, projects and chats are set aside while one
 * is set (`setAsideKinds`): the chips never claim a narrowing the rows ignore.
 * The words are not matched here: ranking by them is the server's, and the
 * fixture is the answer to „Fluchtweg GK 4“ already. What a hit does not carry
 * (its tags, parties, citations) is written beside it in `READ`, the reading
 * the projection would hold.
 */

import { documentReadFamily } from '@/lib/documents/document-status'
import { narrowsDocuments, setAsideKinds, type DocumentHit, type FacetCount, type SearchFacetDimension, type SearchResponse } from '@/lib/search/search-wire'
import { effectiveSort } from '@/features/search/lib/search-sort'
import { toSearchBody, type SearchUrlState } from '@/features/search/lib/search-url'
import { SEARCH_FIXTURE_DOCUMENTS, SEARCH_FIXTURE_REGISTER_DOCUMENTS, SEARCH_FIXTURE_RESPONSE } from './search'

/** What the reading found in each fixture document that its hit does not show. */
const READ: Record<string, { tags: string[]; partyRoles: string[]; cites: Array<{ value: string; label: string }> }> = {
  'd0000000-0000-4000-8000-000000000001': {
    tags: ['Brandschutz'],
    partyRoles: ['architect', 'client', 'authority'],
    cites: [{ value: 'norm:OIB-RL 2', label: 'OIB-RL 2' }, { value: 'plan:EP-05', label: 'EP-05' }],
  },
  'd0000000-0000-4000-8000-000000000002': {
    tags: ['Grundriss', 'Brandschutz'],
    partyRoles: ['architect', 'client'],
    cites: [{ value: 'norm:ÖNORM B 1600', label: 'ÖNORM B 1600' }, { value: 'plan:EP-05', label: 'EP-05' }],
  },
  'd0000000-0000-4000-8000-000000000003': { tags: ['Grundriss'], partyRoles: ['architect', 'client'], cites: [] },
  'd0000000-0000-4000-8000-000000000004': {
    tags: ['Schnitt'],
    partyRoles: ['architect', 'client'],
    cites: [{ value: 'norm:ÖNORM B 1600', label: 'ÖNORM B 1600' }],
  },
  'd0000000-0000-4000-8000-000000000005': {
    tags: ['Brandschutz'],
    partyRoles: ['architect', 'authority'],
    cites: [{ value: 'norm:OIB-RL 2', label: 'OIB-RL 2' }],
  },
  'd0000000-0000-4000-8000-000000000006': { tags: ['Brandschutz'], partyRoles: [], cites: [] },
}

/**
 * A document's reading. The register's further drawings have no entry of
 * their own: their Verfasser was read as the architect, so the Beteiligte
 * count agrees with the Verfasser column beside it.
 */
const readOf = (hit: DocumentHit): (typeof READ)[string] => READ[hit.id] ?? { tags: [], partyRoles: hit.author ? ['architect'] : [], cites: [] }

const fold = (value: string): string => value.toLowerCase().replace(/[\s-]/g, '')
const extension = (hit: DocumentHit): string => hit.filename.split('.').pop()?.toLowerCase() ?? ''
const within = (value: string | null, range: { from?: string; to?: string } | undefined): boolean =>
  !range || (value !== null && (!range.from || value.slice(0, 10) >= range.from) && (!range.to || value.slice(0, 10) <= range.to))
const anyOf = (wanted: readonly string[] | undefined, held: readonly string[]): boolean => !wanted?.length || wanted.some((value) => held.includes(value))

function matches(hit: DocumentHit, state: SearchUrlState): boolean {
  const f = state.filters
  const read = readOf(hit)
  return (
    (!state.projectId || hit.projectId === state.projectId) &&
    anyOf(f.projectIds, hit.projectId ? [hit.projectId] : []) &&
    anyOf(f.documentTypes, hit.documentType ? [hit.documentType] : []) &&
    anyOf(f.tags, read.tags) &&
    anyOf(
      f.parties?.flatMap((party) => (party.role ? [party.role] : [])),
      read.partyRoles
    ) &&
    anyOf(
      f.cites,
      read.cites.flatMap((cite) => [cite.value, cite.label])
    ) &&
    anyOf(
      f.municipalities?.map((value) => value.toLowerCase()),
      hit.municipality ? [hit.municipality.toLowerCase()] : []
    ) &&
    (!f.planNumber || (hit.planNumber !== null && fold(hit.planNumber).startsWith(fold(f.planNumber)))) &&
    anyOf(
      f.planIndex?.map(fold),
      hit.planIndex ? [fold(hit.planIndex)] : []
    ) &&
    anyOf(
      f.scale?.map(fold),
      hit.scale ? [fold(hit.scale)] : []
    ) &&
    (!f.currentOnly || !hit.superseded) &&
    within(hit.planDate, f.planDate) &&
    within(hit.documentDate, f.documentDate) &&
    within(hit.uploadedAt, f.uploaded) &&
    anyOf(f.uploadedBy, hit.uploadedBy ? [hit.uploadedBy] : []) &&
    anyOf(f.states, [documentReadFamily(hit.status)]) &&
    anyOf(f.fileTypes, [extension(hit)]) &&
    (!f.incompleteRead || (hit.pagesNotRead ?? 0) > 0) &&
    (f.pages?.min === undefined || (hit.pageCount ?? 0) >= f.pages.min) &&
    (f.pages?.max === undefined || (hit.pageCount ?? 0) <= f.pages.max)
  )
}

const SORT_KEYS: Record<string, (hit: DocumentHit) => string | number | null> = {
  name: (hit) => hit.title ?? hit.name,
  added: (hit) => hit.uploadedAt,
  plan_number: (hit) => hit.planNumber,
  plan_index: (hit) => hit.planIndex,
  plan_date: (hit) => hit.planDate,
  document_date: (hit) => hit.documentDate,
  document_type: (hit) => hit.documentType,
  page_count: (hit) => hit.pageCount,
  project: (hit) => hit.projectName,
  scale: (hit) => hit.scale,
  folder: (hit) => hit.folderName,
  status: (hit) => hit.status,
  author: (hit) => hit.author,
}

/**
 * Sorted as the page asks the server to sort: the column the reader chose, or
 * the view's default (the register by Plannummer); relevance keeps the
 * fixture's order. A blank sorts last either way, as the register's does.
 */
function sorted(hits: DocumentHit[], state: SearchUrlState): DocumentHit[] {
  const { sort, dir } = effectiveSort(state)
  const key = SORT_KEYS[sort]
  if (!key) return hits
  const direction = dir === 'desc' ? -1 : 1
  return [...hits].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'de', { numeric: true })) * direction
  })
}

function count(values: Array<{ value: string; label?: string | null }>): FacetCount[] {
  const counts = new Map<string, FacetCount>()
  for (const { value, label } of values) {
    const known = counts.get(value)
    counts.set(value, { value, label: label ?? null, count: (known?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

/** The counts over the matched documents, as the server would give them. */
function facetsOf(hits: DocumentHit[]): Partial<Record<SearchFacetDimension, FacetCount[]>> {
  const read = readOf
  return {
    documentType: count(hits.flatMap((hit) => (hit.documentType ? [{ value: hit.documentType }] : []))),
    tag: count(hits.flatMap((hit) => read(hit).tags.map((value) => ({ value })))),
    project: count(hits.flatMap((hit) => (hit.projectId ? [{ value: hit.projectId, label: hit.projectName }] : []))),
    partyRole: count(hits.flatMap((hit) => read(hit).partyRoles.map((value) => ({ value })))),
    municipality: count(hits.flatMap((hit) => (hit.municipality ? [{ value: hit.municipality }] : []))),
    cites: count(hits.flatMap((hit) => read(hit).cites)),
    state: count(hits.map((hit) => ({ value: documentReadFamily(hit.status) }))),
    fileType: count(hits.map((hit) => ({ value: extension(hit) }))),
  }
}

/** The fixture's answer to `state`. */
export function searchFixtureAnswer(state: SearchUrlState): SearchResponse {
  // The register reads the whole Einreichung, not only the hits of „Fluchtweg GK 4“.
  const pool = state.view === 'register' ? [...SEARCH_FIXTURE_DOCUMENTS, ...SEARCH_FIXTURE_REGISTER_DOCUMENTS] : SEARCH_FIXTURE_DOCUMENTS
  const documents = sorted(
    pool.filter((hit) => matches(hit, state)),
    state
  )
  // The fixture is the answer to words even when the field is empty, so the words count as set.
  const setAside = setAsideKinds({ ...toSearchBody(state), text: state.text.trim() || 'Fluchtweg GK 4' })
  const wanted = (kind: keyof SearchResponse['sections']): boolean =>
    !setAside[kind] && (state.view === 'register' ? kind === 'document' : !state.kinds || state.kinds.includes(kind))
  const inProject = <T extends { projectId: string | null }>(hits: T[]): T[] => (state.projectId ? hits.filter((hit) => hit.projectId === state.projectId) : hits)
  // An annotation narrows through its document, against the whole pool so the register's drawings count too.
  const matchedIds = new Set([...SEARCH_FIXTURE_DOCUMENTS, ...SEARCH_FIXTURE_REGISTER_DOCUMENTS].filter((hit) => matches(hit, state)).map((hit) => hit.id))
  const throughDocument = <T extends { documentId?: string }>(hits: T[]): T[] =>
    narrowsDocuments(state.filters) ? hits.filter((hit) => hit.documentId !== undefined && matchedIds.has(hit.documentId)) : hits
  const sections: SearchResponse['sections'] = {}
  for (const [kind, section] of Object.entries(SEARCH_FIXTURE_RESPONSE.sections) as Array<[keyof SearchResponse['sections'], NonNullable<SearchResponse['sections'][keyof SearchResponse['sections']]>]>) {
    if (!wanted(kind)) continue
    const hits =
      kind === 'document'
        ? documents
        : kind === 'project'
          ? section.hits
          : kind === 'annotation'
            ? throughDocument(inProject(section.hits as Array<{ projectId: string | null; documentId: string }>))
            : inProject(section.hits as Array<{ projectId: string | null }>)
    Object.assign(sections, { [kind]: { hits, total: hits.length, totalIsLowerBound: false, nextCursor: null } })
  }
  return { ...SEARCH_FIXTURE_RESPONSE, setAside, sections, facets: facetsOf(documents) }
}
