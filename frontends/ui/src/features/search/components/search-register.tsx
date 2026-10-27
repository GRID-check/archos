'use client'

import type { JSX, ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react'

import { ActionMenu } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LoadMore } from '@/components/ui/load-more'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { documentReadFamily } from '@/lib/documents/document-status'
import type { DocumentHit } from '@/lib/search/search-wire'
import { useSearchLabels } from '../hooks/use-search-labels'
import { documentHitHref } from '../lib/search-hrefs'
import {
  COLUMN_SORT,
  columnSortState,
  effectiveSort,
  FIXED_REGISTER_COLUMN,
  REGISTER_COLUMNS,
  sortByColumn,
  toggleRegisterColumn,
  visibleRegisterColumns,
  type RegisterColumn,
} from '../lib/search-sort'
import { compactFilters, type SearchUrlState } from '../lib/search-url'
import type { SectionView } from '../lib/sections'
import {
  LabelledSwitch,
  MetaLine,
  MetaPart,
  RegisterBar,
  RegisterBody,
  RegisterCell,
  RegisterHead,
  RegisterHeadCell,
  RegisterLink,
  RegisterRow,
  RegisterStack,
  RegisterStackRow,
  RegisterTable,
  ShelfMark,
  SupersededMark,
  ToolbarLabel,
} from './search-atoms'

/** Columns whose values are figures: right-aligned, as a register reads them. */
const NUMERIC: ReadonlySet<RegisterColumn> = new Set(['pages'])

/**
 * Each column's width in rem; the title takes the rest. Sized so the default
 * columns stand beside a readable title in the register's room at 1440 (about
 * 70rem): each header fits its word and its sort arrow, in German and English.
 */
const COLUMN_WIDTH: Readonly<Record<RegisterColumn, number | null>> = {
  planNumber: 7,
  planIndex: 4.5,
  title: null,
  planDate: 7,
  scale: 5.5,
  documentType: 8.5,
  author: 8.5,
  project: 9,
  folder: 8,
  uploaded: 7.5,
  pages: 5,
  status: 6.5,
}

export interface SearchRegisterProps {
  state: SearchUrlState
  section: SectionView<DocumentHit> | undefined
  onStateChange: (next: SearchUrlState) => void
  onLoadMore: () => void
  /** Leave out the Projekt column where the scope is one project. */
  hideProject?: boolean
  /** The row the arrow keys are on (`document:id`). */
  activeKey: string | null
  /** The table's id and each row's, which the search field's combobox names. */
  listId?: string
  optionId?: (hit: DocumentHit) => string
}

/**
 * Above the register, whether or not it has rows: „Nur aktuelle Fassung“, on
 * by default here (the Jour fixe reads the current plans), and the column
 * menu; on a phone, where there are no headers to click, the order too.
 */
export function SearchRegisterBar({
  state,
  onStateChange,
  hideProject = false,
}: {
  state: SearchUrlState
  onStateChange: (next: SearchUrlState) => void
  hideProject?: boolean
}): JSX.Element {
  const t = useTranslations('search')
  const isMobile = useIsMobile()
  return (
    <RegisterBar
      start={
        <LabelledSwitch
          id="search-register-current"
          label={t('register.currentOnly')}
          checked={Boolean(state.filters.currentOnly)}
          onCheckedChange={(on) => onStateChange({ ...state, filters: compactFilters({ ...state.filters, currentOnly: on || undefined }) })}
          testId="search-register-current"
        />
      }
      end={
        <>
          {isMobile ? <SortMenu state={state} onStateChange={onStateChange} hideProject={hideProject} /> : null}
          <ColumnMenu state={state} onStateChange={onStateChange} hideProject={hideProject} />
        </>
      }
    />
  )
}

/** Which columns show: a check per column, kept open while the reader picks several. */
function ColumnMenu({ state, onStateChange, hideProject }: { state: SearchUrlState; onStateChange: (next: SearchUrlState) => void; hideProject: boolean }): JSX.Element {
  const t = useTranslations('search')
  const visible = new Set(visibleRegisterColumns(state.columns))
  const offered = REGISTER_COLUMNS.filter((column) => !(hideProject && column === 'project'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={t('register.columnsMenuTitle')} data-testid="search-register-columns">
          <Columns3 aria-hidden />
          <ToolbarLabel>{t('register.columnsMenu')}</ToolbarLabel>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('register.columnsMenuTitle')}</DropdownMenuLabel>
        {offered.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={visible.has(column)}
            disabled={column === FIXED_REGISTER_COLUMN}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onStateChange({ ...state, columns: toggleRegisterColumn(state.columns, column) })}
            data-testid={`search-register-column-${column}`}
          >
            {t(`register.columns.${column}`)}
          </DropdownMenuCheckboxItem>
        ))}
        {state.columns !== null ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onStateChange({ ...state, columns: null })} data-testid="search-register-columns-reset">
              {t('register.columnsReset')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The order on a phone: the visible columns as choices; the active one again turns it round. */
function SortMenu({ state, onStateChange, hideProject }: { state: SearchUrlState; onStateChange: (next: SearchUrlState) => void; hideProject: boolean }): JSX.Element {
  const t = useTranslations('search')
  const columns = visibleRegisterColumns(state.columns, { hideProject })
  const order = effectiveSort(state)
  const active = columns.find((column) => COLUMN_SORT[column] === order.sort) ?? null
  const Icon = active === null ? ArrowUpDown : order.dir === 'asc' ? ArrowUp : ArrowDown
  const label = active === null ? t('register.sortMenu') : t(`register.columns.${active}`)
  return (
    <ActionMenu
      mode="dropdown"
      entries={[
        { type: 'label', label: t('register.sortMenuTitle') },
        {
          type: 'radio-group',
          value: active ?? '',
          onValueChange: (value) => {
            const column = columns.find((entry) => entry === value)
            if (column) onStateChange(sortByColumn(state, column))
          },
          items: columns.map((column) => ({ value: column, label: t(`register.columns.${column}`), testId: `search-register-sort-${column}` })),
        },
        { type: 'separator' },
        { type: 'label', label: t('register.sortMenuHint') },
      ]}
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={active === null ? t('register.sortMenu') : t('register.sortMenuLabel', { column: label, direction: order.dir === 'asc' ? t('register.ascending') : t('register.descending') })}
          data-testid="search-register-sort"
        >
          <Icon aria-hidden />
          {label}
        </Button>
      }
    />
  )
}

/**
 * The register, the Planliste: one row per document, the columns a Jour fixe
 * reads, each header a sort control. The page scrolls it, and its header row
 * stays put. On a phone it is a stack of entries, the number over the name.
 * It is a view of what Piloti read, not a list anyone maintains.
 */
export function SearchRegister({ state, section, onStateChange, onLoadMore, hideProject = false, activeKey, listId, optionId }: SearchRegisterProps): JSX.Element {
  const t = useTranslations('search')
  const isMobile = useIsMobile()
  const columns = visibleRegisterColumns(state.columns, { hideProject })
  const hits = section?.hits ?? []
  return (
    <>
      {isMobile ? (
        <RegisterStack id={listId} label={t('register.caption')} testId="search-register">
          {hits.map((hit) => (
            <RegisterStackLine key={hit.id} hit={hit} columns={columns} active={activeKey === `document:${hit.id}`} id={optionId?.(hit)} />
          ))}
        </RegisterStack>
      ) : (
        <RegisterTable
          id={listId}
          caption={t('register.caption')}
          testId="search-register"
          columnWidths={columns.map((column) => COLUMN_WIDTH[column])}
          scrollLabel={t('register.scrollLabel')}
        >
          <RegisterHead>
            {columns.map((column) => {
              const label = t(`register.columns.${column}`)
              return (
                <RegisterHeadCell
                  key={column}
                  label={label}
                  numeric={NUMERIC.has(column)}
                  sort={{
                    ariaLabel: t('register.sortBy', { column: label }),
                    direction: columnSortState(state, column),
                    onSort: () => onStateChange(sortByColumn(state, column)),
                  }}
                />
              )
            })}
          </RegisterHead>
          <RegisterBody>
            {hits.map((hit) => (
              <RegisterLine key={hit.id} hit={hit} columns={columns} active={activeKey === `document:${hit.id}`} id={optionId?.(hit)} />
            ))}
          </RegisterBody>
        </RegisterTable>
      )}
      {section ? (
        <LoadMore
          hasMore={section.nextCursor !== null}
          loading={section.loadingMore}
          failed={section.loadMoreFailed}
          onLoadMore={onLoadMore}
          loadMoreLabel={t('loadMore')}
          loadingLabel={t('loadingMore')}
          failedLabel={t('loadMoreFailed')}
        />
      ) : null}
    </>
  )
}

function useStatus(hit: DocumentHit): { node: ReactNode; quiet: boolean } {
  const labels = useSearchLabels()
  if (hit.superseded) return { node: <SupersededMark />, quiet: false }
  const family = documentReadFamily(hit.status)
  return { node: labels.readState(family), quiet: family === 'readable' }
}

function RegisterLine({ hit, columns, active, id }: { hit: DocumentHit; columns: readonly RegisterColumn[]; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  const status = useStatus(hit)
  const cell = (column: RegisterColumn): JSX.Element => {
    switch (column) {
      case 'planNumber':
        return <RegisterCell key={column} kind="code" title={hit.planNumber ?? undefined}>{hit.planNumber}</RegisterCell>
      case 'planIndex':
        return <RegisterCell key={column} kind="code">{hit.planIndex}</RegisterCell>
      case 'planDate':
        return <RegisterCell key={column} kind="muted">{labels.day(hit.planDate)}</RegisterCell>
      case 'scale':
        return <RegisterCell key={column} kind="code">{hit.scale}</RegisterCell>
      case 'title':
        return (
          <RegisterCell key={column} kind="strong" title={hit.title ?? hit.name}>
            <RegisterLink href={documentHitHref(hit)}>{hit.title ?? hit.name}</RegisterLink>
          </RegisterCell>
        )
      case 'documentType': {
        const type = labels.documentType(hit.documentType)
        return <RegisterCell key={column} title={type ?? undefined}>{type}</RegisterCell>
      }
      case 'author':
        return <RegisterCell key={column} title={hit.author ?? undefined}>{hit.author}</RegisterCell>
      case 'project':
        return (
          <RegisterCell key={column} kind="mark">
            {hit.shelf === 'office_shelf' ? (
              <ShelfMark shelf="office_shelf" label={t('where.officeShelf')} />
            ) : hit.projectName ? (
              <ShelfMark shelf="project" label={hit.projectName} />
            ) : null}
          </RegisterCell>
        )
      case 'folder':
        return <RegisterCell key={column} title={hit.folderName ?? undefined}>{hit.folderName}</RegisterCell>
      case 'uploaded':
        return <RegisterCell key={column} kind="muted">{labels.day(hit.uploadedAt)}</RegisterCell>
      case 'pages':
        return <RegisterCell key={column} kind="figure">{hit.pageCount}</RegisterCell>
      case 'status':
        return (
          <RegisterCell key={column} kind={status.quiet ? 'muted' : 'mark'}>
            {status.node}
          </RegisterCell>
        )
    }
  }
  return (
    <RegisterRow active={active} id={id} testId={`search-register-row-${hit.id}`}>
      {columns.map(cell)}
    </RegisterRow>
  )
}

/** On a phone: the number and Index over the name; the other chosen columns on one muted line. */
function RegisterStackLine({ hit, columns, active, id }: { hit: DocumentHit; columns: readonly RegisterColumn[]; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  const status = useStatus(hit)
  const shown = new Set(columns)
  const code = [shown.has('planNumber') ? hit.planNumber : null, shown.has('planIndex') && hit.planIndex ? `${t('register.columns.planIndex')} ${hit.planIndex}` : null]
    .filter(Boolean)
    .join(' · ')
  const meta = (column: RegisterColumn): ReactNode => {
    switch (column) {
      case 'planDate':
        return hit.planDate ? <MetaPart>{labels.day(hit.planDate)}</MetaPart> : null
      case 'scale':
        return hit.scale ? <MetaPart code>{hit.scale}</MetaPart> : null
      case 'documentType':
        return labels.documentType(hit.documentType)
      case 'author':
        return hit.author
      case 'project':
        // A line of its own on a phone, so the project's name is read whole.
        return hit.shelf === 'office_shelf' ? (
          <ShelfMark shelf="office_shelf" label={t('where.officeShelf')} wrap />
        ) : hit.projectName ? (
          <ShelfMark shelf="project" label={hit.projectName} wrap />
        ) : null
      case 'folder':
        return hit.folderName
      case 'uploaded':
        return <MetaPart>{labels.day(hit.uploadedAt)}</MetaPart>
      case 'pages':
        return hit.pageCount === null ? null : <MetaPart>{`${hit.pageCount} ${t('register.columns.pages')}`}</MetaPart>
      default:
        return null
    }
  }
  return (
    <RegisterStackRow
      id={id}
      href={documentHitHref(hit)}
      code={code || undefined}
      title={hit.title ?? hit.name}
      meta={<MetaLine parts={columns.map(meta)} />}
      aside={shown.has('status') && !status.quiet ? status.node : undefined}
      active={active}
      testId={`search-register-row-${hit.id}`}
    />
  )
}
