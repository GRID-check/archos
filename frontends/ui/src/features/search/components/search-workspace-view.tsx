'use client'

import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BookOpenCheck, FilterX, Hourglass, List, SearchX, SlidersHorizontal, Table2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadError } from '@/components/ui/load-error'
import { SearchField } from '@/components/ui/search-field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PHONE_QUERY, useIsMobile } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useLocale, useTranslations } from '@/i18n'
import { SEARCH_KINDS, type DocumentHit, type SearchFacetDimension, type SearchHit, type SearchKind, type SearchResponse } from '@/lib/search/search-wire'
import { clearFilters } from '../lib/active-filters'
import type { SearchExportFormat } from '../lib/search-client'
import { toggleFacet } from '../lib/search-facets'
import { hitHref } from '../lib/search-hrefs'
import { useSearchReturn } from '../hooks/use-search-return'
import { surfaceScope, type SearchSurface } from '../lib/search-surface'
import { activeFilterCount, filtersByReading, officeSearchHref, withView, type SearchUrlState, type SearchView } from '../lib/search-url'
import { kindCountsKnown, type SectionView } from '../lib/sections'
import { HitMenuProvider, type HitMenuState } from './hit-actions-menu'
import { SearchActiveFilters } from './search-active-filters'
import {
  ChoiceStrip,
  EmptyActions,
  FieldShortcut,
  FilterSheet,
  KeysHint,
  KindCount,
  ResultsBody,
  ResultsSkeleton,
  ResultsStatus,
  SearchFrame,
  SearchNote,
  SearchToolbar,
} from './search-atoms'
import { SearchExportMenu } from './search-export-menu'
import { SearchFacetRail } from './search-facet-rail'
import { PartyNameFilter, SearchFilterForm, SearchKeyFilters } from './search-filter-form'
import { SearchRegister, SearchRegisterBar } from './search-register'
import { SearchResultList } from './search-result-list'

const ALL_KINDS = 'all'

export interface SearchWorkspaceViewProps {
  surface: SearchSurface
  state: SearchUrlState
  onStateChange: (next: SearchUrlState) => void
  /** What the field shows, ahead of `state.text` while the reader types. */
  fieldValue: string
  onFieldChange: (value: string) => void
  response: SearchResponse | null
  sections: Partial<Record<SearchKind, SectionView>>
  loading: boolean
  failed: boolean
  onRetry: () => void
  onLoadMore: (kind: SearchKind) => void
  /** Absent: no export offered. Offered in the register view only, where the Planliste it writes is on screen. */
  onExport?: (format: SearchExportFormat) => void
  exporting?: boolean
  /** The saved searches control (`SavedSearchesMenu`), wired by the caller: one button, saving included. */
  savedSearches?: ReactNode
  /** Controls before the view switch: the way back to the Dateien. */
  leading?: ReactNode
  currentUserId?: string
  autoFocus?: boolean
  /** Open the rail's further filters from the start, and under `md` the filter sheet. */
  filtersOpen?: boolean
}

/** The hits in the order the arrow keys walk them: the list's sections in turn, or the register's rows. */
function walkOrder(view: SearchView, sections: Partial<Record<SearchKind, SectionView>>): SearchHit[] {
  if (view === 'register') return sections.document?.hits ?? []
  return SEARCH_KINDS.flatMap((kind) => sections[kind]?.hits ?? [])
}

const hitKey = (hit: SearchHit): string => `${hit.kind}:${hit.id}`

/** The platform's key for "the menu of the thing I am on": Shift+F10, or the keyboard's own menu key. */
export const isMenuKey = (event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean =>
  event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)

/**
 * The search, at any scope: the field, the facets and filters beside the
 * result, the result as a list of what matched or as the register. It holds
 * no question of its own; the question is `state`, which the caller keeps in
 * the URL (`SearchWorkspace`) or, in the preview, in memory.
 *
 * The toolbar is set as the Dateien header sets its own: the view as an icon
 * pair, the secondary actions as quiet icon buttons with their name on hover
 * (saved searches, and in the register the export), so no row of equal
 * labelled buttons competes with the field. Under `md` the rail is a sheet
 * behind „Filter“, the one labelled control, so the first result sits under
 * the field.
 *
 * The keyboard: ⌘K / Strg+K focuses the field from anywhere on the page; in
 * the field ↑ and ↓ walk the results, Enter opens the one marked, Shift+F10
 * (or the menu key) opens the marked document's ⋯, Escape clears the words.
 */
export function SearchWorkspaceView({
  surface,
  state,
  onStateChange,
  fieldValue,
  onFieldChange,
  response,
  sections,
  loading,
  failed,
  onRetry,
  onLoadMore,
  onExport,
  exporting = false,
  savedSearches,
  leading,
  currentUserId,
  autoFocus = false,
  filtersOpen = false,
}: SearchWorkspaceViewProps): JSX.Element {
  const t = useTranslations('search')
  const { locale } = useLocale()
  const router = useRouter()
  const from = useSearchReturn()
  const sheetLayout = useIsMobile()
  const phone = useMediaQuery(PHONE_QUERY)
  const [sheetOpen, setSheetOpen] = useState(filtersOpen)
  const field = useRef<HTMLInputElement | null>(null)
  const filterCount = activeFilterCount(state)
  const officeWide = surface.kind === 'office'

  // ⌘K / Strg+K: here it is the field, the page's own command line. Caught
  // before the shell's palette chord, which would open the palette over it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      field.current?.focus()
      field.current?.select()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  useEffect(() => {
    if (autoFocus) field.current?.focus()
  }, [autoFocus])

  const order = useMemo(() => walkOrder(state.view, sections), [state.view, sections])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // The keys are taught where they work: in the field, until the first arrow.
  const [fieldFocused, setFieldFocused] = useState(false)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const hitMenus = useMemo<HitMenuState>(() => ({ openKey: menuKey, onOpenKeyChange: setMenuKey }), [menuKey])
  // The combobox's ids: each kind's listbox (or the register's table) and each hit's option.
  const idPrefix = useId()
  const listId = (kind: SearchKind): string => `${idPrefix}-list-${kind}`
  const registerId = `${idPrefix}-register`
  const optionId = (hit: SearchHit): string => `${idPrefix}-${hitKey(hit).replace(':', '-')}`
  const activeHit = order.find((hit) => hitKey(hit) === activeKey)
  const controls =
    state.view === 'register' ? registerId : SEARCH_KINDS.filter((kind) => (sections[kind]?.hits.length ?? 0) > 0).map(listId).join(' ')
  // A new answer starts the walk again at the top.
  const [seen, setSeen] = useState(response)
  if (seen !== response) {
    setSeen(response)
    setActiveKey(null)
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (order.length === 0) return
      event.preventDefault()
      const at = order.findIndex((hit) => hitKey(hit) === activeKey)
      const next = event.key === 'ArrowDown' ? Math.min(order.length - 1, at + 1) : Math.max(0, at - 1)
      setActiveKey(hitKey(order[next]))
      return
    }
    if (isMenuKey(event)) {
      const hit = order.find((entry) => hitKey(entry) === activeKey)
      if (hit?.kind !== 'document') return
      event.preventDefault()
      setMenuKey(hitKey(hit))
      return
    }
    if (event.key === 'Enter') {
      const hit = order.find((entry) => hitKey(entry) === activeKey)
      if (!hit) return
      event.preventDefault()
      router.push(hitHref(hit, from))
      return
    }
    if (event.key === 'Escape' && fieldValue !== '') {
      event.preventDefault()
      onFieldChange('')
    }
  }

  const projectName = (id: string): string | null =>
    response?.facets?.project?.find((facet) => facet.value === id)?.label ??
    (sections.document?.hits as DocumentHit[] | undefined)?.find((hit) => hit.projectId === id)?.projectName ??
    null

  const onFacet = (dimension: SearchFacetDimension, value: string): void => onStateChange(toggleFacet(state, dimension, value))
  // The register shows the documents alone, so it counts them alone.
  const visibleSections = (state.view === 'register' ? [sections.document] : Object.values(sections)).filter(
    (section): section is SectionView => Boolean(section)
  )
  const anyHits = visibleSections.some((section) => section.hits.length > 0)
  const total = visibleSections.reduce((sum, section) => sum + section.total, 0)
  const lowerBound = visibleSections.some((section) => section.totalIsLowerBound)
  const documents = sections.document as SectionView<DocumentHit> | undefined
  // A phone cut the long placeholder mid-word: there it is one word.
  const placeholder = phone ? t('field.placeholderShort') : t(`field.placeholder.${surface.kind}`)
  const building = response?.building.length ?? 0
  const oneKind = state.view === 'list' && state.kinds?.length === 1 ? state.kinds[0] : null
  // Kinds a filter that is set cannot narrow are not searched (`setAsideKinds`); the list says which, once.
  const setAside = state.view === 'list' ? (response?.setAside ?? {}) : {}
  const kindTabs = SEARCH_KINDS.filter((kind) => officeWide || kind !== 'project')
  // Every tab its count, or none: a count shows only once it is known (`kindCountsKnown`).
  const countsKnown = kindCountsKnown(response, kindTabs)
  // On a phone the note is one line and the greyed tab carries the whole sentence.
  const setAsideNotes = (['document_filters', 'annotation_filters'] as const).flatMap((reason) => {
    const named = SEARCH_KINDS.filter((kind) => setAside[kind] === reason && (officeWide || kind !== 'project'))
    if (named.length === 0) return []
    const kinds = new Intl.ListFormat(locale, { type: 'conjunction' }).format(named.map((kind) => t(`kinds.${kind}`)))
    return [{ reason, long: t(`setAside.${reason}`, { kinds }), short: t('setAside.short', { kinds }) }]
  })
  const setAsideNote = setAsideNotes.map((note) => (phone ? note.short : note.long))

  const status = failed
    ? null
    : response === null || loading
      ? t('loading')
      : lowerBound
        ? t('summaryAtLeast', { count: total })
        : t('total', { count: total })
  // The shelves still being read are said once, short, in the status line;
  // when a filter that is set depends on what they hold, the same clause says
  // what that costs.
  // On a phone the short clause always: the line above the first hit stays one line.
  const buildingNote = filtersByReading(state) && !phone ? 'notes.buildingFiltered' : 'notes.buildingShort'
  const statusLine = status && building > 0 && anyHits && !loading ? `${status} · ${t(buildingNote, { count: building })}` : status

  // The typed filters an office reaches for first lead, always open; the
  // counts follow; the rest waits behind „Weitere Filter“.
  const rail = (
    <>
      <SearchKeyFilters state={state} onChange={onStateChange} />
      <SearchFacetRail
        state={state}
        facets={response?.facets ?? null}
        onToggle={onFacet}
        unread={response?.unread ?? null}
        showProjects={officeWide}
        extras={{ partyRole: <PartyNameFilter state={state} onChange={onStateChange} /> }}
      />
      <SearchFilterForm state={state} onChange={onStateChange} currentUserId={currentUserId} defaultOpen={filtersOpen} />
    </>
  )

  // An empty answer offers the ways out that can change it, not a sentence about them.
  const emptyActions = [
    filterCount > 0 ? (
      <Button key="clear" type="button" variant="outline" size="sm" onClick={() => onStateChange(clearFilters(state))} data-testid="search-empty-clear">
        {t('filters.clearAll')}
      </Button>
    ) : null,
    oneKind ? (
      <Button key="kinds" type="button" variant="outline" size="sm" onClick={() => onStateChange({ ...state, kinds: null })} data-testid="search-empty-all-kinds">
        {t('empty.allKinds')}
      </Button>
    ) : null,
    state.filters.includeArchived ? null : (
      <Button
        key="archived"
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onStateChange({ ...state, filters: { ...state.filters, includeArchived: true } })}
        data-testid="search-empty-archived"
      >
        {t('empty.includeArchived')}
      </Button>
    ),
    officeWide ? null : (
      <Button key="office" asChild variant="outline" size="sm">
        <Link href={officeSearchHref(state)} data-testid="search-empty-office">
          {t('empty.wholeOffice')}
        </Link>
      </Button>
    ),
  ].filter(Boolean)
  const emptyDescription =
    building > 0
      ? t('empty.reading', { count: building })
      : filterCount > 0
        ? t('empty.withFilters')
        : oneKind
          ? t('empty.oneKind', { kind: t(`kinds.${oneKind}`) })
          : t('empty.description')

  return (
    <SearchFrame
      rail={sheetLayout ? null : rail}
      toolbar={
        <>
          <SearchToolbar
            field={
              <SearchField
                type="search"
                value={fieldValue}
                onChange={onFieldChange}
                onKeyDown={onFieldKeyDown}
                onFocusChange={setFieldFocused}
                placeholder={placeholder}
                label={t('field.label')}
                clearLabel={t('field.clear')}
                inputRef={field}
                hint={<FieldShortcut />}
                combobox={{ controls, expanded: order.length > 0, activeDescendant: activeHit ? optionId(activeHit) : null }}
              />
            }
            controls={
              <>
                {leading}
                <ToggleGroup
                  type="single"
                  segmented
                  size="icon-sm"
                  value={state.view}
                  onValueChange={(value) => {
                    if (value === 'list' || value === 'register') onStateChange(withView(state, value as SearchView))
                  }}
                  aria-label={t('views.label')}
                >
                  <ToggleGroupItem value="list" aria-label={t('views.list')} title={t('views.list')} data-testid="search-view-list">
                    <List aria-hidden />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="register" aria-label={t('views.register')} title={t('views.register')} data-testid="search-view-register">
                    <Table2 aria-hidden />
                  </ToggleGroupItem>
                </ToggleGroup>
                {sheetLayout ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-haspopup="dialog"
                    aria-expanded={sheetOpen}
                    onClick={() => setSheetOpen(true)}
                    data-testid="search-rail-toggle"
                  >
                    <SlidersHorizontal aria-hidden />
                    {filterCount > 0 ? t('filters.toggleCount', { count: filterCount }) : t('filters.toggle')}
                  </Button>
                ) : null}
                {savedSearches}
                {onExport && state.view === 'register' ? <SearchExportMenu onExport={onExport} busy={exporting} /> : null}
              </>
            }
          />
          <SearchActiveFilters state={state} onChange={onStateChange} projectName={projectName} />
          {sheetLayout ? (
            <FilterSheet
              open={sheetOpen}
              onOpenChange={setSheetOpen}
              title={t('filters.sheetTitle')}
              description={t('filters.sheetDescription')}
              closeLabel={t('filters.sheetClose')}
              clearLabel={t('filters.clearAllShort')}
              canClear={filterCount > 0}
              onClear={() => onStateChange(clearFilters(state))}
              showLabel={response === null || loading ? t('loading') : total > 0 ? t('filters.showResults', { count: total }) : t('filters.showNone')}
            >
              {rail}
            </FilterSheet>
          ) : null}
        </>
      }
    >
      {state.view === 'list' ? (
        <ChoiceStrip label={t('kindFilter.label')}>
          <ToggleGroup
            type="single"
            segmented
            size="sm"
            value={state.kinds?.length === 1 ? state.kinds[0] : ALL_KINDS}
            onValueChange={(value) => {
              if (value) onStateChange({ ...state, kinds: value === ALL_KINDS ? null : [value as SearchKind] })
            }}
            aria-label={t('kindFilter.label')}
            data-testid="search-kind"
          >
            <ToggleGroupItem value={ALL_KINDS}>{t('kindFilter.all')}</ToggleGroupItem>
            {kindTabs.map((kind) => {
              const section = countsKnown ? response?.sections[kind] : undefined
              const asideReason = setAside[kind]
              return (
                <ToggleGroupItem
                  key={kind}
                  value={kind}
                  disabled={Boolean(asideReason) && state.kinds?.[0] !== kind}
                  title={asideReason ? (setAsideNotes.find((note) => note.reason === asideReason)?.long ?? t('setAside.tab')) : undefined}
                  data-set-aside={asideReason}
                  data-testid={`search-kind-${kind}`}
                >
                  {t(`kinds.${kind}`)}
                  {section ? <KindCount>{section.totalIsLowerBound ? `${section.total}+` : section.total}</KindCount> : null}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </ChoiceStrip>
      ) : (
        <SearchRegisterBar state={state} onStateChange={onStateChange} hideProject={!officeWide} />
      )}
      <ResultsStatus busy={loading && !failed}>
        {statusLine}
        {status && anyHits && fieldFocused && activeKey === null ? <KeysHint>{` · ${t('keys')}`}</KeysHint> : null}
      </ResultsStatus>
      {setAsideNote.map((note) => (
        <SearchNote key={note} icon={FilterX} testId="search-note-set-aside">
          {note}
        </SearchNote>
      ))}
      {response?.contentPartial ? (
        <SearchNote icon={BookOpenCheck} testId="search-note-partial">
          {t('notes.contentPartial')}
        </SearchNote>
      ) : null}
      {failed ? (
        <LoadError title={t('error')} description={t('errorHint')} onRetry={onRetry} />
      ) : response === null ? (
        loading ? <ResultsSkeleton /> : null
      ) : !anyHits ? (
        <EmptyState
          icon={building > 0 ? Hourglass : SearchX}
          title={building > 0 ? t('empty.readingTitle') : t('empty.title')}
          description={emptyDescription}
          action={emptyActions.length > 0 ? <EmptyActions>{emptyActions}</EmptyActions> : undefined}
          // Bare, as Dateien draws a filter that matches nothing: the answer is the page, not a card on it.
          variant="bare"
          data-testid="search-empty"
        />
      ) : (
        <ResultsBody stale={loading}>
          <HitMenuProvider value={hitMenus}>
          {state.view === 'register' ? (
            <SearchRegister
              state={state}
              section={documents}
              onStateChange={onStateChange}
              onLoadMore={() => onLoadMore('document')}
              hideProject={!officeWide}
              activeKey={activeKey}
              listId={registerId}
              optionId={optionId}
            />
          ) : (
            <SearchResultList
              sections={sections}
              onLoadMore={onLoadMore}
              text={state.text}
              activeKey={activeKey}
              listId={listId}
              optionId={optionId}
              scope={surfaceScope(surface, state)}
            />
          )}
          </HitMenuProvider>
        </ResultsBody>
      )}
    </SearchFrame>
  )
}
