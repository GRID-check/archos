'use client'

import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Bookmark,
  BookmarkPlus,
  BookOpenCheck,
  FileSpreadsheet,
  FileText,
  Hourglass,
  List,
  MoreHorizontal,
  SearchX,
  SlidersHorizontal,
  Table2,
} from 'lucide-react'

import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadError } from '@/components/ui/load-error'
import { SearchField } from '@/components/ui/search-field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PHONE_QUERY, useIsMobile } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useTranslations } from '@/i18n'
import { SEARCH_KINDS, type DocumentHit, type SearchFacetDimension, type SearchHit, type SearchKind, type SearchResponse } from '@/lib/search/search-wire'
import { clearFilters } from '../lib/active-filters'
import type { SearchExportFormat } from '../lib/search-client'
import { toggleFacet } from '../lib/search-facets'
import { hitHref } from '../lib/search-hrefs'
import { useSearchReturn } from '../hooks/use-search-return'
import type { SearchSurface } from '../lib/search-surface'
import { activeFilterCount, filtersByReading, officeSearchHref, withView, type SearchUrlState, type SearchView } from '../lib/search-url'
import type { SectionView } from '../lib/sections'
import type { NarrowSavedSearches } from './saved-searches-menu'
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
  ToolbarLabel,
} from './search-atoms'
import { SearchExportMenu } from './search-export-menu'
import { SearchFacetRail } from './search-facet-rail'
import { SearchFilterForm, SearchKeyFilters } from './search-filter-form'
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
  /** Absent: no export offered. */
  onExport?: (format: SearchExportFormat) => void
  exporting?: boolean
  /**
   * The saved searches control (`SavedSearchesMenu`), wired by the caller.
   * Given the „Mehr“ menu's state on a phone, where that menu opens it; null
   * where the toolbar has room for its own buttons.
   */
  savedSearches?: (narrow: NarrowSavedSearches | null) => ReactNode
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

/**
 * The search, at any scope: the field, the facets and filters beside the
 * result, the result as a list of what matched or as the register. It holds
 * no question of its own; the question is `state`, which the caller keeps in
 * the URL (`SearchWorkspace`) or, in the preview, in memory.
 *
 * Under `md` the rail is a sheet behind „Filter“, so the first result sits
 * under the field. On a phone-sized screen the toolbar keeps the view and
 * „Filter“, and folds the saved searches and the export into one „Mehr“.
 *
 * The keyboard: ⌘K / Strg+K focuses the field from anywhere on the page; in
 * the field ↑ and ↓ walk the results, Enter opens the one marked, Escape
 * clears the words.
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
  const router = useRouter()
  const from = useSearchReturn()
  const sheetLayout = useIsMobile()
  const phone = useMediaQuery(PHONE_QUERY)
  const [sheetOpen, setSheetOpen] = useState(filtersOpen)
  const [savedListOpen, setSavedListOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const field = useRef<HTMLInputElement | null>(null)
  const filterCount = activeFilterCount(state)
  const officeWide = surface.kind === 'office'
  const [modifier, setModifier] = useState(t('field.modKey'))

  // ⌘K / Strg+K: here it is the field, the page's own command line. Caught
  // before the shell's palette chord, which would open the palette over it.
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setModifier('⌘')
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

  const status = failed
    ? null
    : response === null || loading
      ? t('loading')
      : lowerBound
        ? t('summaryAtLeast', { count: total })
        : t('total', { count: total })
  // The shelves still being read are said once, in the status line; the long
  // note only where a filter that is set depends on what they hold.
  const readingNote = building > 0 && anyHits && filtersByReading(state)
  const statusLine = status && building > 0 && anyHits && !loading && !readingNote ? `${status} · ${t('notes.buildingShort', { count: building })}` : status

  const narrowSaved: NarrowSavedSearches = { listOpen: savedListOpen, onListOpenChange: setSavedListOpen, saveOpen, onSaveOpenChange: setSaveOpen }
  const moreEntries: ActionMenuEntry[] = [
    ...(savedSearches
      ? [
          { type: 'item' as const, id: 'saved', label: t('more.savedLabel'), icon: Bookmark, onSelect: () => setSavedListOpen(true), testId: 'search-more-saved' },
          { type: 'item' as const, id: 'save', label: t('saved.save'), icon: BookmarkPlus, onSelect: () => setSaveOpen(true), testId: 'search-more-save' },
        ]
      : []),
    ...(savedSearches && onExport ? [{ type: 'separator' as const }] : []),
    ...(onExport
      ? [
          { type: 'item' as const, id: 'csv', label: t('export.csv'), icon: FileText, disabled: exporting, onSelect: () => onExport('csv'), testId: 'search-export-csv' },
          { type: 'item' as const, id: 'xlsx', label: t('export.xlsx'), icon: FileSpreadsheet, disabled: exporting, onSelect: () => onExport('xlsx'), testId: 'search-export-xlsx' },
        ]
      : []),
  ]

  // The typed filters an office reaches for first lead, always open; the
  // counts follow; the rest waits behind „Weitere Filter“.
  const rail = (
    <>
      <SearchKeyFilters state={state} onChange={onStateChange} />
      <SearchFacetRail state={state} facets={response?.facets ?? null} unread={response?.unread ?? null} onToggle={onFacet} showProjects={officeWide} />
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
                placeholder={placeholder}
                label={t('field.label')}
                clearLabel={t('field.clear')}
                inputRef={field}
                hint={<FieldShortcut modifier={modifier} />}
                combobox={{ controls, expanded: order.length > 0, activeDescendant: activeHit ? optionId(activeHit) : null }}
              />
            }
            controls={
              <>
                {leading}
                <ToggleGroup
                  type="single"
                  segmented
                  size="sm"
                  value={state.view}
                  onValueChange={(value) => {
                    if (value === 'list' || value === 'register') onStateChange(withView(state, value as SearchView))
                  }}
                  aria-label={t('views.label')}
                >
                  <ToggleGroupItem value="list" aria-label={t('views.list')} data-testid="search-view-list">
                    <List aria-hidden />
                    <ToolbarLabel>{t('views.list')}</ToolbarLabel>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="register" aria-label={t('views.register')} data-testid="search-view-register">
                    <Table2 aria-hidden />
                    <ToolbarLabel>{t('views.register')}</ToolbarLabel>
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
                {phone ? (
                  <>
                    {moreEntries.length > 0 ? (
                      <ActionMenu
                        mode="dropdown"
                        entries={moreEntries}
                        trigger={
                          <Button type="button" variant="outline" size="sm" aria-busy={exporting || undefined} data-testid="search-more">
                            <MoreHorizontal aria-hidden />
                            {t('more.label')}
                          </Button>
                        }
                      />
                    ) : null}
                    {savedSearches?.(narrowSaved)}
                  </>
                ) : (
                  <>
                    {savedSearches?.(null)}
                    {onExport ? <SearchExportMenu onExport={onExport} busy={exporting} /> : null}
                  </>
                )}
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
            {SEARCH_KINDS.filter((kind) => officeWide || kind !== 'project').map((kind) => {
              const section = response?.sections[kind]
              return (
                <ToggleGroupItem key={kind} value={kind} data-testid={`search-kind-${kind}`}>
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
        {status && anyHits ? <KeysHint>{` · ${t('keys')}`}</KeysHint> : null}
      </ResultsStatus>
      {readingNote ? (
        <SearchNote icon={Hourglass} testId="search-note-building">
          {t('notes.building', { count: building })}
        </SearchNote>
      ) : null}
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
          data-testid="search-empty"
        />
      ) : (
        <ResultsBody stale={loading}>
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
            <SearchResultList sections={sections} onLoadMore={onLoadMore} text={state.text} activeKey={activeKey} listId={listId} optionId={optionId} />
          )}
        </ResultsBody>
      )}
    </SearchFrame>
  )
}
