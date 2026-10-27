'use client'

import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BookOpenCheck, Hourglass, List, SearchX, SlidersHorizontal, Table2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadError } from '@/components/ui/load-error'
import { SearchField } from '@/components/ui/search-field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { SEARCH_KINDS, type DocumentHit, type SearchFacetDimension, type SearchHit, type SearchKind, type SearchResponse } from '@/lib/search/search-wire'
import { clearFilters } from '../lib/active-filters'
import type { SearchExportFormat } from '../lib/search-client'
import { toggleFacet } from '../lib/search-facets'
import { hitHref } from '../lib/search-hrefs'
import type { SearchSurface } from '../lib/search-surface'
import { activeFilterCount, type SearchUrlState, type SearchView } from '../lib/search-url'
import type { SectionView } from '../lib/sections'
import { SearchActiveFilters } from './search-active-filters'
import {
  FieldShortcut,
  KindCount,
  RailToggleSlot,
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
import { SearchFilterForm } from './search-filter-form'
import { SearchRegister } from './search-register'
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
  /** The saved searches control (`SavedSearchesMenu`), wired by the caller. */
  savedSearches?: ReactNode
  /** Controls before the view switch: the way back to the Dateien. */
  leading?: ReactNode
  currentUserId?: string
  autoFocus?: boolean
  /** Open the rail's typed filters from the start. */
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
  const [railOpen, setRailOpen] = useState(false)
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
      router.push(hitHref(hit))
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
  const placeholder = t(`field.placeholder.${surface.kind}`)

  const status = failed
    ? null
    : response === null
      ? t('loading')
      : loading
        ? t('loading')
        : lowerBound
          ? t('summaryAtLeast', { count: total })
          : t('total', { count: total })

  return (
    <SearchFrame
      railOpen={railOpen}
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
                    if (value === 'list' || value === 'register') onStateChange({ ...state, view: value as SearchView })
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
                {savedSearches}
                {onExport ? <SearchExportMenu onExport={onExport} busy={exporting} /> : null}
                <RailToggleSlot>
                  <Button type="button" variant="outline" size="sm" aria-expanded={railOpen} onClick={() => setRailOpen((open) => !open)} data-testid="search-rail-toggle">
                    <SlidersHorizontal aria-hidden />
                    {filterCount > 0 ? t('filters.toggleCount', { count: filterCount }) : t('filters.toggle')}
                  </Button>
                </RailToggleSlot>
              </>
            }
          />
          <SearchActiveFilters state={state} onChange={onStateChange} projectName={projectName} />
        </>
      }
      rail={
        <>
          <SearchFacetRail state={state} facets={response?.facets ?? null} onToggle={onFacet} showProjects={officeWide} />
          <SearchFilterForm state={state} onChange={onStateChange} currentUserId={currentUserId} defaultOpen={filtersOpen} />
        </>
      }
    >
      {state.view === 'list' ? (
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
      ) : null}
      <ResultsStatus busy={loading && !failed}>
        {status}
        {status && anyHits ? ` · ${t('keys')}` : null}
      </ResultsStatus>
      {response && response.building.length > 0 ? (
        <SearchNote icon={Hourglass} testId="search-note-building">
          {t('notes.building', { count: response.building.length })}
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
          icon={SearchX}
          title={t('empty.title')}
          description={filterCount > 0 ? t('empty.withFilters') : t('empty.description')}
          action={
            filterCount > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => onStateChange(clearFilters(state))} data-testid="search-empty-clear">
                {t('filters.clearAll')}
              </Button>
            ) : undefined
          }
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
