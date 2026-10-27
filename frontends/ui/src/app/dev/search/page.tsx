'use client'

/**
 * Dev preview for the workspace search (ADR-0136): the REAL organism
 * (`SearchWorkspaceView`) over a fixture answer, the scene of
 * `docs/design/document-search.md` — 08:55, „Fluchtweg GK 4“ across two
 * projects and the Büroablage, and 09:10, the register sorted by Plannummer.
 *
 * The question lives in memory here instead of the URL, so every control
 * works (facets toggle, filters set chips, headers sort) while the answer
 * stays the fixture's. `?view=register` opens on the register, `?view=list`
 * on the list; without it both stand one above the other for a capture.
 * `?filters=open` opens the rail's typed filters. `?state=empty` is an answer
 * with no hits while a shelf's facts are still being read, `?state=loading`
 * the first answer on its way, `?state=error` a search that did not answer.
 *
 * German, pinned: the copy that has to fit is German.
 */

import type { JSX } from 'react'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import type { SavedSearchView } from '@/lib/search/saved-search-client'
import { SearchWorkspaceView } from '@/features/search'
import { SavedSearchesMenu } from '@/features/search/components/saved-searches-menu'
import { useSuggestedSearchName } from '@/features/search/hooks/use-suggested-search-name'
import { effectiveSort } from '@/features/search/lib/search-sort'
import { EMPTY_SEARCH_STATE, type SearchUrlState } from '@/features/search/lib/search-url'
import { sectionView, type SectionView } from '@/features/search/lib/sections'
import type { DocumentHit, SearchKind, SearchResponse, SearchSort } from '@/lib/search/search-wire'
import { SEARCH_FIXTURE_REGISTER_DOCUMENTS, SEARCH_FIXTURE_RESPONSE, SEARCH_FIXTURE_SAVED } from '../_fixtures/search'

const SECTIONS = Object.fromEntries(
  Object.entries(SEARCH_FIXTURE_RESPONSE.sections).flatMap(([kind, section]) => (section ? [[kind, sectionView(section)]] : []))
) as Partial<Record<SearchKind, ReturnType<typeof sectionView>>>

type PreviewState = 'answer' | 'empty' | 'loading' | 'error'

/** The value a register column orders by, as the repository reads it. */
const SORT_VALUE: Partial<Record<SearchSort, (hit: DocumentHit) => string | number | null>> = {
  name: (hit) => hit.title ?? hit.name,
  added: (hit) => hit.uploadedAt,
  plan_number: (hit) => hit.planNumber,
  plan_index: (hit) => hit.planIndex,
  plan_date: (hit) => hit.planDate,
  document_type: (hit) => hit.documentType,
  page_count: (hit) => hit.pageCount,
  project: (hit) => hit.projectName,
  scale: (hit) => hit.scale,
  folder: (hit) => hit.folderName,
  status: (hit) => hit.status,
  author: (hit) => hit.author,
}

/**
 * The register's answer here: the fixture's documents and the rest of the
 * Einreichung, filtered by type and Fassung and ordered as the repository
 * orders them, the documents without a value last in both directions. So the
 * capture shows what its chips and headers say.
 */
function registerSection(state: SearchUrlState): SectionView {
  const all = [...(SEARCH_FIXTURE_RESPONSE.sections.document?.hits ?? []), ...SEARCH_FIXTURE_REGISTER_DOCUMENTS] as DocumentHit[]
  const types = state.filters.documentTypes
  const hits = all.filter(
    (hit) => (!types || (hit.documentType !== null && (types as readonly string[]).includes(hit.documentType))) && !(state.filters.currentOnly && hit.superseded)
  )
  const { sort, dir } = effectiveSort(state)
  const value = SORT_VALUE[sort]
  if (value) {
    hits.sort((a, b) => {
      const x = value(a)
      const y = value(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
      const order = x < y ? -1 : x > y ? 1 : 0
      return dir === 'asc' ? order : -order
    })
  }
  return { hits, total: hits.length, totalIsLowerBound: false, nextCursor: null, loadingMore: false, loadMoreFailed: false }
}

const EMPTY_RESPONSE: SearchResponse = {
  ...SEARCH_FIXTURE_RESPONSE,
  sections: { document: { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null } },
  facets: {},
  building: ['office_shelf', 'p-hernals'],
}

function Preview({ initial, filtersOpen, answer }: { initial: SearchUrlState; filtersOpen: boolean; answer: PreviewState }): JSX.Element {
  const [state, setState] = useState(initial)
  const [field, setField] = useState(initial.text)
  const [saved, setSaved] = useState<SavedSearchView[]>(SEARCH_FIXTURE_SAVED)
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  const suggestedName = useSuggestedSearchName(state)
  return (
    <SearchWorkspaceView
      surface={{ kind: 'office' }}
      state={state}
      onStateChange={setState}
      fieldValue={field}
      onFieldChange={(value) => {
        setField(value)
        setState((current) => ({ ...current, text: value }))
      }}
      response={answer === 'answer' ? SEARCH_FIXTURE_RESPONSE : answer === 'empty' ? EMPTY_RESPONSE : null}
      sections={answer !== 'answer' ? {} : state.view === 'register' ? { ...SECTIONS, document: registerSection(state) } : SECTIONS}
      loading={answer === 'loading'}
      failed={answer === 'error'}
      onRetry={() => {}}
      onLoadMore={() => {}}
      onExport={() => {}}
      currentUserId="user_lena"
      filtersOpen={filtersOpen}
      savedSearches={
        <SavedSearchesMenu
          items={saved.filter((entry) => !deleting.has(entry.id))}
          failed={false}
          onApply={() => {}}
          onToggleShare={(item) => setSaved((list) => list.map((entry) => (entry.id === item.id ? { ...entry, shared: !entry.shared } : entry)))}
          onDelete={(item) => setDeleting((ids) => new Set(ids).add(item.id))}
          onUndoDelete={(item) => setDeleting((ids) => new Set([...ids].filter((id) => id !== item.id)))}
          suggestedName={suggestedName}
          onSave={async () => true}
        />
      }
    />
  )
}

function SearchPreview(): JSX.Element {
  const params = useSearchParams()
  const view = params?.get('view')
  const filtersOpen = params?.get('filters') === 'open'
  const stateParam = params?.get('state')
  const answer: PreviewState = stateParam === 'empty' || stateParam === 'loading' || stateParam === 'error' ? stateParam : 'answer'
  const list: SearchUrlState = { ...EMPTY_SEARCH_STATE, text: 'Fluchtweg GK 4' }
  const register: SearchUrlState = {
    ...EMPTY_SEARCH_STATE,
    view: 'register',
    sort: 'plan_number',
    dir: 'asc',
    filters: { documentTypes: ['submission_drawing'], currentOnly: true },
  }
  return (
    <main className="min-h-dvh bg-background px-4 py-8 md:px-8" data-testid="search-preview">
      <h1 className="mb-6 font-mono text-xs text-muted-foreground">/dev/search — Suche ({view ?? 'list + register'})</h1>
      <div className="flex flex-col gap-16">
        {view !== 'register' ? <Preview initial={list} filtersOpen={filtersOpen} answer={answer} /> : null}
        {view !== 'list' ? <Preview initial={register} filtersOpen={filtersOpen} answer={answer} /> : null}
      </div>
    </main>
  )
}

export default function SearchPreviewPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense fallback={<div />}>
        <SearchPreview />
      </Suspense>
    </I18nProvider>
  )
}
